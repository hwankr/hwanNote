export type TodoKind = "task" | "event" | "deadline";

export const TODO_KINDS: readonly TodoKind[] = ["task", "event", "deadline"] as const;

export function isTodoKind(value: unknown): value is TodoKind {
  return value === "task" || value === "event" || value === "deadline";
}

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

export interface DayTodos {
  items: TodoItem[];
}

export interface LegacyTodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarDataV1 {
  version: 1;
  todos: Record<string, { items: LegacyTodoItem[] }>;
  noteLinks: Record<string, string[]>;
}

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

export interface CalendarDataV4 {
  version: 4;
  todos: Record<string, DayTodos>;
  inbox: TodoItem[];
  noteLinks: Record<string, string[]>;
}

export type CalendarData = CalendarDataV4;

export type CalendarTodoGroup =
  | "events"
  | "deadlines"
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
  kind: TodoKind;
}

export interface CalendarTodoQueryOptions {
  todayDateKey?: string;
  dueSoonDays?: number;
}

export const CALENDAR_DATA_VERSION = 4;
export const DEFAULT_DUE_SOON_DAYS = 7;
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

export function createEmptyCalendarData(): CalendarData {
  return { version: CALENDAR_DATA_VERSION, todos: {}, inbox: [], noteLinks: {} };
}

export function parseCalendarData(raw: string): CalendarData {
  if (!raw || raw.trim() === "") {
    return createEmptyCalendarData();
  }

  try {
    const parsed = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null) {
      console.error("calendar.json: invalid format, returning empty data");
      return createEmptyCalendarData();
    }

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
  } catch (error) {
    console.error("calendar.json: parse error, returning empty data", error);
    return createEmptyCalendarData();
  }
}

export function serializeCalendarData(data: CalendarData): string {
  return JSON.stringify(data, null, 2);
}

