import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// WebView2 can lose the IME's caret anchor after a native resize. DOM focus
// still looks correct, but preedit text appears outside the editor until a
// real focus transition. https://github.com/MicrosoftEdge/WebView2Feedback/issues/5675
//
// The refresh briefly blurs the focused editor, so it avoids running while the
// user types and, under the conditions below, gives focus back to the editor
// it blurred:
// - tao reports every WM_WINDOWPOSCHANGED without SWP_NOMOVE as a move, even
//   when the window stays put. Only a changed position counts as movement.
// - Input or composition cancels a pending refresh. A due refresh runs only if
//   there was no input for INPUT_QUIET_MS before it runs, so a geometry change
//   in a longer pause in typing can still cause one refresh.
// - Once blurred, the editor is refocused in the next task, or earlier on the
//   next key, pointer press or composition. Restore only while that editor is
//   connected and no other control has taken focus; while the window is hidden
//   or unfocused, wait until it is visible and active again.
const SETTLE_DELAY_MS = 150;
const INPUT_QUIET_MS = 1_000;
const MODIFIER_KEYS = new Set(["Alt", "AltGraph", "Control", "Meta", "OS", "Shift"]);

interface PendingRestore {
  element: HTMLElement;
  anchor: Node | null | undefined;
  focus: Node | null | undefined;
  anchorOffset: number;
  focusOffset: number;
  scrollPositions: Array<[HTMLElement, number, number]>;
}

function focusedNoteEditor(): HTMLElement | null {
  const element = document.activeElement;
  return element instanceof HTMLElement && element.matches('.note-editor[contenteditable="true"]')
    ? element : null;
}

function validSelectionOffset(node: Node, offset: number): boolean {
  const length = node.nodeType === Node.TEXT_NODE
    ? node.textContent?.length ?? 0 : node.childNodes.length;
  return offset >= 0 && offset <= length;
}

