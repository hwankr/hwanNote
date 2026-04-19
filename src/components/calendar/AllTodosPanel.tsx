import { useCallback, useState } from "react";
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
  onCreateInboxTodo: (text: string) => void;
  onToggleInboxTodo: (todoId: string) => void;
  onUpdateInboxTodo: (todoId: string, text: string) => void;
  onDeleteInboxTodo: (todoId: string) => void;
  onSetInboxTodoDueDate?: (todoId: string, dueDateKey: string | null) => void;
}

const OPEN_GROUPS = CALENDAR_TODO_GROUP_ORDER.filter(
  (group): group is Exclude<CalendarTodoGroup, "done" | "inbox" | "events" | "deadlines"> =>
    group !== "done" && group !== "inbox" && group !== "events" && group !== "deadlines"
);

export default function AllTodosPanel({
  groupedRows,
  todayDateKey,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onOpenSourceDate,
  onCreateInboxTodo,
  onToggleInboxTodo,
  onUpdateInboxTodo,
  onDeleteInboxTodo,
  onSetInboxTodoDueDate,
}: AllTodosPanelProps) {
  const { t } = useI18n();
  const [inboxDraft, setInboxDraft] = useState("");

  const handleAddInbox = useCallback(() => {
    const trimmed = inboxDraft.trim();
    if (!trimmed) {
      return;
    }
    onCreateInboxTodo(trimmed);
    setInboxDraft("");
  }, [inboxDraft, onCreateInboxTodo]);

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

  const inboxRows = groupedRows.inbox;
  const doneRows = groupedRows.done;

  return (
    <div className="calendar-all-panel">
      <section className="calendar-task-section calendar-inbox-section">
        <div className="calendar-task-section-header">
          <h4>{t("calendar.inboxTitle")}</h4>
          <span className="calendar-task-section-count">{inboxRows.length}</span>
        </div>

        <div className="todo-add-row">
          <input
            type="text"
            className="todo-add-input"
            placeholder={t("calendar.inboxAdd")}
            value={inboxDraft}
            onChange={(event) => setInboxDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                handleAddInbox();
              }
            }}
          />
        </div>

        {inboxRows.length === 0 ? (
          <p className="todo-empty">{t("calendar.inboxEmpty")}</p>
        ) : (
          <div className="calendar-task-section-list">
            {inboxRows.map((row) => (
              <TodoItem
                key={`inbox:${row.id}`}
                item={row}
                isOverdue={row.isOverdue}
                onToggle={() => onToggleInboxTodo(row.id)}
                onUpdate={(text) => onUpdateInboxTodo(row.id, text)}
                onDelete={() => onDeleteInboxTodo(row.id)}
                onSetDueDate={
                  onSetInboxTodoDueDate
                    ? (dueDateKey) => onSetInboxTodoDueDate(row.id, dueDateKey)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </section>

      {openSections.map((section) => (
        <section key={section.key} className="calendar-task-section">
          <div className="calendar-task-section-header">
            <h4>{section.title}</h4>
            <span className="calendar-task-section-count">{section.items.length}</span>
          </div>

          <div className="calendar-task-section-list">
            {section.items.map((row) => {
              const rowDateKey = row.sourceDateKey as string;
              return (
                <TodoItem
                  key={`${rowDateKey}:${row.id}`}
                  item={row}
                  sourceDateKey={rowDateKey}
                  showSourceDate
                  isOverdue={row.isOverdue}
                  onToggle={() => onToggleTodo(rowDateKey, row.id)}
                  onUpdate={(text) => onUpdateTodo(rowDateKey, row.id, text)}
                  onDelete={() => onDeleteTodo(rowDateKey, row.id)}
                  onSelectSourceDate={onOpenSourceDate}
                  onSetDueDate={
                    onSetTodoDueDate
                      ? (dueDateKey) => onSetTodoDueDate(rowDateKey, row.id, dueDateKey)
                      : undefined
                  }
                />
              );
            })}
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
        onToggleInboxTodo={onToggleInboxTodo}
        onUpdateInboxTodo={onUpdateInboxTodo}
        onDeleteInboxTodo={onDeleteInboxTodo}
        onSetInboxTodoDueDate={onSetInboxTodoDueDate}
      />
    </div>
  );
}
