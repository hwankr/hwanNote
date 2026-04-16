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
