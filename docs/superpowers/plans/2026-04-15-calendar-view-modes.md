# Calendar View Modes & Done Tidying — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the calendar sidebar from 2 modes (day, all) to 4 (day, week, month, all), add configurable week-start day, and collapse done items by default with a "recent 7 days" filter in the All view.

**Architecture:** Add pure range-calculation utilities to `lib/calendarRange.ts`, introduce two internal shared components (`DoneSection`, `DateGroupedTodoList`), build `WeekTodosPanel`/`MonthTodosPanel` on top of them, modify `AllTodosPanel` to use `DoneSection` with a recency filter, and wire a new `weekStartsOn` preference through `App.tsx → CalendarPage → CalendarSidebar` plus a setting in `SettingsPanel`.

**Tech Stack:** React 18, TypeScript, Zustand (calendarStore). No test runner configured (`package.json` has only `typecheck`); verification is `npm run typecheck` + manual dev-server checks.

**Spec:** [docs/superpowers/specs/2026-04-15-calendar-view-modes-design.md](../specs/2026-04-15-calendar-view-modes-design.md)

---

## File Map

**Create**
- `src/lib/calendarRange.ts` — `WeekStart` type, `DEFAULT_WEEK_STARTS_ON`, `RECENT_DONE_DAYS`, `getWeekRange`, `getMonthRange`, `selectPeriodTodos`, `filterRowsWithinRecentDays`.
- `src/components/calendar/DoneSection.tsx` — shared collapsible done section; optional recency filter toggle.
- `src/components/calendar/DateGroupedTodoList.tsx` — shared layout: date-group list + `DoneSection`.
- `src/components/calendar/WeekTodosPanel.tsx` — thin wrapper: computes week range, feeds `DateGroupedTodoList`.
- `src/components/calendar/MonthTodosPanel.tsx` — same idea for month.

**Modify**
- `src/i18n/messages.ts` — new `calendar.*` and `settings.weekStartsOn*` keys in `ko` and `en`.
- `src/styles/calendar.css` — styles for 4-tab width, `.day-group-header`, `.done-section-*`.
- `src/components/calendar/AllTodosPanel.tsx` — swap inline done section for `DoneSection` with recency filter enabled.
- `src/components/calendar/CalendarSidebar.tsx` — extend `CalendarSidebarMode` to 4 values, add `weekStartsOn`/`data`/`todayDateKey` props, render new panels, update header labels.
- `src/components/calendar/CalendarPage.tsx` — accept `weekStartsOn` prop from `App`, pass through to sidebar, include `todayDateKey`.
- `src/components/SettingsPanel.tsx` — add "week start" select with new props.
- `src/App.tsx` — `WEEK_STARTS_ON_KEY` localStorage key, state + load/save, pass to `CalendarPage` and `SettingsPanel`.

---

## Conventions

- **No test runner exists.** Each task ends with `npm run typecheck`; manual verification is listed where behavior can be observed.
- **Commit early, commit small.** Every task ends with its own commit.
- **Follow existing patterns.** Preference state lives in `App.tsx` with a `hwan-note:*` localStorage key, loaded in one `useEffect([])` and saved in a dedicated `useEffect([value])`.
- **i18n:** two language blocks (`ko`, `en`) must stay in lockstep. Add the same keys to both.

---

## Task 1: Range calculation utilities

**Files:**
- Create: `src/lib/calendarRange.ts`

- [ ] **Step 1: Create the utilities file with full implementation**

Create `src/lib/calendarRange.ts`:

```ts
import {
  deriveCalendarTodoRows,
  formatDateKey,
  parseDateKey,
  type CalendarData,
  type CalendarTodoRow,
} from "./calendarData";

export type WeekStart = 0 | 1; // 0 = Sunday, 1 = Monday

export const DEFAULT_WEEK_STARTS_ON: WeekStart = 1;
export const RECENT_DONE_DAYS = 7;

export function isWeekStart(value: unknown): value is WeekStart {
  return value === 0 || value === 1;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

function listDateKeys(start: Date, count: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < count; i++) {
    keys.push(formatDateKey(addDays(start, i)));
  }
  return keys;
}

/**
 * Return the 7-day window for the week that contains `dateKey`, given a
 * week-start preference. `days[0]` is the start of the week.
 */
export function getWeekRange(
  dateKey: string,
  weekStartsOn: WeekStart
): { startKey: string; endKey: string; days: string[] } {
  const selected = parseDateKey(dateKey);
  const dow = selected.getDay(); // 0 = Sunday
  const delta = (dow - weekStartsOn + 7) % 7;
  const start = addDays(selected, -delta);
  const days = listDateKeys(start, 7);
  return { startKey: days[0], endKey: days[6], days };
}

/**
 * Return every day of the month that contains `dateKey`.
 */
export function getMonthRange(dateKey: string): {
  startKey: string;
  endKey: string;
  days: string[];
} {
  const selected = parseDateKey(dateKey);
  const year = selected.getFullYear();
  const month = selected.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const count = lastDay.getDate();
  const days = listDateKeys(firstDay, count);
  return { startKey: days[0], endKey: days[days.length - 1], days };
}

/**
 * Bucket todo rows into: by-day open items (only days with >=1 open item are
 * keyed) and a flat, newest-first list of done items. Only rows whose
 * `sourceDateKey` falls within `days` are included.
 */
export function selectPeriodTodos(
  data: CalendarData,
  days: string[],
  todayDateKey: string
): {
  openByDay: Record<string, CalendarTodoRow[]>;
  done: CalendarTodoRow[];
} {
  const dayIndex = new Set(days);
  const rows = deriveCalendarTodoRows(data, { todayDateKey }).filter((row) =>
    dayIndex.has(row.sourceDateKey)
  );

  const openByDay: Record<string, CalendarTodoRow[]> = {};
  const done: CalendarTodoRow[] = [];

  for (const row of rows) {
    if (row.done) {
      done.push(row);
    } else {
      const key = row.sourceDateKey;
      if (!openByDay[key]) {
        openByDay[key] = [];
      }
      openByDay[key].push(row);
    }
  }

  done.sort((a, b) => {
    const keyCmp = b.sourceDateKey.localeCompare(a.sourceDateKey);
    if (keyCmp !== 0) return keyCmp;
    return b.updatedAt - a.updatedAt;
  });

  for (const key of Object.keys(openByDay)) {
    openByDay[key].sort((a, b) => {
      if (a.dueDateKey !== b.dueDateKey) {
        if (a.dueDateKey === null) return 1;
        if (b.dueDateKey === null) return -1;
        return a.dueDateKey.localeCompare(b.dueDateKey);
      }
      return a.updatedAt - b.updatedAt;
    });
  }

  return { openByDay, done };
}

/**
 * Keep only rows whose `sourceDateKey` is within the last `RECENT_DONE_DAYS`
 * inclusive of `todayDateKey`.
 */
export function filterRowsWithinRecentDays(
  rows: CalendarTodoRow[],
  todayDateKey: string,
  windowDays = RECENT_DONE_DAYS
): CalendarTodoRow[] {
  const today = parseDateKey(todayDateKey);
  const cutoff = addDays(today, -(windowDays - 1));
  const cutoffKey = formatDateKey(cutoff);
  return rows.filter((row) => row.sourceDateKey >= cutoffKey);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: `0 errors`. Fix any before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/lib/calendarRange.ts
git commit -m "feat(calendar): add range utilities for week/month views"
```