export function installWindowsImeRecovery(): () => void {
  if (!isTauri() || !/Windows NT/.test(navigator.userAgent)) return () => {};

  let disposed = false;
  let composing = false;
  let candidate: HTMLElement | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingRestore: PendingRestore | null = null;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let windowPosition: { x: number; y: number } | null = null;
  const unlisteners: Array<() => void> = [];

  const cancelScheduled = () => {
    clearTimeout(settleTimer);
    settleTimer = undefined;
    candidate = null;
  };

  const dropRestore = () => {
    clearTimeout(restoreTimer);
    restoreTimer = undefined;
    pendingRestore = null;
  };

  // Refocus the editor blurred below. Never take focus back from a different
  // control or a newly mounted editor. Without document focus, keep waiting:
  // Chromium restores the previously focused element when the window becomes
  // active again, and the editor must not lose that because of this module.
  const restoreFocus = (windowFocused = false) => {
    clearTimeout(restoreTimer);
    restoreTimer = undefined;
    const pending = pendingRestore;
    if (!pending) return;
    const { element } = pending;
    const active = document.activeElement;
    if (!element.isConnected || (active !== null && active !== document.body && active !== element)) {
      pendingRestore = null;
      return;
    }
    if (document.visibilityState !== "visible" || (!windowFocused && !document.hasFocus())) return;

    pendingRestore = null;
    element.focus({ preventScroll: true });
    const { anchor, focus, anchorOffset, focusOffset } = pending;
    if (anchor?.isConnected && focus?.isConnected && element.contains(anchor) && element.contains(focus) &&
        validSelectionOffset(anchor, anchorOffset) && validSelectionOffset(focus, focusOffset)) {
      window.getSelection()?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    }
    pending.scrollPositions.forEach(([ancestor, left, top]) => {
      ancestor.scrollLeft = left;
      ancestor.scrollTop = top;
    });
  };

  const recover = () => {
    settleTimer = undefined;
    const element = candidate;
    candidate = null;
    if (disposed || composing || !element || !element.isConnected ||
        document.visibilityState !== "visible" || !document.hasFocus() ||
        focusedNoteEditor() !== element || Date.now() - lastInputAt < INPUT_QUIET_MS) return;

    const selection = window.getSelection();
    const scrollPositions: Array<[HTMLElement, number, number]> = [];
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      scrollPositions.push([ancestor, ancestor.scrollLeft, ancestor.scrollTop]);
    }
    pendingRestore = {
      element,
      anchor: selection?.anchorNode,
      focus: selection?.focusNode,
      anchorOffset: selection?.anchorOffset ?? 0,
      focusOffset: selection?.focusOffset ?? 0,
      scrollPositions,
    };
    element.blur();
    // Give WebView2 a separate task to observe the loss of DOM focus. A
    // synchronous blur/focus pair can be coalesced and leave the anchor stale.
    restoreTimer = setTimeout(() => restoreFocus(), 0);
  };

  const geometryChanged = () => {
    // A geometry change during composition happens while the user is typing.
    if (disposed || composing) return;
    clearTimeout(settleTimer);
    candidate = focusedNoteEditor();
    settleTimer = candidate ? setTimeout(recover, SETTLE_DELAY_MS) : undefined;
  };

  const onMoved = ({ payload }: { payload: { x: number; y: number } }) => {
    const previous = windowPosition;
    windowPosition = { x: payload.x, y: payload.y };
    if (previous && (previous.x !== payload.x || previous.y !== payload.y)) geometryChanged();
  };

  const inputStarted = () => {
    lastInputAt = Date.now();
    // Do not postpone the refresh to a later pause: that pause is mid-typing.
    cancelScheduled();
  };

  const onCompositionStart = () => {
    restoreFocus();
    composing = true;
    inputStarted();
  };
  const onCompositionEnd = () => {
    composing = false;
    inputStarted();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // A key typed during the blur gap belongs to the editor.
    restoreFocus();
    if (!MODIFIER_KEYS.has(event.key)) inputStarted();
  };
  const onPointerDown = () => {
    // Real user interaction already updates the native anchor. Put focus back
    // first so the browser's own pointer handling decides where it goes next,
    // exactly as if the editor had never been blurred.
    restoreFocus();
    cancelScheduled();
  };
  const onFocusIn = (event: FocusEvent) => {
    if (event.target !== candidate) {
      cancelScheduled();
      dropRestore();
    }
  };
  const onWindowBlur = (event: FocusEvent) => {
    if (event.target === event.currentTarget) {
      composing = false;
      cancelScheduled();
      // Keep a pending restore for the window's return.
      clearTimeout(restoreTimer);
      restoreTimer = undefined;
    }
  };
  const onWindowFocus = (event: FocusEvent) => {
    if (event.target === event.currentTarget) restoreFocus(true);
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      restoreFocus();
      return;
    }
    composing = false;
    cancelScheduled();
    clearTimeout(restoreTimer);
    restoreTimer = undefined;
  };

  window.addEventListener("resize", geometryChanged);
  window.addEventListener("blur", onWindowBlur);
  window.addEventListener("focus", onWindowFocus);
  document.addEventListener("compositionstart", onCompositionStart, true);
  document.addEventListener("compositionend", onCompositionEnd, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("beforeinput", inputStarted, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Moving to a monitor with another DPI may change native geometry without
  // changing the CSS viewport dimensions, so also observe native notifications.
  const appWindow = getCurrentWindow();
  void appWindow.outerPosition().then((position) => {
    // A move notification that arrived first is newer than this reply.
    if (!windowPosition) windowPosition = { x: position.x, y: position.y };
  }).catch((error) => console.warn("IME window position unavailable", error));
  [appWindow.onMoved(onMoved), appWindow.onScaleChanged(geometryChanged)].forEach((subscription) => {
    void subscription.then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    }).catch((error) => console.warn("IME window event subscription failed", error));
  });

  return () => {
    restoreFocus();
    disposed = true;
    cancelScheduled();
    dropRestore();
    window.removeEventListener("resize", geometryChanged);
    window.removeEventListener("blur", onWindowBlur);
    window.removeEventListener("focus", onWindowFocus);
    document.removeEventListener("compositionstart", onCompositionStart, true);
    document.removeEventListener("compositionend", onCompositionEnd, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("beforeinput", inputStarted, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unlisteners.forEach((unlisten) => unlisten());
  };
}
