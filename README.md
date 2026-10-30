# reMARS

Project folders are separated by responsibility:

- `web/` contains the Next.js interface and build scripts.
- `desktop/electron/` contains the Electron main process and preload bridge.
- `mars-engine/src/` contains the Java bridge to MARS 4.5.
- `Mars45.jar` and `MARSlicense.txt` are the upstream MARS engine and license.

## Run in development

```powershell
cd web
npm install
npm run desktop:dev
```

The launcher anchors Electron and Next.js to the `web` project root, so the command also works if npm is invoked from a child folder such as `web/dist`. It compiles the Java bridge first and uses `JAVA_HOME` when Java is not on `PATH`.

## Build the Windows installer

```powershell
cd web
npm run dist:win
```

The installer is written to `desktop/build/reMARS-Setup-0.1.0.exe`.
