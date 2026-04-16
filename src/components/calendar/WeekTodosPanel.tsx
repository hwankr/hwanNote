import { useMemo } from "react";
import type { CalendarData } from "../../lib/calendarData";
import { getWeekRange, selectPeriodTodos, type WeekStart } from "../../lib/calendarRange";
import DateGroupedTodoList from "./DateGroupedTodoList";

type WeekTodosPanelProps = {
  data: CalendarData;
  selectedDate: string;
  weekStartsOn: WeekStart;
  todayDateKey: string;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onOpenSourceDate: (dateKey: string) => void;
};

export default function WeekTodosPanel({
  data,
  selectedDate,
  weekStartsOn,
  todayDateKey,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onOpenSourceDate,
}: WeekTodosPanelProps) {
  const { days } = useMemo(
    () => getWeekRange(selectedDate, weekStartsOn),
    [selectedDate, weekStartsOn]
  );

  const { openByDay, done } = useMemo(
    () => selectPeriodTodos(data, days, todayDateKey),
    [data, days, todayDateKey]
  );

  return (
    <DateGroupedTodoList
      days={days}
      openByDay={openByDay}
      doneRows={done}
      todayDateKey={todayDateKey}
      onToggleTodo={onToggleTodo}
      onUpdateTodo={onUpdateTodo}
      onDeleteTodo={onDeleteTodo}
      onSetTodoDueDate={onSetTodoDueDate}
      onSelectSourceDate={onOpenSourceDate}
    />
  );
}
