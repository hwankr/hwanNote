# Undated (Inbox) Todos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to add todos that are not tied to any calendar date. Undated todos appear in a dedicated "Inbox" section in the All-tasks sidebar view and never appear on the month grid or in day/week/month panels. A user can still assign a due date to an undated todo after the fact; if they do, the todo keeps living in the inbox but gets routed to the appropriate due-date group (overdue/due-soon/upcoming).

**Architecture:** Add a parallel `inbox: TodoItem[]` array to `CalendarData` (bump storage version `v2 → v3` with migration). Loosen `CalendarTodoRow.sourceDateKey` to `string | null` and add an `isInbox` flag so existing selectors can carry inbox rows without forcing a full refactor. Introduce a new `"inbox"` group in `CalendarTodoGroup` (undated + no due date → inbox group; undated + has due date → regular dated group). Add new Zustand actions (`createInboxTodo`, `updateInboxTodo`, `toggleInboxTodo`, `deleteInboxTodo`, `setInboxTodoDueDate`). In `AllTodosPanel`, add an inbox add-row + section that dispatches row callbacks to inbox actions when `row.isInbox === true`. Day/Week/Month panels automatically skip inbox rows because `selectPeriodTodos` filters by `sourceDateKey`.

**Tech Stack:** React 18, TypeScript, Zustand (`calendarStore`). No test runner configured; verification is `npm run typecheck` + manual dev-server checks (same convention as the existing [2026-04-15 plan](2026-04-15-calendar-view-modes.md)).

---

## File Map

**Modify**
- `src/lib/calendarData.ts` — bump `CALENDAR_DATA_VERSION` to 3, add `CalendarDataV3` with `inbox`, new `migrateCalendarDataV2ToV3` + `normalizeCalendarDataV3`, extend `CalendarTodoRow` and `CalendarTodoGroup`, update `deriveCalendarTodoRows` / `getCalendarTodoGroup` / `compareCalendarTodoRows` / grouping.
- `src/lib/calendarRange.ts` — in `selectPeriodTodos`, skip rows whose `sourceDateKey` is `null`.
- `src/stores/calendarStore.ts` — add inbox CRUD actions.
- `src/i18n/messages.ts` — add `calendar.inboxTitle`, `calendar.inboxSubtitle`, `calendar.inboxAdd`, `calendar.inboxEmpty`, `calendar.groupInbox` to both `ko` and `en`.
- `src/components/calendar/TodoItem.tsx` — accept `sourceDateKey: string | null | undefined`; hide the source-date chip when null/undefined.
- `src/components/calendar/DoneSection.tsx` — accept optional inbox callbacks; route each row's toggle/update/delete/setDueDate based on `row.isInbox` and nullable `sourceDateKey`.
- `src/components/calendar/DateGroupedTodoList.tsx` — tolerate null `sourceDateKey` in its internal TodoItem callbacks (inbox rows are filtered before they reach this component, but typing must allow null).
- `src/components/calendar/AllTodosPanel.tsx` — add inbox add-row + inbox section; dispatch per-row callbacks based on `row.isInbox`; pass inbox callbacks to `DoneSection`.
- `src/components/calendar/CalendarSidebar.tsx` — thread inbox callbacks from parent to `AllTodosPanel`.
- `src/components/calendar/CalendarPage.tsx` — read inbox actions from the store and pass them through.

**Not modified** — `MonthGrid.tsx`, `DayCell.tsx`, `DayTodosPanel.tsx`, `WeekTodosPanel.tsx`, `MonthTodosPanel.tsx`: these derive display data from `data.todos` / `selectPeriodTodos` and so never see inbox rows.

---

## Conventions

- **No test runner exists.** Every task ends with `npm run typecheck`. Manual verification steps call out observable behavior.
- **Commit early, commit small.** Every task ends with its own commit.
- **i18n parity.** `ko` and `en` blocks in `src/i18n/messages.ts` must receive the same keys.
- **Storage migration.** Treat a `calendar.json` without an `inbox` field as empty inbox. Never delete or rewrite dated todos during migration.

---

## Task 1: Data model v3 — inbox array + migration

**Files:**
- Modify: `src/lib/calendarData.ts`

- [ ] **Step 1: Bump `CALENDAR_DATA_VERSION` and declare the v3 data shape**

In `src/lib/calendarData.ts`, replace the existing `CalendarDataV2` block and `CalendarData` alias with:

