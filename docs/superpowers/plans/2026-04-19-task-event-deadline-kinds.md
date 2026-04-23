# Task / Event / Deadline Kinds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users classify each calendar item as one of three kinds — `task` (actionable, has done/undone state, current behavior), `event` (something that happens that day; no completion), or `deadline` (a marker pointing at "this is when X is due"; no completion). Events and deadlines render differently from tasks throughout the calendar UI and never enter the overdue/done flows.

**Architecture:**
1. Add an optional `kind: TodoKind` field on `TodoItem` (default `"task"` when omitted, so existing JSON files round-trip cleanly). Bump storage version `v3 → v4`. v4 migration just defaults missing kinds.
2. Plumb `kind` through `CalendarTodoRow`. Add two new `CalendarTodoGroup`s — `"events"` and `"deadlines"` — placed before all task groups in `CALENDAR_TODO_GROUP_ORDER`. Tasks keep their existing groups; events/deadlines never participate in overdue/dueSoon/upcoming/done/inbox computations.
3. Treat events and deadlines as date-pinned single-day items: they require `sourceDateKey`, cannot live in the inbox, must have `dueDateKey === null`, must have `done === false`, and are excluded from `computeWeekSpanBars`.
4. UI: `TodoItem` swaps the checkbox for a colored kind badge when `kind !== "task"`, hides the due-date / span chips, and is non-toggleable. `DayTodosPanel` gains a kind selector (segmented control) on the add row. `AllTodosPanel` renders an Events section and a Deadlines section before task groups. `DayCell` paints kind-specific dots.

**Tech Stack:** React 18, TypeScript, Zustand (`calendarStore`). No test runner is configured; verification is `npm run typecheck` plus manual dev-server checks (matches the convention in [2026-04-17-undated-todos.md](2026-04-17-undated-todos.md)).

---

## File Map

**Modify**
- `src/lib/calendarData.ts` — declare `TodoKind`, add `kind?: TodoKind` to `TodoItem`, bump `CALENDAR_DATA_VERSION` to 4, add `CalendarDataV4`, add `migrateCalendarDataV3ToV4`, add `normalizeCalendarDataV4`, extend `CalendarTodoRow` and `CalendarTodoGroup`, update `deriveCalendarTodoRows`, `getCalendarTodoGroup`, `compareCalendarTodoRows`, `createEmptyCalendarTodoGroups`, and `CALENDAR_TODO_GROUP_ORDER`.
- `src/lib/calendarSpans.ts` — skip non-task kinds in `computeWeekSpanBars`.
- `src/stores/calendarStore.ts` — `createTodo` accepts a `kind` argument (default `"task"`). `toggleTodo` / `updateTodo` (`done` updates) / `setTodoDueDate` / `clearTodoDueDate` / `setTodoShowSpan` no-op when the target item's kind is not `"task"`. Inbox CRUD stays task-only (no kind argument).
- `src/i18n/messages.ts` — add `calendar.kindTask`, `calendar.kindEvent`, `calendar.kindDeadline`, `calendar.kindLabel`, `calendar.groupEvents`, `calendar.groupDeadlines` to both `ko` and `en`.
- `src/components/calendar/TodoItem.tsx` — accept `kind?: TodoKind`. For `event`/`deadline`: render a colored kind badge instead of the checkbox, hide the due-date and span chips, drop the `done` styling and the `overdue` chip.
- `src/components/calendar/DayTodosPanel.tsx` — add a kind selector beside the add input; pass selected kind into `onCreateTodo`.
- `src/components/calendar/AllTodosPanel.tsx` — render `events` and `deadlines` sections (each with its own header) before the existing open sections. They reuse the same `TodoItem` callbacks already wired for dated tasks.
- `src/components/calendar/DateGroupedTodoList.tsx` — no functional change, but the embedded `TodoItem` now passes `kind` automatically because it spreads from the row; verify `key` collision is impossible (existing scheme already includes `sourceDateKey`).
- `src/components/calendar/MonthGrid.tsx` — extend the per-day count breakdown so `DayCell` knows event/deadline counts in addition to open/done task counts.
- `src/components/calendar/DayCell.tsx` — accept `eventCount` and `deadlineCount`; render kind-specific dots before the task dots.
- `src/stores/calendarStore.ts` (signature change) — `createTodo: (dateKey, text, kind?)`. The interface declaration must change too.
- `src/components/calendar/CalendarPage.tsx` — pass the new `createTodo` signature through (the call site already exists; just confirm the `kind` argument is forwarded from `DayTodosPanel`).
- `src/styles/calendar.css` — kind badge colors (event = blue accent, deadline = amber accent), kind selector segmented-control styling, kind dot colors on `DayCell`.

**Not modified**
- `src/lib/calendarRange.ts` — already filters by `sourceDateKey` and is kind-agnostic; events/deadlines flow through naturally because they have a `sourceDateKey`. (`done` filter still works because non-task `done` is forced to `false`.)
- `src/components/calendar/WeekTodosPanel.tsx`, `MonthTodosPanel.tsx` — they consume `selectPeriodTodos` results unmodified; events/deadlines just appear alongside tasks per day.
- `src/components/calendar/DoneSection.tsx` — only sees `done === true` rows, which never includes events/deadlines.

---

## Conventions

- **No test runner exists.** Every task ends with `npm run typecheck`. Manual verification calls out observable behavior in the dev server.
- **Commit early, commit small.** Every task ends with its own commit on the current branch.
- **i18n parity.** `ko` and `en` blocks in `src/i18n/messages.ts` always receive the same keys.
- **Backward-compat JSON.** A `TodoItem` with no `kind` field is treated as `kind: "task"`. When serializing, omit `kind` if the value is `"task"` so existing files don't churn on first save.
- **Kind is immutable after creation.** No "change kind" UI in this plan — users delete and recreate to switch. Keeps the implementation small.

