# Tab Overflow Layout Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the top tab strip grows beyond the available width (many tabs or long titles), the tab strip must scroll **internally** and never push the titlebar, workspace, calendar, toolbar, or status bar outside the viewport.

**Architecture:** The bug is a CSS layout failure, not a JS bug. The titlebar uses CSS Grid `grid-template-columns: 52px 1fr 138px`, where `1fr` resolves to `minmax(auto, 1fr)`. That `auto` minimum lets the middle column expand to its content's intrinsic size — i.e. the full unwrapped width of every tab — overriding the inner `.tabs { overflow-x: auto }`. The grid widens, the document gets a horizontal scrollbar, every full-width sibling (`.toolbar`, `.workspace`, `.statusbar`) loses its viewport assumption, and the calendar's fixed-width sidebar (`360px` with `min-width: 320px`) then squeezes the month grid until `.calendar-page { overflow: hidden }` clips it.

The fix locks each `1fr` grid column to `minmax(0, 1fr)`, fences the app shell against horizontal overflow as a safety net, makes the calendar sidebar shrinkable instead of hard-pinned, and lets the toolbar's title input flex.

**Tech Stack:** CSS only. No new dependencies. Files touched: `src/styles/global.css`, `src/styles/calendar.css`. There is no automated test runner for CSS in this repo (`package.json` has no test scripts), so each task verifies by `npm run typecheck` (regression guard) plus manual repro inside `npm run dev`.

---

## Investigation Summary

Verified against current source:

- `src/styles/global.css:54-62` — `.titlebar { display: grid; grid-template-columns: 52px 1fr 138px; }`. The middle `1fr` is the **primary root cause**: `1fr` = `minmax(auto, 1fr)`, so the column's minimum size is its content's intrinsic width. With many tabs the column grows past `1fr` and pushes the whole grid wider than the viewport.
- `src/styles/global.css:75-79` — `.titlebar-center { gap: 8px; min-width: 0; overflow: hidden; }`. The `min-width: 0` here is correct, but it's powerless once the grid column itself has expanded.
- `src/styles/global.css:121-128` — `.tabs { display: flex; flex: 1 1 auto; gap: 6px; min-width: 0; overflow-x: auto; scrollbar-width: none; }`. This *would* scroll internally if the parent column were constrained.
- `src/styles/global.css:140-156` — `.tab { display: flex; max-width: 220px; ... }`. Each tab caps at 220px; ten tabs alone reach ~2200px before gaps and badges. There is **no `flex-shrink: 0`** on `.tab`; the children (`.tab-pin`, `.tab-split-badge`, `.tab-close`) already set `flex-shrink: 0` (lines 231, 264, 285), and `.tab-title` ellipses with `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` (lines 234-238).
- `src/styles/global.css:1454-1464` — `.statusbar { display: grid; grid-template-columns: 1fr auto 1fr; }`. Same `minmax(auto, 1fr)` pitfall as the titlebar; if a status item ever grows it pushes the bar.
- `src/styles/global.css:46-52` — `.app-shell { display: flex; flex-direction: column; height: 100%; min-height: 0; }`. No horizontal containment. If any child overflows, the document scrolls.
- `src/styles/global.css:568-572` — `.workspace { display: flex; flex: 1; min-height: 0; }`. Row flex with no `min-width: 0` on its children.
- `src/styles/calendar.css:3-8` — `.calendar-page { flex: 1; display: flex; background: var(--bg-editor); overflow: hidden; }`. The `overflow: hidden` is what *visibly* clips the calendar grid once space runs out.
- `src/styles/calendar.css:239-247` — `.calendar-sidebar { width: 360px; min-width: 320px; ... }`. Hard `min-width: 320px` floor combined with the fixed `width: 360px` means under pressure this panel refuses to shrink, starving `.month-grid-container`.
- `src/styles/global.css:497-517` — `.toolbar-title-field input { width: 180px; ... }`. Fixed width with no `min-width` or shrink behavior; one of the "기타 UI" elements that breaks under reduced viewport.
- `src/components/TitleBar.tsx:292-405` — Tab JSX is fine; the bug is purely CSS.
- `src/components/calendar/CalendarPage.tsx` — Renders `.calendar-page > .month-grid-container + .calendar-sidebar`; structure is fine.

## File Map

**Modify**
- `src/styles/global.css` — fix `.titlebar` grid template, add app-shell overflow guard, add `min-width: 0` defenses on `.workspace` children and `.titlebar-center`, fix `.statusbar` grid template, make `.toolbar-title-field input` flexible.
- `src/styles/calendar.css` — relax `.calendar-sidebar` width to a clamp + `flex-shrink` so the month grid keeps its room at narrow widths.