```ts
export interface CalendarDataV2 {
  version: 2;
  todos: Record<string, DayTodos>;
  noteLinks: Record<string, string[]>;
}

export interface CalendarDataV3 {
  version: 3;
  todos: Record<string, DayTodos>;
  inbox: TodoItem[];
  noteLinks: Record<string, string[]>;
}

export type CalendarData = CalendarDataV3;

export const CALENDAR_DATA_VERSION = 3;
```

- [ ] **Step 2: Update `createEmptyCalendarData`**

Replace the existing body with:

```ts
export function createEmptyCalendarData(): CalendarData {
  return { version: CALENDAR_DATA_VERSION, todos: {}, inbox: [], noteLinks: {} };
}
```

- [ ] **Step 3: Add a v2 → v3 migrator and wire it into `parseCalendarData`**

Add this helper near the other migrators:

```ts
function migrateCalendarDataV2ToV3(value: unknown): CalendarData {
  return {
    version: CALENDAR_DATA_VERSION,
    todos: normalizeTodosRecord(value, normalizeTodoItem),
    inbox: [],
    noteLinks: normalizeNoteLinksRecord(value),
  };
}
```

Replace the existing version-branching inside `parseCalendarData`:

```ts
    if (parsed.version === 1) {
      return migrateCalendarDataV2ToV3({
        ...migrateCalendarDataV1ToV2(parsed),
        version: 2,
      });
    }

    if (parsed.version === 2) {
      return migrateCalendarDataV2ToV3(parsed);
    }

    if (parsed.version === CALENDAR_DATA_VERSION) {
      return normalizeCalendarDataV3(parsed);
    }

    if (parsed.version === undefined && ("todos" in parsed || "noteLinks" in parsed)) {
      return migrateCalendarDataV2ToV3({
        ...migrateCalendarDataV1ToV2(parsed),
        version: 2,
      });
    }

    if (typeof parsed.version !== "number") {
      console.error("calendar.json: missing version, returning empty data");
      return createEmptyCalendarData();
    }

    if (parsed.version !== CALENDAR_DATA_VERSION) {
      console.error(`calendar.json: unsupported version ${parsed.version}, returning empty data`);
      return createEmptyCalendarData();
    }

    return normalizeCalendarDataV3(parsed);
```

Also rename the existing `normalizeCalendarDataV2` to `normalizeCalendarDataV3` and update its body to populate inbox:

```ts
function normalizeCalendarDataV3(value: unknown): CalendarData {
  return {
    version: CALENDAR_DATA_VERSION,
    todos: normalizeTodosRecord(value, normalizeTodoItem),
    inbox: normalizeInboxArray(value),
    noteLinks: normalizeNoteLinksRecord(value),
  };
}

function normalizeInboxArray(value: unknown): TodoItem[] {
  if (!isPlainObject(value) || !Array.isArray(value.inbox)) {
    return [];
  }
  return value.inbox
    .map(normalizeTodoItem)
    .filter((todo): todo is TodoItem => todo !== null);
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors; later tasks will add UI usages).

- [ ] **Step 5: Commit**

```bash
git add src/lib/calendarData.ts
git commit -m "feat(calendar): add inbox array to CalendarData (v3 migration)"
```

---

## Task 2: Extend selectors — inbox rows + inbox group

**Files:**
- Modify: `src/lib/calendarData.ts`

- [ ] **Step 1: Extend `CalendarTodoRow` and `CalendarTodoGroup`**

Replace the existing declarations with:

```ts
export type CalendarTodoGroup =
  | "overdue"
  | "dueSoon"
  | "upcoming"
  | "inbox"
  | "noDueDate"
  | "done";

export interface CalendarTodoRow {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
  sourceDateKey: string | null;
  dueDateKey: string | null;
  hasDueDate: boolean;
  isOverdue: boolean;
  isInbox: boolean;
  completedAt: number | null;
}

