# HwanNote

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

<p align="center">
  <img src="./resources/icon.png" alt="HwanNote Logo" width="128" height="128">
</p>

> Windows 11 스타일의 데스크톱 마크다운 메모 애플리케이션

HwanNote는 Windows 11 메모장에서 영감을 받아 만들어진 데스크톱 마크다운 메모 앱입니다. Electron과 React, TypeScript를 기반으로 제작되었으며, TipTap 에디터 엔진을 통해 Notion 스타일의 토글 블록, 체크리스트, 표 등 다양한 리치 텍스트 편집 기능을 제공합니다. 가볍고 빠른 인터페이스로 일상적인 메모부터 구조화된 문서 작성까지 활용할 수 있습니다.

---

## 주요 기능

### 편집기

- TipTap(ProseMirror) 기반 리치 마크다운 편집
- 제목(H1~H3), 굵게, 기울임 서식 지원
- **Notion 스타일 토글/접기 블록** — 클릭으로 열고 닫을 수 있는 접이식 콘텐츠 블록
- 체크리스트/할 일 목록 — 중첩 지원, 체크 상태 영구 저장
- 표 — 행, 열, 헤더 완전 지원
- 링크 — URL 자동 감지 및 붙여넣기 시 자동 링크
- 글머리 기호 및 번호 목록
- 빈 에디터에 플레이스홀더 텍스트 표시

### 탭 및 탐색

- 멀티탭 인터페이스 — 여러 메모를 동시에 열어두고 전환
- 드래그 앤 드롭으로 탭 순서 변경
- 탭 고정/해제(Pin/Unpin)
- 탭 우클릭 컨텍스트 메뉴 — 닫기, 다른 탭 닫기, 고정 등
- 저장되지 않은 변경 사항 표시(더티 인디케이터)

### 사이드바

- 계층형 폴더 트리 — 폴더 생성, 이름 변경, 삭제
- 제목 + 내용 통합 검색
- 해시태그 자동 추출 (`#태그` 형식)
- 정렬 — 최근 수정순, 이름순, 생성일순
- 메모 미리보기 카드
- 폴더 간 메모 이동

### 외관 및 테마

- Windows 11 스타일 커스텀 프레임리스 타이틀바
- **다크 / 라이트 / 시스템** 테마 모드
- 에디터 줄 간격 조절 (1.2x ~ 2.2x)
- 다국어 지원 — 한국어, English

### 파일 관리

- **자동 저장** — 변경 후 1초 뒤 자동으로 저장
- 마크다운(`.md`) 파일로 로컬 저장 — 다른 에디터에서도 열 수 있음
- `.md` 파일 연결 — 마크다운 파일을 HwanNote로 바로 열기
- 인덱스 파일(`.hwan-note-index.json`)로 메타데이터 관리

### 키보드 단축키

- 모든 단축키를 설정에서 자유롭게 변경 가능
- 단축키 충돌 자동 감지
- 기본값 초기화 지원

### 상태 표시줄

- 현재 줄, 열, 글자 수 실시간 표시
- 현재 테마, 인코딩(UTF-8), 줄바꿈 형식(CRLF) 정보

---

## 스크린샷

> 스크린샷은 추후 추가 예정입니다.

<!--
아래 형식으로 스크린샷을 추가하세요 (권장 해상도: 1280x840):

| 라이트 테마 | 다크 테마 |
|:---:|:---:|
| ![라이트 테마](./docs/screenshots/light-theme.png) | ![다크 테마](./docs/screenshots/dark-theme.png) |
-->

| 라이트 테마 | 다크 테마 |
|:---:|:---:|
| *추가 예정* | *추가 예정* |

---

## 기술 스택

| 영역 | 기술 | 버전 |
|---|---|---|
| 데스크톱 프레임워크 | Electron | 33 |
| UI 라이브러리 | React | 18 |
| 언어 | TypeScript | 5.7 |
| 에디터 엔진 | TipTap (ProseMirror) | 2.14 |
| 상태 관리 | Zustand | 5 |
| 빌드 도구 | Vite | 6 |
| 패키징 | electron-builder | 25 |

---

## 시스템 요구사항

- **Node.js** >= 20 (소스에서 빌드 시)
- **npm** (Node.js에 포함)
- **Windows 10 / 11** (64-bit)
- **Git** (소스에서 빌드 시)

---

## 설치

### 릴리스 다운로드 (권장)

[GitHub Releases](../../releases) 페이지에서 최신 버전을 다운로드하세요.