**Not modified**
- `src/components/TitleBar.tsx` — tab strip JSX already supports `overflow-x: auto`. No change needed.
- `src/App.tsx` — layout structure is correct; the failure is in CSS sizing.
- `src/components/calendar/*` — DOM is correct.
- `src/components/Toolbar.tsx`, `Sidebar.tsx`, `StatusBar.tsx` — JSX is correct; only their stylesheets change.

---

## Behavior Contract

- Opening 20+ tabs with 30+ character titles must NOT cause the document/body to scroll horizontally.
- The tab strip must scroll **internally** (its existing `overflow-x: auto`) without changing the size of any sibling.
- The "+" tab (`.add-tab-btn`) must remain visible when scrolled (sticky right) without overflowing the titlebar.
- The window control cluster (`titlebar-right`, 138px) must stay fully visible in all tab counts.
- Switching to the calendar view at any tab count must render the full month grid without clipping.
- The calendar sidebar must remain readable at the smallest reasonable Tauri window width (640 px), shrinking gracefully instead of forcing a horizontal scroll.
- The toolbar's title input must shrink instead of overflowing when the window narrows.
- Existing flexible behaviors (sidebar collapse, split editor, drag handle) must not regress.

---

## Task 1: Lock the titlebar grid so tabs cannot widen the layout

**Files:**
- Modify: `src/styles/global.css:54-62`

- [ ] **Step 1: Replace the titlebar grid template**

Edit `src/styles/global.css` lines 54-62. Change:

```css
.titlebar {
  display: grid;
  grid-template-columns: 52px 1fr 138px;
  align-items: center;
  height: 44px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-surface);
  -webkit-app-region: drag;
}
```

to:

```css
.titlebar {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) 138px;
  align-items: center;
  height: 44px;
  min-width: 0;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-surface);
  -webkit-app-region: drag;
}
```

The `minmax(0, 1fr)` removes the automatic content-based minimum so the middle column can shrink below the tabs' intrinsic width. `min-width: 0` on the grid itself is a belt-and-suspenders guard so the grid container itself can shrink inside `.app-shell`.

- [ ] **Step 2: Type-check still passes**