export const CALENDAR_TODO_GROUP_ORDER: CalendarTodoGroup[] = [
  "overdue",
  "dueSoon",
  "upcoming",
  "inbox",
  "noDueDate",
  "done",
];
```

- [ ] **Step 2: Include inbox rows in `deriveCalendarTodoRows`**

Replace `deriveCalendarTodoRows` with:

```ts
export function deriveCalendarTodoRows(
  data: CalendarData,
  options: CalendarTodoQueryOptions = {}
): CalendarTodoRow[] {
  const todayDateKey = options.todayDateKey ?? formatDateKey(new Date());

  const datedRows = Object.entries(data.todos).flatMap(([sourceDateKey, day]) =>
    day.items.map<CalendarTodoRow>((todo) => ({
      id: todo.id,
      text: todo.text,
      done: todo.done,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
      sourceDateKey,
      dueDateKey: todo.dueDateKey,
      hasDueDate: todo.dueDateKey !== null,
      isOverdue: isTodoOverdue(todo, todayDateKey),
      isInbox: false,
      completedAt: todo.completedAt,
    }))
  );

  const inboxRows = data.inbox.map<CalendarTodoRow>((todo) => ({
    id: todo.id,
    text: todo.text,
    done: todo.done,
    createdAt: todo.createdAt,
    updatedAt: todo.updatedAt,
    sourceDateKey: null,
    dueDateKey: todo.dueDateKey,
    hasDueDate: todo.dueDateKey !== null,
    isOverdue: isTodoOverdue(todo, todayDateKey),
    isInbox: true,
    completedAt: todo.completedAt,
  }));

  return [...datedRows, ...inboxRows];
}
```

- [ ] **Step 3: Route inbox + no-due-date rows into the new `"inbox"` group**

Replace `getCalendarTodoGroup` with:

```ts
export function getCalendarTodoGroup(
  row: Pick<CalendarTodoRow, "done" | "dueDateKey" | "isInbox">,
  options: CalendarTodoQueryOptions = {}
): CalendarTodoGroup {
  if (row.done) {
    return "done";
  }

  const todayDateKey = options.todayDateKey ?? formatDateKey(new Date());

  if (isTodoOverdue(row, todayDateKey)) {
    return "overdue";
  }

  if (row.dueDateKey === null) {
    return row.isInbox ? "inbox" : "noDueDate";
  }

  const dueSoonDays = Math.max(0, options.dueSoonDays ?? DEFAULT_DUE_SOON_DAYS);
  const daysUntilDue = getDateKeyDayDistance(todayDateKey, row.dueDateKey);

  return daysUntilDue <= dueSoonDays ? "dueSoon" : "upcoming";
}
```

- [ ] **Step 4: Sort inbox rows last when tiebreaking by `sourceDateKey`**

Replace the `sourceDateKey` tiebreak block inside `compareCalendarTodoRows` with:

```ts
  if (left.sourceDateKey !== right.sourceDateKey) {
    if (left.sourceDateKey === null) return 1;
    if (right.sourceDateKey === null) return -1;
    const sourceDateDelta = left.sourceDateKey.localeCompare(right.sourceDateKey);
    if (sourceDateDelta !== 0) {
      return sourceDateDelta;
    }
  }
```

- [ ] **Step 5: Extend the empty-groups factory**

Replace `createEmptyCalendarTodoGroups` with:

```ts
function createEmptyCalendarTodoGroups(): Record<CalendarTodoGroup, CalendarTodoRow[]> {
  return {
    overdue: [],
    dueSoon: [],
    upcoming: [],
    inbox: [],
    noDueDate: [],
    done: [],
  };
}
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: errors in the UI files (`AllTodosPanel.tsx`, `DoneSection.tsx`, `DateGroupedTodoList.tsx`, `TodoItem.tsx`) because `sourceDateKey` is now `string | null`. These are fixed in later tasks. `src/lib/calendarData.ts` itself must compile cleanly.

- [ ] **Step 7: Commit**

```bash
git add src/lib/calendarData.ts
git commit -m "feat(calendar): introduce inbox group in todo row selectors"
```

---

## Task 3: Range helper handles null source dates

**Files:**
- Modify: `src/lib/calendarRange.ts`

- [ ] **Step 1: Filter out rows with null `sourceDateKey` before bucketing**

In `selectPeriodTodos`, replace the row selection block:

```ts
  const dayIndex = new Set(days);
  const rows = deriveCalendarTodoRows(data, { todayDateKey }).filter(
    (row) => row.sourceDateKey !== null && dayIndex.has(row.sourceDateKey)
  );
```

Then change the inside of the `for (const row of rows)` loop's else branch to use the non-null assertion explicitly (the filter above has narrowed it):

