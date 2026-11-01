// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  cancelEditorFocusRequest,
  cancelEditorFocusRequestFor,
  isEditorFocusPending,
  requestEditorFocus,
  type EditorFocusPermission,
} from "./editorFocusRestore";

const FRAME_MS = 16;

const windowState = { focused: true, visibility: "visible" as DocumentVisibilityState };

const WATCHED_TYPES = new Set(["focus", "focusin", "mousedown", "pointerdown", "visibilitychange"]);

/** Lists the focus, focusin, press and visibilitychange listeners still registered on the window and document. */
function trackFocusListeners() {
  const entries: Array<{ target: EventTarget; type: string; listener: unknown; capture: boolean }> = [];
  const isCapture = (options?: boolean | EventListenerOptions) =>
    typeof options === "boolean" ? options : Boolean(options?.capture);
  for (const target of [window, document] as EventTarget[]) {
    const add = target.addEventListener;
    const remove = target.removeEventListener;
    vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
      if (WATCHED_TYPES.has(type)) entries.push({ target, type, listener, capture: isCapture(options) });
      add.call(target, type, listener, options);
    });
    vi.spyOn(target, "removeEventListener").mockImplementation((type, listener, options) => {
      const index = entries.findIndex((entry) =>
        entry.target === target && entry.type === type && entry.listener === listener &&
        entry.capture === isCapture(options));
      if (index >= 0) entries.splice(index, 1);
      remove.call(target, type, listener, options);
    });
  }
  return () => entries.map(({ target, type }) => `${target === window ? "window" : "document"}:${type}`).sort();
}

// While a request waits: user focus and presses, and the window coming back.
const WATCHING_USER = ["document:focusin", "document:mousedown", "document:pointerdown"];
const WAITING_LISTENERS = [...WATCHING_USER, "document:visibilitychange", "window:focus"].sort();

