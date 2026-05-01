# Changelog

All notable user-facing changes to HwanNote are documented here.

This project follows [Semantic Versioning](https://semver.org/) and commit messages use the
[Conventional Commits](https://www.conventionalcommits.org/) style.

## [0.9.0] - 2026-05-01

Reworks the title bar so the tab strip, calendar tab, and window controls all
stay readable when many notes are open or the window is narrow, and fixes a
chain of layout bugs that caused the calendar view, toolbar, status bar, and
sidebar to break when tabs grew long.

### New Features

- **Pinned calendar tab.** The calendar view tab is now anchored to the right
  edge of the title bar, immediately to the left of the OS window controls.
  It no longer scrolls off-screen when many note tabs are open.
- **Always-visible "+" button.** The new-tab "+" button stays attached to the
  right of the last note tab and remains visible at all tab counts. When the
  strip is at full capacity the button auto-disables (greyed out, with a
  "Tab strip is full" tooltip) instead of pushing tabs into a clipped state.
- **Adaptive tab strip.** Note tabs now share the available width; as more
  tabs open, every tab shrinks uniformly down to a 64 px floor that always
  keeps the close ✕ button reachable.

### Fixed

- **Title bar no longer pushes the layout off-screen.** The title bar grid
  used `1fr` for the tab strip column, which was internally `minmax(auto, 1fr)`
  and grew with content. Switching to `minmax(0, 1fr)` keeps the bar inside
  the viewport so the document never gets a horizontal scrollbar when many
  tabs are open.
- **Calendar view fully renders again.** With the title bar contained, the
  calendar's month grid and todo sidebar both fit in the workspace at all
  window widths. The calendar sidebar can now shrink with the workspace
  instead of starving the month grid at narrow viewports.
- **Status bar and toolbar respond to narrow windows.** The same
  `minmax(0, 1fr)` fix is applied to the status bar grid (including the
  `(max-width: 980px)` override). The toolbar title input is now flexible
  via `flex: 1 1 180px` (and `flex: 1 1 120px` under the
  `(max-width: 1080px)` override) so it shrinks instead of pushing other
  buttons off the row.
- **Tab title clipping is more legible.** Crowded tabs use `text-overflow:
  clip` instead of `ellipsis`, so leading characters of every title remain
  visible even when each tab is narrow — the previous behavior turned every
  tab into a uniform "…" and made tabs indistinguishable.
- **App shell is fenced against horizontal overflow.** `.app-shell` and
  `.workspace` now carry `min-width: 0` and `overflow: hidden` so any future
  child overflow stays inside its container instead of leaking to the
  document.

## [0.8.1] - 2026-04-23

Fixes the note-list right-click delete flow so deletion only completes after
the user confirms and the backend can safely move the note file to trash.

### Fixed

- **Delete confirmation now gates destructive work.** Right-clicking a note and
  choosing Delete now delegates to the app-level delete handler, which asks for
  confirmation before resolving unsaved changes or calling the backend delete
  command.
- **Canceled or failed trash operations preserve notes.** If the OS trash step
  fails, is canceled, or cannot confirm the file state, HwanNote leaves the
  note in the sidebar and keeps the library index intact instead of silently
  dropping it.
- **Stale missing files still clean up safely.** If the index points at a file
  that is already gone before deletion starts, HwanNote can remove only that
  stale index entry.
- **Autosave/delete races are guarded.** Backend delete now resolves, trashes,
  and updates the index inside the file-manager delete transaction, with tests
  covering failed trash, missing files, same-path recreation, and concurrent
  path changes.

## [0.8.0] — 2026-04-23

Introduces a three-kind classification for calendar items — **Task**, **Event**,
and **Deadline** — so time-anchored items (exams, birthdays, report due dates)
render distinctly from actionable to-dos. Events and deadlines are date-pinned,
non-completable, and excluded from overdue/done flows; tasks keep their existing
behavior unchanged.

### New Features

- **Kind selector on the day add-row.** A segmented control (할 일 / 일정 / 마감)
  sits beside the add-input on the day view. The selected kind persists across
  submissions so users can quickly add multiple events in a row when planning.
  The control is keyboard accessible with ARIA radio semantics
  (`role="radiogroup"` + `role="radio"` + `aria-checked`).
- **Event badge.** Items created with kind `event` render a blue calendar-icon
  badge in place of the checkbox. Events are non-completable and never show
  due-date, span, or overdue chips — they're informational markers on a day.
- **Deadline badge.** Items created with kind `deadline` render an amber flag-icon
  badge. Like events, they are single-day markers with no completion state, but
  use a distinct color to signal attention without escalating to red.
- **Dedicated sections in the All-tasks view.** The sidebar's All view now renders
  Events and Deadlines sections above the existing task groups, sorted
  chronologically by source date (nearest first). Section headers use the kind's
  accent color.
- **Kind-colored day-cell dots.** The month grid's indicator dots now distinguish
  four buckets (deadline > event > open task > done task) sharing the same
  3-dot budget. Deadlines render leftmost, then events, then open tasks, then
  done tasks. The cell always reserves at least one slot for open tasks when
  both open and done exist, so completion activity never hides unfinished work.
- **i18n.** Six new keys (`calendar.kindLabel`, `calendar.kindTask`,
  `calendar.kindEvent`, `calendar.kindDeadline`, `calendar.groupEvents`,
  `calendar.groupDeadlines`) shipped in both Korean and English.

### Under the hood

- **CalendarData schema bumped to v4.** The optional `kind?: TodoKind` field is
  the only structural addition; existing v1/v2/v3 data migrates transparently.
  Tasks omit the field in JSON (only events and deadlines serialize `kind`) so
  existing files don't churn on first save.
- **Data-boundary enforcement.** `normalizeTodoItem` forces `done: false`,
  `dueDateKey: null`, `completedAt: null`, and `showSpan: undefined` on any
  loaded event/deadline — hand-edited JSON that violates the invariant is
  silently cleaned rather than crashing.
- **Inbox invariant.** The inbox can only hold tasks. `normalizeInboxArray`
  strips any `kind` value from loaded inbox items, guarding against hand-edited
  JSON that would otherwise produce a row unreachable from any UI surface.
- **Store-level guards.** `toggleTodo`, `setTodoDueDate`, `clearTodoDueDate`,
  and `setTodoShowSpan` no-op on non-task kinds; `updateTodo`'s `done` branch
  is gated to tasks only.
- **Span-bar exclusion.** Week span bars skip event and deadline items even
  though the data-layer invariant already prevents them from having a due date.
- **Theme tokens.** Four new CSS variables (`--kind-event`, `--kind-event-bg`,
  `--kind-deadline`, `--kind-deadline-bg`) are defined in both `lightTheme` and
  `darkTheme` plus the `:root` initial-paint fallback.

### Upgrading

- No manual steps. First launch after install migrates calendar data in place.
- The auto-updater will detect v0.8.0 and prompt to install on next run.

## [0.7.0] — 2026-04-18

Adds horizontal "span bars" to the month grid so multi-day tasks (like an
exam window or a project stretch) show up at a glance, with per-task
opt-out, color rotation, hover highlighting across weeks, and click-to-open.

### New Features

- **Task span bars in the month grid.** Any todo with both a placement
  date and a due date now renders as a thin horizontal bar that spans
  every day between the two, rounding off where the span starts/ends
  within the visible week. A task that crosses a week boundary renders
  as two bars with square corners on the inside edges so the continuation
  reads visually. Same-day tasks and dateless inbox items are not spanned.
- **Per-task show/hide toggle.** Each dated todo with a due date gets a
  new "Span" chip (`calendar.spanLabel`) in its metadata row. Clicking
  the chip flips the bar on or off just for that todo. Bars are on by
  default; the chip exists for hiding multi-month tasks that would
  otherwise clutter the grid.
- **Per-task color rotation.** Bars pick one of six pastel colors via a
  deterministic hash of the todo id, so distinct tasks stay visually
  distinguishable even when stacked in the same week.
- **Hover highlighting with cross-week sync.** Hovering any bar lifts it
  (subtle scale + shadow + near-full color) and simultaneously
  highlights every other bar belonging to the same todo — handy for
  tasks that cross multiple weeks.
- **Click to open the source day.** Clicking (or pressing Enter/Space on)
  a bar switches the sidebar to "day" view for the task's registration
  date. Keyboard users get a focus ring (`:focus-visible`).
- **Muted completed bars.** When a spanned task is checked off, its bar
  shrinks to a thin grayscale stripe so finished work fades into the
  background. Hovering the stripe restores nearly the original color so
  retrospection is still possible.

### Under the hood

- New `showSpan?: boolean` field on `TodoItem` (undefined / true = show,
  false = hide). Absent by default, so existing `calendar.json` files
  load unchanged — no migration required.
- New pure helper `src/lib/calendarSpans.ts` packs week-local bars into
  vertical lanes via a greedy interval-sweep, keeping layout
  deterministic and the renderer dumb.
- `.week-row` grows a CSS custom property `--span-lanes` that reserves
  exactly as much top padding as needed; weeks without spans are
  pixel-identical to v0.6.0.

### Upgrading

- No manual steps. Existing data loads as-is; bars show up on first
  launch for any todo that already has a source date and due date.
- To hide a long-running task's bar, open its source day, find the
  todo, and click the **Span** chip once.

## [0.6.0] — 2026-04-17

Adds an Inbox for dateless todos, weekend-aware styling in the month grid, and
a calendar grid that now always starts on Sunday regardless of the week-start
preference.

### New Features

- **Inbox / undated todos.** The "All" sidebar panel now has an Inbox section
  for todos that don't yet have a date. Create, edit, check off, set a due
  date, and delete inbox items just like dated todos. Inbox state is persisted
  via a new CalendarData v3 schema; existing v1 / v2 data migrates
  transparently on first load.
- **Weekend highlighting in the month grid.** Saturday and Sunday cells now
  use distinct colors (blue and red respectively) so you can pick out weekends
  at a glance. Styling respects light and dark themes; the "today" indicator
  still takes precedence over weekend coloring on the current day.
- **Calendar grid always starts on Sunday.** The month grid's leftmost column
  is always Sunday, matching standard paper calendars. The "Week starts on"
  preference still exists but now only affects the "this week" sidebar
  filter — not the grid layout. The setting is renamed accordingly:
  - English: **"Weekly filter starts on"**
  - Korean: **"주간 필터 시작 요일"**
- **Day-number contrast refinements.** Weekend day numbers (and the "today"
  pill) render with tuned contrast in both themes for better readability.

### Under the hood

- CalendarData schema bumped to v3; older data (v1, v2) auto-migrates with no
  user action required.
- `src-tauri/Cargo.toml` and `Cargo.lock` versions were out of sync with
  `package.json` (0.4.3 vs 0.5.0); all four version sources are now aligned
  at 0.6.0 going forward.

### Upgrading

- No manual steps. First launch after install migrates calendar data in place.
- The auto-updater will detect v0.6.0 and prompt to install on next run.

## [0.5.0] and earlier

No consolidated changelog. See commit history and the
[GitHub Releases page](https://github.com/hwankr/hwanNote/releases) for prior
versions.