```ts
    } else {
      const key = row.sourceDateKey as string;
      if (!openByDay[key]) {
        openByDay[key] = [];
      }
      openByDay[key].push(row);
    }
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: `calendarRange.ts` compiles. Remaining errors live in UI files.

- [ ] **Step 3: Commit**

```bash
git add src/lib/calendarRange.ts
git commit -m "fix(calendar): skip null source-date rows in period selector"
```

---

## Task 4: Store actions for inbox CRUD

**Files:**
- Modify: `src/stores/calendarStore.ts`

- [ ] **Step 1: Extend the store interface**

Add to the `CalendarStore` interface, immediately after `clearTodoDueDate`:

```ts
  createInboxTodo: (text: string) => void;
  updateInboxTodo: (todoId: string, updates: Partial<Pick<TodoItem, "text" | "done">>) => void;
  toggleInboxTodo: (todoId: string) => void;
  deleteInboxTodo: (todoId: string) => void;
  setInboxTodoDueDate: (todoId: string, dueDateKey: string | null) => void;
```

- [ ] **Step 2: Implement the actions**

Add to the `create<CalendarStore>((set) => ({ ... }))` body, immediately after `clearTodoDueDate`:

```ts
  createInboxTodo: (text) => {
    mutateAndSave((data) => {
      const now = Date.now();
      data.inbox.push({
        id: generateTodoId(),
        text,
        done: false,
        createdAt: now,
        updatedAt: now,
        dueDateKey: null,
        completedAt: null,
      });
      return true;
    });
  },

  updateInboxTodo: (todoId, updates) => {
    mutateAndSave((data) => {
      const item = data.inbox.find((t) => t.id === todoId);
      if (!item) return false;

      let changed = false;
      if (updates.text !== undefined && updates.text !== item.text) {
        item.text = updates.text;
        changed = true;
      }
      if (updates.done !== undefined && updates.done !== item.done) {
        item.done = updates.done;
        item.completedAt = updates.done ? Date.now() : null;
        changed = true;
      }
      if (!changed) {
        return false;
      }
      item.updatedAt = Date.now();
      return true;
    });
  },

  toggleInboxTodo: (todoId) => {
    mutateAndSave((data) => {
      const item = data.inbox.find((t) => t.id === todoId);
      if (!item) return false;
      item.done = !item.done;
      const now = Date.now();
      item.completedAt = item.done ? now : null;
      item.updatedAt = now;
      return true;
    });
  },

  deleteInboxTodo: (todoId) => {
    mutateAndSave((data) => {
      const nextInbox = data.inbox.filter((t) => t.id !== todoId);
      if (nextInbox.length === data.inbox.length) {
        return false;
      }
      data.inbox = nextInbox;
      return true;
    });
  },

  setInboxTodoDueDate: (todoId, dueDateKey) => {
    mutateAndSave((data) => {
      const item = data.inbox.find((t) => t.id === todoId);
      if (!item) return false;

      if (dueDateKey !== null && !isDateKey(dueDateKey)) {
        console.warn("Ignored invalid dueDateKey update:", dueDateKey);
        return false;
      }

      if (item.dueDateKey === dueDateKey) {
        return false;
      }

      item.dueDateKey = dueDateKey;
      item.updatedAt = Date.now();
      return true;
    });
  },
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: `calendarStore.ts` compiles. Remaining errors live in UI files.

- [ ] **Step 4: Commit**

```bash
git add src/stores/calendarStore.ts
git commit -m "feat(calendar): add inbox todo CRUD actions"
```

---

## Task 5: i18n strings for inbox

**Files:**
- Modify: `src/i18n/messages.ts`

- [ ] **Step 1: Add Korean keys**

Inside the `ko:` block, add these entries next to the other `calendar.*` keys (order does not matter for runtime; keep them together for readability):

```ts
    "calendar.inboxTitle": "날짜 없는 할 일",
    "calendar.inboxSubtitle": "아직 날짜를 정하지 않은 할 일",
    "calendar.inboxAdd": "날짜 없는 할 일 추가...",
    "calendar.inboxEmpty": "날짜 없는 할 일이 없습니다.",
    "calendar.groupInbox": "날짜 없음",
```

- [ ] **Step 2: Add English keys**

Inside the `en:` block, add the same keys:

```ts
    "calendar.inboxTitle": "Undated tasks",
    "calendar.inboxSubtitle": "Tasks with no scheduled day",
    "calendar.inboxAdd": "Add an undated task...",
    "calendar.inboxEmpty": "No undated tasks.",
    "calendar.groupInbox": "Undated",
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: `messages.ts` still satisfies the `Record<AppLanguage, MessageDictionary>` contract. Remaining errors live in UI files.

- [ ] **Step 4: Commit**

```bash
git add src/i18n/messages.ts
git commit -m "feat(i18n): add inbox/undated todo strings"
```

---

## Task 6: TodoItem tolerates null source date

**Files:**
- Modify: `src/components/calendar/TodoItem.tsx`

- [ ] **Step 1: Accept nullable source date**

Change the `sourceDateKey` prop type to allow null:

```ts
  sourceDateKey?: string | null;
  onSelectSourceDate?: (dateKey: string) => void;