describe("editor focus restoration", () => {
  const editors: Editor[] = [];
  let activeListeners: () => string[];
  let frames: MockInstance<typeof window.requestAnimationFrame>;

  beforeEach(() => {
    vi.useFakeTimers();
    windowState.focused = true;
    windowState.visibility = "visible";
    vi.spyOn(document, "hasFocus").mockImplementation(() => windowState.focused);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => windowState.visibility);
    // jsdom has no layout. ProseMirror reads these when it focuses.
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    activeListeners = trackFocusListeners();
    frames = vi.spyOn(window, "requestAnimationFrame");
  });

  afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy());
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createEditor(text = "alpha beta") {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const editor = new Editor({ element, extensions: [StarterKit], content: `<p>${text}</p>` });
    editors.push(editor);
    return editor;
  }

  /** An editor that had focus at `position` and lost it to the page. */
  function blurredEditor(position = 3) {
    const editor = createEditor();
    editor.commands.setTextSelection(position);
    editor.view.focus();
    editor.view.dom.blur();
    expect(document.activeElement).toBe(document.body);
    return editor;
  }

  function control<K extends "input" | "button">(tag: K) {
    const element = document.createElement(tag);
    document.body.appendChild(element);
    return element;
  }

  /** Pressing a control focuses it after its mousedown listeners run. */
  function press(target: HTMLElement, focus = () => target.focus()) {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    focus();
  }

  function deactivateWindow() {
    windowState.focused = false;
    window.dispatchEvent(new FocusEvent("blur"));
  }

  function activateWindow() {
    windowState.focused = true;
    window.dispatchEvent(new FocusEvent("focus"));
  }

  function advanceFrames(count = 1) {
    vi.advanceTimersByTime(FRAME_MS * count);
  }

  /** Records permission reads, focus calls and onFocused calls in order. */
  function observe(editor: Editor, permission: () => EditorFocusPermission = () => "allow") {
    const log: string[] = [];
    const focus = editor.view.focus.bind(editor.view);
    const viewFocus = vi.spyOn(editor.view, "focus").mockImplementation(() => {
      log.push("focus");
      focus();
    });
    return {
      log,
      viewFocus,
      options: {
        permission: () => {
          log.push("permission");
          return permission();
        },
        onFocused: () => {
          log.push(document.activeElement === editor.view.dom ? "focused" : "onFocused without focus");
        },
      },
    };
  }

  it("focuses right away in an active window and leaves nothing behind", () => {
    const editor = blurredEditor();
    const { log, options } = observe(editor);

    const request = requestEditorFocus(editor, { ...options, start: "now" });

    expect(log).toEqual(["permission", "focus", "focused"]);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(3);
    expect(request.pending).toBe(false);
    expect(isEditorFocusPending()).toBe(false);
    expect(activeListeners()).toEqual([]);
    expect(frames).not.toHaveBeenCalled();
  });

  it.each(["already-focused", "deny"] as const)("ends a request whose permission is %s without touching the editor", (permission) => {
    const editor = blurredEditor();
    const { log, viewFocus, options } = observe(editor, () => permission);

    windowState.focused = false;
    const request = requestEditorFocus(editor, { ...options, start: "now" });

    expect(log).toEqual(["permission"]);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(request.pending).toBe(false);
    expect(activeListeners()).toEqual([]);
  });

  it("keeps a request while the window is inactive, without focusing or polling (W1)", () => {
    const editor = blurredEditor();
    const { log, viewFocus, options } = observe(editor);
    deactivateWindow();

    const request = requestEditorFocus(editor, { ...options, start: "now" });
    vi.advanceTimersByTime(5_000);

    expect(viewFocus).not.toHaveBeenCalled();
    expect(log).toEqual(["permission"]);
    expect(document.activeElement).toBe(document.body);
    expect(request.pending).toBe(true);
    expect(isEditorFocusPending()).toBe(true);
    expect(activeListeners()).toEqual(WAITING_LISTENERS);
    expect(frames).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("checks again and focuses in the one frame after the window itself regains focus (W2)", () => {
    const editor = blurredEditor();
    const { log, viewFocus, options } = observe(editor);
    deactivateWindow();
    const request = requestEditorFocus(editor, { ...options, start: "now" });
    log.length = 0;

    activateWindow();
    window.dispatchEvent(new FocusEvent("focus"));
    document.dispatchEvent(new Event("visibilitychange"));

    // Repeated activation events share one frame, and nothing runs before it.
    expect(frames).toHaveBeenCalledTimes(1);
    expect(log).toEqual([]);
    advanceFrames();

    expect(log).toEqual(["permission", "focus", "focused"]);
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(3);
    expect(request.pending).toBe(false);
    expect(activeListeners()).toEqual([]);

    activateWindow();
    advanceFrames(4);
    expect(frames).toHaveBeenCalledTimes(1);
    expect(viewFocus).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "a window focus event while document.hasFocus() is false",
      wake: () => window.dispatchEvent(new FocusEvent("focus")),
    },
    {
      name: "a visible visibilitychange while document.hasFocus() is false",
      wake: () => document.dispatchEvent(new Event("visibilitychange")),
    },
    {
      name: "a window focus event while the document is hidden",
      wake: () => {
        windowState.visibility = "hidden";
        windowState.focused = true;
        window.dispatchEvent(new FocusEvent("focus"));
      },
    },
  ])("does not focus for $name and does not poll (W3)", ({ wake }) => {
    const editor = blurredEditor();
    const { viewFocus, options } = observe(editor);
    deactivateWindow();
    const request = requestEditorFocus(editor, { ...options, start: "now" });

    wake();
    advanceFrames(20);

    expect(viewFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    expect(frames).toHaveBeenCalledTimes(1);
    expect(request.pending).toBe(true);
    expect(activeListeners()).toEqual(WAITING_LISTENERS);

    // It still waits for the window to become really active.
    windowState.visibility = "visible";
    activateWindow();
    advanceFrames();
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(activeListeners()).toEqual([]);
  });

  it("does not treat element focus events that reach the window, or a hidden visibilitychange, as activation", () => {
    const editor = blurredEditor();
    const { options } = observe(editor);
    deactivateWindow();
    requestEditorFocus(editor, { ...options, start: "now" });
    const input = control("input");

    windowState.focused = true;
    input.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    windowState.visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(frames).not.toHaveBeenCalled();
  });

  it.each([
    { name: "an input", focus: () => { const input = control("input"); press(input); return input; } },
    { name: "a button", focus: () => { const button = control("button"); press(button); return button; } },
    {
      name: "another editor",
      focus: () => {
        // jsdom cannot hit-test a press inside ProseMirror; focus it directly.
        const other = createEditor("other");
        other.view.focus();
        return other.view.dom;
      },
    },
  ])("gives way to $name focused while the window comes back, and never runs later (W4)", ({ focus }) => {
    const editor = blurredEditor();
    const { viewFocus, options } = observe(editor);
    deactivateWindow();
    const request = requestEditorFocus(editor, { ...options, start: "now" });

    activateWindow();
    const target = focus();
    advanceFrames(4);

    expect(document.activeElement).toBe(target);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(request.pending).toBe(false);
    expect(activeListeners()).toEqual([]);

    // Focus falling to the page later does not bring the request back.
    target.blur();
    deactivateWindow();
    activateWindow();
    advanceFrames(4);
    expect(document.activeElement).toBe(document.body);
    expect(viewFocus).not.toHaveBeenCalled();
  });

  it("ends without another focus when the target editor itself gets focus first (W4)", () => {
    const editor = blurredEditor();
    const { viewFocus, options } = observe(editor);
    deactivateWindow();
    const request = requestEditorFocus(editor, { ...options, start: "now" });
    const transactions: Array<{ scrolledIntoView: boolean }> = [];
    editor.on("transaction", ({ transaction }) => { transactions.push(transaction); });

    activateWindow();
    editor.view.dom.focus();
    advanceFrames(4);

    expect(document.activeElement).toBe(editor.view.dom);
    expect(viewFocus).not.toHaveBeenCalled();
    // Only Tiptap's own focus bookkeeping; nothing scrolls or moves the selection.
    expect(transactions.some((transaction) => transaction.scrolledIntoView)).toBe(false);
    expect(editor.state.selection.from).toBe(3);
    expect(request.pending).toBe(false);
  });

  it("drops the request and its listeners when the editor is destroyed (W5)", () => {
    const editor = blurredEditor();
    const { viewFocus, options } = observe(editor);
    deactivateWindow();
    const request = requestEditorFocus(editor, { ...options, start: "now" });

    editor.destroy();

    expect(request.pending).toBe(false);
    expect(activeListeners()).toEqual([]);
    activateWindow();
    advanceFrames(4);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(frames).not.toHaveBeenCalled();
  });

  it("does not focus an editor whose DOM left the page while it waited (W5)", () => {
    const editor = blurredEditor();
    const { viewFocus, options } = observe(editor);
    const domFocus = vi.spyOn(editor.view.dom, "focus");
    deactivateWindow();
    const request = requestEditorFocus(editor, { ...options, start: "now" });

    editor.view.dom.remove();
    activateWindow();
    advanceFrames();

    expect(viewFocus).not.toHaveBeenCalled();
    expect(domFocus).not.toHaveBeenCalled();
    expect(request.pending).toBe(false);
    expect(activeListeners()).toEqual([]);
  });

  it("reads the caller's current state when it runs again, so a replaced instance or target is not focused (W5)", () => {
    const editor = blurredEditor();
    const replacement = createEditor("replacement");
    const app = { target: editor as Editor, settingsOpen: false };
    const { log, viewFocus, options } = observe(editor, () =>
      !app.settingsOpen && app.target === editor ? "allow" : "deny");
    deactivateWindow();
    const request = requestEditorFocus(editor, { ...options, start: "now" });

    // The caller replaced the editor under the same key.
    app.target = replacement;
    activateWindow();
    advanceFrames();

    expect(log).toEqual(["permission", "permission"]);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    expect(request.pending).toBe(false);
    expect(activeListeners()).toEqual([]);
  });

  it("removes its listeners and frame when cancelled (W5)", () => {
    const editor = blurredEditor();
    const { viewFocus, options } = observe(editor);
    deactivateWindow();
    const request = requestEditorFocus(editor, { ...options, start: "now" });
    activateWindow();
    expect(frames).toHaveBeenCalledTimes(1);

    request.cancel();
    advanceFrames(4);

    expect(viewFocus).not.toHaveBeenCalled();
    expect(request.pending).toBe(false);
    expect(isEditorFocusPending()).toBe(false);
    expect(activeListeners()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps only the newest request of a document (W6)", () => {
    const first = blurredEditor();
    const second = createEditor("second");
    const firstObserved = observe(first);
    const secondObserved = observe(second);
    deactivateWindow();

    const older = requestEditorFocus(first, { ...firstObserved.options, start: "now" });
    const newer = requestEditorFocus(second, { ...secondObserved.options, start: "now" });

    expect(older.pending).toBe(false);
    expect(newer.pending).toBe(true);
    expect(activeListeners()).toEqual(WAITING_LISTENERS);
    activateWindow();
    advanceFrames();

    expect(firstObserved.viewFocus).not.toHaveBeenCalled();
    expect(secondObserved.viewFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(second.view.dom);
    expect(activeListeners()).toEqual([]);
  });

  it("does not bring back an older request when the newer one ends at once (W6)", () => {
    const first = blurredEditor();
    const second = createEditor("second");
    const firstObserved = observe(first);
    deactivateWindow();
    const older = requestEditorFocus(first, { ...firstObserved.options, start: "now" });

    const newer = requestEditorFocus(second, { permission: () => "deny", start: "now" });

    expect(older.pending).toBe(false);
    expect(newer.pending).toBe(false);
    expect(activeListeners()).toEqual([]);
    activateWindow();
    advanceFrames(4);
    expect(firstObserved.viewFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("with start \"frame\", checks and focuses in the next frame of an active window", () => {
    const editor = blurredEditor();
    const { log, options } = observe(editor);

    const request = requestEditorFocus(editor, { ...options, start: "frame" });

    expect(log).toEqual([]);
    expect(request.pending).toBe(true);
    expect(activeListeners()).toEqual(WATCHING_USER);
    advanceFrames();
    expect(log).toEqual(["permission", "focus", "focused"]);
    expect(activeListeners()).toEqual([]);
  });

  it("with start \"frame\", waits instead of focusing when the window is inactive by then", () => {
    const editor = blurredEditor();
    const { log, viewFocus, options } = observe(editor);

    requestEditorFocus(editor, { ...options, start: "frame" });
    deactivateWindow();
    advanceFrames(4);

    expect(log).toEqual(["permission"]);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(activeListeners()).toEqual(WAITING_LISTENERS);
    activateWindow();
    advanceFrames();
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor.view.dom);
  });
  // ---- Presses that pick another target (R1) ----

  /** Wraps `editor` in an editor shell, as Editor.tsx does, and returns the shell's empty area. */
  function inShell(editor: Editor) {
    const shell = document.createElement("section");
    shell.className = "editor-shell";
    const margin = document.createElement("div");
    editor.view.dom.parentElement!.replaceWith(shell);
    shell.append(editor.view.dom.parentElement ?? editor.view.dom, margin);
    return margin;
  }

  /** A pointer press that focuses nothing by itself, like a press on an editor's empty area. */
  function pressWithoutFocus(target: Node) {
    // ProseMirror maps a press inside it to a position; jsdom has no hit testing.
    const element = target instanceof Element ? target : target.parentElement;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => element });
    try {
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    } finally {
      Reflect.deleteProperty(document, "elementFromPoint");
    }
  }

  function waitingRequest(editor: Editor) {
    // Let the editors finish their creation timers, so only the request's frame counts.
    vi.runOnlyPendingTimers();
    const observed = observe(editor);
    deactivateWindow();
    const request = requestEditorFocus(editor, { ...observed.options, start: "now" });
    activateWindow();
    return { ...observed, request };
  }

  it.each([
    { name: "another editor's empty area", target: () => inShell(createEditor("other")) },
    { name: "inside another editor", target: () => createEditor("other").view.dom.querySelector("p")! },
    { name: "a button", target: () => control("button") },
    { name: "an input", target: () => control("input") },
    {
      name: "a link",
      target: () => {
        const link = document.createElement("a");
        link.href = "https://example.com";
        link.append(document.createElement("span"));
        document.body.appendChild(link);
        return link.firstElementChild!;
      },
    },
    {
      name: "an element with tabindex -1",
      target: () => {
        const item = document.createElement("div");
        item.tabIndex = -1;
        document.body.appendChild(item);
        return item;
      },
    },
    {
      name: "a label of a field",
      target: () => {
        const label = document.createElement("label");
        label.append("Name", document.createElement("input"));
        document.body.appendChild(label);
        return label;
      },
    },
  ])("drops a waiting request when $name is pressed, before anything has focus (R1)", ({ target }) => {
    const editor = blurredEditor();
    const pressed = target();
    const { viewFocus, request } = waitingRequest(editor);

    pressWithoutFocus(pressed);

    expect(request.pending).toBe(false);
    expect(isEditorFocusPending()).toBe(false);
    expect(activeListeners()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    advanceFrames(4);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);

    // A later return to the window does not bring it back.
    deactivateWindow();
    activateWindow();
    advanceFrames(4);
    expect(viewFocus).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "the title bar's drag area",
      target: () => {
        const titleBar = document.createElement("header");
        titleBar.className = "titlebar";
        const dragArea = document.createElement("div");
        dragArea.className = "titlebar-drag-handle";
        titleBar.appendChild(dragArea);
        document.body.appendChild(titleBar);
        return dragArea;
      },
    },
    { name: "the requested editor's own empty area", target: (editor: Editor) => inShell(editor) },
    { name: "inside the requested editor", target: (editor: Editor) => editor.view.dom.querySelector("p")! },
    { name: "text on the page", target: () => document.body.appendChild(document.createTextNode("status")) },
    {
      name: "a disabled button",
      target: () => {
        const button = control("button");
        button.disabled = true;
        return button;
      },
    },
    {
      name: "a label without a field",
      target: () => {
        const label = document.createElement("label");
        label.textContent = "URL";
        document.body.appendChild(label);
        return label;
      },
    },
  ])("keeps a waiting request when $name is pressed, which picks no other target (R1)", ({ target }) => {
    const editor = blurredEditor();
    const pressed = target(editor);
    const { log, viewFocus, request } = waitingRequest(editor);
    log.length = 0;

    pressWithoutFocus(pressed);

    expect(request.pending).toBe(true);
    advanceFrames();
    expect(log).toEqual(["permission", "focus", "focused"]);
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(3);
    expect(activeListeners()).toEqual([]);
  });

  it("drops a request waiting for its first frame when another target is pressed (R1)", () => {
    const editor = blurredEditor();
    const other = inShell(createEditor("other"));
    vi.runOnlyPendingTimers();
    const { viewFocus, options } = observe(editor);
    const request = requestEditorFocus(editor, { ...options, start: "frame" });

    pressWithoutFocus(other);
    advanceFrames(4);

    expect(request.pending).toBe(false);
    expect(viewFocus).not.toHaveBeenCalled();
    expect(activeListeners()).toEqual([]);
  });

  it("does not count the press that made the request as a later choice (R1)", () => {
    const editor = blurredEditor();
    const button = control("button");
    const { viewFocus, options } = observe(editor);
    let request = requestEditorFocus(editor, { permission: () => "deny", start: "now" });
    // Something made the request while that press was still on its way down.
    window.addEventListener("pointerdown", () => {
      request = requestEditorFocus(editor, { ...options, start: "frame" });
    }, { capture: true, once: true });

    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }));

    expect(request.pending).toBe(true);
    advanceFrames();
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  // ---- Cancelling from the owner (for T7 and Editor unmount) ----

  it.each(["now", "frame"] as const)(
    "cancelEditorFocusRequest drops the document's waiting request (start %s), whatever editor it is for",
    (start) => {
      const editor = blurredEditor();
      vi.runOnlyPendingTimers();
      const { viewFocus, options } = observe(editor);
      deactivateWindow();
      const request = requestEditorFocus(editor, { ...options, start });

      cancelEditorFocusRequest(document);

      expect(request.pending).toBe(false);
      expect(isEditorFocusPending()).toBe(false);
      expect(activeListeners()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      activateWindow();
      advanceFrames(4);
      expect(viewFocus).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(document.body);

      // With nothing waiting it does nothing, and the default is this document.
      expect(() => cancelEditorFocusRequest()).not.toThrow();
    }
  );

  it("cancelEditorFocusRequest leaves a later request alone", () => {
    const editor = blurredEditor();
    const { viewFocus, options } = observe(editor);
    deactivateWindow();
    requestEditorFocus(editor, { ...options, start: "now" });
    cancelEditorFocusRequest();

    const request = requestEditorFocus(editor, { ...options, start: "now" });
    activateWindow();
    advanceFrames();

    expect(request.pending).toBe(false);
    expect(viewFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor.view.dom);
  });

  it("cancelEditorFocusRequestFor drops the request for that editor instance", () => {
    const editor = blurredEditor();
    vi.runOnlyPendingTimers();
    const { viewFocus, options } = observe(editor);
    deactivateWindow();
    const request = requestEditorFocus(editor, { ...options, start: "frame" });

    cancelEditorFocusRequestFor(editor);

    expect(request.pending).toBe(false);
    expect(activeListeners()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    activateWindow();
    advanceFrames(4);
    expect(viewFocus).not.toHaveBeenCalled();
  });

  it("cancelEditorFocusRequestFor keeps the newest request when it is for another editor", () => {
    const older = blurredEditor();
    const newer = createEditor("newer");
    const olderObserved = observe(older);
    const newerObserved = observe(newer);
    deactivateWindow();

    // An editor without a request, and one whose request a newer one replaced.
    cancelEditorFocusRequestFor(older);
    const replaced = requestEditorFocus(older, { ...olderObserved.options, start: "now" });
    const latest = requestEditorFocus(newer, { ...newerObserved.options, start: "now" });
    cancelEditorFocusRequestFor(older);

    expect(replaced.pending).toBe(false);
    expect(latest.pending).toBe(true);
    expect(activeListeners()).toEqual(WAITING_LISTENERS);
    activateWindow();
    advanceFrames();
    expect(olderObserved.viewFocus).not.toHaveBeenCalled();
    expect(newerObserved.viewFocus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(newer.view.dom);
  });
});