Run: `npm run typecheck`
Expected: exits 0 (CSS doesn't affect TS, but this confirms nothing else regressed).

- [ ] **Step 3: Manual repro — overflow tabs**

Run: `npm run dev`
Open 15+ notes so the tab strip is wider than the window. Confirm:
- The tab strip scrolls horizontally inside the titlebar (`.tabs` already has `overflow-x: auto`).
- The window control cluster on the right is still fully visible.
- No horizontal scrollbar on the document/body.

- [ ] **Step 4: Commit**

```bash
git add src/styles/global.css
git commit -m "fix(layout): cap titlebar middle column with minmax(0, 1fr)"
```

---

## Task 2: Fence the app shell against any residual horizontal overflow

**Files:**
- Modify: `src/styles/global.css:46-52`

- [ ] **Step 1: Add overflow guard to .app-shell**

Edit `src/styles/global.css` lines 46-52. Change:

```css
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-shell);
}
```

to:

```css
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-shell);
}
```

`width: 100%` plus `overflow: hidden` makes the shell a hard frame so any overflow from a child (third-party widget, future regression) cannot leak to the document. `min-width: 0` lets the shell itself participate in its own flex parent (`#root`) without inheriting an `auto` minimum.

- [ ] **Step 2: Manual repro — no document scroll**

Run: `npm run dev`. Repeat the 15-tab repro from Task 1. Inspect with DevTools: `document.documentElement.scrollWidth === document.documentElement.clientWidth` must be true.

- [ ] **Step 3: Commit**

```bash
git add src/styles/global.css
git commit -m "fix(layout): fence app-shell so children cannot leak horizontal overflow"
```

---

## Task 3: Defend the workspace row against flex-child intrinsic widths

**Files:**
- Modify: `src/styles/global.css:568-572`

- [ ] **Step 1: Add min-width:0 defenses to .workspace**

Edit `src/styles/global.css` lines 568-572. Change:

```css
.workspace {
  display: flex;
  flex: 1;
  min-height: 0;
}
```

to:

```css
.workspace {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workspace > * {
  min-width: 0;
}
```

`min-width: 0` on `.workspace` itself protects against horizontal overflow when the parent shell narrows. The descendant rule ensures every direct child (sidebar, editor workspace, calendar page) participates in flex shrinking instead of hitting the default `auto` minimum.

- [ ] **Step 2: Manual repro — sidebar + calendar at narrow window**

Run: `npm run dev`. Resize the Tauri window down to ~700 px wide while the calendar view is active. Confirm:
- Sidebar still renders at 320 px.
- Calendar grid is visible (may be tight, but not clipped to invisibility).
- No horizontal document scrollbar appears.

- [ ] **Step 3: Commit**

```bash
git add src/styles/global.css
git commit -m "fix(layout): allow workspace flex children to shrink"
```

---

## Task 4: Apply the same minmax(0, 1fr) fix to the status bar

**Files:**
- Modify: `src/styles/global.css:1454-1464`

- [ ] **Step 1: Replace the statusbar grid template**

Edit `src/styles/global.css` lines 1454-1464. Change:

```css
.statusbar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-top: 1px solid var(--border-soft);
  background: var(--bg-status);
  color: var(--text-muted);
  font-size: 12px;
}
```

to:

```css
.statusbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  height: 30px;
  min-width: 0;
  padding: 0 12px;
  border-top: 1px solid var(--border-soft);
  background: var(--bg-status);
  color: var(--text-muted);
  font-size: 12px;
}
```

Same root cause as the titlebar: `1fr` defaults to `minmax(auto, 1fr)`. If left-side or right-side status content ever grows (long file path, locale strings) it would push the bar.

- [ ] **Step 2: Manual repro — narrow window, long path**

Run: `npm run dev`. Open a note whose name is intentionally long. Resize to ~700 px wide. Confirm the statusbar lays out without overflowing the window.

- [ ] **Step 3: Commit**

```bash
git add src/styles/global.css
git commit -m "fix(layout): cap statusbar grid columns with minmax(0, 1fr)"
```

---

## Task 5: Make the calendar sidebar shrinkable instead of hard-pinned

**Files:**
- Modify: `src/styles/calendar.css:239-247`

- [ ] **Step 1: Replace the calendar-sidebar sizing**

Edit `src/styles/calendar.css` lines 239-247. Change:

```css
.calendar-sidebar {
  width: 360px;
  min-width: 320px;
  border-left: 1px solid var(--border-soft);
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```

to:

```css
.calendar-sidebar {
  flex: 0 1 360px;
  width: clamp(260px, 30vw, 360px);
  min-width: 0;
  border-left: 1px solid var(--border-soft);
  background: var(--bg-surface);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```

`flex: 0 1 360px` keeps the preferred size at 360 px but allows shrinking when the parent runs out of room. `width: clamp(260px, 30vw, 360px)` gives a sensible responsive band: never below 260 px (still readable for the todo lists), never above 360 px. `min-width: 0` removes the previous hard 320 px floor that was starving the month grid.

> **Divergence (during execution):** The `width: clamp(260px, 30vw, 360px)` line above was dropped in commit `ee0bf53`. Both the code-quality and codex adverse reviews showed that an explicit `flex-basis` (`360px` from `flex: 0 1 360px`) overrides `width` for sizing in a flex container per CSS Flexbox §7, so the `clamp()` had no effect on the rendered minimum. The practical floor is provided by `minWidth: 960` in `src-tauri/tauri.conf.json`. Final block contains only `flex: 0 1 360px; min-width: 0; ...`.

- [ ] **Step 2: Manual repro — calendar at narrow window**

Run: `npm run dev`. Open the calendar view. Resize the Tauri window to ~720 px wide. Confirm:
- Both the month grid and the calendar sidebar are visible.
- Neither is clipped to invisibility by `.calendar-page { overflow: hidden }`.
- Day numbers and todo titles are still readable inside the sidebar at the narrowest width.

- [ ] **Step 3: Manual repro — calendar at wide window**

Resize back to a normal window width (≥ 1280 px). Confirm the sidebar settles at its 360 px preferred width and the month grid is unchanged from current behavior.

- [ ] **Step 4: Commit**

```bash
git add src/styles/calendar.css
git commit -m "fix(calendar): allow calendar sidebar to shrink with the workspace"
```

---

## Task 6: Make the toolbar title input flexible

**Files:**
- Modify: `src/styles/global.css:497-517`

- [ ] **Step 1: Replace the toolbar title-field input sizing**

Edit `src/styles/global.css` lines 497-517. Change the existing rules to:

```css
.toolbar-title-field {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
}

.toolbar-title-field input {
  width: 180px;
  min-width: 0;
  flex: 1 1 180px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  background: var(--bg-elevated);
  transition: border-color 120ms ease, box-shadow 120ms ease;
}

.toolbar-title-field input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(0, 120, 212, 0.15);
  outline: none;
}
```

`flex: 0 1 auto` and `min-width: 0` on `.toolbar-title-field` let the field group participate in toolbar shrinking. `flex: 1 1 180px` on the input means: prefer 180 px, grow if the toolbar has room, shrink if it doesn't. `min-width: 0` removes the input's intrinsic content minimum.

- [ ] **Step 2: Manual repro — toolbar at narrow window**

Run: `npm run dev`. Open a note so the toolbar is visible. Resize to ~720 px wide. Confirm:
- The title field shrinks instead of overflowing.
- Other toolbar buttons remain visible.
- Typing in the title input still works and shows the cursor.

- [ ] **Step 3: Commit**

```bash
git add src/styles/global.css
git commit -m "fix(toolbar): allow title input to shrink with the toolbar"
```

---

## Task 7: Add a defensive min-width:0 on .titlebar-center's parent grid item

**Files:**
- Modify: `src/styles/global.css:75-79`

- [ ] **Step 1: Confirm titlebar-center already has the right rules**

Re-read `src/styles/global.css` lines 75-79. Confirm it currently is:

```css
.titlebar-center {
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}
```

If yes, leave the file unchanged for this task — Task 1's `minmax(0, 1fr)` plus the existing `min-width: 0` and `overflow: hidden` are now sufficient. Move to Step 2 without editing.

If for any reason the rule has drifted (e.g. someone removed `min-width: 0` between this plan being written and being executed), restore it to the block above and re-run typecheck.

- [ ] **Step 2: No commit needed if no edit**

If Step 1 required an edit, run `git add src/styles/global.css && git commit -m "fix(layout): restore min-width:0 on .titlebar-center"`. Otherwise skip.

---

## Task 8: Final verification matrix

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 2: Build**

Run: `npm run build:frontend`
Expected: builds without warnings related to CSS.

- [ ] **Step 3: Run the dev app**

Run: `npm run dev`. Wait for the Tauri window to appear.

- [ ] **Step 4: Tab-overflow scenario**

In the running app:
1. Create or open at least 15 notes so they exceed the title bar's available width.
2. Optionally rename a few to long titles (>30 chars) to stress `max-width: 220px`.
3. Confirm: the tabs scroll horizontally inside the titlebar, the `+` button stays sticky at the right, the window controls (minimize/maximize/close) remain fully visible, and the document does NOT scroll horizontally.

- [ ] **Step 5: Calendar-cutoff scenario**

In the running app, with the same many tabs open:
1. Click the calendar tab to switch to calendar view.
2. Confirm: the full month grid renders (all seven day columns and all visible week rows), the calendar sidebar (todos panel) is visible, and nothing is clipped.
3. Resize the Tauri window down to ~720 px wide.
4. Confirm: both panes still render, the sidebar shrinks gracefully toward 260 px, no horizontal document scroll appears.

- [ ] **Step 6: Other-UI scenarios**

Still in the running app:
1. Toggle the sidebar with the menu button — confirm it animates and the editor takes its space.
2. Open the toolbar (notes view) on a narrow window — confirm the title input shrinks rather than pushing other buttons off-screen.
3. Open the status bar at the bottom — confirm it stays inside the window and its center segment is centered.
4. Drag the window across monitors with different DPIs — confirm no layout drift beyond what already exists.

- [ ] **Step 7: Final commit (only if Task 7 added an edit, otherwise skip)**

If any verification revealed a tweak was needed, fix it inline and commit with a focused message. Otherwise no further commit is required for this task.

---

## Out of Scope

- Changing the tab `max-width: 220px` cap — current behavior is intentional and works once the parent column is constrained.
- Adding scroll arrows / keyboard scrolling to the tab strip — separate UX feature, not a layout bug.
- Refactoring `App.tsx` or splitting `global.css` — the file is large but stable; this fix should not pile on unrelated cleanup.
- Adding automated visual regression tests — repo has no test runner today; introducing one is its own project.
- Updating CHANGELOG.md / version bump — leave for a separate release-prep commit.

## Risks & Mitigations

- **Risk:** `overflow: hidden` on `.app-shell` could clip a future modal or popover that escapes the shell. **Mitigation:** existing modals (`.context-menu`, `.settings-overlay`) use `position: fixed` relative to the viewport, which is unaffected by ancestor `overflow: hidden`. Verified at `src/styles/global.css:361-372` (`.context-menu`) and `1488-1495` (`.settings-overlay`).
- **Risk:** Lowering the calendar sidebar minimum to 260 px may cramp the todos list. **Mitigation:** the existing `.calendar-sidebar` already has `overflow: hidden` and its inner panels handle scroll; the visual density at 260 px is acceptable for the same reason 320 px was acceptable.
- **Risk:** `min-width: 0` cascade on `.workspace > *` could affect a future child that needs an intrinsic minimum. **Mitigation:** scoped to direct children of `.workspace` only; any new child explicitly setting `min-width` will override.