```

- [ ] **Step 2: Guard the source-date chip against null**

Replace the `sourceDateLabel` computation with:

```ts
  const sourceDateLabel = sourceDateKey
    ? parseDateKey(sourceDateKey).toLocaleDateString(localeTag, {
        month: "short",
        day: "numeric",
        weekday: "short",
      })
    : null;
```

(Type narrowing already makes the existing JSX safe: it renders the chip only when `showSourceDate && sourceDateKey && sourceDateLabel` are all truthy, so `null` simply hides it.)

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: `TodoItem.tsx` compiles. Callers still error because they pass nullable `sourceDateKey` — fixed in later tasks.

- [ ] **Step 4: Commit**

```bash
git add src/components/calendar/TodoItem.tsx
git commit -m "refactor(calendar): let TodoItem accept null source date"
```

---

## Task 7: DoneSection routes per-row by `isInbox`

**Files:**
- Modify: `src/components/calendar/DoneSection.tsx`

- [ ] **Step 1: Accept optional inbox callbacks**

Replace the prop type with:

```ts
type DoneSectionProps = {
  rows: CalendarTodoRow[];
  todayDateKey: string;
  enableRecencyFilter?: boolean;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onSelectSourceDate?: (dateKey: string) => void;
  onToggleInboxTodo?: (todoId: string) => void;
  onUpdateInboxTodo?: (todoId: string, text: string) => void;
  onDeleteInboxTodo?: (todoId: string) => void;
  onSetInboxTodoDueDate?: (todoId: string, dueDateKey: string | null) => void;
};
```

- [ ] **Step 2: Destructure the new props**

Add them to the component signature (after `onSelectSourceDate`):

```ts
  onSelectSourceDate,
  onToggleInboxTodo,
  onUpdateInboxTodo,
  onDeleteInboxTodo,
  onSetInboxTodoDueDate,
```

- [ ] **Step 3: Route row callbacks based on `row.isInbox`**

Replace the `visibleRows.map(...)` block inside `<div className="done-section-list">` with:

```tsx
            {visibleRows.map((row) => {
              const key = row.isInbox ? `inbox:${row.id}` : `${row.sourceDateKey}:${row.id}`;
              const handleToggle = row.isInbox
                ? () => onToggleInboxTodo?.(row.id)
                : () => onToggleTodo(row.sourceDateKey as string, row.id);
              const handleUpdate = row.isInbox
                ? (text: string) => onUpdateInboxTodo?.(row.id, text)
                : (text: string) => onUpdateTodo(row.sourceDateKey as string, row.id, text);
              const handleDelete = row.isInbox
                ? () => onDeleteInboxTodo?.(row.id)
                : () => onDeleteTodo(row.sourceDateKey as string, row.id);
              const handleSetDueDate = row.isInbox
                ? onSetInboxTodoDueDate
                  ? (dueDateKey: string | null) => onSetInboxTodoDueDate(row.id, dueDateKey)
                  : undefined
                : onSetTodoDueDate
                  ? (dueDateKey: string | null) =>
                      onSetTodoDueDate(row.sourceDateKey as string, row.id, dueDateKey)
                  : undefined;

              return (
                <TodoItem
                  key={key}
                  item={row}
                  sourceDateKey={row.sourceDateKey ?? undefined}
                  showSourceDate={showSourceDate && !row.isInbox}
                  isOverdue={false}
                  onToggle={handleToggle}
                  onUpdate={handleUpdate}
                  onDelete={handleDelete}
                  onSelectSourceDate={onSelectSourceDate}
                  onSetDueDate={handleSetDueDate}
                />
              );
            })}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: `DoneSection.tsx` compiles. `AllTodosPanel.tsx` / `DateGroupedTodoList.tsx` still error — fixed next.

- [ ] **Step 5: Commit**

```bash
git add src/components/calendar/DoneSection.tsx
git commit -m "refactor(calendar): route DoneSection rows by inbox flag"
```

---

## Task 8: DateGroupedTodoList tolerates null source date in types

