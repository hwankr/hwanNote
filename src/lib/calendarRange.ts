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
  const rows = deriveCalendarTodoRows(data, { todayDateKey }).filter(
    (row): row is CalendarTodoRow & { sourceDateKey: string } =>
      row.sourceDateKey !== null && dayIndex.has(row.sourceDateKey)
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
    const aCompleted = a.completedAt ?? -Infinity;
    const bCompleted = b.completedAt ?? -Infinity;
    if (aCompleted !== bCompleted) {
      return bCompleted - aCompleted;
    }
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
 * Keep only rows whose `completedAt` timestamp falls within the last
 * `RECENT_DONE_DAYS` inclusive of `todayDateKey`. Rows with a null
 * `completedAt` (i.e., not done) are excluded.
 */
export function filterRowsWithinRecentDays(
  rows: CalendarTodoRow[],
  todayDateKey: string,
  windowDays = RECENT_DONE_DAYS
): CalendarTodoRow[] {
  const today = parseDateKey(todayDateKey);
  const startOfCutoff = addDays(today, -(windowDays - 1));
  const cutoffMs = startOfCutoff.getTime(); // midnight of the first included day
  return rows.filter(
    (row) => row.completedAt !== null && row.completedAt >= cutoffMs
  );
}
