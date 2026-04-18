import { useCallback, useRef, useState } from "react";
import { normalizeDueDateKey, parseDateKey, type TodoItem as CalendarTodoItem } from "../../lib/calendarData";
import { useI18n } from "../../i18n/context";

type TodoDisplayItem = Pick<
  CalendarTodoItem,
  "id" | "text" | "done" | "dueDateKey" | "showSpan"
>;

interface TodoItemProps {
  item: TodoDisplayItem;
  onToggle: () => void;
  onUpdate: (text: string) => void;
  onDelete: () => void;
  onSetDueDate?: (dueDateKey: string | null) => void;
  onSetShowSpan?: (showSpan: boolean) => void;
  showSourceDate?: boolean;
  sourceDateKey?: string | null;
  onSelectSourceDate?: (dateKey: string) => void;
  isOverdue?: boolean;
}

export default function TodoItem({
  item,
  onToggle,
  onUpdate,
  onDelete,
  onSetDueDate,
  onSetShowSpan,
  showSourceDate = false,
  sourceDateKey,
  onSelectSourceDate,
  isOverdue = false,
}: TodoItemProps) {
  const { t, localeTag } = useI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(item.text);
  const [isDueDateEditing, setIsDueDateEditing] = useState(false);
  const [draftDueDateKey, setDraftDueDateKey] = useState(item.dueDateKey ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const dueDateInputRef = useRef<HTMLInputElement>(null);

  const dueDateKey = normalizeDueDateKey(item.dueDateKey ?? null);
  const dueDateLabel = dueDateKey
    ? parseDateKey(dueDateKey).toLocaleDateString(localeTag, {
        month: "short",
        day: "numeric",
      })
    : t("calendar.noDueDate");

  const sourceDateLabel = sourceDateKey
    ? parseDateKey(sourceDateKey).toLocaleDateString(localeTag, {
        month: "short",
        day: "numeric",
        weekday: "short",
      })
    : null;

  const commitEdit = useCallback(() => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== item.text) {
      onUpdate(trimmed);
    } else {
      setEditText(item.text);
    }
    setIsEditing(false);
  }, [editText, item.text, onUpdate]);

  const startEdit = useCallback(() => {
    setEditText(item.text);
    setIsEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [item.text]);

  const openDueDateEditor = useCallback(() => {
    if (!onSetDueDate) {
      return;
    }

    setDraftDueDateKey(dueDateKey ?? "");
    setIsDueDateEditing(true);
    requestAnimationFrame(() => dueDateInputRef.current?.focus());
  }, [dueDateKey, onSetDueDate]);

  const closeDueDateEditor = useCallback(() => {
    setDraftDueDateKey(dueDateKey ?? "");
    setIsDueDateEditing(false);
  }, [dueDateKey]);

  const saveDueDate = useCallback(() => {
    if (!onSetDueDate) {
      return;
    }

    onSetDueDate(draftDueDateKey || null);
    setIsDueDateEditing(false);
  }, [draftDueDateKey, onSetDueDate]);

  const clearDueDate = useCallback(() => {
    if (!onSetDueDate) {
      return;
    }

    setDraftDueDateKey("");
    onSetDueDate(null);
    setIsDueDateEditing(false);
  }, [onSetDueDate]);

  const dueDateChipClassName = [
    "todo-meta-chip",
    "todo-due-chip",
    dueDateKey ? "has-date" : "empty",
    isOverdue ? "overdue" : "",
    onSetDueDate ? "editable" : "readonly",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={`todo-item ${item.done ? "done" : ""} ${isOverdue ? "overdue" : ""}`}>
      <label className="todo-checkbox-label">
        <input
          type="checkbox"
          checked={item.done}
          onChange={onToggle}
          className="todo-checkbox"
        />
        <span className="todo-checkmark" />
      </label>

      <div className="todo-item-body">
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            className="todo-edit-input"
            value={editText}
            onChange={(event) => setEditText(event.target.value)}
            onBlur={commitEdit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                commitEdit();
              }
              if (event.key === "Escape") {
                setEditText(item.text);
                setIsEditing(false);
              }
            }}
          />
        ) : (
          <button type="button" className="todo-text-button" onDoubleClick={startEdit}>
            <span className="todo-text">{item.text}</span>
          </button>
        )}

        <div className="todo-meta-row">
          {showSourceDate && sourceDateKey && sourceDateLabel && (
            <button
              type="button"
              className="todo-meta-chip todo-source-chip"
              onClick={() => onSelectSourceDate?.(sourceDateKey)}
              title={t("calendar.openSourceDate")}
            >
              <span className="todo-meta-label">{t("calendar.sourceDate")}</span>
              <span>{sourceDateLabel}</span>
            </button>
          )}

          {isDueDateEditing && onSetDueDate ? (
            <div className="todo-due-editor">
              <input
                ref={dueDateInputRef}
                type="date"
                className="todo-due-input"
                value={draftDueDateKey}
                onChange={(event) => setDraftDueDateKey(event.target.value)}
              />
              <div className="todo-due-actions">
                <button type="button" className="todo-inline-btn primary" onClick={saveDueDate}>
                  {t("calendar.dueDateSave")}
                </button>
                {dueDateKey && (
                  <button type="button" className="todo-inline-btn" onClick={clearDueDate}>
                    {t("calendar.dueDateClear")}
                  </button>
                )}
                <button type="button" className="todo-inline-btn" onClick={closeDueDateEditor}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : onSetDueDate ? (
            <button type="button" className={dueDateChipClassName} onClick={openDueDateEditor}>
              <span className="todo-meta-label">{t("calendar.dueDate")}</span>
              <span>{dueDateKey ? dueDateLabel : t("calendar.setDueDate")}</span>
            </button>
          ) : (
            <span className={dueDateChipClassName}>
              <span className="todo-meta-label">{t("calendar.dueDate")}</span>
              <span>{dueDateKey ? dueDateLabel : t("calendar.noDueDate")}</span>
            </span>
          )}

          {onSetShowSpan && item.dueDateKey && dueDateKey && (() => {
            const spanActive = item.showSpan !== false;
            return (
              <button
                type="button"
                className={`todo-meta-chip todo-span-chip${spanActive ? " active" : ""}`}
                onClick={() => onSetShowSpan(!spanActive)}
                aria-pressed={spanActive}
                title={t(spanActive ? "calendar.hideSpan" : "calendar.showSpan")}
              >
                <span className="todo-meta-label">{t("calendar.spanLabel")}</span>
                <span>{t(spanActive ? "calendar.spanOn" : "calendar.spanOff")}</span>
              </button>
            );
          })()}

          {isOverdue && <span className="todo-state-chip overdue">{t("calendar.groupOverdue")}</span>}
        </div>
      </div>

      <button
        type="button"
        className="todo-delete-btn"
        onClick={onDelete}
        title={t("calendar.todoDelete")}
        aria-label={t("calendar.todoDelete")}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
