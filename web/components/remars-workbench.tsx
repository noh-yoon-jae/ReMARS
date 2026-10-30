'use client'

import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowLeftToLine, ArrowRightToLine, BookOpen, ChevronDown, Cpu, FileCode2, FolderOpen, Keyboard, Pause, Play, Plus, Redo2, RotateCcw, Save, Search, Settings2, Square, Terminal, Undo2, X, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type SourceFile = { id: string; name: string; path?: string; source: string; savedSource: string }
type EditorHistoryEntry = { source: string; selectionStart: number; selectionEnd: number }
type EditorHistory = { undo: EditorHistoryEntry[]; redo: EditorHistoryEntry[]; lastInputType: string; lastEditAt: number }
type LogLine = { kind: 'message' | 'output' | 'error'; text: string }
type Snapshot = {
  state: string; pc: string; currentLine: number; instruction: string; steps: number
  registers: { name: string; value: number; hex: string; decimal: string }[]
  pcRegister: { name: string; value: number; hex: string; decimal: string }
  fRegisters: { name: string; value: number; hex: string; decimal: string }[]
  coprocessor0: { name: string; value: number; hex: string; decimal: string }[]
  memory: { base: string; words: string[] }
  breakpoints: number[]
}
type Instruction = { address: string; line: number; machine: string; basic: string; source: string }
type Symbol = { name: string; address: string; segment: string }

const examples: SourceFile[] = [
  {
    id: 'hello-world', name: 'hello-world.asm',
    source: `# Print a message with MARS syscall 4\n.data\nmessage: .asciiz "Hello from reMARS!\\n"\n\n.text\n.globl main\nmain:\n    li   $v0, 4\n    la   $a0, message\n    syscall\n\n    li   $v0, 10\n    syscall`, savedSource: '',
  },
  {
    id: 'loops', name: 'loops.asm',
    source: `# Sum the integers from 1 through 5\n.text\n.globl main\nmain:\n    li   $t0, 1          # counter\n    li   $t1, 5          # upper limit\n    li   $t2, 0          # sum\nloop:\n    addu $t2, $t2, $t0\n    addiu $t0, $t0, 1\n    ble  $t0, $t1, loop\n    move $a0, $t2\n    li   $v0, 1\n    syscall\n    li   $v0, 10\n    syscall`, savedSource: '',
  },
  {
    id: 'array-sum', name: 'array-sum.asm',
    source: `.data\nvalues: .word 3, 8, 2, 9, 4\nlength: .word 5\n\n.text\n.globl main\nmain:\n    la   $t0, values\n    lw   $t1, length\n    li   $t2, 0\n    li   $t3, 0\nloop:\n    beq  $t3, $t1, done\n    lw   $t4, 0($t0)\n    addu $t2, $t2, $t4\n    addiu $t0, $t0, 4\n    addiu $t3, $t3, 1\n    j    loop\ndone:\n    move $a0, $t2\n    li   $v0, 1\n    syscall\n    li   $v0, 10\n    syscall`, savedSource: '',
  },
  {
    id: 'stack-demo', name: 'stack-demo.asm',
    source: `# A small stack frame and function call\n.text\n.globl main\nmain:\n    addiu $sp, $sp, -8\n    sw    $ra, 4($sp)\n    li    $a0, 21\n    jal   double_value\n    lw    $ra, 4($sp)\n    addiu $sp, $sp, 8\n    move  $a0, $v0\n    li    $v0, 1\n    syscall\n    li    $v0, 10\n    syscall\ndouble_value:\n    sll   $v0, $a0, 1\n    jr    $ra`, savedSource: '',
  },
].map((file) => ({ ...file, savedSource: file.source }))

const defaultSettings = { startAtMain: true, delayedBranching: false, warningsAreErrors: false, maxSteps: 1000000, speed: 'normal', valueFormat: 'hex' as 'hex' | 'decimal' }
const speedDelays: Record<string, number> = { slow: 120, normal: 12, fast: 1, instant: 0 }
const emptySnapshot: Snapshot = {
  state: 'ready', pc: '0x00400000', currentLine: 0, instruction: '', steps: 0,
  registers: [], pcRegister: { name: 'pc', value: 0x00400000, hex: '00400000', decimal: '4194304' },
  fRegisters: [], coprocessor0: [], memory: { base: '10010000', words: Array(32).fill('00000000') }, breakpoints: [],
}

const settingOptions = (value: Record<string, unknown>) => ({
  startAtMain: value.startAtMain !== false,
  delayedBranching: value.delayedBranching === true,
  warningsAreErrors: value.warningsAreErrors === true,
})