**Files:**
- Modify: `src/components/calendar/DateGroupedTodoList.tsx`

> Inbox rows are already filtered out of `openByDay` in `selectPeriodTodos` (Task 3), so this component never renders inbox rows. But the TypeScript row type is now nullable, so we narrow it here.

- [ ] **Step 1: Narrow `sourceDateKey` before dispatch**

Replace the inner `rows.map(...)` block in the day-section with:

```tsx
              {rows.map((row) => {
                const rowDateKey = row.sourceDateKey as string;
                return (
                  <TodoItem
                    key={`${rowDateKey}:${row.id}`}
                    item={row}
                    sourceDateKey={rowDateKey}
                    showSourceDate={false}
                    isOverdue={row.isOverdue}
                    onToggle={() => onToggleTodo(rowDateKey, row.id)}
                    onUpdate={(text) => onUpdateTodo(rowDateKey, row.id, text)}
                    onDelete={() => onDeleteTodo(rowDateKey, row.id)}
                    onSelectSourceDate={onSelectSourceDate}
                    onSetDueDate={
                      onSetTodoDueDate
                        ? (dueDateKey) => onSetTodoDueDate(rowDateKey, row.id, dueDateKey)
                        : undefined
                    }
                  />
                );
              })}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: `DateGroupedTodoList.tsx` compiles. `AllTodosPanel.tsx` remaining errors — fixed next.

- [ ] **Step 3: Commit**

```bash
git add src/components/calendar/DateGroupedTodoList.tsx
git commit -m "refactor(calendar): narrow source-date in date-grouped list"
```

---

## Task 9: Inbox section + add-row in AllTodosPanel

**Files:**
- Modify: `src/components/calendar/AllTodosPanel.tsx`

- [ ] **Step 1: Replace the component with inbox-aware version**

Replace the entire file contents with:

```tsx
import { useCallback, useState } from "react";
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
  onCreateInboxTodo: (text: string) => void;
  onToggleInboxTodo: (todoId: string) => void;
  onUpdateInboxTodo: (todoId: string, text: string) => void;
  onDeleteInboxTodo: (todoId: string) => void;
  onSetInboxTodoDueDate?: (todoId: string, dueDateKey: string | null) => void;
}

const OPEN_GROUPS = CALENDAR_TODO_GROUP_ORDER.filter(
  (group): group is Exclude<CalendarTodoGroup, "done" | "inbox"> =>
    group !== "done" && group !== "inbox"
);

