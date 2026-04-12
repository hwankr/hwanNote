import { useI18n } from "../../i18n/context";
import {
  CALENDAR_TODO_GROUP_ORDER,
  type CalendarTodoGroup,
  type CalendarTodoRow,
} from "../../lib/calendarData";
import TodoItem from "./TodoItem";

interface AllTodosPanelProps {
  groupedRows: Record<CalendarTodoGroup, CalendarTodoRow[]>;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onOpenSourceDate: (dateKey: string) => void;
}

export default function AllTodosPanel({
  groupedRows,
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
    done: t("calendar.groupDone"),
  } as const;

  const sections = CALENDAR_TODO_GROUP_ORDER.map((key) => ({
    key,
    title: sectionTitleByKey[key],
    items: groupedRows[key],
  })).filter((section) => section.items.length > 0);

  if (sections.length === 0) {
    return <p className="todo-empty calendar-all-empty">{t("calendar.allTodosEmpty")}</p>;
  }

  return (
    <div className="calendar-all-panel">
      {sections.map((section) => (
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
    </div>
  );
}