| 유형 | 파일명 | 설명 |
|---|---|---|
| 설치 프로그램 | `HwanNote-x.x.x-x64.exe` (NSIS) | 설치/제거 프로그램 포함, 바탕화면 바로가기 생성 |
| 포터블 | `HwanNote-x.x.x-x64.exe` (Portable) | 설치 없이 바로 실행 가능 |

**설치 프로그램 사용 시:**

1. NSIS 설치 파일(`HwanNote-x.x.x-x64.exe`)을 다운로드합니다.
2. 실행 후 설치 경로를 선택합니다 (기본: 사용자 폴더).
3. 설치 완료 후 바탕화면 또는 시작 메뉴에서 HwanNote를 실행합니다.

**포터블 버전 사용 시:**

1. Portable 버전 파일을 다운로드합니다.
2. 원하는 위치에 저장합니다.
3. 파일을 더블클릭하여 바로 실행합니다.

---

## 개발 환경 설정

### 소스에서 빌드 및 실행

```bash
# 저장소 클론
git clone https://github.com/HwanKR/HwanNote.git
cd HwanNote

# 의존성 설치
npm install

# 개발 모드 실행
npm run dev
```

`npm run dev`를 실행하면 세 가지 프로세스가 동시에 시작됩니다:

1. **TypeScript 감시** — Electron 메인 프로세스 코드를 `dist-electron/`으로 실시간 컴파일
2. **Vite 개발 서버** — React UI를 `http://127.0.0.1:5173`에서 핫 리로드(HMR)로 제공
3. **Electron** — electronmon을 통해 메인 프로세스 변경 시 자동 재시작

---

## 빌드 명령어

| 명령어 | 설명 |
|---|---|
| `npm run dev` | 개발 모드 실행 (HMR + 자동 재시작) |
| `npm run build` | 메인 프로세스 + 렌더러 프로덕션 빌드 |
| `npm run start` | 프로덕션 빌드 후 Electron 앱 실행 |
| `npm run dist:win` | Windows 포터블 `.exe` 생성 |
| `npm run dist:installer` | Windows NSIS 설치 프로그램 생성 |
| `npm run dist:all` | 포터블 + 설치 프로그램 모두 생성 |
| `npm run typecheck` | TypeScript 타입 검사 (렌더러 + 메인) |
| `npm run preview` | Vite 프로덕션 빌드 미리보기 |

빌드 결과물은 `release/` 디렉터리에 생성됩니다.

---

## 프로젝트 구조

> v0.1.0 기준

```
HwanNote/
├── electron/                    # Electron 메인 프로세스
│   ├── main.ts                  # 앱 진입점, 윈도우 생성, IPC 핸들러 등록
│   ├── preload.ts               # 컨텍스트 브릿지 (renderer ↔ main 안전한 통신)
│   └── fileManager.ts           # 파일 시스템 I/O, 인덱스 관리, 마크다운 변환
├── src/                         # React 렌더러 프로세스
│   ├── App.tsx                  # 메인 앱 컴포넌트 (상태 관리, 단축키, 테마)
│   ├── main.tsx                 # React 진입점
│   ├── components/              # UI 컴포넌트
│   │   ├── Editor.tsx           # TipTap 에디터 래퍼
│   │   ├── TitleBar.tsx         # 커스텀 타이틀바 + 탭 스트립
│   │   ├── Toolbar.tsx          # 서식 도구 모음 + 제목 입력
│   │   ├── Sidebar.tsx          # 폴더 트리, 검색, 메모 목록
│   │   ├── StatusBar.tsx        # 하단 상태 표시줄
│   │   ├── SettingsPanel.tsx    # 설정 패널 (테마, 언어, 단축키)
│   │   └── SearchBar.tsx        # 검색 입력 컴포넌트
│   ├── extensions/              # TipTap 커스텀 확장
│   │   └── toggleBlock.ts       # Notion 스타일 토글 블록 확장
│   ├── hooks/                   # React 커스텀 훅
│   │   └── useAutoSave.ts       # 자동 저장 훅 (디바운스 기반)
│   ├── stores/                  # 상태 관리
│   │   └── noteStore.ts         # Zustand 메모/탭/사이드바 스토어
│   ├── i18n/                    # 다국어 지원
│   │   ├── messages.ts          # 번역 메시지 (한국어/English)
│   │   └── context.tsx          # i18n React 컨텍스트 프로바이더
│   ├── lib/                     # 유틸리티
│   │   └── shortcuts.ts         # 단축키 정의, 검증, 컨텍스트 매칭
│   └── styles/                  # 스타일
│       ├── global.css           # 전역 스타일
│       └── themes.ts            # 테마 CSS 변수 정의 (dark/light)
├── resources/                   # 빌드 리소스 (아이콘 등)
├── package.json                 # 의존성, 빌드 스크립트, electron-builder 설정
├── vite.config.ts               # Vite 빌드 설정
├── tsconfig.json                # TypeScript 설정 (렌더러)
└── tsconfig.electron.json       # TypeScript 설정 (메인 프로세스, CommonJS)
```

