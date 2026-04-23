import {
  formatDateKey,
  type CalendarData,
  type TodoItem,
} from "./calendarData";

export interface WeekSpanBar {
  todoId: string;
  sourceDateKey: string;
  dueDateKey: string;
  text: string;
  done: boolean;
  startColumn: number; // 0..6 within the week row
  endColumn: number;   // 0..6 within the week row, inclusive
  continuesLeft: boolean;  // span started before this week
  continuesRight: boolean; // span ends after this week
  lane: number; // 0-based vertical slot inside the week
}

export interface WeekSpanComputation {
  bars: WeekSpanBar[];
  laneCount: number;
}

/**
 * Compute the span bars that cross one week. `weekDates` is exactly 7 Date
 * objects in column order (index 0 = leftmost column). Tasks with
 * `showSpan === false` are excluded; `undefined`/`true` are included.
 * Tasks without both a source date and a due date are excluded.
 * Tasks whose span does not intersect the week are excluded.
 */
export function computeWeekSpanBars(
  data: CalendarData,
  weekDates: Date[]
): WeekSpanComputation {
  if (weekDates.length !== 7) {
    return { bars: [], laneCount: 0 };
  }

  const weekStartKey = formatDateKey(weekDates[0]);
  const weekEndKey = formatDateKey(weekDates[6]);

  type Candidate = {
    todoId: string;
    sourceDateKey: string;
    dueDateKey: string;
    text: string;
    done: boolean;
  };

  const candidates: Candidate[] = [];
  for (const [sourceDateKey, day] of Object.entries(data.todos)) {
    for (const todo of day.items) {
      if (todo.kind && todo.kind !== "task") continue;
      if (todo.showSpan === false) continue;
      if (todo.dueDateKey === null) continue;
      if (todo.dueDateKey <= sourceDateKey) continue; // single-day or invalid
      if (todo.dueDateKey < weekStartKey) continue;
      if (sourceDateKey > weekEndKey) continue;
      candidates.push({
        todoId: todo.id,
        sourceDateKey,
        dueDateKey: todo.dueDateKey,
        text: todo.text,
        done: todo.done,
      });
    }
  }

  // Earliest-start-first keeps lane assignment deterministic.
  candidates.sort((a, b) => {
    if (a.sourceDateKey !== b.sourceDateKey) {
      return a.sourceDateKey.localeCompare(b.sourceDateKey);
    }
    if (a.dueDateKey !== b.dueDateKey) {
      return a.dueDateKey.localeCompare(b.dueDateKey);
    }
    return a.todoId.localeCompare(b.todoId);
  });

  const weekDayKeys = weekDates.map(formatDateKey);

  const bars: WeekSpanBar[] = [];
  const laneEnds: number[] = []; // laneEnds[lane] = last endColumn occupied

  for (const c of candidates) {
    const rawStart = weekDayKeys.indexOf(c.sourceDateKey);
    const rawEnd = weekDayKeys.indexOf(c.dueDateKey);
    const startColumn = rawStart === -1 ? 0 : rawStart;
    const endColumn = rawEnd === -1 ? 6 : rawEnd;
    const continuesLeft = c.sourceDateKey < weekStartKey;
    const continuesRight = c.dueDateKey > weekEndKey;

    let lane = 0;
    while (lane < laneEnds.length && laneEnds[lane] >= startColumn) {
      lane++;
    }
    if (lane === laneEnds.length) {
      laneEnds.push(endColumn);
    } else {
      laneEnds[lane] = endColumn;
    }

    bars.push({
      todoId: c.todoId,
      sourceDateKey: c.sourceDateKey,
      dueDateKey: c.dueDateKey,
      text: c.text,
      done: c.done,
      startColumn,
      endColumn,
      continuesLeft,
      continuesRight,
      lane,
    });
  }

  return { bars, laneCount: laneEnds.length };
}

/**
 * Return the TodoItem referenced by a bar. Useful when the caller needs the
 * full object (e.g., for tooltips or keyboard actions).
 */
export function findTodoForBar(
  data: CalendarData,
  sourceDateKey: string,
  todoId: string
): TodoItem | null {
  const day = data.todos[sourceDateKey];
  if (!day) return null;
  return day.items.find((t) => t.id === todoId) ?? null;
}
