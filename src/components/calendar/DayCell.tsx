interface DayCellProps {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  todoCount: number;
  doneCount: number;
  hasNoteLinks: boolean;
  onClick: () => void;
}

export default function DayCell({
  date,
  isCurrentMonth,
  isToday,
  isSelected,
  todoCount,
  doneCount,
  hasNoteLinks,
  onClick,
}: DayCellProps) {
  const allDone = todoCount > 0 && doneCount === todoCount;

  return (
    <button
      type="button"
      className={[
        "day-cell",
        !isCurrentMonth && "dimmed",
        isToday && "today",
        isSelected && "selected",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onClick}
    >
      <span className="day-number">{date.getDate()}</span>
      <div className="day-indicators">
        {todoCount > 0 && (
          <span className={`day-dot todo-dot ${allDone ? "all-done" : ""}`} />
        )}
        {hasNoteLinks && <span className="day-dot note-dot" />}
      </div>
    </button>
  );
}
