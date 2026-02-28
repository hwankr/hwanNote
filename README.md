<p align="center"><img src="./resources/icon.png" alt="HwanNote Logo" width="128" height="128"></p>

# HwanNote

![Platform](https://img.shields.io/badge/Platform-Windows-blue) ![Tauri](https://img.shields.io/badge/Tauri-v2-24C8D8) ![React](https://img.shields.io/badge/React-18-61DAFB) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white) ![License](https://img.shields.io/badge/License-MIT-green)

> Windows 11 스타일의 가볍고 빠른 마크다운 메모 앱

---

## 소개

HwanNote는 Windows 11 메모장에서 영감을 받은 데스크톱 마크다운 메모 앱입니다. Tauri v2와 React 18을 기반으로 제작되어 가볍고 빠르게 동작하며, 마크다운 서식을 시각적으로 편집할 수 있습니다. 작성한 메모는 표준 마크다운(.md) 파일로 저장되어 다른 에디터에서도 열 수 있습니다.

---

## 스크린샷

<!-- 스크린샷: ./screenshots/light.png, ./screenshots/dark.png -->

*스크린샷은 준비 중입니다.*

---

## 주요 기능

### 편집

- 제목(H1~H3), 굵게, 기울임 서식
- 토글/접기 블록 (Notion 스타일의 접이식 콘텐츠)
- 체크리스트 (중첩 지원, 체크 상태 저장)
- 표 (행, 열, 헤더 지원)
- 링크 (URL 자동 감지, 붙여넣기 시 자동 링크)
- 글머리 기호 및 번호 목록
- 날짜/시간 삽입 (F5)
- MD / TXT 형식 전환 (상태 표시줄에서 클릭)
- .txt 파일 가져오기 및 내보내기

### 탭

- 여러 메모를 동시에 열어두고 전환
- 드래그 앤 드롭으로 탭 순서 변경
- 탭 고정/해제
- 저장되지 않은 변경 표시

### 사이드바

- 계층형 폴더 관리 (하위 폴더 생성, 이름 변경, 삭제)
- 제목 + 내용 통합 검색
- 해시태그 자동 추출 (#태그)
- 정렬 (최근 수정순, 이름순, 생성일순)

### 외관 및 설정

- 다크 / 라이트 / 시스템 테마
- 글꼴 크기 조절 (설정 또는 Ctrl+마우스 휠, Ctrl+0으로 초기화)
- 줄 간격 조절
- 탭 크기 설정
- 한국어, English 지원

### 파일 관리

- 자동 저장 (변경 후 자동으로 저장)
- 마크다운(.md) 파일로 로컬 저장
- .md 파일 연결 (마크다운 파일을 HwanNote로 바로 열기)
- 메모 삭제 시 휴지통으로 이동 (안전 삭제)
- 자동 업데이트 지원

---

## 기술 스택

| 영역 | 기술 |
|---|---|
| 데스크톱 프레임워크 | Tauri v2 |
| 백엔드 | Rust |
| UI 프레임워크 | React 18 |
| 언어 | TypeScript |
| 에디터 엔진 | Tiptap (ProseMirror 기반) |
| 상태 관리 | Zustand |
| 빌드 도구 | Vite |

---

## 다운로드 및 설치

최신 설치 파일은 [GitHub Releases](../../releases) 페이지에서 다운로드할 수 있습니다.

- NSIS 설치 파일(.exe)을 실행하면 자동으로 설치됩니다.
- 설치 후 앱 내 자동 업데이트를 통해 최신 버전을 유지할 수 있습니다.
- Windows 10/11 (64-bit) 환경에서 사용할 수 있습니다.

---

## 개발 환경 설정 (소스에서 빌드)

### 요구사항

- Node.js >= 20
- Rust (최신 stable)
- Windows 10/11 (64-bit)

### 설치 및 실행

```bash
git clone https://github.com/hwankr/hwanNote.git
cd hwanNote
npm install
npm run dev
```

### 빌드 명령어

| 명령어 | 설명 |
|---|---|
| `npm run dev` | 개발 모드 실행 (Tauri + Vite) |
| `npm run build` | 프로덕션 빌드 |
| `npm run typecheck` | TypeScript 타입 검사 |

---

## 키보드 단축키

| 기능 | 기본 단축키 |
|---|---|
| 새 메모 | Ctrl+N |
| 메모 저장 | Ctrl+S |
| 사이드바 토글 | Ctrl+B |
| 다음 탭 | Ctrl+Tab |
| 이전 탭 | Ctrl+Shift+Tab |
| 탭 닫기 | Ctrl+W |
| 굵게 | Ctrl+B (에디터 내) |
| 기울임 | Ctrl+I (에디터 내) |
| 체크리스트 | Ctrl+Shift+X (에디터 내) |
| 토글 블록 | Ctrl+Shift+T (에디터 내) |
| 날짜/시간 삽입 | F5 (에디터 내) |

모든 단축키는 설정에서 변경할 수 있습니다.

---

## 저장 위치

메모는 기본적으로 `문서/HwanNote/Notes/` 폴더에 저장됩니다. 저장 경로는 설정에서 변경할 수 있습니다. 모든 메모는 표준 마크다운(.md) 파일로 저장되므로 다른 에디터에서도 열어볼 수 있습니다.

---

## 알려진 제한사항

- Windows 10/11 (64-bit) 전용
- 클라우드 동기화 미지원 (모든 메모는 로컬에 저장됩니다)
- 이미지 삽입 미지원

---

## 라이선스

이 프로젝트는 [MIT](./LICENSE) 라이선스에 따라 배포됩니다.

---

<p align="center">
  Made by <a href="https://github.com/HwanKR">HwanKR</a><br>
  이 프로젝트가 유용하다면 GitHub에서 Star를 눌러 주세요.
</p>
