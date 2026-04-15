# Calendar Day Double-Click Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the calendar sidebar is in "All" (전체 보기) mode, double-clicking a day cell in the month grid switches the sidebar to "Day" (일별 보기) mode focused on that date, giving the user visible feedback that their click landed.

**Architecture:** Lift the `mode` ("day" | "all") state from `CalendarSidebar` up to `CalendarPage` so `MonthGrid` → `DayCell` can trigger a mode change through a new `onOpenDay` callback. Add `onDoubleClick` to `DayCell` that calls both `onSelectDate(dateKey)` and a new `onOpenDayView(dateKey)` (select date + force mode to "day"). Single click keeps its current behavior (select only). The existing `AllTodosPanel` → `onOpenSourceDate` path reuses the same lifted state, so mode-setting logic lives in exactly one place.

**Tech Stack:** React 18, TypeScript, Zustand (for state), Tauri. No test framework installed — verification uses `npm run typecheck` and manual `npm run dev` runs.

**Non-goals:**
- No persistence of sidebar mode across app restarts (matches existing behavior — `mode` is ephemeral UI state).
- No new calendar data, no new todos/notes concepts, no changes to `calendarStore`.
- Single-click behavior is unchanged; only double-click is added.

---

## File Structure

Files to modify (no new files):

- `src/components/calendar/CalendarPage.tsx` — owns `sidebarMode` state; passes `onOpenDayView` down to `MonthGrid` and `CalendarSidebar`.
- `src/components/calendar/CalendarSidebar.tsx` — receives `mode` and `onModeChange` as props (removes internal `useState<CalendarSidebarMode>`); existing `onOpenSourceDate` in `AllTodosPanel` branch now calls the lifted setter.
- `src/components/calendar/MonthGrid.tsx` — adds `onOpenDay: (dateKey: string) => void` prop; passes `onDoubleClick` down to each `DayCell`.
- `src/components/calendar/DayCell.tsx` — adds `onDoubleClick: () => void` prop and wires it to the `<button>`.

Responsibility split is preserved: `CalendarPage` owns orchestration, `MonthGrid` owns layout/enumeration, `DayCell` owns a single cell's interactions, `CalendarSidebar` renders the panel.

---

## Task 1: Lift sidebar mode state from `CalendarSidebar` to `CalendarPage`

**Why first:** Every later task depends on `CalendarPage` being able to set the sidebar mode. Do this as a pure refactor (no behavior change) so regressions stay isolated.

**Files:**
- Modify: `src/components/calendar/CalendarSidebar.tsx:17-51,79-98,123-126`
- Modify: `src/components/calendar/CalendarPage.tsx:18-30,114-128`

- [ ] **Step 1: Export the mode type and update `CalendarSidebarProps`**

In `src/components/calendar/CalendarSidebar.tsx`, the `CalendarSidebarMode` type is already exported (line 17). Replace the internal `useState` with controlled props.

Change the props interface (around lines 19–33) to add `mode` and `onModeChange`:

```tsx
interface CalendarSidebarProps {
  selectedDate: string;
  mode: CalendarSidebarMode;
  onModeChange: (mode: CalendarSidebarMode) => void;
  dayTodos: TodoItem[];
  groupedTodoRows: Record<CalendarTodoGroup, CalendarTodoRow[]>;
  linkedNoteIds: string[];
  pinnedNotes: PinnedNote[];
  onCreateTodo: (dateKey: string, text: string) => void;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onNavigateToNote: (noteId: string) => void;
  noteTitle: (noteId: string) => string;
  onOpenDay: (dateKey: string) => void;
}
```

- [ ] **Step 2: Remove the internal `useState` and consume the prop**