export function RemarsWorkbench() {
  const [files, setFiles] = useState<SourceFile[]>(examples)
  const [activeId, setActiveId] = useState(examples[0].id)
  const [hydrated, setHydrated] = useState(false)
  const [settings, setSettings] = useState(defaultSettings)
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot)
  const [instructions, setInstructions] = useState<Instruction[]>([])
  const [symbols, setSymbols] = useState<Symbol[]>([])
  const [logs, setLogs] = useState<LogLine[]>([{ kind: 'message', text: 'Ready. Assemble a MIPS program to begin.' }])
  const [engineReady, setEngineReady] = useState(false)
  const [engineError, setEngineError] = useState('')
  const [waitingForInput, setWaitingForInput] = useState(false)
  const [stdin, setStdin] = useState('')
  const [inputError, setInputError] = useState('')
  const [rightTab, setRightTab] = useState<'registers' | 'cp1' | 'cp0' | 'memory' | 'text' | 'labels'>('registers')
  const [consoleTab, setConsoleTab] = useState<'messages' | 'console'>('messages')
  const [registerSearch, setRegisterSearch] = useState('')
  const [memoryAddress, setMemoryAddress] = useState('0x10010000')
  const [mobilePanel, setMobilePanel] = useState<'files' | 'debugger' | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null)
  const [assembledTarget, setAssembledTarget] = useState<{ id: string; source: string } | null>(null)
  const [, setHistoryVersion] = useState(0)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const editorHistory = useRef<Record<string, EditorHistory>>({})

  const activeFile = files.find((file) => file.id === activeId) ?? files[0]
  const pendingCloseFile = files.find((file) => file.id === pendingCloseId)
  const source = activeFile?.source ?? ''
  const sourceLines = useMemo(() => source.split('\n'), [source])
  const dirty = activeFile?.source !== activeFile?.savedSource
  const activeHistory = editorHistory.current[activeId]
  const canUndo = Boolean(activeHistory?.undo.length)
  const canRedo = Boolean(activeHistory?.redo.length)
  const breakpointLines = snapshot.breakpoints ?? []
  const runState = snapshot.state

  const notify = (message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2400)
  }
  const log = (kind: LogLine['kind'], text: string) => setLogs((items) => [...items.slice(-499), { kind, text }])
  const appendOutput = (chunk: string) => {
    if (!chunk) return
    setLogs((items) => {
      const last = items[items.length - 1]
      if (last?.kind === 'output') {
        return [...items.slice(0, -1), { ...last, text: (last.text + chunk).slice(-200_000) }]
      }
      return [...items.slice(-499), { kind: 'output', text: chunk.slice(-200_000) }]
    })
  }

  useEffect(() => {
    try {
      const savedFiles = localStorage.getItem('remars.files.v1')
      const savedActive = localStorage.getItem('remars.active.v1')
      const savedSettings = localStorage.getItem('remars.settings.v1')
      if (savedFiles) {
        const parsed = JSON.parse(savedFiles) as SourceFile[]
        if (Array.isArray(parsed) && parsed.length && parsed.every((file) => typeof file.id === 'string' && typeof file.source === 'string')) setFiles(parsed)
      }
      if (savedActive) setActiveId(savedActive)
      if (savedSettings) setSettings({ ...defaultSettings, ...JSON.parse(savedSettings) })
    } catch { /* Keep the built-in starter workspace when stored settings are invalid. */ }
    setHydrated(true)
  }, [])

  useEffect(() => {
    if (!hydrated) return
    localStorage.setItem('remars.files.v1', JSON.stringify(files))
    localStorage.setItem('remars.active.v1', activeId)
    localStorage.setItem('remars.settings.v1', JSON.stringify(settings))
  }, [hydrated, files, activeId, settings])

  useEffect(() => {
    if (!window.remars) {
      setEngineError('Open reMARS as the desktop app to connect the MARS engine.')
      return
    }
    const unsubscribe = window.remars.onEvent((event) => {
      if (event.event === 'engine-ready') { setEngineReady(true); setEngineError(''); return }
      if (event.event === 'engine-error') { setEngineReady(false); setEngineError(event.text || 'MARS engine failed.'); return }
      if (event.event === 'engine-log') { log('message', String(event.text || '').trim()); return }
      if (event.event === 'snapshot' && event.snapshot) {
        setSnapshot(event.snapshot as Snapshot)
        if (Array.isArray(event.instructions)) setInstructions(event.instructions)
        if (Array.isArray(event.symbols)) setSymbols(event.symbols)
        setWaitingForInput(false)
        setInputError('')
        return
      }
      if (event.event === 'output') { appendOutput(String(event.text || '')); return }
      if (event.event === 'input') { setWaitingForInput(Boolean(event.waiting)); return }
      if (event.event === 'breakpoint') { log('message', String(event.text || 'Breakpoint hit.')); return }
      if (event.event === 'error') { log('error', String(event.text || 'MARS runtime error')); return }
      if (event.event === 'console') log('message', String(event.text || ''))
    })
    void window.remars.command('snapshot').then((result) => {
      if (result?.ok) { setEngineReady(true); setEngineError('') }
      if (result?.ok && result.snapshot) setSnapshot(result.snapshot as Snapshot)
      if (Array.isArray(result?.instructions)) setInstructions(result.instructions)
      if (Array.isArray(result?.symbols)) setSymbols(result.symbols)
    }).catch((error) => setEngineError(error instanceof Error ? error.message : 'MARS engine unavailable.'))
    return unsubscribe
  }, [])

  const command = async (action: string, payload: Record<string, unknown> = {}) => {
    if (!window.remars) { notify('MARS 엔진을 사용하려면 데스크톱 앱을 여세요'); return null }
    try {
      const result = await window.remars.command(action, payload)
      if (!result?.ok) {
        if (result?.message) { log('error', result.message); notify('MARS에서 오류가 발생했습니다') }
        return result
      }
      if (result.snapshot) setSnapshot(result.snapshot as Snapshot)
      if (Array.isArray(result.instructions)) setInstructions(result.instructions)
      if (Array.isArray(result.symbols)) setSymbols(result.symbols)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MARS 엔진 오류'
      log('error', message)
      notify(message)
      return null
    }
  }

  const assemble = async () => {
    log('message', `[assemble] ${activeFile.name}`)
    const result = await command('assemble', { code: source, settings: settingOptions(settings) })
    if (result?.ok) { setAssembledTarget({ id: activeId, source }); log('message', result.message || '[MARS] Assemble complete'); notify('어셈블 완료') }
    return result
  }
  const run = async () => {
    if (dirty || !instructions.length || assembledTarget?.id !== activeId || assembledTarget?.source !== source) {
      const result = await assemble()
      if (!result?.ok) return
    }
    setConsoleTab('console')
    log('message', '[run] Program started')
    await command('run', { code: source, maxSteps: settings.maxSteps, delayMs: speedDelays[settings.speed] ?? 0, breakpoints: breakpointLines })
  }
  const step = async () => {
    setConsoleTab('messages')
    const result = await command('step', { code: source, settings: settingOptions(settings), breakpoints: breakpointLines })
    if (result?.ok) setAssembledTarget({ id: activeId, source })
  }
  const backstep = async () => { await command('backstep') }
  const pause = async () => { await command('pause') }
  const stop = async () => { await command('stop') }
  const reset = async () => { setWaitingForInput(false); setStdin(''); setLogs([{ kind: 'message', text: 'Machine reset. Ready to assemble.' }]); await command('reset') }

  const recordEditorChange = (fileId: string, previous: string, next: string, caretStart: number, caretEnd: number, inputType: string) => {
    if (previous === next) return
    const history = editorHistory.current[fileId] ?? (editorHistory.current[fileId] = { undo: [], redo: [], lastInputType: '', lastEditAt: 0 })
    const now = Date.now()
    const coalescible = inputType === 'insertText' || inputType === 'deleteContentBackward' || inputType === 'deleteContentForward'
    const coalesce = coalescible && history.lastInputType === inputType && now - history.lastEditAt < 750
    const delta = next.length - previous.length
    let previousStart = caretStart
    let previousEnd = caretEnd
    if (inputType.startsWith('insert')) previousStart = previousEnd = Math.max(0, caretStart - Math.max(0, delta))
    else if (inputType === 'deleteContentBackward') previousStart = previousEnd = caretStart + Math.abs(Math.min(0, delta))
    if (!coalesce) history.undo.push({ source: previous, selectionStart: previousStart, selectionEnd: previousEnd })
    if (history.undo.length > 200) history.undo.splice(0, history.undo.length - 200)
    history.redo = []
    history.lastInputType = inputType
    history.lastEditAt = now
    setHistoryVersion((version) => version + 1)
  }

  const restoreEditorEntry = (entry: EditorHistoryEntry) => {
    setFiles((items) => items.map((file) => file.id === activeId ? { ...file, source: entry.source } : file))
    const beforeCaret = entry.source.slice(0, entry.selectionStart).split('\n')
    setCursor({ line: beforeCaret.length, column: beforeCaret[beforeCaret.length - 1].length + 1 })
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (editor) editor.setSelectionRange(entry.selectionStart, entry.selectionEnd)
    })
  }

  const undo = () => {
    const history = editorHistory.current[activeId]
    const entry = history?.undo.pop()
    if (!history || !entry) return
    history.redo.push({ source, selectionStart: editorRef.current?.selectionStart ?? source.length, selectionEnd: editorRef.current?.selectionEnd ?? source.length })
    history.lastInputType = ''
    restoreEditorEntry(entry)
    setHistoryVersion((version) => version + 1)
  }

  const redo = () => {
    const history = editorHistory.current[activeId]
    const entry = history?.redo.pop()
    if (!history || !entry) return
    history.undo.push({ source, selectionStart: editorRef.current?.selectionStart ?? source.length, selectionEnd: editorRef.current?.selectionEnd ?? source.length })
    history.lastInputType = ''
    restoreEditorEntry(entry)
    setHistoryVersion((version) => version + 1)
  }

  const saveFile = async (fileId: string, forceSaveAs = false): Promise<boolean> => {
    const file = files.find((item) => item.id === fileId)
    if (!file || !window.remars) { notify('파일 저장은 데스크톱 앱에서 사용할 수 있습니다'); return false }
    const contentAtSave = file.source
    try {
      const result = await window.remars.saveFile({ path: forceSaveAs ? undefined : file.path, name: file.name, contents: contentAtSave })
      if (!result) return false
      setFiles((items) => items.map((item) => item.id === fileId ? { ...item, path: result.path, name: result.name, savedSource: contentAtSave } : item))
      notify('파일 저장 완료')
      return true
    } catch (error) { notify(error instanceof Error ? error.message : '파일 저장 실패'); return false }
  }

  const save = () => activeFile ? saveFile(activeFile.id) : Promise.resolve(false)
  const saveAs = () => activeFile ? saveFile(activeFile.id, true) : Promise.resolve(false)
  const activateFile = (fileId: string) => {
    const history = editorHistory.current[fileId]
    if (history) { history.lastInputType = ''; history.lastEditAt = 0 }
    setActiveId(fileId)
  }

  const open = async () => {
    if (!window.remars) { notify('파일 열기는 데스크톱 앱에서 사용할 수 있습니다'); return }
    try {
      const result = await window.remars.openFile()
      if (!result) return
      const existing = files.find((file) => file.path?.toLowerCase() === result.path.toLowerCase())
      if (existing) { activateFile(existing.id); return }
      const newFile = { id: crypto.randomUUID(), name: result.name, path: result.path, source: result.contents, savedSource: result.contents }
      editorHistory.current[newFile.id] = { undo: [], redo: [], lastInputType: '', lastEditAt: 0 }
      setFiles((items) => [...items, newFile])
      setActiveId(newFile.id)
    } catch (error) { notify(error instanceof Error ? error.message : '파일 열기 실패') }
  }

  const createFile = () => {
    const number = files.filter((file) => file.name.startsWith('untitled')).length + 1
    const name = `untitled-${number}.asm`
    const created = { id: crypto.randomUUID(), name, source: '', savedSource: '' }
    editorHistory.current[created.id] = { undo: [], redo: [], lastInputType: '', lastEditAt: 0 }
    setFiles((items) => [...items, created])
    setActiveId(created.id)
  }

  const finalizeClose = (fileId: string) => {
    const index = files.findIndex((file) => file.id === fileId)
    if (index < 0) { setPendingCloseId(null); return }
    const remaining = files.filter((file) => file.id !== fileId)
    delete editorHistory.current[fileId]
    setPendingCloseId(null)
    if (activeId !== fileId) { setFiles(remaining); setHistoryVersion((version) => version + 1); return }
    setWaitingForInput(false)
    setStdin('')
    setSnapshot((old) => ({ ...old, state: 'ready', currentLine: 0, instruction: '', steps: 0, breakpoints: [] }))
    void (async () => {
      if (runState === 'running') await stop()
      await command('breakpoints', { lines: [] })
      await command('reset')
    })()
    if (!remaining.length) {
      const replacement = { id: crypto.randomUUID(), name: 'untitled.asm', source: '', savedSource: '' }
      editorHistory.current[replacement.id] = { undo: [], redo: [], lastInputType: '', lastEditAt: 0 }
      remaining.push(replacement)
    }
    setFiles(remaining)
    activateFile(remaining[Math.min(index, remaining.length - 1)].id)
    setAssembledTarget(null)
    setInstructions([])
    setSymbols([])
    setHistoryVersion((version) => version + 1)
  }

  const closeFile = (fileId: string) => {
    const file = files.find((item) => item.id === fileId)
    if (!file) return
    if (file.source !== file.savedSource) { setPendingCloseId(fileId); return }
    finalizeClose(fileId)
  }

  const resolvePendingClose = async (choice: 'save' | 'discard' | 'cancel') => {
    const fileId = pendingCloseId
    if (!fileId) return
    if (choice === 'cancel') { setPendingCloseId(null); return }
    if (choice === 'save' && !(await saveFile(fileId))) return
    finalizeClose(fileId)
  }

  const submitInput = async (event: FormEvent) => {
    event.preventDefault()
    const result = await command('input', { text: stdin })
    if (result?.ok) { setStdin(''); setWaitingForInput(false); setInputError('') }
  }

  const toggleBreakpoint = async (line: number) => {
    const next = breakpointLines.includes(line) ? breakpointLines.filter((value) => value !== line) : [...breakpointLines, line]
    setSnapshot((old) => ({ ...old, breakpoints: next }))
    await command('breakpoints', { lines: next })
  }

  const loadMemory = async () => {
    const result = await command('memory', { address: memoryAddress })
    if (result?.memory) setSnapshot((old) => ({ ...old, memory: result.memory }))
  }

  const updateSetting = <K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) => setSettings((old) => ({ ...old, [key]: value }))

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (modifier && key === 's') { event.preventDefault(); void (event.shiftKey ? saveAs() : save()); return }
      if (modifier && key === 'o') { event.preventDefault(); void open(); return }
      if (modifier && key === 'n') { event.preventDefault(); createFile(); return }
      if (modifier && key === 'w') { event.preventDefault(); closeFile(activeId); return }
      if (event.key === 'F3') { event.preventDefault(); void assemble() }
      if (event.key === 'F5' && !event.shiftKey) { event.preventDefault(); void run() }
      if (event.key === 'F7') { event.preventDefault(); void step() }
      if (event.key === 'F8') { event.preventDefault(); void backstep() }
      if (event.key === 'F5' && event.shiftKey) { event.preventDefault(); void stop() }
      if (event.key === 'Escape') { setSettingsOpen(false); setHelpOpen(false); setPendingCloseId(null); setMobilePanel(null) }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const formatValue = (value: { value: number; hex: string; decimal: string }) => settings.valueFormat === 'hex' ? `0x${value.hex}` : value.decimal
  const rightTabs = [
    ['registers', 'Registers'], ['cp1', 'Coprocessor 1'], ['cp0', 'Coprocessor 0'], ['memory', 'Memory'], ['text', 'Text'], ['labels', 'Labels'],
  ] as const
  const filteredRegisters = snapshot.registers.filter((register) => register.name.toLowerCase().includes(registerSearch.toLowerCase()))

  const renderRegisters = (items: Snapshot['registers']) => <div className="space-y-1 p-3">
    <div className="grid grid-cols-[1fr_1.5fr_1fr] px-2 pb-1 text-[9px] uppercase tracking-wider text-slate-600"><span>Register</span><span className="text-right">Value</span><span className="text-right">Decimal</span></div>
    {items.map((register) => <div key={register.name} className={cn('grid grid-cols-[1fr_1.5fr_1fr] rounded px-2 py-1.5 font-mono text-[10px] hover:bg-white/[0.04]', register.name === '$v0' && 'bg-cyan-400/[0.07]')}><span className="text-cyan-300">{register.name}</span><span className="text-right text-slate-300">{formatValue(register)}</span><span className="text-right text-slate-500">{register.decimal}</span></div>)}
    {!items.length && <p className="p-2 text-xs text-slate-600">Assemble a program to load machine registers.</p>}
  </div>

  const filesPanel = <aside className={cn('flex w-[228px] shrink-0 flex-col border-r border-white/8 bg-[#121821]', mobilePanel && mobilePanel !== 'files' ? 'hidden' : 'flex')}>
    <div className="flex h-12 items-center justify-between border-b border-white/8 px-4"><span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Explorer</span><div className="flex"><Button variant="ghost" size="icon" className="size-7 text-slate-500" onClick={open} aria-label="Open file"><FolderOpen /></Button><Button variant="ghost" size="icon" className="size-7 text-slate-500" onClick={createFile} aria-label="New file"><Plus /></Button></div></div>
    <button className="flex items-center gap-2 px-4 py-3 text-left text-xs font-semibold text-slate-300"><ChevronDown className="size-3 text-slate-500" />Workspace <Badge variant="outline" className="ml-auto border-white/10 text-[9px] text-slate-500">{files.length}</Badge></button>
    <div className="flex flex-col gap-0.5 px-2">{files.map((file) => <button key={file.id} onClick={() => { activateFile(file.id); setMobilePanel(null) }} className={cn('flex items-center gap-2 rounded px-2 py-2 text-left text-[11px]', activeId === file.id ? 'bg-cyan-400/10 text-cyan-200' : 'text-slate-400 hover:bg-white/[0.04]')}><FileCode2 className="size-3.5 shrink-0 text-cyan-400" /><span className="truncate">{file.name}</span>{file.source !== file.savedSource && <i className="ml-auto size-1.5 rounded-full bg-amber-300" />}</button>)}</div>
    <div className="mt-auto border-t border-white/8 p-4 text-[10px] text-slate-600"><p className="mb-2 flex items-center gap-2 text-slate-400"><Cpu className="size-3.5 text-cyan-400" />MARS 4.5 · MIPS32</p><p>{files.length} source files</p></div>
  </aside>

  const debuggerPanel = <aside className={cn('flex w-[360px] shrink-0 flex-col border-l border-white/8 bg-[#121821]', mobilePanel && mobilePanel !== 'debugger' ? 'hidden' : 'flex')}>
    <div className="flex h-12 items-center border-b border-white/8 px-4"><span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Machine</span><Badge variant="outline" className={cn('ml-auto border-white/10 text-[10px]', runState === 'running' ? 'text-emerald-300' : runState === 'error' ? 'text-rose-300' : 'text-slate-400')}>{runState}</Badge></div>
    <div className="flex overflow-x-auto border-b border-white/8 px-2">{rightTabs.map(([id, label]) => <button key={id} onClick={() => setRightTab(id)} className={cn('shrink-0 border-b-2 px-2.5 py-3 text-[10px]', rightTab === id ? 'border-cyan-400 text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-300')}>{label}</button>)}</div>
    <div className="min-h-0 flex-1 overflow-auto">
      {rightTab === 'registers' && <><div className="flex items-center gap-2 p-3"><Search className="size-3.5 text-slate-600" /><Input value={registerSearch} onChange={(event) => setRegisterSearch(event.target.value)} placeholder="Filter registers" className="h-7 border-white/8 bg-white/[0.025] text-[10px]" /><button onClick={() => updateSetting('valueFormat', settings.valueFormat === 'hex' ? 'decimal' : 'hex')} className="rounded border border-white/10 px-2 py-1 text-[9px] text-slate-400">{settings.valueFormat.toUpperCase()}</button></div>{renderRegisters(filteredRegisters)}<div className="border-t border-white/8 px-4 py-3 text-[10px] text-slate-500">PC <span className="float-right font-mono text-cyan-300">0x{snapshot.pc}</span><p className="mt-2 truncate">{snapshot.instruction || 'No instruction selected'}</p><p className="mt-1">Executed <span className="font-mono text-slate-300">{snapshot.steps}</span> instructions</p></div></>}
      {rightTab === 'cp1' && renderRegisters(snapshot.fRegisters)}
      {rightTab === 'cp0' && renderRegisters(snapshot.coprocessor0)}
      {rightTab === 'memory' && <div className="p-3"><div className="mb-3 flex gap-2"><Input value={memoryAddress} onChange={(event) => setMemoryAddress(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void loadMemory() }} className="h-8 font-mono text-[10px]" aria-label="Memory base address" /><Button size="sm" variant="outline" className="h-8 border-white/10 px-2 text-[10px]" onClick={loadMemory}>Go</Button></div><p className="mb-2 text-[10px] text-slate-500">Word memory · 0x{snapshot.memory.base.replace(/^0x/i, '')}</p><div className="grid grid-cols-[96px_1fr] gap-x-2 text-[10px] font-mono">{snapshot.memory.words.map((word, index) => <div key={index} className="contents"><span className="py-1 text-emerald-300">0x{(Number.parseInt(snapshot.memory.base.replace(/^0x/i, ''), 16) + index * 4).toString(16).padStart(8, '0').toUpperCase()}</span><span className="border-b border-white/[0.04] py-1 text-right text-slate-300">0x{word}</span></div>)}</div></div>}
      {rightTab === 'text' && <div className="p-2">{instructions.length ? <table className="w-full font-mono text-[9px]"><thead className="text-slate-600"><tr><th className="p-2 text-left">ADDR</th><th className="p-2 text-left">CODE</th><th className="p-2 text-left">BASIC</th></tr></thead><tbody>{instructions.map((item) => <tr key={item.address} className={cn('border-t border-white/[0.04]', snapshot.currentLine === item.line && 'bg-cyan-400/10')}><td className="p-2 text-emerald-300">{item.address}</td><td className="p-2 text-slate-500">{item.machine}</td><td className="p-2 text-slate-300">{item.basic}</td></tr>)}</tbody></table> : <p className="p-3 text-xs text-slate-600">Assemble to view translated instructions.</p>}</div>}
      {rightTab === 'labels' && <div className="p-3">{symbols.length ? <table className="w-full text-[10px]"><thead className="text-slate-600"><tr><th className="p-2 text-left">LABEL</th><th className="p-2 text-left">ADDRESS</th><th className="p-2 text-left">SEGMENT</th></tr></thead><tbody>{symbols.map((symbol) => <tr key={`${symbol.name}-${symbol.address}`} className="border-t border-white/[0.04]"><td className="p-2 text-amber-200">{symbol.name}</td><td className="p-2 font-mono text-emerald-300">{symbol.address}</td><td className="p-2 text-slate-400">{symbol.segment}</td></tr>)}</tbody></table> : <p className="text-xs text-slate-600">Labels appear after assembly.</p>}</div>}
    </div>
  </aside>

  return <div className="flex h-screen min-h-[650px] flex-col overflow-hidden bg-[#0b1017] font-mono text-slate-200">
    <header className="flex h-14 shrink-0 items-center border-b border-white/8 bg-[#10161f] px-4">
      <div className="flex items-center gap-3"><div className="flex size-8 items-center justify-center rounded-lg bg-cyan-400 text-sm font-black text-[#07131b]">rM</div><div><p className="text-sm font-bold tracking-tight text-white">reMARS</p><p className="text-[9px] uppercase tracking-[0.15em] text-slate-500">MIPS development environment</p></div></div>
      <div className="mx-5 hidden h-6 w-px bg-white/10 sm:block" /><div className="hidden items-center gap-2 text-xs text-slate-400 sm:flex"><FileCode2 className="size-4 text-cyan-400" />{activeFile?.name}<span className="text-slate-600">·</span><span className={dirty ? 'text-amber-300' : 'text-slate-500'}>{dirty ? 'unsaved' : 'saved'}</span></div>
      <div className="ml-auto flex items-center gap-1"><Button variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-white" onClick={open} aria-label="Open file" title="Open file (Ctrl+O)"><FolderOpen /></Button><Button variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-white" onClick={save} aria-label="Save file" title="Save (Ctrl+S); Save As (Ctrl+Shift+S)"><Save /></Button><Button variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-white disabled:opacity-30" onClick={undo} disabled={!canUndo} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 /></Button><Button variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-white disabled:opacity-30" onClick={redo} disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl+Y or Ctrl+Shift+Z)"><Redo2 /></Button><Button variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-white" onClick={() => setHelpOpen(true)} aria-label="Keyboard shortcuts"><Keyboard /></Button><Button variant="ghost" size="icon" className="size-8 text-slate-400 hover:text-white" onClick={() => setSettingsOpen(true)} aria-label="Settings"><Settings2 /></Button></div>
    </header>
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-white/8 bg-[#0e141c] px-3">
      <Button size="sm" className="h-7 gap-1.5 bg-cyan-400 px-3 text-[11px] font-bold text-[#07131b] hover:bg-cyan-300" onClick={assemble}><Zap className="size-3.5" />Assemble <kbd>F3</kbd></Button>
      <Button variant="outline" size="sm" className="h-7 gap-1.5 border-white/10 bg-transparent px-3 text-[11px] text-slate-300 hover:bg-white/5" onClick={run} disabled={!engineReady}><Play className="size-3" />Run <kbd>F5</kbd></Button>
      <Button variant="outline" size="sm" className="h-7 gap-1.5 border-white/10 bg-transparent px-3 text-[11px] text-slate-300 hover:bg-white/5" onClick={step}><ArrowRightToLine className="size-3.5" />Step <kbd>F7</kbd></Button>
      <Button variant="outline" size="sm" className="hidden h-7 gap-1.5 border-white/10 bg-transparent px-3 text-[11px] text-slate-300 hover:bg-white/5 sm:flex" onClick={backstep}><ArrowLeftToLine className="size-3.5" /><span className="sr-only">Backstep</span><kbd>F8</kbd></Button>
      <Button variant="outline" size="sm" className="hidden h-7 gap-1.5 border-white/10 bg-transparent px-3 text-[11px] text-slate-300 hover:bg-white/5 md:flex" onClick={pause} disabled={runState !== 'running' || waitingForInput} title={waitingForInput ? 'Send the requested input before pausing' : 'Pause after the current instruction'}><Pause className="size-3" />Pause</Button>
      <Button variant="outline" size="sm" className="hidden h-7 gap-1.5 border-white/10 bg-transparent px-3 text-[11px] text-slate-300 hover:bg-white/5 md:flex" onClick={stop} disabled={runState !== 'running'}><Square className="size-3" />Stop <kbd>⇧F5</kbd></Button>
      <Button variant="ghost" size="icon" className="size-7 text-slate-500 hover:text-slate-200" onClick={reset} title="Reset machine"><RotateCcw className="size-3.5" /></Button>
      <div className="ml-auto flex items-center gap-2"><label className="hidden items-center gap-1.5 text-[10px] text-slate-500 sm:flex">Speed <select value={settings.speed} onChange={(event) => updateSetting('speed', event.target.value)} className="h-7 rounded border border-white/10 bg-[#151d27] px-2 text-[10px] text-slate-300"><option value="slow">Slow</option><option value="normal">1×</option><option value="fast">Fast</option><option value="instant">Instant</option></select></label><span className="hidden h-5 w-px bg-white/10 sm:block"/><span className="flex items-center gap-1.5 text-[10px] text-slate-500"><i className={cn('size-1.5 rounded-full', engineReady ? 'bg-emerald-400' : 'bg-rose-400')} />{engineReady ? 'MARS 4.5' : 'Engine offline'}</span></div>
    </div>
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/8 bg-[#0c121a] px-3 lg:hidden"><Button variant="ghost" size="sm" className="h-7 gap-1 text-[10px] text-slate-400" onClick={() => setMobilePanel('files')}><FolderOpen className="size-3"/>Files</Button><Button variant="ghost" size="sm" className="h-7 gap-1 text-[10px] text-slate-400" onClick={() => setMobilePanel('debugger')}><Cpu className="size-3"/>Machine</Button></div>
    {engineError && <div className="flex shrink-0 items-center gap-2 border-b border-amber-400/15 bg-amber-400/[0.05] px-4 py-2 text-[10px] text-amber-200"><Activity className="size-3.5"/>{engineError}</div>}

    <main className="flex min-h-0 flex-1">
      <div className="hidden lg:flex">{filesPanel}</div>
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/8 bg-[#121821] px-3" role="tablist" aria-label="Open files">{files.map((file) => <div key={file.id} className={cn('group flex h-full max-w-[200px] shrink-0 items-center border-b-2', activeId === file.id ? 'border-cyan-400 text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-300')}><button role="tab" aria-selected={activeId === file.id} onClick={() => { activateFile(file.id); setMobilePanel(null) }} className="flex h-full min-w-0 items-center gap-2 pl-3 text-[10px]" title={file.path || file.name}><FileCode2 className="size-3 shrink-0 text-cyan-400"/><span className="truncate">{file.name}</span>{file.source !== file.savedSource && <i className="size-1.5 shrink-0 rounded-full bg-amber-300"/>}</button><button onClick={() => closeFile(file.id)} className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-slate-600 opacity-0 hover:bg-white/10 hover:text-slate-100 focus:opacity-100 group-hover:opacity-100" aria-label={`Close ${file.name}`} title={`Close ${file.name}`}><X className="size-3"/></button></div>)}<button onClick={createFile} className="px-2 text-slate-500 hover:text-white" aria-label="New file" title="New file (Ctrl+N)"><Plus className="size-3.5"/></button></div>
        <div className="flex min-h-0 flex-1 bg-[#0d131b]">
          <div className="w-12 shrink-0 select-none overflow-hidden border-r border-white/5 bg-[#10161f] py-3 text-right font-mono text-[11px] leading-[22px] text-slate-600">{sourceLines.map((_, index) => { const number = index + 1; return <button key={number} onClick={() => void toggleBreakpoint(number)} className={cn('block h-[22px] w-full pr-3', breakpointLines.includes(number) && 'bg-rose-400/10 text-rose-300', snapshot.currentLine === number && 'bg-cyan-400/10 text-cyan-300')} title={breakpointLines.includes(number) ? `Remove breakpoint at line ${number}` : `Set breakpoint at line ${number}`}>{breakpointLines.includes(number) ? '●' : number}</button> })}</div>
          <textarea ref={editorRef} value={source} onChange={(event) => { const value = event.target.value; const caret = event.target.selectionStart; const inputType = (event.nativeEvent as InputEvent).inputType || 'insertText'; recordEditorChange(activeId, source, value, caret, event.target.selectionEnd, inputType); const before = value.slice(0, caret).split('\n'); setCursor({ line: before.length, column: before[before.length - 1].length + 1 }); setFiles((items) => items.map((file) => file.id === activeId ? { ...file, source: value } : file)) }} onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => { const modifier = event.ctrlKey || event.metaKey; const key = event.key.toLowerCase(); if (modifier && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return } if (modifier && key === 'y') { event.preventDefault(); redo(); return } if (event.key === 'Tab') { event.preventDefault(); const target = event.currentTarget; const start = target.selectionStart; const end = target.selectionEnd; const next = source.slice(0, start) + '    ' + source.slice(end); recordEditorChange(activeId, source, next, start, start, 'tab'); setFiles((items) => items.map((file) => file.id === activeId ? { ...file, source: next } : file)); requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 4 }) } }} spellCheck={false} aria-label="MIPS assembly source editor" className="min-h-[300px] min-w-0 flex-1 resize-none bg-transparent p-3 font-mono text-[12px] leading-[22px] text-slate-300 outline-none selection:bg-cyan-500/25" />
        </div>
        <section className="flex h-[190px] shrink-0 flex-col border-t border-white/8 bg-[#10161f]">
          <div className="flex h-10 shrink-0 items-center gap-4 border-b border-white/8 px-4"><button onClick={() => setConsoleTab('messages')} className={cn('flex h-full items-center border-b-2 text-[10px] uppercase tracking-wider', consoleTab === 'messages' ? 'border-cyan-400 text-slate-200' : 'border-transparent text-slate-500')}>Messages</button><button onClick={() => setConsoleTab('console')} className={cn('flex h-full items-center border-b-2 text-[10px] uppercase tracking-wider', consoleTab === 'console' ? 'border-cyan-400 text-slate-200' : 'border-transparent text-slate-500')}><Terminal className="mr-1.5 size-3"/>Console</button><button onClick={() => setLogs([])} className="ml-auto text-[9px] text-slate-600 hover:text-slate-300">CLEAR</button></div>
          <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[10px] leading-5">{logs.filter((line) => consoleTab === 'console' ? line.kind === 'output' || line.kind === 'error' : line.kind !== 'output').map((line, index) => <p key={`${index}-${line.text}`} className={cn('whitespace-pre-wrap break-all', line.kind === 'output' ? 'text-slate-300' : line.kind === 'error' ? 'text-rose-300' : 'text-slate-500')}>{line.text}</p>)}{!logs.some((line) => consoleTab === 'console' ? line.kind === 'output' || line.kind === 'error' : line.kind !== 'output') && <p className="text-slate-600">{consoleTab === 'console' ? 'Program output appears here.' : 'Assembler and simulator messages appear here.'}</p>}</div>
          {waitingForInput && <form onSubmit={submitInput} className="flex shrink-0 items-center gap-2 border-t border-amber-400/15 bg-amber-400/[0.04] px-3 py-2"><span className="text-[10px] text-amber-200">Program input</span><Input autoFocus value={stdin} onChange={(event) => setStdin(event.target.value)} placeholder="Type input for the MIPS program" className="h-7 border-white/10 bg-black/20 text-[10px]"/><Button size="sm" className="h-7 bg-amber-300 px-3 text-[10px] font-bold text-slate-900 hover:bg-amber-200">Send</Button></form>}
        </section>
      </section>
      <div className="hidden lg:flex">{debuggerPanel}</div>
      {mobilePanel === 'files' && <div className="fixed inset-0 z-30 flex bg-black/70 lg:hidden">{filesPanel}<Button variant="ghost" size="icon" className="absolute right-3 top-3" onClick={() => setMobilePanel(null)} aria-label="Close files"><X/></Button></div>}
      {mobilePanel === 'debugger' && <div className="fixed inset-0 z-30 flex justify-end bg-black/70 lg:hidden">{debuggerPanel}<Button variant="ghost" size="icon" className="absolute right-[370px] top-3" onClick={() => setMobilePanel(null)} aria-label="Close machine panel"><X/></Button></div>}
    </main>

    <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-white/8 bg-[#141a22] px-3 text-[9px] text-slate-500"><span className="flex items-center gap-1.5"><i className={cn('size-1.5 rounded-full', runState === 'running' ? 'bg-emerald-400' : runState === 'error' ? 'bg-rose-400' : 'bg-slate-600')}/>{runState}</span><span>Line {snapshot.currentLine || cursor.line}, Col {cursor.column}</span><span>{source.length} chars</span><span className="ml-auto font-mono">PC 0x{snapshot.pc}</span><span>MIPS32</span></footer>
    {notice && <div role="status" className="fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded border border-cyan-400/20 bg-[#172431] px-4 py-2 text-[10px] text-cyan-100 shadow-xl">{notice}</div>}

    {settingsOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false) }}><section className="w-full max-w-lg rounded-xl border border-white/10 bg-[#121821] shadow-2xl"><div className="flex items-center border-b border-white/8 px-5 py-4"><Settings2 className="mr-2 size-4 text-cyan-300"/><h2 className="text-sm font-semibold">MARS settings</h2><button className="ml-auto text-slate-500" onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X className="size-4"/></button></div><div className="space-y-4 p-5 text-xs">
      <label className="flex items-center justify-between gap-4"><span><b className="font-medium text-slate-200">Start at main</b><p className="mt-1 text-[10px] text-slate-500">Begin simulation at the global main label when it exists.</p></span><input type="checkbox" checked={settings.startAtMain} onChange={(event) => updateSetting('startAtMain', event.target.checked)} /></label>
      <label className="flex items-center justify-between gap-4"><span><b className="font-medium text-slate-200">Delayed branching</b><p className="mt-1 text-[10px] text-slate-500">Execute the instruction after a branch before the jump.</p></span><input type="checkbox" checked={settings.delayedBranching} onChange={(event) => updateSetting('delayedBranching', event.target.checked)} /></label>
      <label className="flex items-center justify-between gap-4"><span><b className="font-medium text-slate-200">Warnings are errors</b><p className="mt-1 text-[10px] text-slate-500">Stop assembly when MARS emits a warning.</p></span><input type="checkbox" checked={settings.warningsAreErrors} onChange={(event) => updateSetting('warningsAreErrors', event.target.checked)} /></label>
      <label className="flex items-center justify-between gap-4"><span><b className="font-medium text-slate-200">Instruction limit</b><p className="mt-1 text-[10px] text-slate-500">Stops loops after this many executed instructions.</p></span><Input type="number" min={1} max={10000000} value={settings.maxSteps} onChange={(event) => updateSetting('maxSteps', Math.min(10000000, Math.max(1, Number(event.target.value) || 1)))} className="h-8 w-32 font-mono text-[10px]"/></label>
      <div className="flex justify-end pt-2"><Button size="sm" className="h-8 bg-cyan-400 px-4 text-[10px] font-bold text-slate-950 hover:bg-cyan-300" onClick={() => { setSettingsOpen(false); notify('설정 저장 완료') }}>Done</Button></div>
    </div></section></div>}
    {pendingCloseFile && <div role="presentation" className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setPendingCloseId(null) }}><section role="dialog" aria-modal="true" aria-labelledby="close-file-title" className="w-full max-w-md rounded-xl border border-white/10 bg-[#121821] shadow-2xl"><div className="flex items-center border-b border-white/8 px-5 py-4"><FileCode2 className="mr-2 size-4 text-cyan-300"/><h2 id="close-file-title" className="text-sm font-semibold">Save changes?</h2><button className="ml-auto text-slate-500" onClick={() => setPendingCloseId(null)} aria-label="Cancel close"><X className="size-4"/></button></div><div className="space-y-5 p-5"><p className="text-xs text-slate-300"><span className="font-semibold text-white">{pendingCloseFile.name}</span> has unsaved changes. Save them before closing?</p><div className="flex justify-end gap-2"><Button variant="outline" className="h-8 border-white/10 bg-transparent px-3 text-[10px] text-slate-300" onClick={() => void resolvePendingClose('cancel')}>Cancel</Button><Button variant="outline" className="h-8 border-white/10 bg-transparent px-3 text-[10px] text-slate-300" onClick={() => void resolvePendingClose('discard')}>Discard</Button><Button className="h-8 bg-cyan-400 px-3 text-[10px] font-bold text-slate-950 hover:bg-cyan-300" onClick={() => void resolvePendingClose('save')}>Save</Button></div></div></section></div>}
    {helpOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setHelpOpen(false) }}><section className="w-full max-w-md rounded-xl border border-white/10 bg-[#121821] shadow-2xl"><div className="flex items-center border-b border-white/8 px-5 py-4"><BookOpen className="mr-2 size-4 text-cyan-300"/><h2 className="text-sm font-semibold">Keyboard shortcuts</h2><button className="ml-auto text-slate-500" onClick={() => setHelpOpen(false)} aria-label="Close help"><X className="size-4"/></button></div><div className="space-y-3 p-5 text-[11px]">{[['Open file','Ctrl + O'],['New file','Ctrl + N'],['Save','Ctrl + S'],['Save As','Ctrl + Shift + S'],['Close tab','Ctrl + W'],['Undo','Ctrl + Z'],['Redo','Ctrl + Y / Ctrl + Shift + Z'],['Assemble','F3'],['Run / continue','F5'],['Step one instruction','F7'],['Backstep','F8'],['Stop','Shift + F5']].map(([name, key]) => <div key={key} className="flex justify-between text-slate-300"><span>{name}</span><kbd>{key}</kbd></div>)}</div></section></div>}
  </div>
}
