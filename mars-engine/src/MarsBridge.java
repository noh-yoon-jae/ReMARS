package remars;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.TreeMap;

import mars.ErrorList;
import mars.Globals;
import mars.MIPSprogram;
import mars.ProcessingException;
import mars.ProgramStatement;
import mars.Settings;
import mars.assembler.Symbol;
import mars.mips.hardware.Coprocessor0;
import mars.mips.hardware.Coprocessor1;
import mars.mips.hardware.Memory;
import mars.mips.hardware.MemoryConfigurations;
import mars.mips.hardware.Register;
import mars.mips.hardware.RegisterFile;
import mars.simulator.DelayedBranch;
import mars.util.SystemIO;

/** Persistent JSON-events-over-stdout bridge to the MARS 4.5 assembler and machine. */
public final class MarsBridge {
    private static final PrintStream PROTOCOL = System.out;
    private static final InputQueue INPUT = new InputQueue();
    private static final Object MACHINE_LOCK = new Object();
    private static volatile MIPSprogram program;
    private static volatile String source = "";
    private static volatile String sourcePath = "";
    private static volatile boolean running;
    private static volatile boolean pauseRequested;
    private static volatile boolean stopRequested;
    private static volatile boolean startAtMain = true;
    private static volatile boolean delayedBranching;
    private static volatile int maxSteps = 1_000_000;
    private static volatile int speedDelayMs;
    private static volatile long executedSteps;
    private static volatile int bypassBreakpointOnce = -1;
    private static volatile String state = "ready";
    private static final Set<Integer> breakpointLines = Collections.synchronizedSet(new HashSet<Integer>());
    private static final Set<Integer> breakpointAddresses = Collections.synchronizedSet(new HashSet<Integer>());
    private static final Map<Integer, ProgramStatement> statementsByAddress = Collections.synchronizedMap(new TreeMap<Integer, ProgramStatement>());
    private static volatile String lastAssemblyError = "";

    private MarsBridge() { }