---

## Task 2: DoneSection shared component

**Files:**
- Create: `src/components/calendar/DoneSection.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/calendar/DoneSection.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useI18n } from "../../i18n/context";
import {
  filterRowsWithinRecentDays,
  RECENT_DONE_DAYS,
} from "../../lib/calendarRange";
import type { CalendarTodoRow } from "../../lib/calendarData";
import TodoItem from "./TodoItem";

type DoneSectionProps = {
  rows: CalendarTodoRow[];
  todayDateKey: string;
  /** When true, show a "recent 7 days / all" filter when expanded. */
  enableRecencyFilter?: boolean;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onSelectSourceDate?: (dateKey: string) => void;
};

export default function DoneSection({
  rows,
  todayDateKey,
  enableRecencyFilter = false,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onSelectSourceDate,
}: DoneSectionProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<"recent" | "all">("recent");

  const visibleRows = useMemo(() => {
    if (!enableRecencyFilter || filter === "all") {
      return rows;
    }
    return filterRowsWithinRecentDays(rows, todayDateKey);
  }, [enableRecencyFilter, filter, rows, todayDateKey]);

  const totalCount = rows.length;
  const shownCount = visibleRows.length;

  if (totalCount === 0) {
    return null;
  }

  const toggleLabel = expanded
    ? t("calendar.doneExpanded", { count: totalCount })
    : t("calendar.doneCollapsed", { count: totalCount });

  return (
    <section className="done-section">
      <button
        type="button"
        className="done-section-toggle"
        aria-expanded={expanded}
        aria-controls="done-section-body"
        onClick={() => setExpanded((value) => !value)}
      >
        <span aria-hidden="true">{expanded ? "▼" : "▶"}</span>
        <span>{toggleLabel}</span>
      </button>

      {expanded && (
        <div id="done-section-body" className="done-section-body">
          {enableRecencyFilter && (
            <div className="done-section-filter" role="tablist" aria-label={t("calendar.doneFilterLabel")}>
              <button
                type="button"
                role="tab"
                aria-selected={filter === "recent"}
                className={`done-section-filter-btn ${filter === "recent" ? "active" : ""}`}
                onClick={() => setFilter("recent")}
              >
                {t("calendar.doneRecent", { days: RECENT_DONE_DAYS })}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filter === "all"}
                className={`done-section-filter-btn ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                {t("calendar.doneAll")}
              </button>
              <span className="done-section-filter-count">
                {filter === "recent"
                  ? t("calendar.doneCountRatio", { shown: shownCount, total: totalCount })
                  : t("calendar.doneCountTotal", { total: totalCount })}
              </span>
            </div>
          )}

          <div className="done-section-list">
            {visibleRows.map((row) => (
              <TodoItem
                key={`${row.sourceDateKey}:${row.id}`}
                item={row}
                sourceDateKey={row.sourceDateKey}
                showSourceDate
                isOverdue={false}
                onToggle={() => onToggleTodo(row.sourceDateKey, row.id)}
                onUpdate={(text) => onUpdateTodo(row.sourceDateKey, row.id, text)}
                onDelete={() => onDeleteTodo(row.sourceDateKey, row.id)}
                onSelectSourceDate={onSelectSourceDate}
                onSetDueDate={
                  onSetTodoDueDate
                    ? (dueDateKey) => onSetTodoDueDate(row.sourceDateKey, row.id, dueDateKey)
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Typecheck** — `npm run typecheck` must pass. (The `t()` calls reference i18n keys added in Task 6; TypeScript does not validate message key existence, so this passes before Task 6.)

- [ ] **Step 3: Commit**

```bash
git add src/components/calendar/DoneSection.tsx
git commit -m "feat(calendar): add shared collapsible DoneSection component"
```

---

## Task 3: DateGroupedTodoList shared component

**Files:**
- Create: `src/components/calendar/DateGroupedTodoList.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/calendar/DateGroupedTodoList.tsx`:

```tsx
import { useI18n } from "../../i18n/context";
import { parseDateKey, type CalendarTodoRow } from "../../lib/calendarData";
import TodoItem from "./TodoItem";
import DoneSection from "./DoneSection";

type DateGroupedTodoListProps = {
  days: string[]; // ordered; may include days with no open items
  openByDay: Record<string, CalendarTodoRow[]>;
  doneRows: CalendarTodoRow[];
  todayDateKey: string;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onSelectSourceDate?: (dateKey: string) => void;
};

export default function DateGroupedTodoList({
  days,
  openByDay,
  doneRows,
  todayDateKey,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onSelectSourceDate,
}: DateGroupedTodoListProps) {
  const { t, localeTag } = useI18n();

  const daysWithOpen = days.filter((dayKey) => (openByDay[dayKey]?.length ?? 0) > 0);
  const hasAnything = daysWithOpen.length > 0 || doneRows.length > 0;

  if (!hasAnything) {
    return <p className="todo-empty calendar-all-empty">{t("calendar.periodEmpty")}</p>;
  }

  return (
    <div className="calendar-period-panel">
      {daysWithOpen.map((dayKey) => {
        const rows = openByDay[dayKey];
        const label = parseDateKey(dayKey).toLocaleDateString(localeTag, {
          month: "short",
          day: "numeric",
          weekday: "short",
        });

        return (
          <section key={dayKey} className="calendar-day-group">
            <div className="day-group-header">
              <h4>{label}</h4>
              <span className="day-group-count">{rows.length}</span>
            </div>
            <div className="calendar-day-group-list">
              {rows.map((row) => (
                <TodoItem
                  key={`${row.sourceDateKey}:${row.id}`}
                  item={row}
                  sourceDateKey={row.sourceDateKey}
                  showSourceDate={false}
                  isOverdue={row.isOverdue}
                  onToggle={() => onToggleTodo(row.sourceDateKey, row.id)}
                  onUpdate={(text) => onUpdateTodo(row.sourceDateKey, row.id, text)}
                  onDelete={() => onDeleteTodo(row.sourceDateKey, row.id)}
                  onSelectSourceDate={onSelectSourceDate}
                  onSetDueDate={
                    onSetTodoDueDate
                      ? (dueDateKey) => onSetTodoDueDate(row.sourceDateKey, row.id, dueDateKey)
                      : undefined
                  }
                />
              ))}
            </div>
          </section>
        );
      })}

      <DoneSection
        rows={doneRows}
        todayDateKey={todayDateKey}
        enableRecencyFilter={false}
        onToggleTodo={onToggleTodo}
        onUpdateTodo={onUpdateTodo}
        onDeleteTodo={onDeleteTodo}
        onSetTodoDueDate={onSetTodoDueDate}
        onSelectSourceDate={onSelectSourceDate}
      />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck** — `npm run typecheck` must pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/calendar/DateGroupedTodoList.tsx
git commit -m "feat(calendar): add DateGroupedTodoList shared layout component"
```

---

## Task 4: WeekTodosPanel

**Files:**
- Create: `src/components/calendar/WeekTodosPanel.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/calendar/WeekTodosPanel.tsx`:

```tsx
import { useMemo } from "react";
import type { CalendarData } from "../../lib/calendarData";
import { getWeekRange, selectPeriodTodos, type WeekStart } from "../../lib/calendarRange";
import DateGroupedTodoList from "./DateGroupedTodoList";

type WeekTodosPanelProps = {
  data: CalendarData;
  selectedDate: string;
  weekStartsOn: WeekStart;
  todayDateKey: string;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onOpenSourceDate: (dateKey: string) => void;
};

export default function WeekTodosPanel({
  data,
  selectedDate,
  weekStartsOn,
  todayDateKey,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onOpenSourceDate,
}: WeekTodosPanelProps) {
  const { days } = useMemo(
    () => getWeekRange(selectedDate, weekStartsOn),
    [selectedDate, weekStartsOn]
  );

  const { openByDay, done } = useMemo(
    () => selectPeriodTodos(data, days, todayDateKey),
    [data, days, todayDateKey]
  );

  return (
    <DateGroupedTodoList
      days={days}
      openByDay={openByDay}
      doneRows={done}
      todayDateKey={todayDateKey}
      onToggleTodo={onToggleTodo}
      onUpdateTodo={onUpdateTodo}
      onDeleteTodo={onDeleteTodo}
      onSetTodoDueDate={onSetTodoDueDate}
      onSelectSourceDate={onOpenSourceDate}
    />
  );
}
```

- [ ] **Step 2: Typecheck** — `npm run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add src/components/calendar/WeekTodosPanel.tsx
git commit -m "feat(calendar): add WeekTodosPanel component"
```

---

## Task 5: MonthTodosPanel

**Files:**
- Create: `src/components/calendar/MonthTodosPanel.tsx`

- [ ] **Step 1: Create the component**

Create `src/components/calendar/MonthTodosPanel.tsx`:

```tsx
import { useMemo } from "react";
import type { CalendarData } from "../../lib/calendarData";
import { getMonthRange, selectPeriodTodos } from "../../lib/calendarRange";
import DateGroupedTodoList from "./DateGroupedTodoList";

type MonthTodosPanelProps = {
  data: CalendarData;
  selectedDate: string;
  todayDateKey: string;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onOpenSourceDate: (dateKey: string) => void;
};

export default function MonthTodosPanel({
  data,
  selectedDate,
  todayDateKey,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onOpenSourceDate,
}: MonthTodosPanelProps) {
  const { days } = useMemo(() => getMonthRange(selectedDate), [selectedDate]);

  const { openByDay, done } = useMemo(
    () => selectPeriodTodos(data, days, todayDateKey),
    [data, days, todayDateKey]
  );

  return (
    <DateGroupedTodoList
      days={days}
      openByDay={openByDay}
      doneRows={done}
      todayDateKey={todayDateKey}
      onToggleTodo={onToggleTodo}
      onUpdateTodo={onUpdateTodo}
      onDeleteTodo={onDeleteTodo}
      onSetTodoDueDate={onSetTodoDueDate}
      onSelectSourceDate={onOpenSourceDate}
    />
  );
}
```

- [ ] **Step 2: Typecheck** — `npm run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add src/components/calendar/MonthTodosPanel.tsx
git commit -m "feat(calendar): add MonthTodosPanel component"
```

---

## Task 6: i18n keys (ko + en)

**Files:**
- Modify: `src/i18n/messages.ts`

- [ ] **Step 1: Add Korean keys**

In `src/i18n/messages.ts`, find the `ko` block where calendar keys end (line ~205, after `"calendar.groupDone": "완료"`). Add these keys immediately after `"calendar.groupDone": "완료"` (keep the trailing comma on the previous entry):

```ts
    "calendar.viewWeek": "주간 보기",
    "calendar.viewMonth": "월간 보기",
    "calendar.weekViewTitle": "{start} – {end}",
    "calendar.weekViewSubtitle": "이번 주 할 일",
    "calendar.monthViewTitle": "{year}년 {month}",
    "calendar.monthViewSubtitle": "이번 달 할 일",
    "calendar.periodEmpty": "이 기간에 할 일이 없습니다.",
    "calendar.doneCollapsed": "완료 ({count})",
    "calendar.doneExpanded": "완료 ({count})",
    "calendar.doneRecent": "최근 {days}일",
    "calendar.doneAll": "전체",
    "calendar.doneFilterLabel": "완료 기간 필터",
    "calendar.doneCountRatio": "{shown} / {total}",
    "calendar.doneCountTotal": "{total}",
    "settings.weekStartsOn": "주의 시작 요일",
    "settings.weekStartsOnSunday": "일요일",
    "settings.weekStartsOnMonday": "월요일",
```

- [ ] **Step 2: Add English keys**

In the same file, find the `en` block's matching location (after `"calendar.groupDone": "Done"`, line ~402). Add:

```ts
    "calendar.viewWeek": "Week",
    "calendar.viewMonth": "Month",
    "calendar.weekViewTitle": "{start} – {end}",
    "calendar.weekViewSubtitle": "Tasks for this week",
    "calendar.monthViewTitle": "{month} {year}",
    "calendar.monthViewSubtitle": "Tasks for this month",
    "calendar.periodEmpty": "No tasks in this period.",
    "calendar.doneCollapsed": "Done ({count})",
    "calendar.doneExpanded": "Done ({count})",
    "calendar.doneRecent": "Last {days} days",
    "calendar.doneAll": "All",
    "calendar.doneFilterLabel": "Done filter",
    "calendar.doneCountRatio": "{shown} / {total}",
    "calendar.doneCountTotal": "{total}",
    "settings.weekStartsOn": "Week starts on",
    "settings.weekStartsOnSunday": "Sunday",
    "settings.weekStartsOnMonday": "Monday",
```

- [ ] **Step 3: Typecheck** — `npm run typecheck`.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/messages.ts
git commit -m "i18n(calendar): add keys for week/month views and done filter"
```

---

## Task 7: AllTodosPanel — use DoneSection with recency filter

**Files:**
- Modify: `src/components/calendar/AllTodosPanel.tsx`

- [ ] **Step 1: Replace the inline done section with `DoneSection`**

Overwrite `src/components/calendar/AllTodosPanel.tsx` with:

```tsx
import { useI18n } from "../../i18n/context";
import {
  CALENDAR_TODO_GROUP_ORDER,
  type CalendarTodoGroup,
  type CalendarTodoRow,
} from "../../lib/calendarData";
import DoneSection from "./DoneSection";
import TodoItem from "./TodoItem";

interface AllTodosPanelProps {
  groupedRows: Record<CalendarTodoGroup, CalendarTodoRow[]>;
  todayDateKey: string;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onOpenSourceDate: (dateKey: string) => void;
}

const OPEN_GROUPS = CALENDAR_TODO_GROUP_ORDER.filter(
  (group): group is Exclude<CalendarTodoGroup, "done"> => group !== "done"
);

export default function AllTodosPanel({
  groupedRows,
  todayDateKey,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onOpenSourceDate,
}: AllTodosPanelProps) {
  const { t } = useI18n();

  const sectionTitleByKey = {
    overdue: t("calendar.groupOverdue"),
    dueSoon: t("calendar.groupDueSoon"),
    upcoming: t("calendar.groupUpcoming"),
    noDueDate: t("calendar.groupNoDueDate"),
  } as const;

  const openSections = OPEN_GROUPS.map((key) => ({
    key,
    title: sectionTitleByKey[key],
    items: groupedRows[key],
  })).filter((section) => section.items.length > 0);

  const doneRows = groupedRows.done;
  const hasAnything = openSections.length > 0 || doneRows.length > 0;

  if (!hasAnything) {
    return <p className="todo-empty calendar-all-empty">{t("calendar.allTodosEmpty")}</p>;
  }

  return (
    <div className="calendar-all-panel">
      {openSections.map((section) => (
        <section key={section.key} className="calendar-task-section">
          <div className="calendar-task-section-header">
            <h4>{section.title}</h4>
            <span className="calendar-task-section-count">{section.items.length}</span>
          </div>

          <div className="calendar-task-section-list">
            {section.items.map((row) => (
              <TodoItem
                key={`${row.sourceDateKey}:${row.id}`}
                item={row}
                sourceDateKey={row.sourceDateKey}
                showSourceDate
                isOverdue={row.isOverdue}
                onToggle={() => onToggleTodo(row.sourceDateKey, row.id)}
                onUpdate={(text) => onUpdateTodo(row.sourceDateKey, row.id, text)}
                onDelete={() => onDeleteTodo(row.sourceDateKey, row.id)}
                onSelectSourceDate={onOpenSourceDate}
                onSetDueDate={
                  onSetTodoDueDate
                    ? (dueDateKey) => onSetTodoDueDate(row.sourceDateKey, row.id, dueDateKey)
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      ))}

      <DoneSection
        rows={doneRows}
        todayDateKey={todayDateKey}
        enableRecencyFilter
        onToggleTodo={onToggleTodo}
        onUpdateTodo={onUpdateTodo}
        onDeleteTodo={onDeleteTodo}
        onSetTodoDueDate={onSetTodoDueDate}
        onSelectSourceDate={onOpenSourceDate}
      />
    </div>
  );
}
```

Note the new required prop `todayDateKey`. Callers are fixed in Task 8.

- [ ] **Step 2: Typecheck** — `npm run typecheck`.

Expected: **One error** about `AllTodosPanel` being rendered without `todayDateKey` from `CalendarSidebar`. That's fine — fixed in Task 8. If you see other errors, they are real.

- [ ] **Step 3: Commit**

```bash
git add src/components/calendar/AllTodosPanel.tsx
git commit -m "feat(calendar): use DoneSection in AllTodosPanel with recency filter"
```

---

## Task 8: CalendarSidebar — extend to 4 modes

**Files:**
- Modify: `src/components/calendar/CalendarSidebar.tsx`

- [ ] **Step 1: Rewrite CalendarSidebar**

Overwrite `src/components/calendar/CalendarSidebar.tsx` with:

```tsx
import { useMemo } from "react";
import { useI18n } from "../../i18n/context";
import {
  parseDateKey,
  type CalendarData,
  type CalendarTodoGroup,
  type CalendarTodoRow,
  type TodoItem,
} from "../../lib/calendarData";
import { getWeekRange, type WeekStart } from "../../lib/calendarRange";
import AllTodosPanel from "./AllTodosPanel";
import DayTodosPanel from "./DayTodosPanel";
import MonthTodosPanel from "./MonthTodosPanel";
import WeekTodosPanel from "./WeekTodosPanel";

export interface PinnedNote {
  id: string;
  title: string;
}

export type CalendarSidebarMode = "day" | "week" | "month" | "all";

interface CalendarSidebarProps {
  selectedDate: string;
  todayDateKey: string;
  mode: CalendarSidebarMode;
  onModeChange: (mode: CalendarSidebarMode) => void;
  data: CalendarData;
  weekStartsOn: WeekStart;
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

const MODES: CalendarSidebarMode[] = ["day", "week", "month", "all"];

export default function CalendarSidebar({
  selectedDate,
  todayDateKey,
  mode,
  onModeChange,
  data,
  weekStartsOn,
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

  const weekRangeLabel = useMemo(() => {
    const { startKey, endKey } = getWeekRange(selectedDate, weekStartsOn);
    const startLabel = parseDateKey(startKey).toLocaleDateString(localeTag, {
      month: "short",
      day: "numeric",
    });
    const endLabel = parseDateKey(endKey).toLocaleDateString(localeTag, {
      month: "short",
      day: "numeric",
    });
    return t("calendar.weekViewTitle", { start: startLabel, end: endLabel });
  }, [localeTag, selectedDate, t, weekStartsOn]);

  const monthLabel = useMemo(() => {
    const parsed = parseDateKey(selectedDate);
    const year = parsed.getFullYear();
    const month = parsed.toLocaleDateString(localeTag, { month: "long" });
    return t("calendar.monthViewTitle", { year, month });
  }, [localeTag, selectedDate, t]);

  const eyebrowByMode: Record<CalendarSidebarMode, string> = {
    day: t("calendar.viewDay"),
    week: t("calendar.viewWeek"),
    month: t("calendar.viewMonth"),
    all: t("calendar.viewAll"),
  };

  const titleByMode: Record<CalendarSidebarMode, string> = {
    day: selectedDateLabel,
    week: weekRangeLabel,
    month: monthLabel,
    all: t("calendar.allViewTitle"),
  };

  const subtitleByMode: Record<CalendarSidebarMode, string> = {
    day: t("calendar.dayViewSubtitle"),
    week: t("calendar.weekViewSubtitle"),
    month: t("calendar.monthViewSubtitle"),
    all: t("calendar.allViewSubtitle"),
  };

  return (
    <aside className="calendar-sidebar">
      <div className="calendar-sidebar-header">
        <div className="calendar-sidebar-heading">
          <span className="calendar-sidebar-eyebrow">{eyebrowByMode[mode]}</span>
          <h3 className="calendar-sidebar-title">{titleByMode[mode]}</h3>
          <p className="calendar-sidebar-subtitle">{subtitleByMode[mode]}</p>
        </div>

        <div className="calendar-view-switch" role="tablist" aria-label={t("calendar.title")}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={`calendar-view-switch-btn ${mode === m ? "active" : ""}`}
              onClick={() => onModeChange(m)}
            >
              {eyebrowByMode[m]}
            </button>
          ))}
        </div>
      </div>

      <div className="calendar-sidebar-content">
        {mode === "day" && (
          <DayTodosPanel
            selectedDate={selectedDate}
            dayTodos={dayTodos}
            linkedNoteIds={linkedNoteIds}
            pinnedNotes={pinnedNotes}
            onCreateTodo={onCreateTodo}
            onToggleTodo={onToggleTodo}
            onUpdateTodo={onUpdateTodo}
            onDeleteTodo={onDeleteTodo}
            onSetTodoDueDate={onSetTodoDueDate}
            onNavigateToNote={onNavigateToNote}
            noteTitle={noteTitle}
          />
        )}
        {mode === "week" && (
          <WeekTodosPanel
            data={data}
            selectedDate={selectedDate}
            weekStartsOn={weekStartsOn}
            todayDateKey={todayDateKey}
            onToggleTodo={onToggleTodo}
            onUpdateTodo={onUpdateTodo}
            onDeleteTodo={onDeleteTodo}
            onSetTodoDueDate={onSetTodoDueDate}
            onOpenSourceDate={onOpenDay}
          />
        )}
        {mode === "month" && (
          <MonthTodosPanel
            data={data}
            selectedDate={selectedDate}
            todayDateKey={todayDateKey}
            onToggleTodo={onToggleTodo}
            onUpdateTodo={onUpdateTodo}
            onDeleteTodo={onDeleteTodo}
            onSetTodoDueDate={onSetTodoDueDate}
            onOpenSourceDate={onOpenDay}
          />
        )}
        {mode === "all" && (
          <AllTodosPanel
            groupedRows={groupedTodoRows}
            todayDateKey={todayDateKey}
            onToggleTodo={onToggleTodo}
            onUpdateTodo={onUpdateTodo}
            onDeleteTodo={onDeleteTodo}
            onSetTodoDueDate={onSetTodoDueDate}
            onOpenSourceDate={onOpenDay}
          />
        )}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Typecheck** — `npm run typecheck`.

Expected: errors about `CalendarPage` not passing new props (`data`, `todayDateKey`, `weekStartsOn`). Fixed in Task 9.

- [ ] **Step 3: Commit**

```bash
git add src/components/calendar/CalendarSidebar.tsx
git commit -m "feat(calendar): extend sidebar to day/week/month/all modes"
```

---

## Task 9: CalendarPage — pass new props through

**Files:**
- Modify: `src/components/calendar/CalendarPage.tsx`

- [ ] **Step 1: Add `weekStartsOn` prop and pass new values**

Replace `src/components/calendar/CalendarPage.tsx` with:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDateKey, parseDateKey, type TodoItem } from "../../lib/calendarData";
import type { WeekStart } from "../../lib/calendarRange";
import { useNoteStore } from "../../stores/noteStore";
import { selectTodoRowsByGroup, useCalendarStore } from "../../stores/calendarStore";
import CalendarSidebar, { type CalendarSidebarMode } from "./CalendarSidebar";
import MonthGrid from "./MonthGrid";

interface CalendarPageProps {
  onNavigateToNote: (noteId: string) => void;
  weekStartsOn: WeekStart;
}

type TodoUpdateFn = (
  dateKey: string,
  todoId: string,
  updates: Partial<Pick<TodoItem, "text" | "done">>
) => void;

export default function CalendarPage({ onNavigateToNote, weekStartsOn }: CalendarPageProps) {
  const todayDateKey = formatDateKey(new Date());
  const data = useCalendarStore((s) => s.data);
  const selectedDate = useCalendarStore((s) => s.selectedDate);
  const currentMonth = useCalendarStore((s) => s.currentMonth);
  const loaded = useCalendarStore((s) => s.loaded);
  const loadCalendarData = useCalendarStore((s) => s.loadCalendarData);
  const setSelectedDate = useCalendarStore((s) => s.setSelectedDate);
  const setCurrentMonth = useCalendarStore((s) => s.setCurrentMonth);
  const createTodo = useCalendarStore((s) => s.createTodo);
  const toggleTodo = useCalendarStore((s) => s.toggleTodo);
  const updateTodo = useCalendarStore((s) => s.updateTodo) as TodoUpdateFn;
  const deleteTodo = useCalendarStore((s) => s.deleteTodo);
  const setTodoDueDate = useCalendarStore((s) => s.setTodoDueDate);

  const notesById = useNoteStore((s) => s.notesById);
  const allNotes = useNoteStore((s) => s.allNotes);

  const [sidebarMode, setSidebarMode] = useState<CalendarSidebarMode>("day");

  useEffect(() => {
    if (!loaded) {
      void loadCalendarData();
    }
  }, [loaded, loadCalendarData]);

  const handlePrevMonth = useCallback(() => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  }, [currentMonth, setCurrentMonth]);

  const handleNextMonth = useCallback(() => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  }, [currentMonth, setCurrentMonth]);

  const handleToday = useCallback(() => {
    const now = new Date();
    setCurrentMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedDate(formatDateKey(now));
  }, [setCurrentMonth, setSelectedDate]);

  const handleOpenDay = useCallback(
    (dateKey: string) => {
      const sourceDate = parseDateKey(dateKey);
      setSelectedDate(dateKey);
      setCurrentMonth(new Date(sourceDate.getFullYear(), sourceDate.getMonth(), 1));
      setSidebarMode("day");
    },
    [setCurrentMonth, setSelectedDate, setSidebarMode]
  );

  const handleUpdateTodo = useCallback(
    (dateKey: string, todoId: string, text: string) => {
      updateTodo(dateKey, todoId, { text });
    },
    [updateTodo]
  );

  const handleSetTodoDueDate = useCallback(
    (dateKey: string, todoId: string, dueDateKey: string | null) => {
      setTodoDueDate(dateKey, todoId, dueDateKey);
    },
    [setTodoDueDate]
  );

  const linkedNoteIds = data.noteLinks[selectedDate] ?? [];
  const pinnedNotes = useMemo(
    () =>
      allNotes.filter((note) => note.isPinned).map((note) => ({
        id: note.id,
        title: note.title,
      })),
    [allNotes]
  );

  const getNoteTitle = useCallback(
    (noteId: string) => {
      return notesById[noteId]?.title ?? noteId;
    },
    [notesById]
  );

  const groupedTodoRows = useMemo(
    () => selectTodoRowsByGroup({ data }, { todayDateKey }),
    [data, todayDateKey]
  );

  const dayTodos = data.todos[selectedDate]?.items ?? [];

  return (
    <div className="calendar-page">
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
      <CalendarSidebar
        selectedDate={selectedDate}
        todayDateKey={todayDateKey}
        mode={sidebarMode}
        onModeChange={setSidebarMode}
        data={data}
        weekStartsOn={weekStartsOn}
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
    </div>
  );
}
```

- [ ] **Step 2: Typecheck** — `npm run typecheck`.

Expected: one error about `App.tsx` not passing `weekStartsOn` to `CalendarPage`. Fixed in Task 10.

- [ ] **Step 3: Commit**

```bash
git add src/components/calendar/CalendarPage.tsx
git commit -m "feat(calendar): wire weekStartsOn and new sidebar props through CalendarPage"
```

---

## Task 10: App.tsx — persist `weekStartsOn` and pass to CalendarPage

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the localStorage key constant**

Find the block of `_KEY` constants at the top of `src/App.tsx` (around line 39–45). Add one line alphabetically next to existing keys:

```ts
const WEEK_STARTS_ON_KEY = "hwan-note:week-starts-on";
```

- [ ] **Step 2: Import the WeekStart type and helpers**

Near the top of `src/App.tsx`, add (or extend an existing import of `./lib/…` if colocated):

```ts
import { DEFAULT_WEEK_STARTS_ON, isWeekStart, type WeekStart } from "./lib/calendarRange";
```

- [ ] **Step 3: Add state next to other preferences**

Find the line declaring `const [themeMode, setThemeMode] = useState<ThemeMode>("light");` (~line 669). Below the existing preference states (spellcheck/tabSize etc.), add:

```ts
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStart>(DEFAULT_WEEK_STARTS_ON);
```

- [ ] **Step 4: Load from localStorage in the existing load `useEffect`**

Inside the existing `useEffect(() => { ... }, [])` that loads theme/font/etc. (~line 967 start), add one more `try` block at the end of that effect (before the closing `}, []);`):

```ts
    try {
      const rawWeekStartsOn = window.localStorage.getItem(WEEK_STARTS_ON_KEY);
      if (rawWeekStartsOn !== null) {
        const parsed = Number.parseInt(rawWeekStartsOn, 10);
        if (isWeekStart(parsed)) {
          setWeekStartsOn(parsed);
        }
      }
    } catch (error) {
      console.warn("Failed to load week-starts-on", error);
    }
```

- [ ] **Step 5: Save on change**

Immediately after the existing `useEffect(() => { window.localStorage.setItem(EDITOR_SPELLCHECK_KEY, String(editorSpellcheck)); }, [editorSpellcheck]);` block (~line 1047), add:

```ts
  useEffect(() => {
    window.localStorage.setItem(WEEK_STARTS_ON_KEY, String(weekStartsOn));
  }, [weekStartsOn]);
```

- [ ] **Step 6: Pass `weekStartsOn` to `CalendarPage`**

Find where `<CalendarPage` is rendered in `src/App.tsx` (search for `CalendarPage`). Add the `weekStartsOn` prop:

```tsx
<CalendarPage onNavigateToNote={...} weekStartsOn={weekStartsOn} />
```

(Keep any existing props; add `weekStartsOn={weekStartsOn}` alongside them.)

- [ ] **Step 7: Pass new props to `<SettingsPanel …>`**

Find the `<SettingsPanel` element (~line 2282, where `themeMode={themeMode}` appears). Add:

```tsx
  weekStartsOn={weekStartsOn}
  onWeekStartsOnChange={setWeekStartsOn}
```

alongside the existing props.

- [ ] **Step 8: Typecheck** — `npm run typecheck`.

Expected: one error about `SettingsPanel` not declaring `weekStartsOn`/`onWeekStartsOnChange` props. Fixed in Task 11.

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx
git commit -m "feat(calendar): persist weekStartsOn preference and thread through App"
```

---

## Task 11: SettingsPanel — week-start selector

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Import WeekStart type**

At the top of `src/components/SettingsPanel.tsx`, add:

```ts
import type { WeekStart } from "../lib/calendarRange";
```

- [ ] **Step 2: Extend `SettingsPanelProps`**

Inside the `SettingsPanelProps` interface, alongside other existing prop declarations, add:

```ts
  weekStartsOn: WeekStart;
  onWeekStartsOnChange: (value: WeekStart) => void;
```

- [ ] **Step 3: Destructure the new props**

In the component signature where other props are destructured, add `weekStartsOn,` and `onWeekStartsOnChange,`.

- [ ] **Step 4: Render the select**

Find the language `settings-item` block (the one with `<label htmlFor="language">`). Directly after its closing `</div>`, insert a new setting block:

```tsx
          <div className="settings-item">
            <label htmlFor="week-starts-on">{t("settings.weekStartsOn")}</label>
            <select
              id="week-starts-on"
              value={weekStartsOn}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10) as WeekStart;
                onWeekStartsOnChange(parsed === 0 ? 0 : 1);
              }}
            >
              <option value={1}>{t("settings.weekStartsOnMonday")}</option>
              <option value={0}>{t("settings.weekStartsOnSunday")}</option>
            </select>
          </div>
```

- [ ] **Step 5: Typecheck** — `npm run typecheck` should now pass with 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "feat(settings): add week-start selector"
```

---

## Task 12: CSS — new classes and wider mode switch

**Files:**
- Modify: `src/styles/calendar.css`

- [ ] **Step 1: Append new styles**

At the end of `src/styles/calendar.css`, append:

```css
/* 4-mode switch: allow more room */
.calendar-view-switch {
  flex-wrap: wrap;
}

.calendar-view-switch-btn {
  padding: 4px 10px;
  font-size: 12px;
}

/* Date-grouped layout for week/month */
.calendar-period-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.calendar-day-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.day-group-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 2px;
}

.day-group-header h4 {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.day-group-count {
  font-size: 11px;
  color: var(--text-tertiary);
  background: var(--bg-subtle);
  padding: 1px 6px;
  border-radius: 10px;
}

.calendar-day-group-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Collapsible done section */
.done-section {
  margin-top: 12px;
  border-top: 1px solid var(--border-subtle);
  padding-top: 8px;
}

.done-section-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 6px;
}

.done-section-toggle:hover {
  background: var(--bg-subtle);
}

.done-section-body {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.done-section-filter {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px;
  background: var(--bg-subtle);
  border-radius: 6px;
  align-self: flex-start;
  margin-bottom: 4px;
}

.done-section-filter-btn {
  border: none;
  background: transparent;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  border-radius: 4px;
  cursor: pointer;
}

.done-section-filter-btn.active {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.done-section-filter-count {
  margin-left: 6px;
  font-size: 11px;
  color: var(--text-tertiary);
}

.done-section-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
```

- [ ] **Step 2: Dev-server visual check**

Run: `npm run dev:frontend`
Manually verify in the browser:
1. Open calendar. See 4 tabs in the sidebar header (일별/주간/월간/전체).
2. Click 주간. Empty state or day-group headers render without visual glitches.
3. Click 월간. Same.
4. Click 전체. Done section at the bottom is collapsed by default; clicking expands and shows a "최근 7일 / 전체" filter.

Stop the dev server with Ctrl+C.

- [ ] **Step 3: Commit**

```bash
git add src/styles/calendar.css
git commit -m "style(calendar): add period-panel and done-section styles"
```

---

## Task 13: Final verification

**Files:** — (no code changes)

- [ ] **Step 1: Typecheck passes cleanly**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2: Manual verification checklist**

Run `npm run dev:frontend` and verify each item:

- [ ] 4 modes switch works: day, week, month, all
- [ ] Day view unchanged from before
- [ ] Week view with `weekStartsOn=1` shows Monday–Sunday; changing setting to Sunday re-renders as Sunday–Saturday immediately
- [ ] Week range label in header shows both endpoints (e.g. "Apr 14 – Apr 20")
- [ ] Clicking a date in a different week/month on the month grid updates the week/month view's range accordingly
- [ ] Done section in Week/Month/All is collapsed by default, with count e.g. `▶ 완료 (8)`
- [ ] Expanding done in All view shows "최근 7일 / 전체" tabs; recent is default
- [ ] Switching Recent → All in All view changes the list and count ratio (`3 / 12` vs `12`)
- [ ] Overdue todo whose source date is outside the visible week/month does NOT appear in that view; it still appears in All view under "지난 마감"
- [ ] Reload the app after changing `weekStartsOn` in settings — preference persists
- [ ] Empty period (week/month with no open + no done) shows "이 기간에 할 일이 없습니다." message

- [ ] **Step 3: Final commit if any tweaks were needed**

If the manual verification revealed a fix you made:

```bash
git add -A
git commit -m "fix(calendar): <short description of the manual-verify fix>"
```

Otherwise the plan is complete — no final commit required.

---

## Self-review notes

All spec requirements from `2026-04-15-calendar-view-modes-design.md` are covered:

- Section 2 (architecture): Tasks 1–11.
- Section 3 (UI): Tasks 6 (copy), 12 (CSS), 7/8/9 (rendering).
- Section 4 (edge cases): `periodEmpty` empty state (Task 6/3), range-only filtering (Task 1's `selectPeriodTodos`), month boundary (Task 1's `getMonthRange` uses `new Date(year, month + 1, 0)` which is always the correct last day), weekStartsOn live-reactivity (useMemo dependency in Task 4).

Type consistency across tasks:
- `WeekStart`, `DEFAULT_WEEK_STARTS_ON`, `RECENT_DONE_DAYS`, `isWeekStart` defined in Task 1; consumed in Tasks 2, 4, 5, 8, 10, 11.
- `DoneSection` prop `enableRecencyFilter` matches between Task 2 (definition), Task 3 (uses `false`), Task 7 (uses `true`).
- `DateGroupedTodoList` signature matches usage in Tasks 4 and 5.
- i18n keys used in Tasks 2, 3, 7, 8, 11 all defined in Task 6.
- `CalendarSidebar` new props (`data`, `todayDateKey`, `weekStartsOn`) added in Task 8 match what `CalendarPage` provides in Task 9.
