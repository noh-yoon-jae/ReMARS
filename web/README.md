# reMARS

reMARS is a Windows desktop shell for the Next.js MIPS IDE. The packaged app includes Electron, the MARS 4.5 JAR, and a trimmed Java runtime. Source is split between the frontend (`web`), Electron app (`desktop/electron`), and Java bridge (`mars-engine/src`).

## Development

- Node.js 22 or newer
- JDK 17 or newer, with `JAVA_HOME` set

```powershell
cd web
npm install
npm run desktop:dev
```

The desktop development launcher always runs from the `web` project root, even when the npm command is invoked from a child folder such as `web/dist`.

## Build the Windows installer

```powershell
npm run dist:win
```

The installer is written to `desktop/build/reMARS-Setup-0.1.0.exe`.

## Engine support

- Assemble with MARS 4.5 and view translated instructions, labels, and diagnostics.
- Run, pause, stop, step, and backstep while preserving MIPS machine state.
- Set source line breakpoints and inspect live general, coprocessor, and memory values.
- Handle console input and output syscalls interactively.
- Edit multiple source files, open/save `.asm` files, and restore the workspace from local storage.

The original MARS MIT license is included in the installer as `MARSlicense.txt`.

Generated files are kept out of source folders: frontend export in `web/out`, Electron staging and Java runtime in `web/.build`, bridge classes in `mars-engine/build`, and Windows installers in `desktop/build`.
