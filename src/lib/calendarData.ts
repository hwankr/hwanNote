export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface DayTodos {
  items: TodoItem[];
}

export interface CalendarData {
  version: 1;
  todos: Record<string, DayTodos>;
  noteLinks: Record<string, string[]>;
}

export function createEmptyCalendarData(): CalendarData {
  return { version: 1, todos: {}, noteLinks: {} };
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

    if (parsed.version !== 1) {
      console.error(`calendar.json: unsupported version ${parsed.version}, returning empty data`);
      return createEmptyCalendarData();
    }

    return {
      version: 1,
      todos: parsed.todos ?? {},
      noteLinks: parsed.noteLinks ?? {},
    };
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
