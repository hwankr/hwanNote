# Windows 개발 환경 세팅

## 현재 상태

- 로컬 브랜치: `main`
- 로컬 HEAD: `72c0069`
- 원격 `origin/main`: `72c0069`
- 2026-03-14 기준 `git pull --ff-only` 적용 완료

즉, 현재 로컬 저장소는 원격 `main` 과 동기화된 상태입니다. 아래 문서는 Windows 개발 환경을 빠르게 점검하기 위한 보조 메모입니다.

## 프로젝트 요구사항

프로젝트 자체 요구사항:

- Node.js >= 20 (`package.json`)
- Rust stable (`README.md`)
- Windows 10/11 64-bit (`README.md`)

Tauri Windows 개발 추가 요구사항:

- WebView2 Runtime
- Visual Studio C++ Build Tools 2022 권장

## 빠른 점검

PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-dev.ps1
```

의존성 설치까지 같이:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-dev.ps1 -InstallDependencies
```

## 권장 순서

1. `git pull --ff-only`
2. `powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-dev.ps1`
3. `npm install`
4. `npm run typecheck`
5. `npm run dev`

## 참고

- `src-tauri/tauri.windows.conf.json` 에 NSIS 언어 설정(English, Korean)을 추가로 반영했습니다.
- `README.md` 에 Linux/WSL 개발 안내와 Windows 체크리스트를 함께 정리했습니다.
