import type { Editor } from "@tiptap/core";

// Shared lifecycle for giving focus back to an editor (after a popup closes or
// the split layout changes). The caller decides what is allowed; this module
// decides when it may run:
// - Focus only while the document is visible and document.hasFocus() is true.
//   Otherwise keep the request until the window itself receives focus or the
//   document becomes visible, then check again in the next animation frame,
//   after the focus the user gave on the way back has been applied.
// - Each document keeps only its latest request. A new request replaces the
//   older one even when the new one is then denied or already satisfied.
// - Any focus change while a request waits (another control, another editor,
//   or the target editor itself) settles it. A dropped request never comes
//   back, even if focus later returns to the page.
// - So does a press that picks another target while a request waits, before
//   that target has focus: another editor's area (whose empty part focuses it
//   a frame later) or any control that takes focus. A press that picks no
//   target, such as on the title bar to bring the window back, or one on the
//   requested editor's own area, keeps the request.
// - Owners can drop requests: all of a document's (a new navigation) or only
//   those for one editor instance (that editor unmounts).
// - Listeners and the frame exist only while a request waits.
// The Windows IME recovery keeps its own pending restore and is not merged in.

/**
 * What a request may do right now. "allow" focuses the editor (or waits for an
 * inactive window), "already-focused" and "deny" end the request untouched.
 */
export type EditorFocusPermission = "allow" | "already-focused" | "deny";

export interface EditorFocusRequestOptions {
  /**
   * Reads the current permission. It runs before every attempt, including the
   * one after the window becomes active again, so it must read current state
   * instead of values captured when the request was made.
   */
  permission: () => EditorFocusPermission;
  /**
   * When the first attempt runs: "now" in the calling task (a layout effect),
   * "frame" in the next animation frame (a closing UI may still hold focus).
   */
  start: "now" | "frame";
  /** Runs right after the editor is focused, in the same callback. */
  onFocused?: () => void;
}

export interface EditorFocusRequest {
  /** Drops the request. Does nothing once it has finished or been replaced. */
  cancel(): void;
  /** Whether the request still waits for a frame or for the window. */
  readonly pending: boolean;
}

const SETTLED: EditorFocusRequest = { cancel() {}, pending: false };

// The one waiting request of each document, and of each editor it targets.
const latestRequests = new WeakMap<Document, EditorFocusRequest>();
const requestsByEditor = new WeakMap<Editor, EditorFocusRequest>();

// Editor.tsx wraps each editor in this shell. Pressing its empty part focuses
// that editor, one frame later.
const EDITOR_AREA_SELECTOR = ".editor-shell";

// Elements that take focus when pressed.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "iframe",
  "summary",
  "[tabindex]",
  "[contenteditable]:not([contenteditable='false'])",
].join(", ");

/** The document is visible and its window has system focus. */
export function isDocumentActive(doc: Document): boolean {
  return doc.visibilityState === "visible" && doc.hasFocus();
}

/** Whether `doc` has a focus request that is still waiting. */
export function isEditorFocusPending(doc: Document = document): boolean {
  return latestRequests.has(doc);
}

/**
 * Drops the waiting focus request of `doc`, whatever editor it is for. For a
 * new user navigation, which decides focus again.
 */
export function cancelEditorFocusRequest(doc: Document = document): void {
  latestRequests.get(doc)?.cancel();
}

/**
 * Drops the waiting focus request for this editor instance only. A request
 * for another editor, or for a newer instance of the same note, stays.
 */
export function cancelEditorFocusRequestFor(editor: Editor): void {
  requestsByEditor.get(editor)?.cancel();
}

