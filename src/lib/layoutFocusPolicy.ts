import type { EditorFocusPermission } from "./editorFocusRestore";

// When an editor that stays visible across a split-layout change may take
// focus, and how a note navigation the user asked for carries its permission to
// the layout commit that shows it. App owns the state and the one-slot intent
// ref; these functions only read what they are given and the document's focus.

/** What a navigation selects: a tab to show in the focused pane, or tabs to close. */
export type NavigationTarget =
  | { kind: "target"; tabId: string }
  | { kind: "close"; tabIds: string[] };

/**
 * A note navigation the user started (tab, drop, unsplit, close, sidebar,
 * shortcut). App keeps at most one; a newer one replaces it, and async work
 * tells its own intent apart by object identity.
 */
export interface NavigationIntent {
  /** The focused element when the navigation started. */
  sourceElement: Element | null;
  targetOrOperation: NavigationTarget;
  /** The navigation changed the layout, or (a close) is about to. */
  applied: boolean;
}

/** Text controls keep focus over a layout change. An editor root is classified first. */
export const TEXT_CONTROL_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

/** Focus inside a dialog stays there over a layout change. */
export const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/** The parts of an editor view the rules read. */
export interface LayoutFocusView {
  readonly dom: Element;
  readonly composing: boolean;
}

export interface LayoutFocusFacts {
  /**
   * Rule 1: the layout changed, the notes view shows with settings closed, and
   * the focused pane's editor is a live, registered editor that was already
   * visible before the change (the target). App checks it again on every try.
   */
  eligible: boolean;
  target: LayoutFocusView;
  /** Every live registered editor, the target included. */
  registered: Iterable<LayoutFocusView>;
  /** The navigation this layout change carries, already matched to it. */
  intent: NavigationIntent | null;
}

/**
 * Whether the target may take focus now. Only an editor root that is the
 * document's active element counts as editor focus: a checkbox or field inside
 * an editor is a control of its own.
 */
export function layoutFocusPermission({ eligible, target, registered, intent }: LayoutFocusFacts): EditorFocusPermission {
  if (!eligible) return "deny";
  const doc = target.dom.ownerDocument;
  const active = doc.activeElement;
  const onPage = !active || active === doc.body;
  let focusedEditor: LayoutFocusView | null = null;
  if (!onPage) {
    for (const view of registered) {
      if (view.dom === active) {
        focusedEditor = view;
        break;
      }
    }
  }
  // A dialog keeps focus, even on a registered editor root; a text control
  // other than a registered editor root does too. Neither yields to a navigation.
  if (!onPage && (active.closest(DIALOG_SELECTOR) || (!focusedEditor && active.closest(TEXT_CONTROL_SELECTOR)))) {
    return "deny";
  }
  // Moving focus away would end another editor's composition.
  if (focusedEditor && focusedEditor.dom !== target.dom && focusedEditor.composing) return "deny";
  if (focusedEditor && focusedEditor.dom === target.dom) return "already-focused";
  if (onPage || focusedEditor) return "allow";
  // Any other control (a tab, a toolbar or sidebar button, a menu item) keeps
  // focus unless it started the navigation this change shows and still has it.
  return intent !== null && active === intent.sourceElement ? "allow" : "deny";
}

export type NavigationIntentDecision = "keep" | "discard" | "consume";

export interface NavigationCommitFacts {
  /** The pane editors or the focused pane's editor differ from the previous commit. */
  layoutChanged: boolean;
  /** The notes view shows and settings are closed. */
  notesVisible: boolean;
  openTabIds: readonly string[];
  /** The tab of the focused pane's editor; null while pane normalization is pending. */
  focusedTabId: string | null;
  /** The tabs the panes named at the previous commit (the secondary only while split). */
  previousPaneTabIds: readonly (string | null)[];
}

/**
 * What a commit does with the pending intent: "consume" it (the first commit
 * that shows its result with a focused editor; the caller uses it once),
 * "keep" it for a later commit of the same navigation, or "discard" it.
 */
export function decideNavigationIntent(intent: NavigationIntent, facts: NavigationCommitFacts): NavigationIntentDecision {
  if (!facts.notesVisible) return "discard";
  const operation = intent.targetOrOperation;
  if (operation.kind === "target" ? !facts.openTabIds.includes(operation.tabId) : facts.openTabIds.length === 0) {
    return "discard";
  }
  if (!intent.applied) return "keep";
  if (operation.kind === "target") {
    // A selection commits with the handler's own state change. A commit that
    // left the layout as it was means it changed nothing.
    if (!facts.layoutChanged) return "discard";
    if (facts.focusedTabId === null) return "keep";
    return facts.focusedTabId === operation.tabId ? "consume" : "discard";
  }
  // A close counts only for the layout change that closing a shown tab made:
  // the first commit, or the pane normalization right after it.
  const closedShownTab = operation.tabIds.some((tabId) =>
    facts.previousPaneTabIds.includes(tabId) && !facts.openTabIds.includes(tabId));
  if (!facts.layoutChanged || !closedShownTab || facts.focusedTabId === null) return "keep";
  return "consume";
}
