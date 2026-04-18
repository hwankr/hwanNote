# Changelog

All notable user-facing changes to HwanNote are documented here.

This project follows [Semantic Versioning](https://semver.org/) and commit messages use the
[Conventional Commits](https://www.conventionalcommits.org/) style.

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
