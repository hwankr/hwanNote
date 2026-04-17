interface DayCellProps {
  date: Date;
  weekday: number; // 0 = Sunday … 6 = Saturday
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  openCount: number;
  doneCount: number;
  hasNoteLinks: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}

const MAX_DOTS = 3;

export default function DayCell({
  date,
  weekday,
  isCurrentMonth,
  isToday,
  isSelected,
  openCount,
  doneCount,
  hasNoteLinks,
  onClick,
  onDoubleClick,
}: DayCellProps) {
  const total = openCount + doneCount;
  const doneCap = openCount > 0 ? MAX_DOTS - 1 : MAX_DOTS;
  const renderedDone = Math.min(doneCount, doneCap);
  const renderedOpen = Math.min(openCount, MAX_DOTS - renderedDone);
  const overflow = total - (renderedDone + renderedOpen);

  return (
    <button
      type="button"
      className={[
        "day-cell",
        weekday === 0 && "sunday",
        weekday === 6 && "saturday",
        !isCurrentMonth && "dimmed",
        isToday && "today",
        isSelected && "selected",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <span className="day-number">{date.getDate()}</span>
      <div className="day-indicators">
        {Array.from({ length: renderedDone }).map((_, i) => (
          <span key={`d${i}`} className="day-dot todo-dot done" />
        ))}
        {Array.from({ length: renderedOpen }).map((_, i) => (
          <span key={`o${i}`} className="day-dot todo-dot" />
        ))}
        {overflow > 0 && (
          <span className="day-dot-overflow">
            {overflow > 9 ? "+9+" : `+${overflow}`}
          </span>
        )}
        {hasNoteLinks && <span className="day-dot note-dot" />}
      </div>
    </button>
  );
}
