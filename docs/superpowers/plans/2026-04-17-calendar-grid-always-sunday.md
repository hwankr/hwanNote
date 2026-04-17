# Calendar Grid Always Starts on Sunday — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple the month-grid layout from the `weekStartsOn` preference so the grid always starts on Sunday (matching standard paper calendars), while keeping the "this week" filter window driven by the preference (so a Monday-start user still sees Mon–Sun in the week panel).

**Architecture:** Today `weekStartsOn` flows from `App.tsx` into `CalendarPage` and from there into both `MonthGrid` (grid column order + header labels) and `CalendarSidebar` (→ `WeekTodosPanel`'s `getWeekRange`). We split these two consumers: stop threading `weekStartsOn` through `MonthGrid` (it hard-codes Sunday-start, which is what `getMonthGrid` already does when you pass `0`), and keep the `WeekTodosPanel` / `CalendarSidebar.weekRangeLabel` paths unchanged. We also relabel the setting so it describes what it actually does ("Weekly filter starts on" / "주간 필터 시작 요일"). No store changes, no data migration.

**Tech Stack:** React 18, TypeScript, plain CSS. No test runner is configured (`package.json` only defines `typecheck`); verification is `npm run typecheck` plus a dev-server walkthrough — same convention used by the existing `2026-04-17-calendar-weekend-highlighting.md` plan.

**Spec:** Inline (request was "캘린더에서 주간 시작을 월요일로 하면 캘린더에서도 월요일 부터 시작하는데, 실제 달력은 일요일 부터 시작하니 이건 통일해줘. 다만 이번주 같은 필터에서만 월요일 부터 필터되도록하고.").

---

## File Map

**Modify**
- `src/components/calendar/MonthGrid.tsx` — drop the `weekStartsOn` prop; always build a Sunday-start grid and render Sun→Sat headers. Weekend styling (`date.getDay()`-driven via `DayCell`'s `weekday` prop) is unaffected.
- `src/components/calendar/CalendarPage.tsx` — stop forwarding `weekStartsOn` into `<MonthGrid>`; keep it on `<CalendarSidebar>` (that's where `WeekTodosPanel` and `weekRangeLabel` consume it).
- `src/i18n/messages.ts` — change the setting title to "Weekly filter starts on" / "주간 필터 시작 요일" so users understand the setting no longer moves the grid.

**Do not create any new files.** No store changes, no calendar-data migration, no CSS changes. `src/lib/calendarRange.ts`'s `getWeekRange` / `DEFAULT_WEEK_STARTS_ON` stay as-is.

---

## Conventions

- **No test runner exists.** Each task ends with `npm run typecheck`. Visual verification uses `npm run dev` and the browser.
- **Commit early, commit small.** Every task ends with its own commit. Use the existing repo style (`feat(calendar): …`, `fix(calendar): …`, `i18n: …`), matching recent commits like `feat(calendar): color weekend cells for quicker day-of-week scanning`.
- **Do not touch `getWeekRange` / `DEFAULT_WEEK_STARTS_ON`.** They keep serving the week filter.
- **Do not touch `WeekStart` type or the localStorage key (`hwan-note:week-starts-on`).** The preference still exists; it just stops driving the grid.
- **Weekend cell colors are already layout-independent.** `DayCell` reads `weekday` from `date.getDay()` (not from column index), so Sunday stays red and Saturday stays blue regardless of what the grid does. Nothing to change there.

---

## Task 1: Make `MonthGrid` always render a Sunday-start grid

**Files:**
- Modify: `src/components/calendar/MonthGrid.tsx`

- [ ] **Step 1: Remove `weekStartsOn` from `MonthGridProps` and drop the `WeekStart` import**

Open `src/components/calendar/MonthGrid.tsx`. Replace the imports block and the `MonthGridProps` interface with the versions below. The only changes are: removing the `WeekStart` import and removing the `weekStartsOn` field.

```tsx
import { useMemo } from "react";
import { useI18n } from "../../i18n/context";
import { formatDateKey } from "../../lib/calendarData";
import type { CalendarData } from "../../lib/calendarData";
import DayCell from "./DayCell";

interface MonthGridProps {
  currentMonth: Date;
  selectedDate: string;
  data: CalendarData;
  onSelectDate: (dateKey: string) => void;
  onOpenDay: (dateKey: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
}
```

- [ ] **Step 2: Hard-code the Sunday-start grid builder**

Replace the `getMonthGrid` function with a no-parameter, Sunday-start version:

```tsx
function getMonthGrid(year: number, month: number): Date[][] {
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay(); // 0 = Sunday

  const weeks: Date[][] = [];
  let current = new Date(year, month, 1 - startOffset);

  for (let w = 0; w < 6; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    weeks.push(week);
  }

  return weeks;
}
```

- [ ] **Step 3: Drop `weekStartsOn` from the component signature and the `getMonthGrid` call**

Replace the `export default function MonthGrid({ … })` destructured props to remove `weekStartsOn`, and update the `useMemo` dependency list. The final shape of the signature and the `weeks` hook becomes:

```tsx
export default function MonthGrid({
  currentMonth,
  selectedDate,
  data,
  onSelectDate,
  onOpenDay,
  onPrevMonth,
  onNextMonth,
  onToday,
}: MonthGridProps) {
  const { t } = useI18n();

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const weeks = useMemo(() => getMonthGrid(year, month), [year, month]);
```

- [ ] **Step 4: Stop rotating the day headers**

Replace the `dayHeaders` block so it renders Sunday→Saturday verbatim:

```tsx
  const dayHeaders = [
    { label: t("calendar.sunday"), type: "sunday" },
    { label: t("calendar.monday"), type: "" },
    { label: t("calendar.tuesday"), type: "" },
    { label: t("calendar.wednesday"), type: "" },
    { label: t("calendar.thursday"), type: "" },
    { label: t("calendar.friday"), type: "" },
    { label: t("calendar.saturday"), type: "saturday" },
  ];
```

Delete the now-unused `allDayHeaders` constant and the `slice(weekStartsOn)` / `slice(0, weekStartsOn)` logic. The JSX that maps over `dayHeaders` stays as-is. `DayCell`'s `weekday={date.getDay()}` prop stays as-is — weekend coloring is unaffected.

- [ ] **Step 5: Run typecheck to verify it passes**

Run: `npm run typecheck`
Expected: clean exit (`tsc --noEmit` returns 0).

- [ ] **Step 6: Commit**

```bash
git add src/components/calendar/MonthGrid.tsx
git commit -m "feat(calendar): always render month grid starting on Sunday"
```

---

## Task 2: Stop passing `weekStartsOn` from `CalendarPage` to `MonthGrid`

**Files:**
- Modify: `src/components/calendar/CalendarPage.tsx`

- [ ] **Step 1: Remove the `weekStartsOn` prop from the `<MonthGrid>` call**

Open `src/components/calendar/CalendarPage.tsx`. Find the `<MonthGrid …>` element in the JSX (it starts around line 129). Delete the `weekStartsOn={weekStartsOn}` prop line only. The final element should read:

```tsx
      <MonthGrid
        currentMonth={currentMonth}
        selectedDate={selectedDate}
        data={data}
        onSelectDate={setSelectedDate}
        onOpenDay={handleOpenDay}
        onPrevMonth={handlePrevMonth}
        onNextMonth={handleNextMonth}
        onToday={handleToday}
      />
```

Do **not** remove `weekStartsOn` from `CalendarPageProps` or from the `<CalendarSidebar weekStartsOn={weekStartsOn} … />` call — `WeekTodosPanel` and the sidebar's `weekRangeLabel` still need it. The `import { type WeekStart } from "../../lib/calendarRange"` line at the top also stays.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: clean exit. TypeScript should confirm that `MonthGrid` no longer accepts `weekStartsOn` and that no other caller is broken.

- [ ] **Step 3: Manual verification in the dev server**

Run (in a separate terminal): `npm run dev:frontend`

In the browser at the dev URL:

1. Open Settings → set "Week starts on" to **Monday**.
2. Open the Calendar view. **Expected:** the month grid's leftmost column header is `Sun`/`일`, and the first column of every week row is Sunday. Saturday is red-blue-tinted as before.
3. Switch the sidebar to the "week" view and confirm the title reads something like "Apr 13 – Apr 19" (i.e., the Monday–Sunday window that contains the selected date). Confirm the week panel lists days starting from Monday.
4. Back in Settings, switch "Week starts on" to **Sunday**. Grid is unchanged. Sidebar week view should now show a Sunday–Saturday window.
5. Reload the page; preference persists (localStorage key `hwan-note:week-starts-on` still works), grid is still Sunday-start for both values.

If any of the above fails, stop and fix before committing.

- [ ] **Step 4: Commit**

```bash
git add src/components/calendar/CalendarPage.tsx
git commit -m "fix(calendar): decouple month grid from weekStartsOn preference"
```

---

## Task 3: Relabel the setting to reflect its narrowed scope

**Files:**
- Modify: `src/i18n/messages.ts`

- [ ] **Step 1: Update the Korean label**

In `src/i18n/messages.ts`, find the Korean block around line 225:

```ts
    "settings.weekStartsOn": "주의 시작 요일",
    "settings.weekStartsOnSunday": "일요일",
    "settings.weekStartsOnMonday": "월요일"
```

Replace only the title key. Keep the option labels as-is:

```ts
    "settings.weekStartsOn": "주간 필터 시작 요일",
    "settings.weekStartsOnSunday": "일요일",
    "settings.weekStartsOnMonday": "월요일"
```

- [ ] **Step 2: Update the English label**

In the same file around line 444:

```ts
    "settings.weekStartsOn": "Week starts on",
    "settings.weekStartsOnSunday": "Sunday",
    "settings.weekStartsOnMonday": "Monday"
```

Replace only the title key:

```ts
    "settings.weekStartsOn": "Weekly filter starts on",
    "settings.weekStartsOnSunday": "Sunday",
    "settings.weekStartsOnMonday": "Monday"
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: clean exit.

- [ ] **Step 4: Manual verification in the dev server**

In the open browser session:

1. Open Settings. The setting label reads **"주간 필터 시작 요일"** (ko) or **"Weekly filter starts on"** (en).
2. Changing the value still flips the "week" sidebar view's day-order and range title, and never touches the grid.

- [ ] **Step 5: Commit**

```bash
git add src/i18n/messages.ts
git commit -m "i18n(calendar): rename week-start setting to reflect filter-only scope"
```

---

## Self-Review Checklist (run before handoff)

- [ ] Grid: `MonthGrid.tsx` no longer imports `WeekStart`, no longer accepts `weekStartsOn`, and always produces Sun-first weeks with Sun–Sat headers.
- [ ] Week filter: `getWeekRange(selectedDate, weekStartsOn)` in `src/lib/calendarRange.ts` is unchanged; `WeekTodosPanel` and `CalendarSidebar`'s `weekRangeLabel` still consume `weekStartsOn` from `CalendarPage`.
- [ ] Setting pipeline: `App.tsx`'s `weekStartsOn` state, `WEEK_STARTS_ON_KEY` persistence, and the `SettingsPanel` control are all untouched. Only the visible label changed.
- [ ] Weekend styling: Saturday/Sunday tints still read from `date.getDay()` in `DayCell`, so the leftmost column's class does not shift when the preference flips.
- [ ] Three commits total, one per task; each compiles (`npm run typecheck`).
- [ ] Manual check performed at both `weekStartsOn=1` (Monday) and `weekStartsOn=0` (Sunday); grid identical in both cases, sidebar week view differs correctly.
