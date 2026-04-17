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
  onSetTodoShowSpan?: (dateKey: string, todoId: string, showSpan: boolean) => void;
  onCreateInboxTodo: (text: string) => void;
  onToggleInboxTodo: (todoId: string) => void;
  onUpdateInboxTodo: (todoId: string, text: string) => void;
  onDeleteInboxTodo: (todoId: string) => void;
  onSetInboxTodoDueDate?: (todoId: string, dueDateKey: string | null) => void;
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
  onSetTodoShowSpan,
  onCreateInboxTodo,
  onToggleInboxTodo,
  onUpdateInboxTodo,
  onDeleteInboxTodo,
  onSetInboxTodoDueDate,
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
            onSetTodoShowSpan={onSetTodoShowSpan}
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
            onCreateInboxTodo={onCreateInboxTodo}
            onToggleInboxTodo={onToggleInboxTodo}
            onUpdateInboxTodo={onUpdateInboxTodo}
            onDeleteInboxTodo={onDeleteInboxTodo}
            onSetInboxTodoDueDate={onSetInboxTodoDueDate}
          />
        )}
      </div>
    </aside>
  );
}
