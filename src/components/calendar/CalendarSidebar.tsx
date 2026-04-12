import { useMemo, useState } from "react";
import { useI18n } from "../../i18n/context";
import {
  parseDateKey,
  type CalendarTodoGroup,
  type CalendarTodoRow,
  type TodoItem,
} from "../../lib/calendarData";
import AllTodosPanel from "./AllTodosPanel";
import DayTodosPanel from "./DayTodosPanel";

export interface PinnedNote {
  id: string;
  title: string;
}

export type CalendarSidebarMode = "day" | "all";

interface CalendarSidebarProps {
  selectedDate: string;
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

export default function CalendarSidebar({
  selectedDate,
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
  const [mode, setMode] = useState<CalendarSidebarMode>("day");

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

  return (
    <aside className="calendar-sidebar">
      <div className="calendar-sidebar-header">
        <div className="calendar-sidebar-heading">
          <span className="calendar-sidebar-eyebrow">
            {mode === "day" ? t("calendar.viewDay") : t("calendar.viewAll")}
          </span>
          <h3 className="calendar-sidebar-title">
            {mode === "day" ? selectedDateLabel : t("calendar.allViewTitle")}
          </h3>
          <p className="calendar-sidebar-subtitle">
            {mode === "day" ? t("calendar.dayViewSubtitle") : t("calendar.allViewSubtitle")}
          </p>
        </div>

        <div className="calendar-view-switch" role="tablist" aria-label={t("calendar.title")}>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "day"}
            className={`calendar-view-switch-btn ${mode === "day" ? "active" : ""}`}
            onClick={() => setMode("day")}
          >
            {t("calendar.viewDay")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "all"}
            className={`calendar-view-switch-btn ${mode === "all" ? "active" : ""}`}
            onClick={() => setMode("all")}
          >
            {t("calendar.viewAll")}
          </button>
        </div>
      </div>

      <div className="calendar-sidebar-content">
        {mode === "day" ? (
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
        ) : (
          <AllTodosPanel
            groupedRows={groupedTodoRows}
            onToggleTodo={onToggleTodo}
            onUpdateTodo={onUpdateTodo}
            onDeleteTodo={onDeleteTodo}
            onSetTodoDueDate={onSetTodoDueDate}
            onOpenSourceDate={(dateKey) => {
              onOpenDay(dateKey);
              setMode("day");
            }}
          />
        )}
      </div>
    </aside>
  );
}
