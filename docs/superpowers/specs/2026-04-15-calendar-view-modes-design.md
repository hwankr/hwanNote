# 캘린더 뷰 모드 개편 및 완료 항목 정리 — 설계 문서

작성일: 2026-04-15
대상 브랜치: `gallant-snyder`
작성자: 브레인스토밍 세션 결과

---

## 배경과 문제

현재 캘린더 사이드바는 `일별(day)` / `전체(all)` 두 모드만 지원한다.
`AllTodosPanel`의 **완료 섹션**은 지연/임박/예정/마감없음/완료 섹션 중 맨 아래에 놓여,
완료된 항목이 시간이 지날수록 계속 누적되어 시각적 노이즈가 된다.

## 목표

1. 사이드바 뷰 모드를 **일별 / 주간 / 월간 / 전체** 4가지로 확장한다.
2. 주간/월간 뷰는 **선택된 날짜**를 기준으로 해당 주/해당 달을 보여준다.
   - 월간 그리드에서 다른 주/달의 날짜를 클릭하면 주간/월간 뷰도 그 기준으로 갱신된다.
3. 주의 시작 요일을 설정에서 **일요일 / 월요일 (기본 월요일)** 중 선택할 수 있다.
4. 모든 뷰에서 **완료 항목은 기본적으로 접혀있다.**
5. 전체 뷰에서 완료 섹션을 펼쳤을 때 기본은 **최근 7일의 완료**만 보이고, "전체" 토글로 모든 완료를 볼 수 있다.

## 범위 밖 (Out of Scope)

- 일별 뷰에는 완료 접기 추가하지 않음 (한 날짜에 국한되어 효용 낮음).
- 주간/월간 뷰의 날짜 그룹 헤더 자체를 접는 기능은 v1에 포함하지 않음 (YAGNI).
- "최근 N일" 필터의 N 자체를 설정에서 조정하는 기능은 v1 제외 (7일 고정).
- 주간/월간 뷰의 오버듀 항목을 범위 바깥에서 끌어오는 로직은 포함하지 않음 (아래 정책 참조).

## 정책 결정

- **소스 날짜 기준 필터링**: 주간/월간 뷰는 `sourceDateKey`가 해당 범위에 속하는 항목만 보여준다. 오버듀라 해도 소스가 범위 밖이면 해당 뷰에는 나타나지 않는다. 사용자가 전체 오버듀를 확인하려면 **전체 뷰**를 사용한다.
- **주간 범위 계산**: `weekStartsOn`(0=일, 1=월) 기준 7일. 선택일이 속한 주.
- **월간 범위 계산**: 선택일이 속한 달의 1일 ~ 말일.
- **모드 초기값**: 앱 실행 시 현재처럼 `day` 유지. `selectedDate` 기본값도 오늘 그대로.
- **영속화**: `sidebarMode`는 지금처럼 세션 내 상태로만. `weekStartsOn`은 다른 사용자 설정과 같은 방식으로 저장 (앱의 기존 설정 영속화 경로를 따름).

---

## 아키텍처 / 컴포넌트 구성

### 타입 변경

```ts
// src/components/calendar/CalendarSidebar.tsx
export type CalendarSidebarMode = "day" | "week" | "month" | "all";

// src/lib/calendarData.ts (새 타입)
export type WeekStart = 0 | 1; // 0=일요일, 1=월요일
```

### 신규 컴포넌트

| 파일 | 역할 |
|---|---|
| `src/components/calendar/WeekTodosPanel.tsx` | 선택일이 속한 주의 날짜별 그룹 + 접힌 완료 섹션 |
| `src/components/calendar/MonthTodosPanel.tsx` | 선택일이 속한 달의 날짜별 그룹 + 접힌 완료 섹션 |
| `src/components/calendar/DateGroupedTodoList.tsx` | 공용 내부 컴포넌트. `openByDay` + `done`을 받아 날짜 그룹 섹션 + 완료 섹션을 렌더 |
| `src/components/calendar/DoneSection.tsx` | 공용 내부 컴포넌트. 접기/펼침 + (옵션) 최근 7일 필터 |

### 수정 컴포넌트

- `CalendarSidebar.tsx`
  - `mode` 타입 확장, 4버튼 segmented control로 변경.
  - 모드별 eyebrow/title/subtitle 분기. 주간은 `"4월 14일 – 4월 20일"`, 월간은 `"2026년 4월"` 포맷.
  - `weekStartsOn` prop 추가, `WeekTodosPanel`에 전달.