---

## 키보드 단축키

HwanNote의 단축키는 **컨텍스트 기반**으로 동작합니다. 에디터에 포커스가 있는지 여부에 따라 같은 키 조합이 다르게 작동할 수 있습니다.

### 앱 단축키

| 기능 | 기본 단축키 | 컨텍스트 |
|---|---|---|
| 사이드바 열기/닫기 | `Ctrl+B` | 에디터 외부 |
| 다음 탭 | `Ctrl+Tab` | 전역 |
| 이전 탭 | `Ctrl+Shift+Tab` | 전역 |
| 메모 저장 | `Ctrl+S` | 전역 |
| 새 메모 | `Ctrl+N` | 전역 |
| 탭 닫기 | `Ctrl+W` | 전역 |

### 에디터 단축키

| 기능 | 기본 단축키 | 컨텍스트 |
|---|---|---|
| 굵게 토글 | `Ctrl+B` | 에디터 |
| 기울임 토글 | `Ctrl+I` | 에디터 |
| 체크리스트 토글 | `Ctrl+Shift+X` | 에디터 |
| 토글 블록 삽입 | `Ctrl+Shift+T` | 에디터 |

> **참고:** `Ctrl+B`는 에디터에 포커스가 있을 때는 **굵게** 서식을, 에디터 외부에서는 **사이드바 토글**로 작동합니다. 이는 컨텍스트 기반 단축키 시스템으로, 동일한 키 조합이 상황에 따라 다른 기능을 수행합니다.

> **참고:** 모든 단축키는 설정 패널에서 변경할 수 있으며, 충돌이 감지되면 자동으로 알려줍니다.

---

## 설정

설정 패널은 툴바의 톱니바퀴 아이콘을 클릭하거나, 열린 상태에서 `Esc`를 눌러 닫을 수 있습니다.

### 설정 항목

| 항목 | 설명 | 기본값 |
|---|---|---|
| 테마 모드 | 라이트 / 다크 / 시스템 설정 따르기 | 라이트 |
| 언어 | 한국어 / English | 한국어 |
| 줄 간격 | 에디터 줄 간격 (1.20x ~ 2.20x) | 1.55x |
| 자동 저장 경로 | 메모 저장 위치 (읽기 전용) | `문서/HwanNote/Notes/` |
| 키보드 단축키 | 각 단축키 클릭 후 새 키 조합 입력 | 위 표 참고 |

### 설정 저장 위치

모든 설정은 브라우저 `localStorage`에 저장됩니다:

| 키 | 용도 |
|---|---|
| `hwan-note:theme-mode` | 테마 모드 (`light` / `dark` / `system`) |
| `hwan-note:editor-line-height` | 에디터 줄 간격 (숫자) |
| `hwan-note:shortcuts` | 사용자 정의 단축키 (JSON) |
| `hwan-note:custom-folders` | 사용자 생성 폴더 목록 (JSON) |

---

## 파일 저장 구조

HwanNote는 메모를 표준 마크다운(`.md`) 파일로 저장합니다. 다른 마크다운 에디터나 텍스트 에디터에서도 자유롭게 열고 편집할 수 있습니다.

### 저장 경로

```
문서/
└── HwanNote/
    └── Notes/
        ├── .hwan-note-index.json    # 메모 인덱스 (ID, 생성일, 수동 제목)
        ├── 메모-제목.md              # 마크다운 메모 파일
        ├── 폴더이름/
        │   └── 하위-메모.md          # 폴더 안의 메모
        └── ...
```

### 파일 형식

- **인코딩:** UTF-8
- **줄바꿈:** Windows CRLF (`\r\n`)
- **제목 생성:** 메모 첫 줄에서 자동으로 제목 추출 (수동 제목 설정도 가능)
- **파일명:** 제목을 slug화하여 생성 (특수문자 제거, 공백은 `-`로 변환)

