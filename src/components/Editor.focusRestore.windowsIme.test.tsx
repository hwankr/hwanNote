// @vitest-environment jsdom

import type { Editor as TiptapEditor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/context";
import { installWindowsImeRecovery } from "../lib/windowsImeRecovery";
import Editor, { restoreEditorFocus } from "./Editor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MovedListener = (event: { payload: { x: number; y: number } }) => void;

const native = vi.hoisted(() => ({ moved: null as MovedListener | null }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    outerPosition: () => Promise.resolve({ x: 100, y: 100 }),
    onMoved: (callback: MovedListener) => {
      native.moved = callback;
      return Promise.resolve(() => undefined);
    },
    onScaleChanged: () => Promise.resolve(() => undefined),
  }),
}));

const windowState = { focused: true, visibility: "visible" as DocumentVisibilityState };

// The general focus restore and the Windows IME recovery both wait for the
// window to come back. They must not fight over focus when it does.
describe("focus restoration together with the Windows IME recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  const editors: TiptapEditor[] = [];
  let cleanup: (() => void) | undefined;
  const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  const originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    editors.length = 0;
    windowState.focused = true;
    windowState.visibility = "visible";
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    vi.spyOn(document, "hasFocus").mockImplementation(() => windowState.focused);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => windowState.visibility);
    // jsdom has no layout. These stubs support ProseMirror's scroll calculations.
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
    native.moved = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalRangeRects) Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
    if (originalRangeBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeBounds);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  });

  async function mountEditors() {
    await act(async () => {
      root.render(
        <I18nProvider>
          {["메모 입력", "다른 메모"].map((text, index) => (
            <Editor
              key={text}
              content={{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }}
              tabSize={4}
              spellcheck={false}
              autofocus={false}
              onChange={() => {}}
              onCursorChange={() => {}}
              onEditorReady={(nextEditor) => {
                if (nextEditor) editors[index] = nextEditor;
              }}
            />
          ))}
        </I18nProvider>
      );
    });
    cleanup = installWindowsImeRecovery();
    await act(async () => {
      for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
    });
    expect(native.moved).not.toBeNull();
    return editors.slice();
  }

  async function advance(milliseconds: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
  }

  /**
   * The IME recovery blurs `editor` after a real window move, and the window
   * loses focus before the recovery's next-task restore runs, so that restore
   * waits for the window too.
   */
  async function leaveWithImeRestorePending(editor: TiptapEditor) {
    act(() => {
      editor.commands.setTextSelection(3);
      editor.view.focus();
    });
    act(() => native.moved!({ payload: { x: 1_920, y: 100 } }));
    await advance(149);
    await advance(1);
    expect(document.activeElement).toBe(document.body);
    windowState.focused = false;
    await act(async () => { window.dispatchEvent(new FocusEvent("blur")); });
    await advance(50);
    expect(document.activeElement).toBe(document.body);
  }

  function observe(editor: TiptapEditor) {
    const scrolls: unknown[] = [];
    const transactions = vi.fn();
    editor.on("transaction", ({ transaction }) => {
      transactions();
      if (transaction.scrolledIntoView) scrolls.push(transaction);
    });
    const focusEvents = vi.fn();
    const blurEvents = vi.fn();
    editor.view.dom.addEventListener("focus", focusEvents);
    editor.view.dom.addEventListener("blur", blurEvents);
    return { scrolls, transactions, focusEvents, blurEvents, viewFocus: vi.spyOn(editor.view, "focus") };
  }

  async function returnToWindow() {
    windowState.focused = true;
    await act(async () => { window.dispatchEvent(new FocusEvent("focus")); });
  }

  it("lets the IME recovery restore the same editor and adds no focus or scrolling (W7)", async () => {
    const [editor] = await mountEditors();
    await leaveWithImeRestorePending(editor);
    const selection = editor.state.selection.toJSON();
    act(() => restoreEditorFocus(editor));
    await advance(64);
    const observed = observe(editor);

    await returnToWindow();
    await advance(64);

    expect(document.activeElement).toBe(editor.view.dom);
    expect(observed.focusEvents).toHaveBeenCalledTimes(1);
    expect(observed.blurEvents).not.toHaveBeenCalled();
    expect(observed.viewFocus).not.toHaveBeenCalled();
    expect(observed.scrolls).toHaveLength(0);
    expect(editor.state.selection.toJSON()).toEqual(selection);
  });

  it("does not take focus back for an older general request on another editor (W7)", async () => {
    const [editor, other] = await mountEditors();
    await leaveWithImeRestorePending(editor);
    act(() => restoreEditorFocus(other));
    await advance(64);
    const kept = observe(editor);
    const older = observe(other);

    await returnToWindow();
    await advance(64);

    expect(document.activeElement).toBe(editor.view.dom);
    expect(kept.focusEvents).toHaveBeenCalledTimes(1);
    expect(kept.blurEvents).not.toHaveBeenCalled();
    expect(older.viewFocus).not.toHaveBeenCalled();
    expect(older.focusEvents).not.toHaveBeenCalled();
    expect(older.scrolls).toHaveLength(0);
  });

  it("leaves an editor that already has focus and is composing when the window returns untouched (W8)", async () => {
    const [editor] = await mountEditors();
    await leaveWithImeRestorePending(editor);
    act(() => restoreEditorFocus(editor));
    await advance(16);

    await returnToWindow();
    expect(document.activeElement).toBe(editor.view.dom);
    await act(async () => {
      editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    expect(editor.view.composing).toBe(true);
    const observed = observe(editor);
    const domBlur = vi.spyOn(editor.view.dom, "blur");
    await advance(64);

    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.view.composing).toBe(true);
    expect(observed.viewFocus).not.toHaveBeenCalled();
    expect(observed.focusEvents).not.toHaveBeenCalled();
    expect(observed.transactions).not.toHaveBeenCalled();
    expect(domBlur).not.toHaveBeenCalled();
  });
});
