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

## Windows 한글 IME 회귀 확인

합성 composition 이벤트를 사용하는 자동 테스트는 문자·선택·실행 취소 보존을
확인하지만, 실제 WebView2의 조합 글자 표시까지 검증하지는 않습니다.
아래 확인은 문제가 발생했던 PC의 Microsoft 한글 IME로 진행합니다.

1. `npm exec -- tauri build --debug --no-bundle --ci -- --locked`로 프런트엔드를
   내장한 테스트 앱을 빌드합니다. 기존 HwanNote를 종료한 뒤
   `src-tauri/target/debug/hwan-note.exe`를 실행합니다. 동일 앱의 중복 실행은
   기존 창으로 연결되므로 설치된 앱이 계속 실행 중이면 수정본을 시험할 수 없습니다.
2. 새 테스트 메모에 `ㄱ`, `ㅏ`, `ㄴ`, `ㅏ`를 천천히 입력합니다. 다음 음절을
   시작하기 전에도 현재 조합 중인 `ㄱ` → `가` → `ㄴ` → `나`가 보여야 합니다.
3. 편집기에 커서를 둔 채 창 크기를 바꾸거나 `Win+Shift+방향키`로 다른 모니터로
   옮긴 뒤 반복합니다. 이동 후 편집기를 다시 클릭하거나 Alt+Tab하지 않고 확인합니다.
   기존 모니터들의 배율이 다르면 양방향 이동을 모두 확인합니다.
4. 한글 조합 도중에도 창을 이동해 보고, 마지막 음절과 커서·스크롤 위치가 유지되는지,
   실행 취소가 동작하는지 확인합니다. 제목과 링크 입력에서는 한글 확정용 Enter가
   편집기를 바꾸거나 팝업을 닫지 않는지도 확인합니다.
5. 재발하면 Windows/WebView2 버전, 사용 중인 각 모니터 배율, 직전에 수행한 창 조작,
   조합 중인 글자의 표시 위치와 Alt+Tab 후 변화 여부를 기록합니다.

관련 WebView2 보고: <https://github.com/MicrosoftEdge/WebView2Feedback/issues/5675>.
창 크기 변경 뒤 IME 위치가 어긋나는 보고와 유사하나, 실제 환경의 원인과
수정 효과는 위 수동 확인 결과로 판단합니다.

## 참고

- `src-tauri/tauri.windows.conf.json` 에 NSIS 언어 설정(English, Korean)을 추가로 반영했습니다.
- `README.md` 에 Linux/WSL 개발 안내와 Windows 체크리스트를 함께 정리했습니다.
