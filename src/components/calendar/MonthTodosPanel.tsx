import { useMemo } from "react";
import type { CalendarData } from "../../lib/calendarData";
import { getMonthRange, selectPeriodTodos } from "../../lib/calendarRange";
import DateGroupedTodoList from "./DateGroupedTodoList";

type MonthTodosPanelProps = {
  data: CalendarData;
  selectedDate: string;
  todayDateKey: string;
  onToggleTodo: (dateKey: string, todoId: string) => void;
  onUpdateTodo: (dateKey: string, todoId: string, text: string) => void;
  onDeleteTodo: (dateKey: string, todoId: string) => void;
  onSetTodoDueDate?: (dateKey: string, todoId: string, dueDateKey: string | null) => void;
  onOpenSourceDate: (dateKey: string) => void;
};

export default function MonthTodosPanel({
  data,
  selectedDate,
  todayDateKey,
  onToggleTodo,
  onUpdateTodo,
  onDeleteTodo,
  onSetTodoDueDate,
  onOpenSourceDate,
}: MonthTodosPanelProps) {
  const { days } = useMemo(() => getMonthRange(selectedDate), [selectedDate]);

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
