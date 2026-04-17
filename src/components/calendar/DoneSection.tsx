import { useId, useMemo, useState } from "react";
import { useI18n } from "../../i18n/context";
import {
  filterRowsWithinRecentDays,
  RECENT_DONE_DAYS,
} from "../../lib/calendarRange";
import type { CalendarTodoRow } from "../../lib/calendarData";
import TodoItem from "./TodoItem";

type DoneSectionProps = {
  rows: CalendarTodoRow[];
  todayDateKey: string;
  enableRecencyFilter?: boolean;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onSelectSourceDate?: (dateKey: string) => void;
  onToggleInboxTodo?: (todoId: string) => void;
  onUpdateInboxTodo?: (todoId: string, text: string) => void;
  onDeleteInboxTodo?: (todoId: string) => void;
  onSetInboxTodoDueDate?: (todoId: string, dueDateKey: string | null) => void;
};

export default function DoneSection({
  rows,
  todayDateKey,
  enableRecencyFilter = false,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onSelectSourceDate,
  onToggleInboxTodo,
  onUpdateInboxTodo,
  onDeleteInboxTodo,
  onSetInboxTodoDueDate,
}: DoneSectionProps) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<"recent" | "all">("recent");
  const bodyId = `done-section-body-${useId()}`;
  const showSourceDate = Boolean(onSelectSourceDate);

  const visibleRows = useMemo(() => {
    if (!enableRecencyFilter || filter === "all") {
      return rows;
    }
    return filterRowsWithinRecentDays(rows, todayDateKey);
  }, [enableRecencyFilter, filter, rows, todayDateKey]);

  const totalCount = rows.length;
  const shownCount = visibleRows.length;

  if (totalCount === 0) {
    return null;
  }

  const toggleLabel = expanded
    ? t("calendar.doneExpanded", { count: totalCount })
    : t("calendar.doneCollapsed", { count: totalCount });

  return (
    <section className="done-section">
      <button
        type="button"
        className="done-section-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span aria-hidden="true">{expanded ? "▼" : "▶"}</span>
        <span>{toggleLabel}</span>
      </button>

      {expanded && (
        <div id={bodyId} className="done-section-body">
          {enableRecencyFilter && (
            <div className="done-section-filter" role="tablist" aria-label={t("calendar.doneFilterLabel")}>
              <button
                type="button"
                role="tab"
                aria-selected={filter === "recent"}
                className={`done-section-filter-btn ${filter === "recent" ? "active" : ""}`}
                onClick={() => setFilter("recent")}
              >
                {t("calendar.doneRecent", { days: RECENT_DONE_DAYS })}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={filter === "all"}
                className={`done-section-filter-btn ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                {t("calendar.doneAll")}
              </button>
              <span className="done-section-filter-count">
                {filter === "recent"
                  ? t("calendar.doneCountRatio", { shown: shownCount, total: totalCount })
                  : t("calendar.doneCountTotal", { total: totalCount })}
              </span>
            </div>
          )}

          <div className="done-section-list">
            {visibleRows.map((row) => {
              const key = row.isInbox ? `inbox:${row.id}` : `${row.sourceDateKey}:${row.id}`;
              const handleToggle = row.isInbox
                ? () => onToggleInboxTodo?.(row.id)
                : () => onToggleTodo(row.sourceDateKey as string, row.id);
              const handleUpdate = row.isInbox
                ? (text: string) => onUpdateInboxTodo?.(row.id, text)
                : (text: string) => onUpdateTodo(row.sourceDateKey as string, row.id, text);
              const handleDelete = row.isInbox
                ? () => onDeleteInboxTodo?.(row.id)
                : () => onDeleteTodo(row.sourceDateKey as string, row.id);
              const handleSetDueDate = row.isInbox
                ? onSetInboxTodoDueDate
                  ? (dueDateKey: string | null) => onSetInboxTodoDueDate(row.id, dueDateKey)
                  : undefined
                : onSetTodoDueDate
                  ? (dueDateKey: string | null) =>
                      onSetTodoDueDate(row.sourceDateKey as string, row.id, dueDateKey)
                  : undefined;

              return (
                <TodoItem
                  key={key}
                  item={row}
                  sourceDateKey={row.sourceDateKey ?? undefined}
                  showSourceDate={showSourceDate && !row.isInbox}
                  isOverdue={false}
                  onToggle={handleToggle}
                  onUpdate={handleUpdate}
                  onDelete={handleDelete}
                  onSelectSourceDate={onSelectSourceDate}
                  onSetDueDate={handleSetDueDate}
                />
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
