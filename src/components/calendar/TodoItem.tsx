import { useCallback, useRef, useState } from "react";
import { useI18n } from "../../i18n/context";
import type { TodoItem as TodoItemType } from "../../lib/calendarData";

interface TodoItemProps {
  item: TodoItemType;
  onToggle: () => void;
  onUpdate: (text: string) => void;
  onDelete: () => void;
}

export default function TodoItem({ item, onToggle, onUpdate, onDelete }: TodoItemProps) {
  const { t } = useI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(item.text);
  const inputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className={`todo-item ${item.done ? "done" : ""}`}>
      <label className="todo-checkbox-label">
        <input
          type="checkbox"
          checked={item.done}
          onChange={onToggle}
          className="todo-checkbox"
        />
        <span className="todo-checkmark" />
      </label>

      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          className="todo-edit-input"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") {
              setEditText(item.text);
              setIsEditing(false);
            }
          }}
        />
      ) : (
        <span className="todo-text" onDoubleClick={startEdit}>
          {item.text}
        </span>
      )}

      <button
        type="button"
        className="todo-delete-btn"
        onClick={onDelete}
        title={t("calendar.todoDelete")}
        aria-label={t("calendar.todoDelete")}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
  );
}
