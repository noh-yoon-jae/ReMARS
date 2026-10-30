# reMARS

프로젝트 폴더는 책임별로 분리되어 있습니다:

- `web/`에는 Next.js 인터페이스와 빌드 스크립트가 포함되어 있습니다.
- `desktop/electron/`에는 Electron 메인 프로세스와 프리로드 브리지가 포함되어 있습니다.
- `mars-engine/src/`에는 MARS 4.5에 대한 Java 브리지가 포함되어 있습니다.
- `Mars45.jar` 및 `MARSlicense.txt`는 업스트림 MARS 엔진과 라이선스입니다.

## 개발 환경에서 실행

```powershell
cd web
npm install
npm run desktop:dev
```

런처는 Electron과 Next.js를 `web` 프로젝트 루트에 고정하므로, `web/dist`와 같은 하위 폴더에서 npm을 호출해도 명령이 작동합니다. Java 브리지를 먼저 컴파일하며, Java가 `PATH`에 없을 때 `JAVA_HOME`을 사용합니다.

## Windows 설치 프로그램 빌드

```powershell
cd web
npm run dist:win
```

설치 프로그램은 `desktop/build/reMARS-Setup-0.1.0.exe`에 작성됩니다.
