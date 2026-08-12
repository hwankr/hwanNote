# Changelog

All notable user-facing changes to HwanNote are documented here.

This project follows [Semantic Versioning](https://semver.org/) and commit messages use the
[Conventional Commits](https://www.conventionalcommits.org/) style.

## [0.9.9] - 2026-08-12

Fixes an update-install data-loss risk where HwanNote could release its close
guard before pending calendar and note writes had finished.

### Fixed

- **Update installation now fails closed on calendar save problems.** HwanNote
  waits for the guarded calendar save and does not start installation when the
  save is blocked or fails.
- **All note writes drain before restart.** Pending title drafts, debounced
  autosaves, dirty notes, and already-running per-note save tasks are completed
  before the updater receives permission to close the app.

## [0.9.8] - 2026-08-12

Fixes a calendar data-loss race where automatic cloud recovery could reload the
cloud calendar before a pending local edit reached its delayed autosave.

### Fixed

- **Cloud recovery serializes calendar writes and reloads.** Recovery now pauses
  calendar mutations, waits for an active save, and flushes pending fallback
  edits to their original local source before reading the restored cloud file.
- **Local changes receive a durable recovery copy.** Calendar edits at risk
  during a source transition are preserved in a uniquely named local recovery
  file without overwriting either the local or cloud `calendar.json`.
- **Unsafe recovery attempts fail closed.** A failed source save, recovery-copy
  write, corrupt load, or non-cloud reload keeps recovery pending and leaves the
  current note library untouched for a safe retry.
- **Recovery copies are bounded and deduplicated.** Repeated retries reuse an
  identical recovery file, while size and retention limits prevent uncontrolled
  disk growth.

## [0.9.7] - 2026-08-12

Fixes a data-loss risk where changing the interface language could reload the
note library, cancel a pending autosave, and replace an unsaved library tab with
its older on-disk copy.

### Fixed

- **Language changes no longer reload notes.** Initial note hydration now runs
  once independently of locale-aware display sorting, including under React
  Strict Mode.
- **Reloads preserve edits made during I/O.** Before an intentional library
  reload, dirty tabs are saved; edits that race with a same-source reload stay
  in place and resume autosaving afterward.
- **Source changes fail closed or recover conflicts.** A reload is refused when
  dirty tabs cannot be saved, while edits made during a real storage-source
  transition are retained as unsaved recovery tabs instead of being overwritten.

## [0.9.6] - 2026-08-12

Fixes a cloud-sync data-loss risk where deleting a cloud note or changing its
folder after the cloud directory disappeared could target a same-ID note or
folder in local fallback storage instead.

### Fixed

- **Library mutations stay bound to their load source.** Note deletion and
  folder creation, rename, and deletion now carry the library's resolved
  `loadedFrom` value into Rust and never recalculate a fallback destination.
- **Unavailable cloud targets fail closed.** A mutation for a cloud-loaded
  library is rejected when cloud storage is unavailable, leaving any same-ID
  local note and matching local folder untouched.
- **Recovery pauses note and folder changes.** HwanNote blocks destructive and
  folder-changing actions while cloud recovery or a library transition is in
  progress, and rechecks the captured source after confirmation dialogs before
  invoking the filesystem command.

## [0.9.5] - 2026-08-11

Fixes a calendar corruption recovery bug where a malformed `calendar.json` could
be treated like an empty calendar and then overwritten on exit before the user
had a chance to recover or explicitly reset it.

### Fixed

- **Corrupt calendars stay blocked until recovery.** Parse failures now keep
  the calendar in a dedicated recovery state instead of silently converting it
  into a writable empty calendar.
- **Reload and reset clear the recovery guard explicitly.** Successfully
  reloading from disk releases the write guard, and the empty-calendar reset
  path now uses a dedicated recovery command that clears the guard after a
  confirmed reset.
- **The calendar page shows recovery actions.** When the calendar cannot be
  read, the calendar view now presents the source path, backup path, and
  recovery actions instead of exposing the normal editing UI.

## [0.9.4] - 2026-08-11

Fixes a cloud-sync data-loss risk where notes opened from local fallback
storage could overwrite same-ID cloud notes after a delayed cloud folder
became available.

### Fixed

- **Note saves remain bound to their load source.** Note loads now carry the
  resolved storage source through the frontend and back into Rust saves.
  Notes loaded from local fallback continue writing only to local storage,
  even if the configured cloud folder appears before the next autosave.
- **Recovered cloud storage is reloaded before writes resume.** HwanNote
  monitors cloud availability, pauses note writes during a source transition,
  waits for active saves to settle, and reloads the authoritative cloud
  library before enabling saves again.
- **Local/cloud conflicts are preserved without overwrites.** When a local
  fallback note differs from the recovered same-ID cloud note, the cloud note
  stays authoritative and the local content opens as a separate unsaved
  recovery tab for review.
- **Mid-session disconnects use the same recovery guard.** If a cloud library
  disappears after it was loaded, writes stay suspended until the folder
  returns and the reload/merge step completes.

## [0.9.3] - 2026-08-11

Fixes a data-loss risk where an older autosave completion could incorrectly
mark newer in-memory edits as saved.

### Fixed

- **Autosave completion is revision-safe.** Each tab now advances its own
  revision whenever persisted content changes. A completed write clears the
  dirty state only when it saved the tab's current revision, so edits made
  during an in-flight save remain protected by autosave retries and close
  warnings.
- **Saved snapshots match disk contents.** Save completion records the exact
  request-time snapshot that was written instead of rebuilding it from newer
  live editor state.
- **Same-tab writes are serialized.** Autosave, manual save, close-triggered
  save, and pin updates share a per-tab queue so an older write cannot finish
  after and overwrite a newer one.
- **Pending autosaves are tracked per tab.** Switching between notes no longer
  displaces another tab's queued retry.

## [0.9.1] - 2026-05-01

Fixes a cloud-sync data-loss risk where `calendar.json` could be overwritten
with an empty fallback calendar if HwanNote started before Google Drive or
another configured cloud folder was available.

### Fixed

- **Cloud calendars are protected during delayed Drive startup.** Calendar
  loads now remember whether data came from local storage, cloud storage, or a
  local fallback used while the cloud folder was missing. Fallback-loaded
  calendar data is saved back to local storage instead of being written into
  the cloud folder after Drive appears.
- **Storage changes flush calendar edits first.** Changing the cloud provider,
  switching between local and cloud libraries, or changing the local library
  directory now saves pending calendar edits before the storage target changes
  and reloads calendar data from the new source afterward.
- **Existing cloud `calendar.json` files are not overwritten during migration.**
  When local notes are copied into a cloud library, the calendar file is copied
  only if the destination does not already have one. The copy uses exclusive
  file creation so a concurrently downloaded cloud calendar still wins safely.
- **Failed calendar saves block destructive transitions.** If the app cannot
  flush calendar data before a storage change or window close, it keeps the
  current session open and shows an error instead of silently dropping edits.

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