---

## Task 1: Data model v4 — `kind` field + migration

**Files:**
- Modify: `src/lib/calendarData.ts`

- [ ] **Step 1: Add the `TodoKind` type and extend `TodoItem`**

In `src/lib/calendarData.ts`, near the top (above `TodoItem`):

```ts
export type TodoKind = "task" | "event" | "deadline";

export const TODO_KINDS: readonly TodoKind[] = ["task", "event", "deadline"] as const;

export function isTodoKind(value: unknown): value is TodoKind {
  return value === "task" || value === "event" || value === "deadline";
}
```

Update the `TodoItem` interface to add the optional field (place after `showSpan`):

```ts
export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
  dueDateKey: string | null;
  completedAt: number | null;
  showSpan?: boolean;
  kind?: TodoKind;
}
```

- [ ] **Step 2: Bump version constant and declare v4 shape**

Replace the `CalendarDataV3` / `CalendarData` / `CALENDAR_DATA_VERSION` block with:

```ts
export interface CalendarDataV3 {
  version: 3;
  todos: Record<string, DayTodos>;
  inbox: TodoItem[];
  noteLinks: Record<string, string[]>;
}

export interface CalendarDataV4 {
  version: 4;
  todos: Record<string, DayTodos>;
  inbox: TodoItem[];
  noteLinks: Record<string, string[]>;
}

export type CalendarData = CalendarDataV4;

export const CALENDAR_DATA_VERSION = 4;
```

- [ ] **Step 3: Update `createEmptyCalendarData`**

Replace the body with:

```ts
export function createEmptyCalendarData(): CalendarData {
  return { version: CALENDAR_DATA_VERSION, todos: {}, inbox: [], noteLinks: {} };
}
```

- [ ] **Step 4: Add v3 → v4 migrator and a v4 normalizer**

Add these two helpers near the existing migrators / normalizers:

```ts
function migrateCalendarDataV3ToV4(value: unknown): CalendarData {
  return {
    version: CALENDAR_DATA_VERSION,
    todos: normalizeTodosRecord(value, normalizeTodoItem),
    inbox: normalizeInboxArray(value),
    noteLinks: normalizeNoteLinksRecord(value),
  };
}

function normalizeCalendarDataV4(value: unknown): CalendarData {
  return {
    version: CALENDAR_DATA_VERSION,
    todos: normalizeTodosRecord(value, normalizeTodoItem),
    inbox: normalizeInboxArray(value),
    noteLinks: normalizeNoteLinksRecord(value),
  };
}
```

Keep `normalizeCalendarDataV3` in the file but stop calling it (we route everything through v4 now).

- [ ] **Step 5: Wire migrators into `parseCalendarData`**

Replace the version-branching inside `parseCalendarData` with:

```ts
    if (parsed.version === 1) {
      return migrateCalendarDataV3ToV4(
        migrateCalendarDataV2ToV3({
          ...migrateCalendarDataV1ToV2(parsed),
          version: 2,
        })
      );
    }

    if (parsed.version === 2) {
      return migrateCalendarDataV3ToV4(migrateCalendarDataV2ToV3(parsed));
    }

    if (parsed.version === 3) {
      return migrateCalendarDataV3ToV4(parsed);
    }

    if (parsed.version === CALENDAR_DATA_VERSION) {
      return normalizeCalendarDataV4(parsed);
    }

    if (parsed.version === undefined && ("todos" in parsed || "noteLinks" in parsed)) {
      return migrateCalendarDataV3ToV4(
        migrateCalendarDataV2ToV3({
          ...migrateCalendarDataV1ToV2(parsed),
          version: 2,
        })
      );
    }

    if (typeof parsed.version !== "number") {
      console.error("calendar.json: missing version, returning empty data");
      return createEmptyCalendarData();
    }

    if (parsed.version !== CALENDAR_DATA_VERSION) {
      console.error(`calendar.json: unsupported version ${parsed.version}, returning empty data`);
      return createEmptyCalendarData();
    }

    return normalizeCalendarDataV4(parsed);
```

- [ ] **Step 6: Teach `normalizeTodoItem` about `kind`**

In `normalizeTodoItem`, after the `rawShowSpan` block, add:

```ts
  const rawKind = isPlainObject(value) ? value.kind : undefined;
  const kind = isTodoKind(rawKind) && rawKind !== "task" ? rawKind : undefined;

  const normalizedDone =
    kind === "event" || kind === "deadline" ? false : normalized.done;
  const normalizedDueDateKey =
    kind === "event" || kind === "deadline"
      ? null
      : normalizeDueDateKey(isPlainObject(value) ? value.dueDateKey : null);
  const normalizedCompletedAt =
    kind === "event" || kind === "deadline"
      ? null
      : completedAt;
  const normalizedShowSpan =
    kind === "event" || kind === "deadline" ? undefined : showSpan;
```

Then change the return object to consume those locals (replacing the existing return):

```ts
  return {
    ...normalized,
    done: normalizedDone,
    dueDateKey: normalizedDueDateKey,
    completedAt: normalizedCompletedAt,
    showSpan: normalizedShowSpan,
    kind,
  };
```

Rationale: storing `kind: "task"` is redundant — leave it `undefined` so default JSON omits the field. For `event`/`deadline`, force the constraint invariants at the data boundary so the rest of the code can trust them.

- [ ] **Step 7: Run typecheck and commit**

