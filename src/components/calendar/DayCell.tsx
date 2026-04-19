interface DayCellProps {
  date: Date;
  weekday: number; // 0 = Sunday … 6 = Saturday
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  openCount: number;
  doneCount: number;
  eventCount: number;
  deadlineCount: number;
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
  eventCount,
  deadlineCount,
  hasNoteLinks,
  onClick,
  onDoubleClick,
}: DayCellProps) {
  // Render priority: deadlines first (most urgent visual), then events,
  // then open tasks, then done tasks. We share the MAX_DOTS budget across
  // all four buckets so the cell never overflows.
  let budget = MAX_DOTS;
  const renderedDeadline = Math.min(deadlineCount, budget);
  budget -= renderedDeadline;
  const renderedEvent = Math.min(eventCount, budget);
  budget -= renderedEvent;
  const doneCap = openCount > 0 ? Math.max(0, budget - 1) : budget;
  const renderedDone = Math.min(doneCount, doneCap);
  budget -= renderedDone;
  const renderedOpen = Math.min(openCount, budget);

  const total = openCount + doneCount + eventCount + deadlineCount;
  const overflow = total - (renderedDeadline + renderedEvent + renderedDone + renderedOpen);

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
        {Array.from({ length: renderedDeadline }).map((_, i) => (
          <span key={`dl${i}`} className="day-dot deadline-dot" />
        ))}
        {Array.from({ length: renderedEvent }).map((_, i) => (
          <span key={`ev${i}`} className="day-dot event-dot" />
        ))}
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
