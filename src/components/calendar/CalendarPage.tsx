import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDateKey, parseDateKey, type TodoItem } from "../../lib/calendarData";
import { useNoteStore } from "../../stores/noteStore";
import { selectTodoRowsByGroup, useCalendarStore } from "../../stores/calendarStore";
import CalendarSidebar, { type CalendarSidebarMode } from "./CalendarSidebar";
import MonthGrid from "./MonthGrid";

interface CalendarPageProps {
  onNavigateToNote: (noteId: string) => void;
}

type TodoUpdateFn = (
  dateKey: string,
  todoId: string,
  updates: Partial<Pick<TodoItem, "text" | "done">>
) => void;

export default function CalendarPage({ onNavigateToNote }: CalendarPageProps) {
  const todayDateKey = formatDateKey(new Date());
  const data = useCalendarStore((s) => s.data);
  const selectedDate = useCalendarStore((s) => s.selectedDate);
  const currentMonth = useCalendarStore((s) => s.currentMonth);
  const loaded = useCalendarStore((s) => s.loaded);
  const loadCalendarData = useCalendarStore((s) => s.loadCalendarData);
  const setSelectedDate = useCalendarStore((s) => s.setSelectedDate);
  const setCurrentMonth = useCalendarStore((s) => s.setCurrentMonth);
  const createTodo = useCalendarStore((s) => s.createTodo);
  const toggleTodo = useCalendarStore((s) => s.toggleTodo);
  const updateTodo = useCalendarStore((s) => s.updateTodo) as TodoUpdateFn;
  const deleteTodo = useCalendarStore((s) => s.deleteTodo);
  const setTodoDueDate = useCalendarStore((s) => s.setTodoDueDate);

  const notesById = useNoteStore((s) => s.notesById);
  const allNotes = useNoteStore((s) => s.allNotes);

  const [sidebarMode, setSidebarMode] = useState<CalendarSidebarMode>("day");

  useEffect(() => {
    if (!loaded) {
      void loadCalendarData();
    }
  }, [loaded, loadCalendarData]);

  const handlePrevMonth = useCallback(() => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
  }, [currentMonth, setCurrentMonth]);

  const handleNextMonth = useCallback(() => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
  }, [currentMonth, setCurrentMonth]);

  const handleToday = useCallback(() => {
    const now = new Date();
    setCurrentMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedDate(formatDateKey(now));
  }, [setCurrentMonth, setSelectedDate]);

  const handleOpenDay = useCallback(
    (dateKey: string) => {
      const sourceDate = parseDateKey(dateKey);
      setSelectedDate(dateKey);
      setCurrentMonth(new Date(sourceDate.getFullYear(), sourceDate.getMonth(), 1));
      setSidebarMode("day");
    },
    [setCurrentMonth, setSelectedDate]
  );

  const handleUpdateTodo = useCallback(
    (dateKey: string, todoId: string, text: string) => {
      updateTodo(dateKey, todoId, { text });
    },
    [updateTodo]
  );

  const handleSetTodoDueDate = useCallback(
    (dateKey: string, todoId: string, dueDateKey: string | null) => {
      setTodoDueDate(dateKey, todoId, dueDateKey);
    },
    [setTodoDueDate]
  );

  const linkedNoteIds = data.noteLinks[selectedDate] ?? [];
  const pinnedNotes = useMemo(
    () =>
      allNotes.filter((note) => note.isPinned).map((note) => ({
        id: note.id,
        title: note.title,
      })),
    [allNotes]
  );

  const getNoteTitle = useCallback(
    (noteId: string) => {
      return notesById[noteId]?.title ?? noteId;
    },
    [notesById]
  );

  const groupedTodoRows = useMemo(
    () => selectTodoRowsByGroup({ data }, { todayDateKey }),
    [data, todayDateKey]
  );

  const dayTodos = data.todos[selectedDate]?.items ?? [];

  return (
    <div className="calendar-page">
      <MonthGrid
        currentMonth={currentMonth}
        selectedDate={selectedDate}
        data={data}
        onSelectDate={setSelectedDate}
        onOpenDay={handleOpenDay}
        onPrevMonth={handlePrevMonth}
        onNextMonth={handleNextMonth}
        onToday={handleToday}
      />
      <CalendarSidebar
        selectedDate={selectedDate}
        mode={sidebarMode}
        onModeChange={setSidebarMode}
        dayTodos={dayTodos}
        groupedTodoRows={groupedTodoRows}
        linkedNoteIds={linkedNoteIds}
        onNavigateToNote={onNavigateToNote}
        noteTitle={getNoteTitle}
        pinnedNotes={pinnedNotes}
        onCreateTodo={createTodo}
        onToggleTodo={toggleTodo}
        onUpdateTodo={handleUpdateTodo}
        onDeleteTodo={deleteTodo}
        onOpenDay={handleOpenDay}
        onSetTodoDueDate={handleSetTodoDueDate}
      />
    </div>
  );
}