In the component body (lines 35–51), remove the `useState` line and destructure the new props. Replace the `useState` import if it is no longer used elsewhere in the file (it isn't — `useMemo` is the only remaining React hook, so change the import to `import { useMemo } from "react";`).

Updated component signature and body top:

```tsx
export default function CalendarSidebar({
  selectedDate,
  mode,
  onModeChange,
  dayTodos,
  groupedTodoRows,
  linkedNoteIds,
  pinnedNotes,
  onCreateTodo,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onNavigateToNote,
  noteTitle,
  onOpenDay,
}: CalendarSidebarProps) {
  const { t, localeTag } = useI18n();

  const selectedDateLabel = useMemo(
    () =>
      parseDateKey(selectedDate).toLocaleDateString(localeTag, {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "short",
      }),
    [localeTag, selectedDate]
  );
```

- [ ] **Step 3: Replace every `setMode(...)` call with `onModeChange(...)`**

Two call sites need updating:

Line 85 (the "day" tab button):

```tsx
onClick={() => onModeChange("day")}
```

Line 95 (the "all" tab button):

```tsx
onClick={() => onModeChange("all")}
```

Line 125 (inside `AllTodosPanel`'s `onOpenSourceDate` callback):

```tsx
onOpenSourceDate={(dateKey) => {
  onOpenDay(dateKey);
  onModeChange("day");
}}
```

- [ ] **Step 4: Add `sidebarMode` state to `CalendarPage` and pass props through**

In `src/components/calendar/CalendarPage.tsx`, add state and pass it to `CalendarSidebar`. Imports need `useState` added.

Change the imports at line 1:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDateKey, parseDateKey, type TodoItem } from "../../lib/calendarData";
import { useNoteStore } from "../../stores/noteStore";
import { selectTodoRowsByGroup, useCalendarStore } from "../../stores/calendarStore";
import CalendarSidebar, { type CalendarSidebarMode } from "./CalendarSidebar";
import MonthGrid from "./MonthGrid";
```

Inside the component (near line 31, after the existing hook calls), add the mode state:

```tsx
  const [sidebarMode, setSidebarMode] = useState<CalendarSidebarMode>("day");
```

Update the `<CalendarSidebar ... />` JSX (lines 114–128) to pass the new props:

```tsx
      <CalendarSidebar
        selectedDate={selectedDate}
        mode={sidebarMode}
        onModeChange={setSidebarMode}
        dayTodos={dayTodos}
        groupedTodoRows={groupedTodoRows}
        linkedNoteIds={linkedNoteIds}
        onNavigateToNote={onNavigateToNote}
        noteTitle={getNoteTitle}
        pinnedNotes={pinnedNotes}
        onCreateTodo={createTodo}
        onToggleTodo={toggleTodo}
        onUpdateTodo={handleUpdateTodo}
        onDeleteTodo={deleteTodo}
        onOpenDay={handleOpenDay}
        onSetTodoDueDate={handleSetTodoDueDate}
      />
```

Note: `CalendarSidebarMode` is already exported from `CalendarSidebar.tsx:17` — no export change needed.

- [ ] **Step 5: Typecheck and verify no behavior change**

Run:

```bash
npm run typecheck
```

Expected: exit code 0, no errors.

Run the dev app and confirm the sidebar tabs still switch between "일별 보기" and "전체 보기" as before, and that clicking a source date inside the All panel still switches the sidebar to Day view:

```bash
npm run dev
```

Expected manual checks:
- Open calendar view, click the "전체 보기" tab — sidebar switches to all view.
- Click "일별 보기" — sidebar switches back.
- While in "전체 보기", click the source-date button on any grouped todo — sidebar flips to "일별 보기" for that date. (This is the pre-existing behavior preserved by the refactor.)

- [ ] **Step 6: Commit**

```bash
git add src/components/calendar/CalendarPage.tsx src/components/calendar/CalendarSidebar.tsx
git commit -m "refactor(calendar): lift sidebar mode state to CalendarPage"
```

---

## Task 2: Plumb a double-click callback through `MonthGrid` to `DayCell`

**Why separately:** `MonthGrid`/`DayCell` currently have no notion of double-click. Adding the plumbing without wiring the behavior in `CalendarPage` yet keeps the diff small and lets the typecheck confirm the prop contract is right before we use it.

**Files:**
- Modify: `src/components/calendar/DayCell.tsx:1-10,30-59`
- Modify: `src/components/calendar/MonthGrid.tsx:7-15,99-122`

- [ ] **Step 1: Add `onDoubleClick` prop to `DayCell`**

Replace the props interface in `src/components/calendar/DayCell.tsx` (lines 1–10):

```tsx
interface DayCellProps {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  openCount: number;
  doneCount: number;
  hasNoteLinks: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}
```

Destructure the new prop (line 14–23):

```tsx
export default function DayCell({
  date,
  isCurrentMonth,
  isToday,
  isSelected,
  openCount,
  doneCount,
  hasNoteLinks,
  onClick,
  onDoubleClick,
}: DayCellProps) {
```

Wire it to the `<button>` element (line 31–42), adding `onDoubleClick={onDoubleClick}`:

```tsx
    <button
      type="button"
      className={[
        "day-cell",
        !isCurrentMonth && "dimmed",
        isToday && "today",
        isSelected && "selected",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
```

- [ ] **Step 2: Add `onOpenDay` prop to `MonthGrid` and forward it**

Update the `MonthGridProps` interface (lines 7–15) in `src/components/calendar/MonthGrid.tsx`:

```tsx
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

Destructure the new prop (lines 36–44):

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
```

Pass it into each `<DayCell />` (lines 108–120). The cell already receives `onClick={() => onSelectDate(dateKey)}`; add the matching `onDoubleClick`:

```tsx
              return (
                <DayCell
                  key={dateKey}
                  date={date}
                  isCurrentMonth={date.getMonth() === month}
                  isToday={dateKey === today}
                  isSelected={dateKey === selectedDate}
                  openCount={openCount}
                  doneCount={doneCount}
                  hasNoteLinks={hasNoteLinks}
                  onClick={() => onSelectDate(dateKey)}
                  onDoubleClick={() => onOpenDay(dateKey)}
                />
              );
```

- [ ] **Step 3: Temporary stub in `CalendarPage` to satisfy the type**

In `src/components/calendar/CalendarPage.tsx`, the `<MonthGrid />` JSX (around lines 105–113) does not yet pass `onOpenDay`. Typecheck will now fail until we pass it. For this task, wire it to the existing `handleOpenDay` callback (defined at line 56), which already sets `selectedDate` and adjusts `currentMonth`. The mode switch will be added in Task 3.

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

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck
```

Expected: exit code 0, no errors.

- [ ] **Step 5: Manual smoke test — double-click currently only selects**

```bash
npm run dev
```

Expected:
- Single-click a date: selects it (sidebar updates if in day view) — same as before.
- Double-click a date: fires `handleOpenDay` (selects + snaps month). Sidebar mode is **not yet** forced to "day" — Task 3 handles that.
- Typing into a todo input or interacting with an open panel should still work.

- [ ] **Step 6: Commit**

```bash
git add src/components/calendar/DayCell.tsx src/components/calendar/MonthGrid.tsx src/components/calendar/CalendarPage.tsx
git commit -m "feat(calendar): forward onDoubleClick from MonthGrid to DayCell"
```

---

## Task 3: Force sidebar to "day" mode on double-click

**Why separately:** With plumbing in place and mode state lifted, the behavior change is one tiny edit. Keeping it alone makes the commit a clean "here is the feature" entry in the log.

**Files:**
- Modify: `src/components/calendar/CalendarPage.tsx:56-63`

- [ ] **Step 1: Extend `handleOpenDay` to set sidebar mode to "day"**

In `src/components/calendar/CalendarPage.tsx`, replace the existing `handleOpenDay` (lines 56–63):

```tsx
  const handleOpenDay = useCallback(
    (dateKey: string) => {
      const sourceDate = parseDateKey(dateKey);
      setSelectedDate(dateKey);
      setCurrentMonth(new Date(sourceDate.getFullYear(), sourceDate.getMonth(), 1));
      setSidebarMode("day");
    },
    [setCurrentMonth, setSelectedDate]
  );
```

This callback is reused by three paths, and this change is intentional for all of them:

1. Month-grid double-click (new) → selects date + opens day view.
2. `AllTodosPanel`'s `onOpenSourceDate` (existing path at `CalendarSidebar.tsx:123`) → already explicitly calls `onModeChange("day")` afterward, so `setSidebarMode("day")` inside `handleOpenDay` becomes the single source of truth; the explicit call in `CalendarSidebar` becomes redundant.
3. Any future callers.

Note on dependencies: `setSidebarMode` is stable (returned by `useState`), so it does not need to go in the dependency array, but including it is harmless and satisfies `react-hooks/exhaustive-deps` style checkers if they get added later. Keep the array as shown.

- [ ] **Step 2: Remove the now-redundant explicit mode switch in `CalendarSidebar`**

In `src/components/calendar/CalendarSidebar.tsx`, the `AllTodosPanel` callback (lines 123–126 after Task 1's edits) can be simplified back to a single call, since `onOpenDay` now handles mode:

```tsx
            onOpenSourceDate={onOpenDay}
```

This also drops the need to reference `onModeChange` inside that branch; `onModeChange` is still used by the tab buttons.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: exit code 0, no errors.

- [ ] **Step 4: Manual verification of all three entry paths**

```bash
npm run dev
```

Expected checks:

Path A — Double-click from All view:
1. Open calendar, switch sidebar to "전체 보기".
2. Double-click any date in the month grid.
3. Sidebar flips to "일별 보기" showing that date's todos/linked notes. The clicked date is also selected (highlight ring) and the month grid snaps to that date's month if it was in an adjacent month.

Path B — Double-click from Day view:
1. Ensure sidebar is on "일별 보기".
2. Double-click a different date.
3. Selection + month snap update. Sidebar remains on day view (no visible mode flip since it was already there).

Path C — "Go to source date" from All view (regression check):
1. Switch sidebar to "전체 보기".
2. On any todo row with a source-date button, click it.
3. Sidebar flips to "일별 보기" for that source date (same as before Task 1).

Path D — Single-click (regression check):
1. Single-click a date in either mode.
2. In "일별 보기": sidebar updates to that date's content (existing behavior).
3. In "전체 보기": the date becomes `selected` in the grid but the sidebar stays in All view. This is intentional — single-click still only selects; double-click is the explicit "take me to this day" gesture.

- [ ] **Step 5: Commit**

```bash
git add src/components/calendar/CalendarPage.tsx src/components/calendar/CalendarSidebar.tsx
git commit -m "feat(calendar): switch sidebar to day view on month-grid double-click"
```

---

## Task 4: Final verification

**Files:** none modified.

- [ ] **Step 1: Full typecheck**

```bash
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 2: Smoke test the broader app**

```bash
npm run dev
```

Expected — nothing outside calendar should have changed:
- Notes view still renders and tab switching still works.
- Creating/toggling/updating todos still works on both day and all panels.
- Pinned notes and linked notes still open when clicked.
- Month navigation (prev / next / today buttons) unaffected.

- [ ] **Step 3: Update CHANGELOG or release notes if the project tracks them**

Skim the repo root and `docs/` for any `CHANGELOG.md` or release-notes file. If one exists, add a line under the unreleased / next-version section such as:

```markdown
- Double-click a date in the month grid to jump to that day's view.
```

If no such file exists, skip this step.

- [ ] **Step 4: Final commit (if step 3 added anything)**

```bash
git add CHANGELOG.md # or whichever file was updated
git commit -m "docs: note double-click navigation in calendar"
```

---

## Notes on trade-offs and alternatives considered

- **Single-click auto-switching in All view**: rejected because it would silently change the meaning of clicking a cell while in All view, and the AllTodosPanel already provides a deliberate "go to source date" button for single-gesture navigation. Double-click keeps the distinction between "just pick a date" and "commit to viewing that day".
- **Persisting `sidebarMode` in `calendarStore`**: not required for this feature — mode is ephemeral UI state and matches existing behavior (resets on mount). Can be added later if product wants mode to survive app restarts; would be a drop-in replacement of `useState` with a store slice.
- **Triggering mode switch from `MonthGrid` itself**: rejected. `MonthGrid` should not know about sidebar concerns. Orchestration belongs in `CalendarPage`, which is exactly why we lifted `sidebarMode` there.
- **Double-click delay / a11y**: relying on the native `onDoubleClick` DOM event is fine here — `DayCell` is a `<button>`, keyboard users still get Enter/Space → single-click select, and double-click is a pure enhancement (no information is inaccessible without it, since the tab buttons and the sidebar always give keyboard access to day mode).