### 특수 마크다운 구문

#### 체크리스트

```markdown
- [x] 완료된 항목
- [ ] 미완료 항목
  - [x] 중첩된 하위 항목
```

#### 토글 블록

HwanNote는 접이식 토글 블록을 위해 커스텀 마크다운 구문을 사용합니다:

```markdown
:::toggle[open] 토글 제목
토글 내부 콘텐츠가 여기에 들어갑니다.
여러 줄 작성 가능합니다.
:::
```

- `:::toggle[open]` — 펼쳐진 상태의 토글 블록 시작
- `:::toggle[closed]` — 접힌 상태의 토글 블록 시작
- `:::` — 토글 블록 끝
- 토글 블록은 중첩 가능합니다

> **참고:** 이 구문은 HwanNote 전용입니다. 다른 마크다운 에디터에서는 일반 텍스트로 표시됩니다.

### 인덱스 파일

`.hwan-note-index.json`은 각 메모의 메타데이터를 관리합니다:

```json
{
  "entries": {
    "note-abc123def456": {
      "relativePath": "메모-제목.md",
      "createdAt": 1708784400000,
      "manualTitle": "사용자가 지정한 제목"
    }
  }
}
```

- `relativePath` — `Notes/` 기준 상대 경로
- `createdAt` — 메모 최초 생성 시각 (Unix 타임스탬프, ms)
- `manualTitle` — 사용자가 직접 설정한 제목 (자동 제목 사용 시 생략)

---

## 알려진 제한사항

- **Windows 전용** — 현재 Windows 10/11(64-bit)만 지원합니다. macOS 및 Linux 지원은 로드맵에 포함되어 있습니다.
- **클라우드 동기화 미지원** — 모든 메모는 로컬 파일 시스템에만 저장됩니다.
- **마크다운 미리보기 없음** — WYSIWYG 편집만 지원하며, 원본 마크다운 미리보기 모드는 아직 없습니다.
- **이미지 삽입 미지원** — 현재 텍스트 기반 콘텐츠만 지원합니다.
- **커스텀 토글 구문** — 토글 블록의 `:::toggle` 구문은 표준 마크다운이 아니므로, 다른 에디터에서는 일반 텍스트로 표시됩니다.

---

## 기여하기

HwanNote에 기여해 주셔서 감사합니다! 버그 리포트, 기능 제안, 코드 기여 모두 환영합니다.

### 기여 방법

1. 이 저장소를 **Fork** 합니다.
2. 새 브랜치를 생성합니다.
   ```bash
   git checkout -b feature/새기능
   ```
3. 변경 사항을 커밋합니다.
   ```bash
   git commit -m 'feat: 새로운 기능 추가'
   ```
4. 브랜치에 Push 합니다.
   ```bash
   git push origin feature/새기능
   ```
5. **Pull Request**를 생성합니다.

### 개발 가이드라인

- **TypeScript strict 모드**를 유지하세요. `npm run typecheck`으로 확인할 수 있습니다.
- 커밋 메시지는 [Conventional Commits](https://www.conventionalcommits.org/) 형식을 따르세요:
  - `feat:` 새로운 기능
  - `fix:` 버그 수정
  - `docs:` 문서 변경
  - `refactor:` 리팩토링
  - `style:` 코드 스타일 변경
- 새로운 UI 텍스트는 `src/i18n/messages.ts`에 **한국어와 영어 번역을 모두** 추가하세요.
- 새로운 컴포넌트는 `src/components/` 디렉터리에 작성하세요.

---

## 로드맵

- [ ] macOS / Linux 지원
- [ ] 마크다운 원본 미리보기 모드
- [ ] 코드 블록 구문 강조(Syntax Highlighting)
- [ ] 이미지 삽입 지원
- [ ] 마크다운 파일 내보내기/가져오기
- [ ] 메모 간 링크 (위키 링크)
- [ ] 플러그인 시스템
- [ ] 클라우드 동기화

> 로드맵은 개발 상황에 따라 변경될 수 있습니다.

---

## 라이선스

이 프로젝트는 [MIT 라이선스](./LICENSE)로 배포됩니다.

---

<p align="center">
  <b>HwanNote</b>를 만든 <a href="https://github.com/HwanKR">HwanKR</a>
  <br><br>
  이 프로젝트가 유용하다면 <b>Star</b>를 눌러주세요!
</p>
