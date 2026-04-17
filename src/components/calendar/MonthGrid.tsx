import { useMemo } from "react";
import { useI18n } from "../../i18n/context";
import { formatDateKey } from "../../lib/calendarData";
import type { CalendarData } from "../../lib/calendarData";
import { computeWeekSpanBars, type WeekSpanBar } from "../../lib/calendarSpans";
import DayCell from "./DayCell";

interface MonthGridProps {
  currentMonth: Date;
  selectedDate: string;
  data: CalendarData;
  onSelectDate: (dateKey: string) => void;
  onOpenDay: (dateKey: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
}

function getMonthGrid(year: number, month: number): Date[][] {
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay(); // 0 = Sunday

  const weeks: Date[][] = [];
  let current = new Date(year, month, 1 - startOffset);

  for (let w = 0; w < 6; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    weeks.push(week);
  }

  return weeks;
}

export default function MonthGrid({
  currentMonth,
  selectedDate,
  data,
  onSelectDate,
  onOpenDay,
  onPrevMonth,
  onNextMonth,
  onToday,
}: MonthGridProps) {
  const { t } = useI18n();

  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();

  const weeks = useMemo(() => getMonthGrid(year, month), [year, month]);

  const weekSpans = useMemo(
    () => weeks.map((week) => computeWeekSpanBars(data, week)),
    [weeks, data]
  );

  const today = useMemo(() => formatDateKey(new Date()), []);

  const monthLabel = useMemo(() => {
    return currentMonth.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
    });
  }, [currentMonth]);

  const dayHeaders = [
    { label: t("calendar.sunday"), type: "sunday" },
    { label: t("calendar.monday"), type: "" },
    { label: t("calendar.tuesday"), type: "" },
    { label: t("calendar.wednesday"), type: "" },
    { label: t("calendar.thursday"), type: "" },
    { label: t("calendar.friday"), type: "" },
    { label: t("calendar.saturday"), type: "saturday" },
  ];

  return (
    <div className="month-grid-container">
      <div className="month-header">
        <button type="button" className="month-nav-btn" onClick={onPrevMonth} title={t("calendar.prevMonth")}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <h2 className="month-title">{monthLabel}</h2>
        <button type="button" className="month-nav-btn" onClick={onNextMonth} title={t("calendar.nextMonth")}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button type="button" className="month-today-btn" onClick={onToday}>
          {t("calendar.today")}
        </button>
      </div>

      <div className="month-grid">
        <div className="day-headers">
          {dayHeaders.map((header, i) => (
            <div key={i} className={`day-header ${header.type}`}>
              {header.label}
            </div>
          ))}
        </div>

        {weeks.map((week, wi) => {
          const { bars, laneCount } = weekSpans[wi];
          return (
            <div
              key={wi}
              className={`week-row${laneCount > 0 ? " has-spans" : ""}`}
              style={{ "--span-lanes": laneCount } as React.CSSProperties}
            >
              {laneCount > 0 && (
                <div className="week-row-spans" aria-hidden="true">
                  {bars.map((bar) => (
                    <SpanBar key={`${bar.sourceDateKey}:${bar.todoId}`} bar={bar} />
                  ))}
                </div>
              )}
              {week.map((date) => {
                const dateKey = formatDateKey(date);
                const items = data.todos[dateKey]?.items ?? [];
                const doneCount = items.filter((t) => t.done).length;
                const openCount = items.length - doneCount;
                const hasNoteLinks = (data.noteLinks[dateKey]?.length ?? 0) > 0;

                return (
                  <DayCell
                    key={dateKey}
                    date={date}
                    weekday={date.getDay()}
                    isCurrentMonth={date.getMonth() === month}
                    isToday={dateKey === today}
                    isSelected={dateKey === selectedDate}
                    openCount={openCount}
                    doneCount={doneCount}
                    hasNoteLinks={hasNoteLinks}
                    onClick={() => onSelectDate(dateKey)}
                    onDoubleClick={() => onOpenDay(dateKey)}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface SpanBarProps {
  bar: WeekSpanBar;
}

function SpanBar({ bar }: SpanBarProps) {
  const classes = [
    "span-bar",
    bar.done && "done",
    bar.continuesLeft && "continues-left",
    bar.continuesRight && "continues-right",
  ]
    .filter(Boolean)
    .join(" ");

  const gridColumn = `${bar.startColumn + 1} / ${bar.endColumn + 2}`;

  return (
    <div
      className={classes}
      style={{
        gridColumn,
        ["--bar-lane" as string]: bar.lane,
      } as React.CSSProperties}
      title={bar.text}
    >
      {bar.text}
    </div>
  );
}