function elementOf(target: EventTarget | null): Element | null {
  const node = target as Node | null;
  if (!node || typeof node.nodeType !== "number") return null;
  return node.nodeType === node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * Whether a press on `target` picks a target other than the editor whose root
 * is `editorDOM`: another editor's area, or a control that takes focus. Its
 * own root and shell, and places that take no focus (such as the title bar's
 * drag area) pick nothing else.
 */
function pressPicksOtherTarget(target: EventTarget | null, editorDOM: HTMLElement): boolean {
  const element = elementOf(target);
  if (!element || editorDOM.contains(element)) return false;
  const area = element.closest(EDITOR_AREA_SELECTOR);
  if (area) return !area.contains(editorDOM);
  if (element.closest(FOCUSABLE_SELECTOR)) return true;
  // A label focuses its control on click.
  const label = element.closest("label");
  return Boolean(label?.control);
}

export function requestEditorFocus(editor: Editor, options: EditorFocusRequestOptions): EditorFocusRequest {
  if (editor.isDestroyed) return SETTLED;
  const doc = editor.view.dom.ownerDocument;
  const win = doc.defaultView;
  latestRequests.get(doc)?.cancel();
  // The press or key that made this request (a click outside that closed a
  // popup) is not a later choice of another target.
  const originEvent = win?.event;

  let settled = false;
  let frame: number | null = null;
  let watchingUser = false;
  let waitingForWindow = false;

  const request: EditorFocusRequest = {
    cancel: () => settle(),
    get pending() {
      return !settled;
    },
  };
  latestRequests.set(doc, request);
  requestsByEditor.set(editor, request);

  function settle() {
    if (settled) return;
    settled = true;
    if (latestRequests.get(doc) === request) latestRequests.delete(doc);
    if (requestsByEditor.get(editor) === request) requestsByEditor.delete(editor);
    if (frame !== null) {
      win?.cancelAnimationFrame(frame);
      frame = null;
    }
    if (watchingUser) {
      watchingUser = false;
      doc.removeEventListener("focusin", onFocusIn, true);
      doc.removeEventListener("pointerdown", onPress, true);
      doc.removeEventListener("mousedown", onPress, true);
      editor.off("destroy", onDestroy);
    }
    if (waitingForWindow) {
      waitingForWindow = false;
      win?.removeEventListener("focus", onWindowFocus);
      doc.removeEventListener("visibilitychange", onVisibilityChange);
    }
  }

  // While the request waits, watch for the user choosing something else.
  function watchUser() {
    if (watchingUser) return;
    watchingUser = true;
    doc.addEventListener("focusin", onFocusIn, true);
    doc.addEventListener("pointerdown", onPress, true);
    doc.addEventListener("mousedown", onPress, true);
    editor.on("destroy", onDestroy);
  }

  function attempt() {
    if (settled) return;
    if (editor.isDestroyed || !editor.view.dom.isConnected) {
      settle();
      return;
    }
    if (options.permission() !== "allow") {
      settle();
      return;
    }
    if (!isDocumentActive(doc)) {
      waitForWindow();
      return;
    }
    // Settle before focusing so this request's own focusin is not mistaken for
    // a newer focus, and focus in the same callback that checked.
    settle();
    editor.view.focus();
    options.onFocused?.();
  }

  function scheduleFrame() {
    if (frame !== null) return;
    if (!win) {
      settle();
      return;
    }
    watchUser();
    frame = win.requestAnimationFrame(() => {
      frame = null;
      attempt();
    });
  }

  function waitForWindow() {
    if (!win) {
      settle();
      return;
    }
    watchUser();
    if (waitingForWindow) return;
    waitingForWindow = true;
    win.addEventListener("focus", onWindowFocus);
    doc.addEventListener("visibilitychange", onVisibilityChange);
  }

  // Focus events of elements reach the window too; only the window's own
  // focus means it became active.
  function onWindowFocus(event: Event) {
    if (event.target === event.currentTarget) scheduleFrame();
  }

  function onVisibilityChange() {
    if (doc.visibilityState === "visible") scheduleFrame();
  }

  function onFocusIn() {
    settle();
  }

  // Some targets take focus only later (another editor's empty area focuses it
  // in the next frame), so the press itself ends the request.
  function onPress(event: Event) {
    if (event !== originEvent && pressPicksOtherTarget(event.target, editor.view.dom)) settle();
  }

  function onDestroy() {
    settle();
  }

  if (options.start === "frame") scheduleFrame();
  else attempt();
  return request;
}
