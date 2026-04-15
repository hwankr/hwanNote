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
  /** When true, show a "recent 7 days / all" filter when expanded. */
  enableRecencyFilter?: boolean;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onSelectSourceDate?: (dateKey: string) => void;
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
            {visibleRows.map((row) => (
              <TodoItem
                key={`${row.sourceDateKey}:${row.id}`}
                item={row}
                sourceDateKey={row.sourceDateKey}
                showSourceDate={showSourceDate}
                isOverdue={false}
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
        </div>
      )}
    </section>
  );
}
