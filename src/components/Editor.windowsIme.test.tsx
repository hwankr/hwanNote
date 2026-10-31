// @vitest-environment jsdom

import type { Editor as TiptapEditor } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/context";
import { installWindowsImeRecovery } from "../lib/windowsImeRecovery";
import Editor from "./Editor";

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

const KEY_INTERVAL_MS = 200;

describe("Windows IME recovery with the real editor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let editor: TiptapEditor;
  let cleanup: (() => void) | undefined;
  const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  const originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
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

  async function mountFocusedEditor() {
    await act(async () => {
      root.render(
        <I18nProvider>
          <Editor
            content={{ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "메모 입력" }] }] }}
            tabSize={4}
            spellcheck={false}
            autofocus={false}
            onChange={() => {}}
            onCursorChange={() => {}}
            onEditorReady={(nextEditor) => {
              if (nextEditor) editor = nextEditor;
            }}
          />
        </I18nProvider>
      );
    });
    cleanup = installWindowsImeRecovery();
    await act(async () => {
      for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
    });
    expect(native.moved).not.toBeNull();
    act(() => {
      editor.commands.setTextSelection(3);
      editor.view.focus();
    });
    expect(document.activeElement).toBe(editor.view.dom);
  }

  async function advance(milliseconds: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
  }

  // Each key is followed by an ordinary pause, longer than the old 150 ms settle delay.
  async function type(text: string) {
    for (const character of text) {
      await act(async () => {
        editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: character, bubbles: true }));
        editor.view.dispatch(editor.state.tr.insertText(character));
      });
      await advance(KEY_INTERVAL_MS);
    }
  }

  it("keeps the editor focused while typing continues across window notifications", async () => {
    await mountFocusedEditor();
    const blurs = vi.fn();
    editor.view.dom.addEventListener("blur", blurs);

    await type("가나");
    // tao reports this when Windows repositions the window without moving it.
    act(() => native.moved!({ payload: { x: 100, y: 100 } }));
    await type("다라");
    act(() => { window.dispatchEvent(new Event("resize")); });
    await type("마바");
    await advance(5_000);

    expect(blurs).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.view.hasFocus()).toBe(true);
    expect(editor.state.doc.textContent).toBe("메모가나다라마바 입력");
    expect(editor.state.selection.from).toBe(9);
  });

  it("still refreshes the IME anchor once after a real move while idle and keeps the selection", async () => {
    await mountFocusedEditor();
    await type("가");
    await advance(2_000);
    const { from, to } = editor.state.selection;
    const blurs = vi.fn();
    const focuses = vi.fn();
    editor.view.dom.addEventListener("blur", blurs);
    editor.view.dom.addEventListener("focus", focuses);

    act(() => native.moved!({ payload: { x: 1_920, y: 100 } }));
    await advance(200);

    expect(blurs).toHaveBeenCalledTimes(1);
    expect(focuses).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(editor.view.dom);
    expect(editor.state.selection.from).toBe(from);
    expect(editor.state.selection.to).toBe(to);
    await type("나");
    expect(editor.state.doc.textContent).toBe("메모가나 입력");
  });
});
