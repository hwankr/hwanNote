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
