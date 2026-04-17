# Changelog

All notable user-facing changes to HwanNote are documented here.

This project follows [Semantic Versioning](https://semver.org/) and commit messages use the
[Conventional Commits](https://www.conventionalcommits.org/) style.

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