export default function AllTodosPanel({
  groupedRows,
  todayDateKey,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onOpenSourceDate,
  onCreateInboxTodo,
  onToggleInboxTodo,
  onUpdateInboxTodo,
  onDeleteInboxTodo,
  onSetInboxTodoDueDate,
}: AllTodosPanelProps) {
  const { t } = useI18n();
  const [inboxDraft, setInboxDraft] = useState("");

  const handleAddInbox = useCallback(() => {
    const trimmed = inboxDraft.trim();
    if (!trimmed) {
      return;
    }
    onCreateInboxTodo(trimmed);
    setInboxDraft("");
  }, [inboxDraft, onCreateInboxTodo]);

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

  const inboxRows = groupedRows.inbox;
  const doneRows = groupedRows.done;

  return (
    <div className="calendar-all-panel">
      <section className="calendar-task-section calendar-inbox-section">
        <div className="calendar-task-section-header">
          <h4>{t("calendar.inboxTitle")}</h4>
          <span className="calendar-task-section-count">{inboxRows.length}</span>
        </div>

        <div className="todo-add-row">
          <input
            type="text"
            className="todo-add-input"
            placeholder={t("calendar.inboxAdd")}
            value={inboxDraft}
            onChange={(event) => setInboxDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                handleAddInbox();
              }
            }}
          />
        </div>

        {inboxRows.length === 0 ? (
          <p className="todo-empty">{t("calendar.inboxEmpty")}</p>
        ) : (
          <div className="calendar-task-section-list">
            {inboxRows.map((row) => (
              <TodoItem
                key={`inbox:${row.id}`}
                item={row}
                isOverdue={row.isOverdue}
                onToggle={() => onToggleInboxTodo(row.id)}
                onUpdate={(text) => onUpdateInboxTodo(row.id, text)}
                onDelete={() => onDeleteInboxTodo(row.id)}
                onSetDueDate={
                  onSetInboxTodoDueDate
                    ? (dueDateKey) => onSetInboxTodoDueDate(row.id, dueDateKey)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      {openSections.map((section) => (
        <section key={section.key} className="calendar-task-section">
          <div className="calendar-task-section-header">
            <h4>{section.title}</h4>
            <span className="calendar-task-section-count">{section.items.length}</span>
          </div>

          <div className="calendar-task-section-list">
            {section.items.map((row) => {
              const rowDateKey = row.sourceDateKey as string;
              return (
                <TodoItem
                  key={`${rowDateKey}:${row.id}`}
                  item={row}
                  sourceDateKey={rowDateKey}
                  showSourceDate
                  isOverdue={row.isOverdue}
                  onToggle={() => onToggleTodo(rowDateKey, row.id)}
                  onUpdate={(text) => onUpdateTodo(rowDateKey, row.id, text)}
                  onDelete={() => onDeleteTodo(rowDateKey, row.id)}
                  onSelectSourceDate={onOpenSourceDate}
                  onSetDueDate={
                    onSetTodoDueDate
                      ? (dueDateKey) => onSetTodoDueDate(rowDateKey, row.id, dueDateKey)
                      : undefined
                  }
                />
              );
            })}
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
        onToggleInboxTodo={onToggleInboxTodo}
        onUpdateInboxTodo={onUpdateInboxTodo}
        onDeleteInboxTodo={onDeleteInboxTodo}
        onSetInboxTodoDueDate={onSetInboxTodoDueDate}
      />
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: `AllTodosPanel.tsx` compiles. `CalendarSidebar.tsx` errors because new props aren't supplied — fixed next.

- [ ] **Step 3: Commit**

```bash
git add src/components/calendar/AllTodosPanel.tsx
git commit -m "feat(calendar): add inbox add-row and section to AllTodosPanel"
```

---

## Task 10: Thread inbox callbacks through CalendarSidebar

**Files:**
- Modify: `src/components/calendar/CalendarSidebar.tsx`

- [ ] **Step 1: Extend the sidebar props**

Add these fields to `CalendarSidebarProps` (next to the other `on*Todo` callbacks):

```ts
  onCreateInboxTodo: (text: string) => void;
  onToggleInboxTodo: (todoId: string) => void;
  onUpdateInboxTodo: (todoId: string, text: string) => void;
  onDeleteInboxTodo: (todoId: string) => void;
  onSetInboxTodoDueDate?: (todoId: string, dueDateKey: string | null) => void;
```

- [ ] **Step 2: Destructure the new props**

Add them to the function signature destructuring block (immediately after the existing `on*Todo` callbacks).

- [ ] **Step 3: Pass them into `AllTodosPanel`**

Replace the `mode === "all"` branch with:

```tsx
        {mode === "all" && (
          <AllTodosPanel
            groupedRows={groupedTodoRows}
            todayDateKey={todayDateKey}
            onToggleTodo={onToggleTodo}
            onUpdateTodo={onUpdateTodo}
            onDeleteTodo={onDeleteTodo}
            onSetTodoDueDate={onSetTodoDueDate}
            onOpenSourceDate={onOpenDay}
            onCreateInboxTodo={onCreateInboxTodo}
            onToggleInboxTodo={onToggleInboxTodo}
            onUpdateInboxTodo={onUpdateInboxTodo}
            onDeleteInboxTodo={onDeleteInboxTodo}
            onSetInboxTodoDueDate={onSetInboxTodoDueDate}
          />
        )}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: `CalendarSidebar.tsx` compiles. `CalendarPage.tsx` errors because it doesn't pass the new props yet — fixed next.

- [ ] **Step 5: Commit**

```bash
git add src/components/calendar/CalendarSidebar.tsx
git commit -m "refactor(calendar): thread inbox callbacks through sidebar"
```

---

## Task 11: Wire inbox store actions in CalendarPage

**Files:**
- Modify: `src/components/calendar/CalendarPage.tsx`

- [ ] **Step 1: Pull inbox actions from the store**

Immediately after the `setTodoDueDate` selector, add:

```ts
  const createInboxTodo = useCalendarStore((s) => s.createInboxTodo);
  const toggleInboxTodo = useCalendarStore((s) => s.toggleInboxTodo);
  const updateInboxTodo = useCalendarStore((s) => s.updateInboxTodo);
  const deleteInboxTodo = useCalendarStore((s) => s.deleteInboxTodo);
  const setInboxTodoDueDate = useCalendarStore((s) => s.setInboxTodoDueDate);
```

- [ ] **Step 2: Adapt `updateInboxTodo` to the `(id, text) => void` shape**

After `handleSetTodoDueDate`, add:

```ts
  const handleUpdateInboxTodo = useCallback(
    (todoId: string, text: string) => {
      updateInboxTodo(todoId, { text });
    },
    [updateInboxTodo]
  );

  const handleSetInboxTodoDueDate = useCallback(
    (todoId: string, dueDateKey: string | null) => {
      setInboxTodoDueDate(todoId, dueDateKey);
    },
    [setInboxTodoDueDate]
  );
```

- [ ] **Step 3: Pass the callbacks to `CalendarSidebar`**

Extend the `<CalendarSidebar .../>` usage with:

```tsx
        onCreateInboxTodo={createInboxTodo}
        onToggleInboxTodo={toggleInboxTodo}
        onUpdateInboxTodo={handleUpdateInboxTodo}
        onDeleteInboxTodo={deleteInboxTodo}
        onSetInboxTodoDueDate={handleSetInboxTodoDueDate}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors anywhere).

- [ ] **Step 5: Commit**

```bash
git add src/components/calendar/CalendarPage.tsx
git commit -m "feat(calendar): wire inbox actions from store to sidebar"
```

---

## Task 12: Manual verification

> No automated UI tests exist. Exercise the feature in the dev app.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: Tauri app launches without console errors. Open the Calendar view.

- [ ] **Step 2: Verify empty inbox state**

Switch to the **All tasks** (`전체`) sidebar mode.
Expected: A new "날짜 없는 할 일 / Undated tasks" section appears with an `Add an undated task...` input and the empty message `날짜 없는 할 일이 없습니다.` / `No undated tasks.`.

- [ ] **Step 3: Add an undated todo**

Type a task into the inbox input, press Enter.
Expected: The input clears, the task appears in the inbox section with count `1`, and the month grid does NOT show the task on any day.

- [ ] **Step 4: Verify exclusion from day / week / month views**

Switch to **Day / Week / Month** modes.
Expected: Inbox task is NOT visible in any of those views (today, this week, or this month).

- [ ] **Step 5: Assign a due date to the inbox task**

Click the inbox task's "Set due date" chip and pick a date within the current week.
Expected: The task moves out of the inbox section and into `Due soon` / `Upcoming` / `Overdue` (as appropriate) in the All view. It still does NOT appear in the Day/Week/Month views because those views still bucket by `sourceDateKey`, which remains null for inbox items.

- [ ] **Step 6: Complete and restore**

Check off the task.
Expected: It moves into the `Done` collapsed section. Uncheck it.
Expected: It returns to its previous group.

- [ ] **Step 7: Delete an inbox task**

Delete an inbox task.
Expected: The section updates; if empty, it shows the empty message again.

- [ ] **Step 8: Persist across reloads**

Close and reopen the app (or reload the dev build).
Expected: Inbox tasks persist. Opening an old `calendar.json` without an `inbox` key starts with empty inbox (migration v2 → v3).

- [ ] **Step 9: Final typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 10: Commit only if additional tweaks were needed**

If manual testing revealed a bug, fix it and commit a targeted follow-up. Otherwise no commit.

---

## Self-Review Checklist

**Spec coverage**
- User can add todos without choosing a date ✅ (inbox add-row in All view, Task 9).
- Undated todos do not appear on specific dates in calendar ✅ (`selectPeriodTodos` filters null source keys, Task 3; `MonthGrid` reads only `data.todos`, untouched).
- Undated todos survive reload ✅ (inbox serialized with `CalendarData` v3, Tasks 1 + 4).
- Existing dated-todo flows unaffected ✅ (noDueDate group still exists for dated-but-undue todos; existing callbacks unchanged for dated rows).

**Placeholder scan**
- No "TBD", "handle appropriately", or vague language.
- All code steps provide full code blocks for the edit.
- i18n keys populated in both `ko` and `en`.

**Type consistency**
- `CalendarTodoRow.sourceDateKey: string | null` + `isInbox: boolean` used consistently across `AllTodosPanel`, `DoneSection`, `DateGroupedTodoList`, `TodoItem`.
- `CalendarTodoGroup` includes `"inbox"` and `CALENDAR_TODO_GROUP_ORDER` matches.
- Inbox callbacks have signature `(todoId, ...)` (no `dateKey`), consistently named `on*InboxTodo`.
- `createInboxTodo` returns `void`; component state `inboxDraft` resets on commit.
