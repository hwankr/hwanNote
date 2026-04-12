import { useCallback, useState } from "react";
import { useI18n } from "../../i18n/context";
import { parseDateKey } from "../../lib/calendarData";
import type { CalendarData } from "../../lib/calendarData";
import TodoItem from "./TodoItem";

interface PinnedNote {
  id: string;
  title: string;
}

interface TodoPanelProps {
  selectedDate: string;
  data: CalendarData;
  onCreateTodo: (dateKey: string, text: string) => void;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  linkedNoteIds: string[];
  onNavigateToNote: (noteId: string) => void;
  noteTitle: (noteId: string) => string;
  pinnedNotes?: PinnedNote[];
}

export default function TodoPanel({
  selectedDate,
  data,
  onCreateTodo,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  linkedNoteIds,
  onNavigateToNote,
  noteTitle,
  pinnedNotes = [],
}: TodoPanelProps) {
  const { t, localeTag } = useI18n();
  const [newTodoText, setNewTodoText] = useState("");
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);

  const dayTodos = data.todos[selectedDate]?.items ?? [];

  const dateLabel = parseDateKey(selectedDate).toLocaleDateString(localeTag, {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  });

  const handleAddTodo = useCallback(() => {
    const trimmed = newTodoText.trim();
    if (!trimmed) return;
    onCreateTodo(selectedDate, trimmed);
    setNewTodoText("");
  }, [newTodoText, selectedDate, onCreateTodo]);

  return (
    <div className="todo-panel">
      <div className="todo-panel-header">
        <h3 className="todo-date-label">{dateLabel}</h3>
      </div>

      <div className="todo-add-row">
        <input
          type="text"
          className="todo-add-input"
          placeholder={t("calendar.todoAdd")}
          value={newTodoText}
          onChange={(e) => setNewTodoText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAddTodo();
          }}
        />
      </div>

      <div className="todo-list">
        {dayTodos.length === 0 ? (
          <p className="todo-empty">{t("calendar.todoEmpty")}</p>
        ) : (
          dayTodos.map((item) => (
            <TodoItem
              key={item.id}
              item={item}
              onToggle={() => onToggleTodo(selectedDate, item.id)}
              onUpdate={(text) => onUpdateTodo(selectedDate, item.id, text)}
              onDelete={() => onDeleteTodo(selectedDate, item.id)}
            />
          ))
        )}
      </div>

      {pinnedNotes.length > 0 && (
        <div className="todo-linked-notes">
          <h4
            className="todo-section-toggle"
            onClick={() => setPinnedCollapsed((v) => !v)}
          >
            {pinnedCollapsed ? "\u25b6" : "\u25bc"} {t("calendar.pinnedNotes")}
          </h4>
          {!pinnedCollapsed &&
            pinnedNotes.map((note) => (
              <button
                key={note.id}
                type="button"
                className="linked-note-btn"
                onClick={() => onNavigateToNote(note.id)}
              >
                {note.title}
              </button>
            ))}
        </div>
      )}

      {linkedNoteIds.length > 0 && (
        <div className="todo-linked-notes">
          <h4>{t("calendar.linkedNotes")}</h4>
          {linkedNoteIds.map((noteId) => (
            <button
              key={noteId}
              type="button"
              className="linked-note-btn"
              onClick={() => onNavigateToNote(noteId)}
            >
              {noteTitle(noteId)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
