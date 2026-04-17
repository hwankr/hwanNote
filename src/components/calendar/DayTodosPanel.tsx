import { useCallback, useState } from "react";
import { useI18n } from "../../i18n/context";
import type { TodoItem as CalendarTodoItem } from "../../lib/calendarData";
import type { PinnedNote } from "./CalendarSidebar";
import TodoItem from "./TodoItem";

interface DayTodosPanelProps {
  selectedDate: string;
  dayTodos: CalendarTodoItem[];
  linkedNoteIds: string[];
  pinnedNotes: PinnedNote[];
  onCreateTodo: (dateKey: string, text: string) => void;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onSetTodoShowSpan?: (dateKey: string, todoId: string, showSpan: boolean) => void;
  onNavigateToNote: (noteId: string) => void;
  noteTitle: (noteId: string) => string;
}

export default function DayTodosPanel({
  selectedDate,
  dayTodos,
  linkedNoteIds,
  pinnedNotes,
  onCreateTodo,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onSetTodoShowSpan,
  onNavigateToNote,
  noteTitle,
}: DayTodosPanelProps) {
  const { t } = useI18n();
  const [newTodoText, setNewTodoText] = useState("");
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);

  const handleAddTodo = useCallback(() => {
    const trimmed = newTodoText.trim();
    if (!trimmed) {
      return;
    }

    onCreateTodo(selectedDate, trimmed);
    setNewTodoText("");
  }, [newTodoText, onCreateTodo, selectedDate]);

  return (
    <>
      <div className="todo-add-row">
        <input
          type="text"
          className="todo-add-input"
          placeholder={t("calendar.todoAdd")}
          value={newTodoText}
          onChange={(event) => setNewTodoText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              handleAddTodo();
            }
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
              onSetDueDate={
                onSetTodoDueDate
                  ? (dueDateKey) => onSetTodoDueDate(selectedDate, item.id, dueDateKey)
                  : undefined
              }
              onSetShowSpan={
                onSetTodoShowSpan
                  ? (showSpan) => onSetTodoShowSpan(selectedDate, item.id, showSpan)
                  : undefined
              }
            />
          ))
        )}
      </div>

      {pinnedNotes.length > 0 && (
        <div className="todo-linked-notes">
          <button
            type="button"
            className="todo-section-toggle"
            onClick={() => setPinnedCollapsed((value) => !value)}
          >
            <span aria-hidden="true">{pinnedCollapsed ? "▶" : "▼"}</span>
            <span>{t("calendar.pinnedNotes")}</span>
          </button>
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
    </>
  );
}