```bash
npm run typecheck
```
Expected: passes.

```bash
git add src/lib/calendarData.ts
git commit -m "feat(calendar): add TodoKind field with v4 migration"
```

---

## Task 2: Selectors — surface `kind`, add events/deadlines groups

**Files:**
- Modify: `src/lib/calendarData.ts`

- [ ] **Step 1: Extend `CalendarTodoRow` with `kind`**

Replace the `CalendarTodoRow` interface with:

```ts
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
  kind: TodoKind;
}
```

(Note: the row carries a non-optional `kind` — undefined-on-storage means `"task"`, but the row always carries an explicit value so consumers don't have to remember the default.)

- [ ] **Step 2: Set `kind` when building rows in `deriveCalendarTodoRows`**

Replace the `datedRows` mapping with:

```ts
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
      kind: todo.kind ?? "task",
    }))
  );
```

And the `inboxRows` mapping with:

```ts
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
    kind: todo.kind ?? "task",
  }));
```

- [ ] **Step 3: Add `events` and `deadlines` to `CalendarTodoGroup`**

Replace the `CalendarTodoGroup` type and `CALENDAR_TODO_GROUP_ORDER` with:

```ts
export type CalendarTodoGroup =
  | "events"
  | "deadlines"
  | "overdue"
  | "dueSoon"
  | "upcoming"
  | "inbox"
  | "noDueDate"
  | "done";

export const CALENDAR_TODO_GROUP_ORDER: CalendarTodoGroup[] = [
  "events",
  "deadlines",
  "overdue",
  "dueSoon",
  "upcoming",
  "inbox",
  "noDueDate",
  "done",
];
```

- [ ] **Step 4: Route events/deadlines into their own groups**

Replace `getCalendarTodoGroup` with:

```ts
export function getCalendarTodoGroup(
  row: Pick<CalendarTodoRow, "done" | "dueDateKey" | "isInbox" | "kind">,
  options: CalendarTodoQueryOptions = {}
): CalendarTodoGroup {
  if (row.kind === "event") {
    return "events";
  }

  if (row.kind === "deadline") {
    return "deadlines";
  }

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

- [ ] **Step 5: Update `createEmptyCalendarTodoGroups`**

Replace the body with:

```ts
function createEmptyCalendarTodoGroups(): Record<CalendarTodoGroup, CalendarTodoRow[]> {
  return {
    events: [],
    deadlines: [],
    overdue: [],
    dueSoon: [],
    upcoming: [],
    inbox: [],
    noDueDate: [],
    done: [],
  };
}
```

- [ ] **Step 6: Sort events/deadlines chronologically by `sourceDateKey`**

Inside `compareCalendarTodoRows`, before the existing `groupDelta` block, add:

```ts
  const leftGroup = getCalendarTodoGroup(left, options);
  const rightGroup = getCalendarTodoGroup(right, options);

  if (leftGroup === rightGroup && (leftGroup === "events" || leftGroup === "deadlines")) {
    if (left.sourceDateKey !== right.sourceDateKey) {
      if (left.sourceDateKey === null) return 1;
      if (right.sourceDateKey === null) return -1;
      return left.sourceDateKey.localeCompare(right.sourceDateKey);
    }
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    return left.text.localeCompare(right.text, undefined, { numeric: true, sensitivity: "base" });
  }
```

(The existing group-index sort below will still place these groups first because of the new `CALENDAR_TODO_GROUP_ORDER`. This block only fires when both rows already share the events or deadlines group, and gives them a date-ascending order so the nearest one is on top.)

- [ ] **Step 7: Run typecheck and commit**

```bash
npm run typecheck
```
Expected: passes.

```bash
git add src/lib/calendarData.ts
git commit -m "feat(calendar): expose kind in CalendarTodoRow and add events/deadlines groups"
```

---

## Task 3: Span bars exclude non-task kinds

**Files:**
- Modify: `src/lib/calendarSpans.ts`

- [ ] **Step 1: Skip non-task todos when collecting span candidates**

In `computeWeekSpanBars`, add a kind guard inside the candidate loop. Replace this block:

```ts
  for (const [sourceDateKey, day] of Object.entries(data.todos)) {
    for (const todo of day.items) {
      if (todo.showSpan === false) continue;
      if (todo.dueDateKey === null) continue;
```

with:

```ts
  for (const [sourceDateKey, day] of Object.entries(data.todos)) {
    for (const todo of day.items) {
      if (todo.kind && todo.kind !== "task") continue;
      if (todo.showSpan === false) continue;
      if (todo.dueDateKey === null) continue;
```

- [ ] **Step 2: Run typecheck and commit**

```bash
npm run typecheck
```
Expected: passes.

```bash
git add src/lib/calendarSpans.ts
git commit -m "feat(calendar): exclude event/deadline kinds from week span bars"
```

---

## Task 4: Store — `kind` in `createTodo`, guard mutations on non-tasks

**Files:**
- Modify: `src/stores/calendarStore.ts`

- [ ] **Step 1: Update the `CalendarStore` interface for `createTodo`**

Replace the existing `createTodo` line in the `CalendarStore` interface with:

```ts
  createTodo: (dateKey: string, text: string, kind?: TodoKind) => void;
```

Also extend the import from `calendarData` to include `TodoKind`:

```ts
import {
  compareCalendarTodoRows,
  createEmptyCalendarData,
  deriveCalendarTodoRows,
  formatDateKey,
  generateTodoId,
  groupCalendarTodoRows,
  isDateKey,
  isTodoOverdue,
  parseCalendarData,
  serializeCalendarData,
  type CalendarData,
  type CalendarTodoGroup,
  type CalendarTodoQueryOptions,
  type CalendarTodoRow,
  type TodoItem,
  type TodoKind,
} from "../lib/calendarData";
```

- [ ] **Step 2: Implement `createTodo` with `kind` and constraint enforcement**

Replace the `createTodo` body with:

```ts
  createTodo: (dateKey, text, kind = "task") => {
    mutateAndSave((data) => {
      if (!data.todos[dateKey]) {
        data.todos[dateKey] = { items: [] };
      }
      const now = Date.now();
      const item: TodoItem = {
        id: generateTodoId(),
        text,
        done: false,
        createdAt: now,
        updatedAt: now,
        dueDateKey: null,
        completedAt: null,
      };
      if (kind !== "task") {
        item.kind = kind;
      }
      data.todos[dateKey].items.push(item);
      return true;
    });
  },
```

- [ ] **Step 3: Guard `updateTodo`'s `done` update against non-tasks**

Replace the `updateTodo` body with:

```ts
  updateTodo: (dateKey, todoId, updates) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return false;
      const item = day.items.find((t) => t.id === todoId);
      if (!item) return false;

      const itemKind: TodoKind = item.kind ?? "task";

      let changed = false;
      if (updates.text !== undefined && updates.text !== item.text) {
        item.text = updates.text;
        changed = true;
      }
      if (updates.done !== undefined && itemKind === "task" && updates.done !== item.done) {
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
```

- [ ] **Step 4: Guard `toggleTodo` against non-tasks**

Replace the `toggleTodo` body with:

```ts
  toggleTodo: (dateKey, todoId) => {
    mutateAndSave((data) => {
      const day = data.todos[dateKey];
      if (!day) return false;
      const item = day.items.find((t) => t.id === todoId);
      if (!item) return false;
      if ((item.kind ?? "task") !== "task") return false;
      item.done = !item.done;
      const now = Date.now();
      item.completedAt = item.done ? now : null;
      item.updatedAt = now;
      return true;
    });
  },
```

- [ ] **Step 5: Guard `setTodoDueDate` and `clearTodoDueDate` against non-tasks**

In `setTodoDueDate`, after the `if (!item) return false;` line, add:

```ts
      if ((item.kind ?? "task") !== "task") return false;
```

Do the same in `clearTodoDueDate`.

- [ ] **Step 6: Guard `setTodoShowSpan` against non-tasks**

In `setTodoShowSpan`, after the `if (!item) return false;` line, add:

```ts
      if ((item.kind ?? "task") !== "task") return false;
```

- [ ] **Step 7: Run typecheck and commit**

```bash
npm run typecheck
```
Expected: passes (`createTodo` callers compile because the third arg is optional).

```bash
git add src/stores/calendarStore.ts
git commit -m "feat(calendar): accept kind in createTodo; guard mutations against non-task kinds"
```

---

## Task 5: i18n — kind labels and group titles

**Files:**
- Modify: `src/i18n/messages.ts`

- [ ] **Step 1: Add Korean keys**

Inside the `ko` block, add (place near the existing `calendar.group*` keys):

```ts
    "calendar.kindLabel": "분류",
    "calendar.kindTask": "할 일",
    "calendar.kindEvent": "일정",
    "calendar.kindDeadline": "마감",
    "calendar.groupEvents": "일정",
    "calendar.groupDeadlines": "마감",
```

- [ ] **Step 2: Add English keys**

Inside the `en` block, add the same set:

```ts
    "calendar.kindLabel": "Kind",
    "calendar.kindTask": "Task",
    "calendar.kindEvent": "Event",
    "calendar.kindDeadline": "Deadline",
    "calendar.groupEvents": "Events",
    "calendar.groupDeadlines": "Deadlines",
```

- [ ] **Step 3: Run typecheck and commit**

```bash
npm run typecheck
```
Expected: passes.

```bash
git add src/i18n/messages.ts
git commit -m "i18n: add kind labels and event/deadline group titles"
```

---

## Task 6: `TodoItem` — render variant per kind

**Files:**
- Modify: `src/components/calendar/TodoItem.tsx`

- [ ] **Step 1: Extend the props to accept `kind`**

Replace the `TodoDisplayItem` type and `TodoItemProps` interface with:

```ts
type TodoDisplayItem = Pick<
  CalendarTodoItem,
  "id" | "text" | "done" | "dueDateKey" | "showSpan" | "kind"
>;

interface TodoItemProps {
  item: TodoDisplayItem;
  onToggle: () => void;
  onUpdate: (text: string) => void;
  onDelete: () => void;
  onSetDueDate?: (dueDateKey: string | null) => void;
  onSetShowSpan?: (showSpan: boolean) => void;
  showSourceDate?: boolean;
  sourceDateKey?: string | null;
  onSelectSourceDate?: (dateKey: string) => void;
  isOverdue?: boolean;
}
```

Also add a `TodoKind` import alongside `CalendarTodoItem`:

```ts
import {
  normalizeDueDateKey,
  parseDateKey,
  type TodoItem as CalendarTodoItem,
  type TodoKind,
} from "../../lib/calendarData";
```

- [ ] **Step 2: Compute the resolved kind once at the top of the component**

Right after the existing `const { t, localeTag } = useI18n();` line, add:

```ts
  const kind: TodoKind = item.kind ?? "task";
  const isEventLike = kind === "event" || kind === "deadline";
```

- [ ] **Step 3: Replace the checkbox with a kind badge for non-task items**

Replace the entire `<label className="todo-checkbox-label"> ... </label>` block with:

```tsx
      {isEventLike ? (
        <span
          className={`todo-kind-badge kind-${kind}`}
          title={t(kind === "event" ? "calendar.kindEvent" : "calendar.kindDeadline")}
          aria-label={t(kind === "event" ? "calendar.kindEvent" : "calendar.kindDeadline")}
        >
          {kind === "event" ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <rect x="2" y="3" width="10" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M2 6h10" stroke="currentColor" strokeWidth="1.2" />
              <path d="M5 1.5v2M9 1.5v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3.5 1.5v11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <path d="M3.5 2.5h7l-1.5 2.25L11 7H3.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      ) : (
        <label className="todo-checkbox-label">
          <input
            type="checkbox"
            checked={item.done}
            onChange={onToggle}
            className="todo-checkbox"
          />
          <span className="todo-checkmark" />
        </label>
      )}
```

- [ ] **Step 4: Hide due-date and span chips for non-task items**

Wrap the `{isDueDateEditing && onSetDueDate ? ( ... )}` block and the `{onSetShowSpan && item.dueDateKey && dueDateKey && ...}` block in an `isEventLike` guard. Concretely, replace both blocks with this combined section:

```tsx
          {!isEventLike && (
            <>
              {isDueDateEditing && onSetDueDate ? (
                <div className="todo-due-editor">
                  <input
                    ref={dueDateInputRef}
                    type="date"
                    className="todo-due-input"
                    value={draftDueDateKey}
                    onChange={(event) => setDraftDueDateKey(event.target.value)}
                  />
                  <div className="todo-due-actions">
                    <button type="button" className="todo-inline-btn primary" onClick={saveDueDate}>
                      {t("calendar.dueDateSave")}
                    </button>
                    {dueDateKey && (
                      <button type="button" className="todo-inline-btn" onClick={clearDueDate}>
                        {t("calendar.dueDateClear")}
                      </button>
                    )}
                    <button type="button" className="todo-inline-btn" onClick={closeDueDateEditor}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              ) : onSetDueDate ? (
                <button type="button" className={dueDateChipClassName} onClick={openDueDateEditor}>
                  <span className="todo-meta-label">{t("calendar.dueDate")}</span>
                  <span>{dueDateKey ? dueDateLabel : t("calendar.setDueDate")}</span>
                </button>
              ) : (
                <span className={dueDateChipClassName}>
                  <span className="todo-meta-label">{t("calendar.dueDate")}</span>
                  <span>{dueDateKey ? dueDateLabel : t("calendar.noDueDate")}</span>
                </span>
              )}

              {onSetShowSpan && item.dueDateKey && dueDateKey && (() => {
                const spanActive = item.showSpan !== false;
                return (
                  <button
                    type="button"
                    className={`todo-meta-chip todo-span-chip${spanActive ? " active" : ""}`}
                    onClick={() => onSetShowSpan(!spanActive)}
                    aria-pressed={spanActive}
                    title={t(spanActive ? "calendar.hideSpan" : "calendar.showSpan")}
                  >
                    <span className="todo-meta-label">{t("calendar.spanLabel")}</span>
                    <span>{t(spanActive ? "calendar.spanOn" : "calendar.spanOff")}</span>
                  </button>
                );
              })()}

              {isOverdue && <span className="todo-state-chip overdue">{t("calendar.groupOverdue")}</span>}
            </>
          )}
```

(The `{isOverdue && ...}` chip moves inside the same guard so events/deadlines never get an "overdue" badge — they don't have due-date semantics.)

- [ ] **Step 5: Update the root container class so kind themes through CSS**

Replace the outer `<div>` opener with:

```tsx
    <div
      className={`todo-item kind-${kind} ${item.done ? "done" : ""} ${isOverdue && !isEventLike ? "overdue" : ""}`}
    >
```

(The `done` class only ever applies to tasks because the store guards `done` toggles for non-tasks; but the `isOverdue` qualifier above ensures the styling can never leak.)

- [ ] **Step 6: Run typecheck and commit**

```bash
npm run typecheck
```
Expected: passes.

```bash
git add src/components/calendar/TodoItem.tsx
git commit -m "feat(calendar): render kind-specific badge and hide due/span chips for events and deadlines"
```

---

## Task 7: `DayTodosPanel` — kind selector on the add row

**Files:**
- Modify: `src/components/calendar/DayTodosPanel.tsx`

- [ ] **Step 1: Update imports and props for kind**

Replace the existing imports with:

```ts
import { useCallback, useState } from "react";
import { useI18n } from "../../i18n/context";
import {
  TODO_KINDS,
  type TodoItem as CalendarTodoItem,
  type TodoKind,
} from "../../lib/calendarData";
import type { PinnedNote } from "./CalendarSidebar";
import TodoItem from "./TodoItem";
```

Replace the `onCreateTodo` line in `DayTodosPanelProps` with:

```ts
  onCreateTodo: (dateKey: string, text: string, kind: TodoKind) => void;
```

- [ ] **Step 2: Track the selected kind in state**

After the existing `const [newTodoText, setNewTodoText] = useState("");`, add:

```ts
  const [newTodoKind, setNewTodoKind] = useState<TodoKind>("task");
```

- [ ] **Step 3: Pass the kind into `onCreateTodo` and reset after submit**

Replace the `handleAddTodo` callback with:

```ts
  const handleAddTodo = useCallback(() => {
    const trimmed = newTodoText.trim();
    if (!trimmed) {
      return;
    }

    onCreateTodo(selectedDate, trimmed, newTodoKind);
    setNewTodoText("");
  }, [newTodoText, newTodoKind, onCreateTodo, selectedDate]);
```

(Intentionally keep `newTodoKind` between submissions — most users will add several events in a row when planning.)

- [ ] **Step 4: Render the kind selector beside the input**

Replace the `<div className="todo-add-row"> ... </div>` block with:

```tsx
      <div className="todo-add-row">
        <div className="todo-kind-selector" role="radiogroup" aria-label={t("calendar.kindLabel")}>
          {TODO_KINDS.map((kindOption) => (
            <button
              key={kindOption}
              type="button"
              role="radio"
              aria-checked={newTodoKind === kindOption}
              className={`todo-kind-option kind-${kindOption}${newTodoKind === kindOption ? " active" : ""}`}
              onClick={() => setNewTodoKind(kindOption)}
            >
              {t(
                kindOption === "task"
                  ? "calendar.kindTask"
                  : kindOption === "event"
                    ? "calendar.kindEvent"
                    : "calendar.kindDeadline"
              )}
            </button>
          ))}
        </div>
        <input
          type="text"
          className="todo-add-input"
          placeholder={t("calendar.todoAdd")}
          value={newTodoText}
          onChange={(event) => setNewTodoText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              handleAddTodo();
            }
          }}
        />
      </div>
```

- [ ] **Step 5: Run typecheck and commit**

```bash
npm run typecheck
```
Expected: typecheck will fail at the `CalendarPage.tsx` call site that wires `onCreateTodo` because the signature changed. That's fine — Task 8 fixes it. Defer the commit until Task 8 to keep `main` green per-commit.

(If the team's policy permits stage commits, you may commit this file alone now. Default is to wait.)

---

## Task 8: `CalendarPage` — forward the kind argument

**Files:**
- Modify: `src/components/calendar/CalendarPage.tsx`

- [ ] **Step 1: Locate the `onCreateTodo` wiring**

Open `src/components/calendar/CalendarPage.tsx`. Find the spot where `createTodo` from the store is passed into `DayTodosPanel` (search for `onCreateTodo`). The handler will look like one of:

```tsx
onCreateTodo={createTodo}
```

or

```tsx
onCreateTodo={(dateKey, text) => createTodo(dateKey, text)}
```

- [ ] **Step 2: Forward the third argument**

If the prop is the bare reference (`onCreateTodo={createTodo}`), no change is needed — the new optional third arg passes through. If it's the inline arrow form, replace it with:

```tsx
onCreateTodo={(dateKey, text, kind) => createTodo(dateKey, text, kind)}
```

- [ ] **Step 3: Run typecheck and commit (combine with Task 7)**

```bash
npm run typecheck
```
Expected: passes.

```bash
git add src/components/calendar/DayTodosPanel.tsx src/components/calendar/CalendarPage.tsx
git commit -m "feat(calendar): kind selector on day add-row, forward through CalendarPage"
```

---

## Task 9: `AllTodosPanel` — render events and deadlines sections

**Files:**
- Modify: `src/components/calendar/AllTodosPanel.tsx`

- [ ] **Step 1: Update the `OPEN_GROUPS` filter**

Replace the existing `OPEN_GROUPS` constant with:

```ts
const TASK_OPEN_GROUPS = CALENDAR_TODO_GROUP_ORDER.filter(
  (group): group is "overdue" | "dueSoon" | "upcoming" | "noDueDate" =>
    group === "overdue" || group === "dueSoon" || group === "upcoming" || group === "noDueDate"
);
```

Also rename the `OPEN_GROUPS` references below to `TASK_OPEN_GROUPS` (only one reference exists, inside `openSections`).

- [ ] **Step 2: Build the events/deadlines sections**

Inside the component body, after the `const inboxRows = groupedRows.inbox;` and `const doneRows = groupedRows.done;` lines, add:

```ts
  const eventRows = groupedRows.events;
  const deadlineRows = groupedRows.deadlines;
```

- [ ] **Step 3: Render the event and deadline sections before the existing open sections**

Inside the returned JSX, add the following two sections immediately after the inbox section closing `</section>` and before the `{openSections.map(...)}` block:

```tsx
      {eventRows.length > 0 && (
        <section className="calendar-task-section calendar-events-section">
          <div className="calendar-task-section-header">
            <h4>{t("calendar.groupEvents")}</h4>
            <span className="calendar-task-section-count">{eventRows.length}</span>
          </div>
          <div className="calendar-task-section-list">
            {eventRows.map((row) => {
              const rowDateKey = row.sourceDateKey as string;
              return (
                <TodoItem
                  key={`${rowDateKey}:${row.id}`}
                  item={row}
                  sourceDateKey={rowDateKey}
                  showSourceDate
                  isOverdue={false}
                  onToggle={() => onToggleTodo(rowDateKey, row.id)}
                  onUpdate={(text) => onUpdateTodo(rowDateKey, row.id, text)}
                  onDelete={() => onDeleteTodo(rowDateKey, row.id)}
                  onSelectSourceDate={onOpenSourceDate}
                />
              );
            })}
          </div>
        </section>
      )}

      {deadlineRows.length > 0 && (
        <section className="calendar-task-section calendar-deadlines-section">
          <div className="calendar-task-section-header">
            <h4>{t("calendar.groupDeadlines")}</h4>
            <span className="calendar-task-section-count">{deadlineRows.length}</span>
          </div>
          <div className="calendar-task-section-list">
            {deadlineRows.map((row) => {
              const rowDateKey = row.sourceDateKey as string;
              return (
                <TodoItem
                  key={`${rowDateKey}:${row.id}`}
                  item={row}
                  sourceDateKey={rowDateKey}
                  showSourceDate
                  isOverdue={false}
                  onToggle={() => onToggleTodo(rowDateKey, row.id)}
                  onUpdate={(text) => onUpdateTodo(rowDateKey, row.id, text)}
                  onDelete={() => onDeleteTodo(rowDateKey, row.id)}
                  onSelectSourceDate={onOpenSourceDate}
                />
              );
            })}
          </div>
        </section>
      )}
```

(Note: `onToggle` is supplied for prop completeness but the kind badge in `TodoItem` ignores it — `onToggle` is only wired to the checkbox, which isn't rendered for non-tasks.)

- [ ] **Step 4: Run typecheck and commit**

```bash
npm run typecheck
```
Expected: passes.

```bash
git add src/components/calendar/AllTodosPanel.tsx
git commit -m "feat(calendar): render Events and Deadlines sections in AllTodosPanel"
```

---

## Task 10: `MonthGrid` + `DayCell` — kind-aware indicator dots

**Files:**
- Modify: `src/components/calendar/MonthGrid.tsx`
- Modify: `src/components/calendar/DayCell.tsx`

- [ ] **Step 1: Compute event/deadline counts in `MonthGrid`**

In `src/components/calendar/MonthGrid.tsx`, replace the per-day breakdown inside `week.map((date) => ...)` with:

```tsx
              {week.map((date) => {
                const dateKey = formatDateKey(date);
                const items = data.todos[dateKey]?.items ?? [];
                let openCount = 0;
                let doneCount = 0;
                let eventCount = 0;
                let deadlineCount = 0;
                for (const item of items) {
                  const itemKind = item.kind ?? "task";
                  if (itemKind === "event") {
                    eventCount++;
                  } else if (itemKind === "deadline") {
                    deadlineCount++;
                  } else if (item.done) {
                    doneCount++;
                  } else {
                    openCount++;
                  }
                }
                const hasNoteLinks = (data.noteLinks[dateKey]?.length ?? 0) > 0;

                return (
                  <DayCell
                    key={dateKey}
                    date={date}
                    weekday={date.getDay()}
                    isCurrentMonth={date.getMonth() === month}
                    isToday={dateKey === today}
                    isSelected={dateKey === selectedDate}
                    openCount={openCount}
                    doneCount={doneCount}
                    eventCount={eventCount}
                    deadlineCount={deadlineCount}
                    hasNoteLinks={hasNoteLinks}
                    onClick={() => onSelectDate(dateKey)}
                    onDoubleClick={() => onOpenDay(dateKey)}
                  />
                );
              })}
```

- [ ] **Step 2: Accept and render the new counts in `DayCell`**

Replace `DayCell.tsx` entirely with:

```tsx
interface DayCellProps {
  date: Date;
  weekday: number; // 0 = Sunday … 6 = Saturday
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  openCount: number;
  doneCount: number;
  eventCount: number;
  deadlineCount: number;
  hasNoteLinks: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}

const MAX_DOTS = 3;

export default function DayCell({
  date,
  weekday,
  isCurrentMonth,
  isToday,
  isSelected,
  openCount,
  doneCount,
  eventCount,
  deadlineCount,
  hasNoteLinks,
  onClick,
  onDoubleClick,
}: DayCellProps) {
  // Render priority: deadlines first (most urgent visual), then events,
  // then open tasks, then done tasks. We share the MAX_DOTS budget across
  // all four buckets so the cell never overflows.
  let budget = MAX_DOTS;
  const renderedDeadline = Math.min(deadlineCount, budget);
  budget -= renderedDeadline;
  const renderedEvent = Math.min(eventCount, budget);
  budget -= renderedEvent;
  const doneCap = openCount > 0 ? Math.max(0, budget - 1) : budget;
  const renderedDone = Math.min(doneCount, doneCap);
  budget -= renderedDone;
  const renderedOpen = Math.min(openCount, budget);

  const total = openCount + doneCount + eventCount + deadlineCount;
  const overflow = total - (renderedDeadline + renderedEvent + renderedDone + renderedOpen);

  return (
    <button
      type="button"
      className={[
        "day-cell",
        weekday === 0 && "sunday",
        weekday === 6 && "saturday",
        !isCurrentMonth && "dimmed",
        isToday && "today",
        isSelected && "selected",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span className="day-number">{date.getDate()}</span>
      <div className="day-indicators">
        {Array.from({ length: renderedDeadline }).map((_, i) => (
          <span key={`dl${i}`} className="day-dot deadline-dot" />
        ))}
        {Array.from({ length: renderedEvent }).map((_, i) => (
          <span key={`ev${i}`} className="day-dot event-dot" />
        ))}
        {Array.from({ length: renderedDone }).map((_, i) => (
          <span key={`d${i}`} className="day-dot todo-dot done" />
        ))}
        {Array.from({ length: renderedOpen }).map((_, i) => (
          <span key={`o${i}`} className="day-dot todo-dot" />
        ))}
        {overflow > 0 && (
          <span className="day-dot-overflow">
            {overflow > 9 ? "+9+" : `+${overflow}`}
          </span>
        )}
        {hasNoteLinks && <span className="day-dot note-dot" />}
      </div>
    </button>
  );
}
```

- [ ] **Step 3: Run typecheck and commit**

```bash
npm run typecheck
```
Expected: passes.

```bash
git add src/components/calendar/MonthGrid.tsx src/components/calendar/DayCell.tsx
git commit -m "feat(calendar): kind-aware indicator dots on day cells"
```

---

## Task 11: CSS — kind badge, kind selector, day dot colors

**Files:**
- Modify: `src/styles/calendar.css`

- [ ] **Step 1: Add kind palette CSS variables to the calendar root**

Find the top-level `.calendar` (or the existing root selector that defines other calendar variables — search for `--span-palette-0`). Add inside the same selector:

```css
  --kind-event: #2f7bd6;
  --kind-event-bg: rgba(47, 123, 214, 0.12);
  --kind-deadline: #c75a1f;
  --kind-deadline-bg: rgba(199, 90, 31, 0.12);
```

(Adjust hue if the existing palette already names these tokens differently — search `--accent` and `--warn` for repo conventions, and prefer existing tokens if present.)

- [ ] **Step 2: Style the kind badge inside `TodoItem`**

Append to `src/styles/calendar.css`:

```css
.todo-kind-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  flex: 0 0 auto;
}

.todo-kind-badge.kind-event {
  color: var(--kind-event);
  background: var(--kind-event-bg);
}

.todo-kind-badge.kind-deadline {
  color: var(--kind-deadline);
  background: var(--kind-deadline-bg);
}

.todo-item.kind-event .todo-text-button .todo-text {
  color: var(--kind-event);
  font-weight: 500;
}

.todo-item.kind-deadline .todo-text-button .todo-text {
  color: var(--kind-deadline);
  font-weight: 500;
}
```

- [ ] **Step 3: Style the kind selector segmented control**

Append:

```css
.todo-kind-selector {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: var(--surface-muted, rgba(0, 0, 0, 0.05));
  margin-right: 6px;
}

.todo-kind-option {
  border: 0;
  background: transparent;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-muted, #666);
}

.todo-kind-option:hover {
  background: var(--surface-hover, rgba(0, 0, 0, 0.06));
}

.todo-kind-option.active {
  background: var(--surface-elevated, #fff);
  color: var(--text-primary, #111);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.todo-kind-option.active.kind-event {
  color: var(--kind-event);
}

.todo-kind-option.active.kind-deadline {
  color: var(--kind-deadline);
}
```

- [ ] **Step 4: Style the `DayCell` kind dots**

Append:

```css
.day-dot.event-dot {
  background: var(--kind-event);
}

.day-dot.deadline-dot {
  background: var(--kind-deadline);
}
```

- [ ] **Step 5: Style the new section headers in `AllTodosPanel`**

Append:

```css
.calendar-events-section .calendar-task-section-header h4 {
  color: var(--kind-event);
}

.calendar-deadlines-section .calendar-task-section-header h4 {
  color: var(--kind-deadline);
}
```

- [ ] **Step 6: Commit**

```bash
git add src/styles/calendar.css
git commit -m "style(calendar): kind badges, kind selector, kind-colored day dots"
```

(No typecheck for CSS-only changes — but if any earlier task is uncommitted, run `npm run typecheck` first.)

---

## Task 12: Manual verification + final commit

**Files:** none (verification only)

- [ ] **Step 1: Build sanity check**

```bash
npm run typecheck
```
Expected: passes.

- [ ] **Step 2: Start the dev frontend**

```bash
npm run dev:frontend
```
Open the calendar view in the browser preview. (Tauri-shell verification is optional; the kind feature lives entirely in the React layer.)

- [ ] **Step 3: Smoke-test each kind**

Walk through this checklist in the running app:

1. Pick a day. In the day add-row, the kind selector shows three options with `Task` selected by default. Type "test task" and press Enter — it appears with a checkbox.
2. Switch the selector to `Event`. Type "team meeting" and press Enter — it appears with a blue calendar badge instead of a checkbox; clicking the text does not toggle anything; the badge is non-interactive; no due-date or span chip is visible.
3. Switch the selector to `Deadline`. Type "report due" and press Enter — it appears with an amber flag badge; same hidden chips.
4. Open `All tasks` view. Verify two new sections — `Events` and `Deadlines` — appear above the existing groups, each containing the right items, sorted by source date ascending.
5. Switch back to month view. Verify the day cell shows colored dots: amber for the deadline, blue for the event, plus a regular dot for the open task. The dot order is deadline → event → open → done.
6. Check that the events and deadlines do **not** appear in the `Done` section after marking a sibling task done.
7. Reload the app (or restart `npm run dev:frontend`) — the kinds persist after JSON round-trip.
8. Open `~/.../calendar.json` (the path printed in the dev console / logs) and confirm event/deadline items have `"kind": "event"` / `"kind": "deadline"` while regular tasks have no `kind` key.

- [ ] **Step 4: Final commit (only if any tweaks were needed)**

If smoke-test fixes were made, commit them. Otherwise nothing to commit.

```bash
git status
```
Expected: clean working tree, branch ahead of `main` by ~7-8 commits.

---

## Self-Review Notes

- **Spec coverage:** Three kinds (`task`, `event`, `deadline`) with persistence, kind-specific UI in `TodoItem`, kind selector in add-row, dedicated sections in `AllTodosPanel`, kind-aware dots on `DayCell`, exclusion from spans / done / overdue / dueSoon — all covered.
- **Backward compat:** Tasks without a stored `kind` still load and behave exactly as before (default fallback in `normalizeTodoItem`, store mutators, and selectors).
- **Constraint enforcement is data-side:** `normalizeTodoItem` strips `done` / `dueDateKey` / `showSpan` from event/deadline items at parse time so even hand-edited JSON cannot smuggle invalid combinations into the UI.
- **No inbox kinds:** Inbox CRUD does not accept a `kind` argument; events and deadlines must live on a date. This matches the conceptual model — they are anchored points in time, not floating items.
- **Kind is immutable after creation.** This is a deliberate scope cut. Adding "convert kind" later is a small, additive change.
