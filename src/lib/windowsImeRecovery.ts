import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// WebView2 can lose the IME's caret anchor after a native resize. DOM focus
// still looks correct, but preedit text appears outside the editor until a
// real focus transition. https://github.com/MicrosoftEdge/WebView2Feedback/issues/5675
const SETTLE_DELAY_MS = 150;

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
  let restore: (() => void) | null = null;
  const unlisteners: Array<() => void> = [];

  const finishRestore = () => {
    clearTimeout(restoreTimer);
    restoreTimer = undefined;
    const complete = restore;
    restore = null;
    complete?.();
  };

  const cancel = () => {
    clearTimeout(settleTimer);
    clearTimeout(restoreTimer);
    candidate = null;
    restore = null;
  };

  const recover = () => {
    const element = candidate;
    if (disposed || composing || !element) return;
    if (!element.isConnected || document.visibilityState !== "visible" ||
        !document.hasFocus() || focusedNoteEditor() !== element) {
      cancel();
      return;
    }

    candidate = null;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const focus = selection?.focusNode;
    const anchorOffset = selection?.anchorOffset ?? 0;
    const focusOffset = selection?.focusOffset ?? 0;
    const scrollPositions: Array<[HTMLElement, number, number]> = [];
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      scrollPositions.push([ancestor, ancestor.scrollLeft, ancestor.scrollTop]);
    }

    restore = () => {
      // Never take focus back from a different control, another window, or a
      // newly mounted editor. The user can change any of these while waiting.
      if (disposed || !element.isConnected || !document.hasFocus() ||
          document.visibilityState !== "visible" ||
          (document.activeElement !== document.body && document.activeElement !== element)) return;
      element.focus({ preventScroll: true });
      if (anchor?.isConnected && focus?.isConnected && element.contains(anchor) && element.contains(focus) &&
          validSelectionOffset(anchor, anchorOffset) && validSelectionOffset(focus, focusOffset)) {
        window.getSelection()?.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
      }
      scrollPositions.forEach(([ancestor, left, top]) => {
        ancestor.scrollLeft = left;
        ancestor.scrollTop = top;
      });
    };
    element.blur();
    // Give WebView2 a separate task to observe the loss of DOM focus. A
    // synchronous blur/focus pair can be coalesced and leave the anchor stale.
    restoreTimer = setTimeout(finishRestore, 0);
  };

  const schedule = () => {
    clearTimeout(settleTimer);
    if (candidate && !composing) settleTimer = setTimeout(recover, SETTLE_DELAY_MS);
  };

  const geometryChanged = () => {
    if (disposed) return;
    candidate = focusedNoteEditor();
    schedule();
  };

  const onCompositionStart = () => {
    finishRestore();
    composing = true;
    clearTimeout(settleTimer);
  };
  const onCompositionEnd = () => {
    composing = false;
    // Let ProseMirror flush the final character before touching DOM focus.
    schedule();
  };
  const onKeyDown = () => {
    finishRestore();
    // Do not interrupt ordinary typing immediately after a resize either.
    schedule();
  };
  const onPointerDown = () => {
    // Real user interaction already updates the native anchor. In particular,
    // don't refocus the editor after a click on a toolbar or another pane.
    cancel();
  };
  const onFocusIn = (event: FocusEvent) => {
    if (event.target !== candidate) {
      cancel();
    }
  };
  const onWindowBlur = (event: FocusEvent) => {
    if (event.target === event.currentTarget) {
      composing = false;
      cancel();
    }
  };
  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") {
      composing = false;
      cancel();
    }
  };

  window.addEventListener("resize", geometryChanged);
  window.addEventListener("blur", onWindowBlur);
  document.addEventListener("compositionstart", onCompositionStart, true);
  document.addEventListener("compositionend", onCompositionEnd, true);
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Moving to a monitor with another DPI may change native geometry without
  // changing the CSS viewport dimensions, so also observe native notifications.
  const appWindow = getCurrentWindow();
  [appWindow.onMoved(geometryChanged), appWindow.onScaleChanged(geometryChanged)].forEach((subscription) => {
    void subscription.then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    }).catch((error) => console.warn("IME window event subscription failed", error));
  });

  return () => {
    finishRestore();
    disposed = true;
    cancel();
    window.removeEventListener("resize", geometryChanged);
    window.removeEventListener("blur", onWindowBlur);
    document.removeEventListener("compositionstart", onCompositionStart, true);
    document.removeEventListener("compositionend", onCompositionEnd, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unlisteners.forEach((unlisten) => unlisten());
  };
}