    public static void main(String[] args) throws Exception {
        System.setProperty("java.awt.headless", "true");
        System.setIn(INPUT);
        System.setOut(new PrintStream(new MipsOutput(), true, "UTF-8"));
        Globals.initialize(false);
        MemoryConfigurations.buildConfigurationCollection();
        MemoryConfigurations.setCurrentConfiguration(MemoryConfigurations.getDefaultConfiguration());
        Memory.setConfiguration();
        resetMachine();
        emitRaw("{\"event\":\"engine-ready\",\"version\":\"4.5\"}");

        java.io.BufferedReader reader = new java.io.BufferedReader(
            new java.io.InputStreamReader(new FileInputStream(FileDescriptor.in), StandardCharsets.UTF_8));
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isEmpty()) continue;
            try {
                handle(line);
            } catch (Throwable error) {
                replyError(idFrom(line), error.toString());
            }
        }
        requestStop();
    }

    private static void handle(String line) throws Exception {
        String[] fields = line.split("\\t", -1);
        String id = fields.length > 0 ? fields[0] : "0";
        String command = fields.length > 1 ? fields[1] : "";
        String arg = fields.length > 2 && !"run".equals(command) ? decode(fields[2]) : "";
        switch (command) {
            case "assemble": {
                String options = fields.length > 3 ? decode(fields[3]) : "";
                Map<String, String> opts = parseOptions(options);
                startAtMain = Boolean.parseBoolean(opts.getOrDefault("startAtMain", "true"));
                delayedBranching = Boolean.parseBoolean(opts.getOrDefault("delayedBranching", "false"));
                boolean warningsAreErrors = Boolean.parseBoolean(opts.getOrDefault("warningsAreErrors", "false"));
                String message = assemble(arg, warningsAreErrors);
                boolean ok = lastAssemblyError.isEmpty();
                reply(id, "{\"ok\":" + ok + ",\"message\":" + json(message) + ",\"snapshot\":" + snapshotJson() + ",\"instructions\":" + instructionsJson() + ",\"symbols\":" + symbolsJson() + "}");
                break;
            }
            case "run": {
                maxSteps = parseInt(fields, 2, 1_000_000);
                speedDelayMs = Math.max(0, Math.min(parseInt(fields, 3, 0), 2_000));
                setBreakpoints(decode(fields.length > 4 ? fields[4] : ""));
                if (fields.length > 5 && !decode(fields[5]).isEmpty() && !decode(fields[5]).equals(source)) {
                    assemble(decode(fields[5]), false);
                }
                if (!lastAssemblyError.isEmpty()) {
                    reply(id, "{\"ok\":false,\"message\":" + json(lastAssemblyError) + "}");
                } else if (running) {
                    reply(id, "{\"ok\":false,\"message\":\"Program is already running\"}");
                } else {
                    startExecution("running", maxSteps);
                    reply(id, "{\"ok\":true,\"message\":\"Program started\",\"snapshot\":" + snapshotJson() + "}");
                }
                break;
            }
            case "step": {
                String code = arg;
                String options = fields.length > 3 ? decode(fields[3]) : "";
                Map<String, String> opts = parseOptions(options);
                startAtMain = Boolean.parseBoolean(opts.getOrDefault("startAtMain", "true"));
                delayedBranching = Boolean.parseBoolean(opts.getOrDefault("delayedBranching", "false"));
                if (!code.isEmpty() && !code.equals(source)) assemble(code, false);
                if (!lastAssemblyError.isEmpty()) reply(id, "{\"ok\":false,\"message\":" + json(lastAssemblyError) + "}");
                else if (running) reply(id, "{\"ok\":false,\"message\":\"Program is already running\"}");
                else {
                    setBreakpoints(decode(fields.length > 4 ? fields[4] : ""));
                    startExecution("stepping", 1);
                    reply(id, "{\"ok\":true,\"message\":\"Step started\",\"snapshot\":" + snapshotJson() + "}");
                }
                break;
            }
            case "pause":
                pauseRequested = true;
                reply(id, "{\"ok\":true,\"message\":\"Pause requested\"}");
                break;
            case "stop":
                requestStop();
                reply(id, "{\"ok\":true,\"message\":\"Stop requested\"}");
                break;
            case "reset":
                requestStop();
                Thread.sleep(30L);
                if (!source.isEmpty()) assemble(source, false);
                else {
                    resetMachine();
                    state = "ready";
                }
                reply(id, "{\"ok\":true,\"snapshot\":" + snapshotJson() + "}");
                break;
            case "backstep":
                synchronized (MACHINE_LOCK) {
                    if (program != null && program.backSteppingEnabled() && !program.getBackStepper().empty()) {
                        program.getBackStepper().backStep();
                        executedSteps = Math.max(0, executedSteps - 1);
                        state = "paused";
                        emitSnapshot();
                        reply(id, "{\"ok\":true,\"snapshot\":" + snapshotJson() + "}");
                    } else reply(id, "{\"ok\":false,\"message\":\"No instruction to step back\"}");
                }
                break;
            case "input":
                INPUT.feed(arg);
                reply(id, "{\"ok\":true}");
                break;
            case "breakpoints":
                setBreakpoints(arg);
                reply(id, "{\"ok\":true,\"lines\":" + intArrayJson(breakpointLines) + "}");
                break;
            case "snapshot":
                reply(id, "{\"ok\":true,\"snapshot\":" + snapshotJson() + ",\"instructions\":" + instructionsJson() + ",\"symbols\":" + symbolsJson() + "}");
                break;
            case "memory":
                int address;
                try { address = Integer.decode(arg); } catch (NumberFormatException e) { address = Memory.dataBaseAddress; }
                reply(id, "{\"ok\":true,\"memory\":" + memoryJson(address) + "}");
                break;
            default:
                replyError(id, "Unknown MARS bridge command: " + command);
        }
    }

    private static String assemble(String text, boolean warningsAreErrors) throws Exception {
        requestStop();
        synchronized (MACHINE_LOCK) {
            waitForIdle();
            source = text;
            INPUT.clear();
            resetMachine();
            breakpointAddresses.clear();
            statementsByAddress.clear();
            if (!sourcePath.isEmpty()) try { Files.deleteIfExists(new File(sourcePath).toPath()); } catch (Exception ignored) { }
            File file = Files.createTempFile("remars-", ".asm").toFile();
            sourcePath = file.getAbsolutePath();
            Files.write(file.toPath(), text.getBytes(StandardCharsets.UTF_8));
            MIPSprogram next = new MIPSprogram();
            try {
                next.readSource(sourcePath);
                next.tokenize();
                ArrayList<String> filenames = new ArrayList<String>();
                filenames.add(sourcePath);
                ArrayList prepared = next.prepareFilesForAssembly(filenames, sourcePath, null);
                Globals.getSettings().setBooleanSettingNonPersistent(Settings.EXTENDED_ASSEMBLER_ENABLED, true);
                Globals.getSettings().setDelayedBranchingEnabledNonPersistent(delayedBranching);
                Globals.getSettings().setBooleanSettingNonPersistent(Settings.START_AT_MAIN, startAtMain);
                ErrorList warnings = next.assemble(prepared, true, warningsAreErrors);
                String report = warnings == null ? "" : warnings.generateWarningReport();
                if (warnings != null && warnings.warningsOccurred()) emit("console", "[MARS] " + report);
                RegisterFile.initializeProgramCounter(startAtMain);
                Globals.program = next;
                program = next;
                lastAssemblyError = "";
                for (Object item : next.getMachineList()) {
                    if (item instanceof ProgramStatement) {
                        ProgramStatement statement = (ProgramStatement) item;
                        statementsByAddress.put(statement.getAddress(), statement);
                    }
                }
                refreshBreakpointAddresses();
                state = "paused";
                executedSteps = 0;
                bypassBreakpointOnce = -1;
                SystemIO.resetFiles();
                return report.isEmpty() ? "Assembled successfully" : report;
            } catch (ProcessingException error) {
                lastAssemblyError = error.errors().generateErrorAndWarningReport();
                state = "error";
                program = null;
                emit("error", lastAssemblyError);
                return lastAssemblyError;
            }
        }
    }

    private static void startExecution(final String mode, final int limit) {
        if (program == null || running) return;
        pauseRequested = false;
        stopRequested = false;
        INPUT.resume();
        running = true;
        state = "running";
        emitSnapshot();
        Thread worker = new Thread(new Runnable() {
            public void run() {
                int localSteps = 0;
                long lastUpdate = 0;
                try {
                    while (!stopRequested) {
                        if (pauseRequested) { state = "paused"; break; }
                        int pc = RegisterFile.getProgramCounter();
                        if (!"stepping".equals(mode) && breakpointAddresses.contains(pc) && pc != bypassBreakpointOnce) {
                            state = "paused";
                            bypassBreakpointOnce = pc;
                            emit("breakpoint", "Breakpoint at " + hex(pc));
                            break;
                        }
                        if (pc == bypassBreakpointOnce) bypassBreakpointOnce = -1;
                        if (limit > 0 && localSteps >= limit) {
                            state = "stopped";
                            emit("console", "[MARS] Instruction limit reached (" + limit + ")");
                            break;
                        }
                        boolean done;
                        synchronized (MACHINE_LOCK) {
                            done = program.simulateStepAtPC(null);
                        }
                        localSteps++;
                        executedSteps++;
                        if (done) { state = "finished"; break; }
                        if (mode.equals("stepping")) { state = "paused"; break; }
                        if (stopRequested) { state = "stopped"; break; }
                        long now = System.currentTimeMillis();
                        if (now - lastUpdate >= 30) {
                            emitSnapshot();
                            lastUpdate = now;
                        }
                        if (speedDelayMs > 0) Thread.sleep(speedDelayMs);
                    }
                } catch (Throwable error) {
                    state = "error";
                    String message = error instanceof ProcessingException
                        ? ((ProcessingException) error).errors().generateErrorAndWarningReport()
                        : error.toString();
                    emit("error", message);
                } finally {
                    if (stopRequested) state = "stopped";
                    running = false;
                    INPUT.resume();
                    SystemIO.resetFiles();
                    emitSnapshot();
                }
            }
        }, "reMARS-simulator");
        worker.setDaemon(true);
        worker.start();
    }

    private static void requestStop() {
        stopRequested = true;
        pauseRequested = false;
        INPUT.abortWait();
    }

    private static void waitForIdle() {
        long deadline = System.currentTimeMillis() + 3_000L;
        while (running && System.currentTimeMillis() < deadline) {
            try { Thread.sleep(5L); } catch (InterruptedException e) { Thread.currentThread().interrupt(); break; }
        }
    }

    private static void resetMachine() {
        if (Globals.memory != null) Globals.memory.clear();
        RegisterFile.resetRegisters();
        Coprocessor0.resetRegisters();
        Coprocessor1.resetRegisters();
        try {
            java.lang.reflect.Method clear = DelayedBranch.class.getDeclaredMethod("clear");
            clear.setAccessible(true);
            clear.invoke(null);
        } catch (Exception ignored) { }
        executedSteps = 0;
        SystemIO.resetFiles();
    }

    private static void setBreakpoints(String csv) {
        breakpointLines.clear();
        if (!csv.trim().isEmpty()) {
            for (String value : csv.split(",")) {
                try { breakpointLines.add(Integer.valueOf(value.trim())); } catch (NumberFormatException ignored) { }
            }
        }
        refreshBreakpointAddresses();
    }

    private static void refreshBreakpointAddresses() {
        breakpointAddresses.clear();
        synchronized (statementsByAddress) {
            for (Map.Entry<Integer, ProgramStatement> entry : statementsByAddress.entrySet()) {
                if (breakpointLines.contains(entry.getValue().getSourceLine())) breakpointAddresses.add(entry.getKey());
            }
        }
    }

    private static String snapshotJson() {
        int pc = RegisterFile.getProgramCounter();
        ProgramStatement statement = statementsByAddress.get(pc);
        String currentInstruction = statement == null ? "" : statement.getPrintableBasicAssemblyStatement();
        int currentLine = statement == null ? 0 : statement.getSourceLine();
        StringBuilder out = new StringBuilder("{\"state\":").append(json(state))
            .append(",\"pc\":").append(json(hex(pc))).append(",\"pcValue\":").append(pc)
            .append(",\"currentLine\":").append(currentLine)
            .append(",\"instruction\":").append(json(currentInstruction))
            .append(",\"steps\":").append(executedSteps)
            .append(",\"registers\":[");
        Register[] regs = RegisterFile.getRegisters();
        for (int i = 0; i < regs.length; i++) {
            if (i > 0) out.append(',');
            registerJson(out, regs[i]);
        }
        out.append("],\"pcRegister\":");
        registerJson(out, RegisterFile.getProgramCounterRegister());
        out.append(",\"fRegisters\":[");
        Register[] fregs = Coprocessor1.getRegisters();
        for (int i = 0; i < fregs.length; i++) { if (i > 0) out.append(','); registerJson(out, fregs[i]); }
        out.append("],\"coprocessor0\":[");
        Register[] cp0 = Coprocessor0.getRegisters();
        for (int i = 0; i < cp0.length; i++) { if (i > 0) out.append(','); registerJson(out, cp0[i]); }
        out.append("],\"memory\":").append(memoryJson(Memory.dataBaseAddress)).append('}');
        return out.toString();
    }

    private static String memoryJson(int base) {
        base = Memory.alignToWordBoundary(base);
        StringBuilder out = new StringBuilder("{\"base\":").append(json(hex(base))).append(",\"words\":[");
        for (int i = 0; i < 32; i++) {
            if (i > 0) out.append(',');
            try {
                Integer word = Globals.memory.getRawWordOrNull(base + i * 4);
                out.append(json(hex(word == null ? 0 : word.intValue())));
            } catch (Exception e) { out.append(json("00000000")); }
        }
        return out.append("]}").toString();
    }

    private static void registerJson(StringBuilder out, Register register) {
        int value = register.getValueNoNotify();
        out.append("{\"name\":").append(json(register.getName()))
            .append(",\"value\":").append(value)
            .append(",\"hex\":").append(json(hex(value)))
            .append(",\"decimal\":").append(json(Integer.toString(value))).append('}');
    }

    private static String instructionsJson() {
        StringBuilder out = new StringBuilder("[");
        boolean first = true;
        synchronized (statementsByAddress) {
            for (ProgramStatement item : statementsByAddress.values()) {
                if (!first) out.append(',');
                first = false;
                out.append("{\"address\":").append(json(hex(item.getAddress())))
                    .append(",\"line\":").append(item.getSourceLine())
                    .append(",\"machine\":").append(json(item.getMachineStatement()))
                    .append(",\"basic\":").append(json(item.getPrintableBasicAssemblyStatement()))
                    .append(",\"source\":").append(json(item.getSource())).append('}');
            }
        }
        return out.append(']').toString();
    }

    private static String symbolsJson() {
        if (program == null || program.getLocalSymbolTable() == null) return "[]";
        StringBuilder out = new StringBuilder("[");
        boolean first = true;
        for (Object item : program.getLocalSymbolTable().getAllSymbols()) {
            if (!(item instanceof Symbol)) continue;
            Symbol symbol = (Symbol) item;
            if (!first) out.append(',');
            first = false;
            out.append("{\"name\":").append(json(symbol.getName()))
                .append(",\"address\":").append(json(hex(symbol.getAddress())))
                .append(",\"segment\":").append(json(symbol.getType() ? "text" : "data")).append('}');
        }
        return out.append(']').toString();
    }

    private static void emitSnapshot() { emitRaw("{\"event\":\"snapshot\",\"snapshot\":" + snapshotJson() + ",\"instructions\":" + instructionsJson() + ",\"symbols\":" + symbolsJson() + "}"); }
    private static void emit(String event, String text) { emitRaw("{\"event\":" + json(event) + ",\"text\":" + json(text) + "}"); }
    private static void reply(String id, String body) { emitRaw("{\"id\":" + json(id) + "," + body.substring(1)); }
    private static void replyError(String id, String text) { reply(id, "{\"ok\":false,\"message\":" + json(text) + "}"); }
    private static synchronized void emitRaw(String json) { PROTOCOL.println(json); PROTOCOL.flush(); }

    private static String intArrayJson(Set<Integer> values) {
        StringBuilder out = new StringBuilder("[");
        boolean first = true;
        for (Integer value : values) { if (!first) out.append(','); first = false; out.append(value.intValue()); }
        return out.append(']').toString();
    }

    private static int parseInt(String[] fields, int index, int fallback) {
        try { return Integer.parseInt(fields[index]); } catch (Exception e) { return fallback; }
    }
    private static String idFrom(String line) { String[] fields = line.split("\\t", 2); return fields.length == 0 ? "0" : fields[0]; }
    private static String decode(String value) {
        if (value == null || value.isEmpty()) return "";
        return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
    }
    private static Map<String, String> parseOptions(String text) {
        Map<String, String> result = new HashMap<String, String>();
        for (String item : text.split(";")) {
            int split = item.indexOf('=');
            if (split > 0) result.put(item.substring(0, split), item.substring(split + 1));
        }
        return result;
    }
    private static String hex(int value) { return String.format("%08X", value); }
    private static String json(String value) {
        if (value == null) return "null";
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default: if (c < 32) out.append(String.format("\\u%04x", (int) c)); else out.append(c);
            }
        }
        return out.append('"').toString();
    }

    private static final class MipsOutput extends OutputStream {
        private final ByteArrayOutputStream pending = new ByteArrayOutputStream();
        @Override public synchronized void write(int value) {
            if (value == '\n') flushLine(); else pending.write(value);
        }
        @Override public synchronized void write(byte[] bytes, int offset, int length) {
            for (int i = offset; i < offset + length; i++) write(bytes[i] & 0xff);
        }
        @Override public synchronized void flush() { if (pending.size() > 0) flushPending(false); }
        private void flushLine() { flushPending(true); }
        private void flushPending(boolean newline) {
            String value = new String(pending.toByteArray(), StandardCharsets.UTF_8);
            pending.reset();
            emit("output", value + (newline ? "\n" : ""));
        }
    }

    private static final class InputQueue extends InputStream {
        private final LinkedBlockingQueue<Integer> bytes = new LinkedBlockingQueue<Integer>();
        private volatile boolean waiting;
        @Override public int read() {
            try {
                Integer value = bytes.poll();
                if (value != null) return value.intValue();
                if (!waiting) { waiting = true; emitRaw("{\"event\":\"input\",\"waiting\":true}"); }
                return bytes.take().intValue();
            } catch (InterruptedException e) { Thread.currentThread().interrupt(); return '\n'; }
        }
        @Override public int read(byte[] target, int offset, int length) {
            if (length == 0) return 0;
            int first = read();
            target[offset] = (byte) first;
            int count = 1;
            while (count < length) {
                Integer value = bytes.poll();
                if (value == null) break;
                target[offset + count] = (byte) value.intValue();
                count++;
            }
            return count;
        }
        synchronized void feed(String text) {
            byte[] values = text.getBytes(StandardCharsets.UTF_8);
            for (byte value : values) bytes.offer(Integer.valueOf(value & 0xff));
            waiting = false;
        }
        synchronized void abortWait() { if (waiting) feed("\n"); }
        synchronized void clear() { bytes.clear(); waiting = false; }
        void resume() { waiting = false; }
    }
}
