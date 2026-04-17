# Calendar Weekend Highlighting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Saturday/Sunday visually distinct in the month grid so users can pick out weekends at a glance — add weekend-aware styling to each day cell (not only the header row), and keep it readable in both the normal and dimmed (out-of-month) states.

**Architecture:** The month grid is rendered by `MonthGrid.tsx` → `DayCell.tsx`. Day-of-week is already accessible via `date.getDay()`. We add a `weekday` prop to `DayCell`, emit `sunday` / `saturday` modifier classes (matching the existing header class naming), and style `.day-cell.sunday` / `.day-cell.saturday` in `calendar.css`. We also add a subtle `.weekend-column` background tint so the column reads as a group, and we make sure the `today` circle still wins over weekend color on today's cell. No new state, no i18n keys, no store changes.

**Tech Stack:** React 18, TypeScript, plain CSS (CSS variables in `src/styles/global.css`). No test runner is configured (`package.json` only defines `typecheck`); verification is `npm run typecheck` + manual dev-server inspection, matching the existing calendar plan convention.

**Spec:** Inline (request was "캘린더의 토, 일 주말 구분을 조금 더 용이하게 해줘. 색상을 넣는다던가.").

---

## File Map

**Modify**
- `src/components/calendar/DayCell.tsx` — accept `weekday: number` (0–6), append `sunday` / `saturday` class when it matches.
- `src/components/calendar/MonthGrid.tsx` — pass `date.getDay()` to `DayCell` as `weekday`.
- `src/styles/calendar.css` — add `.day-cell.sunday` / `.day-cell.saturday` rules (day-number color + soft column background), and make sure `.day-cell.today .day-number` still overrides the weekend color. Keep dimmed (out-of-month) cells tinted but de-emphasized.

**Do not create any new files.** This is a pure visual change.

---

## Conventions

- **No test runner exists.** Each task ends with `npm run typecheck`. Visual verification uses `npm run dev` and the browser.
- **Commit early, commit small.** Every task ends with its own commit.
- **Reuse the existing palette** used by `.day-header.sunday` (`#e57373`) and `.day-header.saturday` (`#64b5f6`) so the header and the body stay consistent. Background tints are derived from those colors via `color-mix`, matching the existing `.todo-item.overdue` pattern in `calendar.css:388`.
- **i18n is not affected.** Weekday headers already exist in both `ko` and `en` (`src/i18n/messages.ts:175`, `:394`).
- **Week-start preference is not affected.** The class is driven by the date's real `getDay()`, not by column index — Sunday stays red and Saturday stays blue whether `weekStartsOn` is `0` or `1`.

---

## Task 1: Plumb `weekday` into `DayCell`

**Files:**
- Modify: `src/components/calendar/DayCell.tsx`
- Modify: `src/components/calendar/MonthGrid.tsx`

- [ ] **Step 1: Add `weekday` to `DayCellProps` and emit the class**

Open `src/components/calendar/DayCell.tsx`. Replace the existing `DayCellProps` interface and the `className` expression with the versions below.

New `DayCellProps` (add the `weekday` field; everything else is unchanged):

```tsx
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
```

Add `weekday` to the destructured props in the component signature:

```tsx
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
```

Replace the `className` expression on the `<button>` with:

```tsx
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
```

Nothing else in `DayCell.tsx` changes.

- [ ] **Step 2: Pass `weekday` from `MonthGrid`**

Open `src/components/calendar/MonthGrid.tsx`. In the `<DayCell …/>` JSX inside the `week.map` (currently around `MonthGrid.tsx:119-130`), add one prop `weekday={date.getDay()}`. The resulting block should read:

```tsx
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
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exits 0, no errors. The new required prop `weekday` must be present on every `DayCell` call site — there is only one (the one you just edited in `MonthGrid.tsx`).

- [ ] **Step 4: Commit**

```bash
git add src/components/calendar/DayCell.tsx src/components/calendar/MonthGrid.tsx
git commit -m "feat(calendar): thread weekday into DayCell for weekend styling"
```

---

## Task 2: Add weekend CSS styling

**Files:**
- Modify: `src/styles/calendar.css`

- [ ] **Step 1: Add weekend rules**

Open `src/styles/calendar.css`. Immediately after the existing `.day-header.saturday { … }` block (currently ends at `calendar.css:103`), insert the following block. Keeping it grouped with the header rules makes the weekend palette easy to find.

```css
/* —— Weekend day cells —— */