- `AllTodosPanel.tsx`
  - 기존 `done` 섹션을 `DoneSection` 컴포넌트로 교체.
  - `DoneSection`이 All 모드일 때 "최근 7일 / 전체" 토글을 노출.
- `CalendarPage.tsx`
  - `weekStartsOn`을 store에서 읽어 `CalendarSidebar`로 전달.
- `SettingsPanel.tsx`
  - "주의 시작 요일" 항목 추가 (일요일/월요일 select 또는 라디오).
  - 새 props: `weekStartsOn`, `onWeekStartsOnChange`.
- `App.tsx`
  - `weekStartsOn` 상태를 기존 사용자 설정(예: `themeMode`, `editorFontSize`)과 같은 경로로 영속화.
  - `SettingsPanel`에 props 전달.

### 상수 / 기본값

- `DEFAULT_WEEK_STARTS_ON: WeekStart = 1` (월요일)
- `RECENT_DONE_DAYS = 7`

---

## 유틸 / 데이터 계층

### `src/lib/calendarData.ts`에 추가

```ts
export type WeekStart = 0 | 1;

// 선택일이 속한 주의 7일 (weekStartsOn 기준)
export function getWeekRange(
  dateKey: string,
  weekStartsOn: WeekStart
): { startKey: string; endKey: string; days: string[] };

// 선택일이 속한 달의 모든 날짜
export function getMonthRange(dateKey: string): {
  startKey: string;
  endKey: string;
  days: string[];
};

// 주어진 날짜 집합에 대해 open/done 분류
// - openByDay: 진행중 항목이 있는 날짜만 키로 포함 (빈 날은 제외)
// - done: 완료 항목 평탄화, sourceDateKey 내림차순 정렬
export function selectPeriodTodos(
  data: CalendarData,
  days: string[],
  todayDateKey: string
): {
  openByDay: Record<string, CalendarTodoRow[]>;
  done: CalendarTodoRow[];
};
```

`CalendarTodoRow`를 그대로 재사용해 `sourceDateKey`, `isOverdue`, `dueDateKey` 등 기존 메타데이터를 활용한다.

### `calendarStore` 추가

```ts
weekStartsOn: WeekStart;              // 초기값 DEFAULT_WEEK_STARTS_ON
setWeekStartsOn(v: WeekStart): void;  // 설정에서 변경 시 호출
```

실제 영속화는 기존 사용자 설정(App.tsx가 관리하는 환경설정들)과 동일한 패턴을 구현 시점에 확인해 맞춘다. 파생 상태이므로 변경 시 `WeekTodosPanel`은 `useMemo`로 자동 재계산.

---

## 데이터 / 상태 흐름

```
CalendarPage
  ├─ reads: data, selectedDate, weekStartsOn (from calendarStore)
  ├─ state: sidebarMode ("day" | "week" | "month" | "all")
  └─ renders:
       MonthGrid (기존, 변경 없음)
       CalendarSidebar
         ├─ mode=day   → DayTodosPanel (기존)
         ├─ mode=week  → WeekTodosPanel ── DateGroupedTodoList ── DoneSection
         │                   uses: getWeekRange + selectPeriodTodos
         ├─ mode=month → MonthTodosPanel ── DateGroupedTodoList ── DoneSection
         │                   uses: getMonthRange + selectPeriodTodos
         └─ mode=all   → AllTodosPanel (수정됨) ── DoneSection (with recency toggle)
```

`DoneSection`의 접힘 상태와 "최근 7일 / 전체" 필터는 컴포넌트 내부 `useState`로 관리 (세션 내 로컬).

---

## UI / UX 디테일

### 모드 스위치 (사이드바 헤더)

`[ 일별 | 주간 | 월간 | 전체 ]` — 기존 segmented 스타일을 4버튼으로. 4개가 들어가도록 CSS 폭 조정.

### 헤더 라벨