export function generateTodoId(): string {
  return `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  return formatDateKey(parseDateKey(value)) === value;
}

export function formatDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function normalizeDueDateKey(value: unknown): string | null {
  return typeof value === "string" && isDateKey(value) ? value : null;
}

export function isTodoOverdue(
  todo: Pick<TodoItem, "done" | "dueDateKey">,
  todayDateKey = formatDateKey(new Date())
): boolean {
  return !todo.done && todo.dueDateKey !== null && todo.dueDateKey < todayDateKey;
}

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
      kind: todo.kind ?? "task",
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
    kind: todo.kind ?? "task",
  }));

  return [...datedRows, ...inboxRows];
}

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

export function compareCalendarTodoRows(
  left: CalendarTodoRow,
  right: CalendarTodoRow,
  options: CalendarTodoQueryOptions = {}
): number {
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

  const groupDelta =
    CALENDAR_TODO_GROUP_ORDER.indexOf(leftGroup) -
    CALENDAR_TODO_GROUP_ORDER.indexOf(rightGroup);

  if (groupDelta !== 0) {
    return groupDelta;
  }

  if (left.dueDateKey !== right.dueDateKey) {
    if (left.dueDateKey === null) return 1;
    if (right.dueDateKey === null) return -1;

    const dueDelta = left.dueDateKey.localeCompare(right.dueDateKey);
    if (dueDelta !== 0) {
      return dueDelta;
    }
  }

  if (left.sourceDateKey !== right.sourceDateKey) {
    if (left.sourceDateKey === null) return 1;
    if (right.sourceDateKey === null) return -1;
    const sourceDateDelta = left.sourceDateKey.localeCompare(right.sourceDateKey);
    if (sourceDateDelta !== 0) {
      return sourceDateDelta;
    }
  }

  const updatedDelta = right.updatedAt - left.updatedAt;
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  const createdDelta = right.createdAt - left.createdAt;
  if (createdDelta !== 0) {
    return createdDelta;
  }

  return left.text.localeCompare(right.text, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function groupCalendarTodoRows(
  rows: CalendarTodoRow[],
  options: CalendarTodoQueryOptions = {}
): Record<CalendarTodoGroup, CalendarTodoRow[]> {
  const grouped = createEmptyCalendarTodoGroups();

  for (const row of rows) {
    grouped[getCalendarTodoGroup(row, options)].push(row);
  }

  for (const group of CALENDAR_TODO_GROUP_ORDER) {
    grouped[group].sort((left, right) => compareCalendarTodoRows(left, right, options));
  }

  return grouped;
}

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

function migrateCalendarDataV1ToV2(value: unknown): CalendarDataV2 {
  return {
    version: 2,
    todos: normalizeTodosRecord(value, normalizeLegacyTodoItem),
    noteLinks: normalizeNoteLinksRecord(value),
  };
}

function migrateCalendarDataV2ToV3(value: unknown): CalendarDataV3 {
  return {
    version: 3,
    todos: normalizeTodosRecord(value, normalizeTodoItem),
    inbox: [],
    noteLinks: normalizeNoteLinksRecord(value),
  };
}

function normalizeCalendarDataV3(value: unknown): CalendarDataV3 {
  return {
    version: 3,
    todos: normalizeTodosRecord(value, normalizeTodoItem),
    inbox: normalizeInboxArray(value),
    noteLinks: normalizeNoteLinksRecord(value),
  };
}

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

function normalizeInboxArray(value: unknown): TodoItem[] {
  if (!isPlainObject(value) || !Array.isArray(value.inbox)) {
    return [];
  }
  return value.inbox
    .map(normalizeTodoItem)
    .filter((todo): todo is TodoItem => todo !== null);
}

function normalizeTodosRecord(
  value: unknown,
  todoNormalizer: (todo: unknown) => TodoItem | null
): Record<string, DayTodos> {
  const record = readNestedRecord(value, "todos");
  const todos: Record<string, DayTodos> = {};

  for (const [dateKey, dayValue] of Object.entries(record)) {
    const itemsRecord = isPlainObject(dayValue) && Array.isArray(dayValue.items) ? dayValue.items : [];
    const items = itemsRecord.map(todoNormalizer).filter((todo): todo is TodoItem => todo !== null);

    if (items.length > 0) {
      todos[dateKey] = { items };
    }
  }

  return todos;
}

function normalizeNoteLinksRecord(value: unknown): Record<string, string[]> {
  const record = readNestedRecord(value, "noteLinks");
  const noteLinks: Record<string, string[]> = {};

  for (const [dateKey, rawLinks] of Object.entries(record)) {
    if (!Array.isArray(rawLinks)) {
      continue;
    }

    const links = rawLinks.filter((link): link is string => typeof link === "string");

    if (links.length > 0) {
      noteLinks[dateKey] = links;
    }
  }

  return noteLinks;
}

function normalizeLegacyTodoItem(value: unknown): TodoItem | null {
  const normalized = normalizeBaseTodoItem(value);
  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    dueDateKey: null,
    completedAt: normalized.done ? normalized.updatedAt : null,
  };
}

function normalizeTodoItem(value: unknown): TodoItem | null {
  const normalized = normalizeBaseTodoItem(value);
  if (!normalized) {
    return null;
  }

  const rawCompletedAt = isPlainObject(value) ? value.completedAt : null;
  const completedAt =
    typeof rawCompletedAt === "number" && Number.isFinite(rawCompletedAt)
      ? rawCompletedAt
      : normalized.done
        ? normalized.updatedAt
        : null;

  const rawShowSpan = isPlainObject(value) ? value.showSpan : undefined;
  const showSpan = typeof rawShowSpan === "boolean" ? rawShowSpan : undefined;

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

  return {
    ...normalized,
    done: normalizedDone,
    dueDateKey: normalizedDueDateKey,
    completedAt: normalizedCompletedAt,
    showSpan: normalizedShowSpan,
    kind,
  };
}

function normalizeBaseTodoItem(
  value: unknown
): Omit<TodoItem, "dueDateKey" | "completedAt"> | null {
  if (!isPlainObject(value)) {
    return null;
  }

  if (typeof value.id !== "string" || typeof value.text !== "string") {
    return null;
  }

  const createdAt = toFiniteNumber(value.createdAt, 0);
  const updatedAt = toFiniteNumber(value.updatedAt, createdAt);

  return {
    id: value.id,
    text: value.text,
    done: typeof value.done === "boolean" ? value.done : false,
    createdAt,
    updatedAt,
  };
}

function readNestedRecord(value: unknown, key: string): Record<string, unknown> {
  if (!isPlainObject(value) || !isPlainObject(value[key])) {
    return {};
  }

  return value[key];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function getDateKeyDayDistance(fromDateKey: string, toDateKey: string): number {
  const fromDate = parseDateKey(fromDateKey);
  const toDate = parseDateKey(toDateKey);
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((toDate.getTime() - fromDate.getTime()) / millisecondsPerDay);
}