.day-cell.sunday {
  background: color-mix(in srgb, #e57373 6%, transparent);
}

.day-cell.sunday .day-number {
  color: #e57373;
}

.day-cell.saturday {
  background: color-mix(in srgb, #64b5f6 7%, transparent);
}

.day-cell.saturday .day-number {
  color: #5aa8ed;
}

.day-cell.sunday:hover,
.day-cell.saturday:hover {
  background: var(--bg-hover);
}

/* Today’s circle should always win over weekend tint */
.day-cell.today.sunday .day-number,
.day-cell.today.saturday .day-number {
  color: #fff;
  background: var(--accent);
}
```

Why each rule:
- The background tints are very low opacity (6–7%) so they read as a column stripe without fighting the content.
- `.day-number` color matches the header color for each weekend day — Sunday red, Saturday blue — but Saturday is nudged to `#5aa8ed` so the number stays readable on a light card. These are the same two hues already used at `calendar.css:97-103`.
- The `hover` rule restores the standard hover treatment so weekend cells don't feel "stuck" colored on interaction.
- The `today` override preserves the existing white-on-accent circle on `today` (see `calendar.css:136-146`), which would otherwise be overridden by the weekend color because of later-in-file specificity.

- [ ] **Step 2: Confirm dimmed (out-of-month) cells still work**

Dimmed cells already use `opacity: 0.35` (see `calendar.css:132-134`). The new weekend rules do NOT touch opacity, so out-of-month Saturday/Sunday cells will appear as a faded red/blue number — which is the desired "calendar-grid" look. No extra rule needed.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exits 0. (CSS is not typechecked, but this confirms Task 1's changes still build together with Task 2 staged.)

- [ ] **Step 4: Manual verification (dev server)**

Run: `npm run dev`
Open the app, switch to the calendar page, and check:
1. In the current month, Sunday cells have a faint red tint and the day number is red; Saturday cells have a faint blue tint and the day number is blue.
2. Hovering a weekend cell replaces the tint with the normal `var(--bg-hover)` color (not a double-stacked tint).
3. If today is a Saturday or Sunday, the today cell still shows the white number on the blue accent circle — the weekend color must NOT leak onto the today circle.
4. Out-of-month weekend cells (the grey faded ones on the first/last row) still show the red/blue number, just at 35% opacity. They should still look dimmer than in-month weekend cells.
5. `selected` weekend cells still show the accent border around the tinted background — the two decorations should stack cleanly.
6. Toggle **Settings → Week starts on** between Sunday and Monday. The red column should always be Sunday and the blue column should always be Saturday, regardless of which side of the grid they land on.

Stop the dev server (`Ctrl+C`) once verification passes.

- [ ] **Step 5: Commit**

```bash
git add src/styles/calendar.css
git commit -m "feat(calendar): color weekend cells for quicker day-of-week scanning"
```

---

## Self-Review Notes

- **Spec coverage.** The spec asks for easier weekend distinction, with color as an example. Task 1+2 color both the column background and the day number, matching the existing header palette.
- **No placeholders.** Every step includes exact paths, the exact CSS/TSX blocks to insert, and exact verification commands.
- **Type consistency.** The only new public API is `weekday: number` on `DayCell`. It is defined in Task 1 Step 1 and supplied in Task 1 Step 2; there is a single call site so there is no way to miss one.
- **No test runner.** Matches the established convention documented in [docs/superpowers/plans/2026-04-15-calendar-view-modes.md](2026-04-15-calendar-view-modes.md): verify with `npm run typecheck` + manual browser check.
- **Weekend vs. week-start.** `date.getDay()` is used, not the column index, so the color is bound to the real day, not the layout position. This is the correct behavior when `weekStartsOn === 0` (Sunday-first) because the first column would otherwise still be styled red — which happens to be correct there too, but only because of alignment, not logic. Using `getDay()` is the robust choice.
