import { useCallback, useEffect } from "react";
import { useCalendarStore } from "../../stores/calendarStore";
import { useNoteStore } from "../../stores/noteStore";
import { formatDateKey } from "../../lib/calendarData";
import MonthGrid from "./MonthGrid";
import TodoPanel from "./TodoPanel";

interface CalendarPageProps {
  onNavigateToNote: (noteId: string) => void;
}

export default function CalendarPage({ onNavigateToNote }: CalendarPageProps) {
  const data = useCalendarStore((s) => s.data);
  const selectedDate = useCalendarStore((s) => s.selectedDate);
  const currentMonth = useCalendarStore((s) => s.currentMonth);
  const loaded = useCalendarStore((s) => s.loaded);
  const loadCalendarData = useCalendarStore((s) => s.loadCalendarData);
  const setSelectedDate = useCalendarStore((s) => s.setSelectedDate);
  const setCurrentMonth = useCalendarStore((s) => s.setCurrentMonth);
  const createTodo = useCalendarStore((s) => s.createTodo);
  const toggleTodo = useCalendarStore((s) => s.toggleTodo);
  const updateTodo = useCalendarStore((s) => s.updateTodo);
  const deleteTodo = useCalendarStore((s) => s.deleteTodo);

  const notesById = useNoteStore((s) => s.notesById);

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

  const handleUpdateTodo = useCallback(
    (dateKey: string, todoId: string, text: string) => {
      updateTodo(dateKey, todoId, { text });
    },
    [updateTodo]
  );

  const linkedNoteIds = data.noteLinks[selectedDate] ?? [];

  const allNotes = useNoteStore((s) => s.allNotes);
  const pinnedNotes = allNotes
    .filter((n) => n.isPinned)
    .map((n) => ({ id: n.id, title: n.title }));

  const getNoteTitle = useCallback(
    (noteId: string) => {
      return notesById[noteId]?.title ?? noteId;
    },
    [notesById]
  );

  return (
    <div className="calendar-page">
      <MonthGrid
        currentMonth={currentMonth}
        selectedDate={selectedDate}
        data={data}
        onSelectDate={setSelectedDate}
        onPrevMonth={handlePrevMonth}
        onNextMonth={handleNextMonth}
        onToday={handleToday}
      />
      <TodoPanel
        selectedDate={selectedDate}
        data={data}
        onCreateTodo={createTodo}
        onToggleTodo={toggleTodo}
        onUpdateTodo={handleUpdateTodo}
        onDeleteTodo={deleteTodo}
        linkedNoteIds={linkedNoteIds}
        onNavigateToNote={onNavigateToNote}
        noteTitle={getNoteTitle}
        pinnedNotes={pinnedNotes}
      />
    </div>
  );
}