| 모드 | eyebrow | title | subtitle |
|---|---|---|---|
| day | "일별 보기" (기존) | "YYYY년 M월 D일 (요일)" (기존) | 기존 |
| week | "주간 보기" | "M월 D일 – M월 D일" (범위) | "이번 주 할 일" (this week's tasks) |
| month | "월간 보기" | "YYYY년 M월" | "이번 달 할 일" |
| all | "전체 보기" (기존) | (기존) | (기존) |

### 주간/월간 뷰 레이아웃

```
▼ 월요일 (4/14)
  [ ] 회의 자료 준비     [마감 4/15]
  [ ] 리뷰 답변
▼ 화요일 (4/15)
  [ ] 미팅 노트 정리
— (진행중 항목 없는 날은 생략) —

▶ 완료 (8)             ← 기본 접힘
```

- 진행중 항목이 있는 날만 그룹 렌더.
- 오버듀 항목은 기존 `overdue` chip 그대로 표시. 본 뷰에서는 source date가 범위 내인 것만 보인다.
- 완료 항목 표시: 펼쳤을 때 `showSourceDate=true`로 넘겨 날짜 라벨 같이 보이게 (기존 지원).

### 완료 섹션 (DoneSection)

- 접힘 상태: `▶ 완료 (12)` — 한 줄 토글 버튼.
- 펼침 상태: `▼ 완료 (12)` 헤더 + 리스트.
- **All 뷰 전용**: 펼쳤을 때 리스트 상단에 필터 컨트롤 `[ 최근 7일 | 전체 ]`. 기본 "최근 7일". 전환 시 카운트는 필터된 수/전체 수 형태로 표시 (예: "최근 7일 (3 / 12)").

### Empty states

- 범위 내 진행중 + 완료 모두 0: "이번 주(달)에 할 일이 없습니다" 한 줄.
- 진행중 0, 완료만 있음: 진행중 빈 영역 생략, 완료 섹션만 표시.

### i18n 키 (신규)

ko/en 양쪽 모두:
- `calendar.viewWeek`, `calendar.viewMonth`
- `calendar.weekViewTitle`, `calendar.weekViewSubtitle`
- `calendar.monthViewTitle`, `calendar.monthViewSubtitle`
- `calendar.doneCollapsed` (예: "완료")
- `calendar.doneRecent7`, `calendar.doneAll`
- `calendar.periodEmpty` (이 주/달 할 일 없음)
- `settings.weekStartsOn`, `settings.weekStartsOnSunday`, `settings.weekStartsOnMonday`

### 접근성

- 모드 스위치: 기존 `role="tab"` / `aria-selected` 패턴을 4개 버튼으로 확장.
- `DoneSection` 토글 버튼: `aria-expanded`, `aria-controls` 지정.

### CSS 추가

- `.calendar-view-switch-btn` 4개 적용 시 폭/간격 조정.
- `.day-group-header` (주간/월간 날짜 헤더 스타일).
- `.done-section-toggle`, `.done-section-filter`.

---

## 에지 케이스

- **범위 내 할 일 0개** — empty state 문구.
- **모두 완료 상태** — 진행중 섹션 빈 영역 숨기고 완료 섹션만.
- **오버듀가 범위 밖 소스** — 해당 뷰에 나타나지 않음 (정책).
- **주가 두 달에 걸침** — 헤더에 양쪽 달 포함 표기 (예: "4월 28일 – 5월 4일").
- **월간 뷰에서 2월 / 31일 월** — `getMonthRange`가 실제 말일까지 정확히 계산.
- **`weekStartsOn` 변경** — 현재 주간 뷰가 다음 렌더에서 자동 재계산 (파생 상태).

## 성능

- 주간=7일, 월간=28~31일 순회로 기존 All 뷰보다 작음.
- 범위 계산과 그룹핑은 `useMemo`로 메모이즈.

## 검증

프로젝트에 공식 테스트 러너가 설정되어 있지 않다 (package.json에 test 스크립트 없음).
다음으로 대체:
- `npm run typecheck` 통과 (필수).
- 수동 검증 체크리스트:
  - [ ] 4개 모드 전환이 모두 동작
  - [ ] 주간 뷰: `weekStartsOn=1`일 때 월~일, `weekStartsOn=0`일 때 일~토
  - [ ] 월간 그리드에서 다른 달의 날짜 클릭 → 월간 뷰가 그 달로 이동
  - [ ] 완료 섹션 기본 접힘, 카운트 정확
  - [ ] 전체 뷰: 펼친 뒤 "최근 7일" 기본, "전체" 전환
  - [ ] 설정 변경 시 주간 뷰 즉시 반영 및 영속화 (앱 재시작 후 유지)
  - [ ] 범위 바깥 오버듀는 주간/월간에 안 나타남, 전체 뷰엔 나타남

## 호환 / 마이그레이션

- 기존 `sidebarMode` 저장값 없음 (세션 상태). 호환 이슈 없음.
- `weekStartsOn` 신규 설정, 기본 1(월). 기존 사용자 영향 없음.
