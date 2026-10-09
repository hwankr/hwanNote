// @vitest-environment jsdom

import type { Editor as TiptapEditor, JSONContent } from "@tiptap/core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/context";
import { installWindowsImeRecovery } from "../lib/windowsImeRecovery";
import Editor from "./Editor";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tauri-apps/api/core")>(),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onMoved: async () => () => {},
    onScaleChanged: async () => () => {},
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const documentWithText = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }]
});

// jsdom cannot run the Windows IME or paint a WebView. These tests reproduce
// native DOM mutation/composition event ordering and the React controlled echo,
// not the reported physical-keyboard or compositor behavior.
describe("mounted editor during IME composition", () => {
  let container: HTMLDivElement;
  let root: Root;
  let editor: TiptapEditor;
  let replaceContent: (content: JSONContent) => void;
  let rerenderParent: () => void;
  let cleanupRecovery: (() => void) | undefined;
  const onChange = vi.fn();
  const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  const originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

  beforeEach(() => {
    window.localStorage.clear();
    onChange.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
  });

  afterEach(() => {
    act(() => {
      cleanupRecovery?.();
      cleanupRecovery = undefined;
      root.unmount();
    });
    container.remove();
    if (originalRangeRects) Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
    if (originalRangeBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeBounds);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function mount() {
    function Harness() {
      const [content, setContent] = useState(documentWithText("prefix "));
      const [cursor, setCursor] = useState(0);
      const [revision, setRevision] = useState(0);
      replaceContent = setContent;
      rerenderParent = () => setRevision((value) => value + 1);
      return (
        <I18nProvider>
          <output>{cursor}:{revision}</output>
          <Editor
            content={content}
            tabSize={4}
            spellcheck={false}
            autofocus={false}
            onChange={(nextContent, text) => {
              onChange(nextContent, text);
              setContent(nextContent);
            }}
            onCursorChange={(_line, column) => setCursor(column)}
            onEditorReady={(nextEditor) => { if (nextEditor) editor = nextEditor; }}
          />
        </I18nProvider>
      );
    }
    await act(async () => { root.render(<Harness />); });
    act(() => {
      editor.commands.setTextSelection(8);
      editor.view.focus();
    });
    return editor.view.dom.querySelector("p")!.firstChild as Text;
  }

  function composition(type: "compositionstart" | "compositionupdate" | "compositionend", data: string) {
    editor.view.dom.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
  }

  async function updateComposition(textNode: Text, text: string, data: string) {
    await act(async () => {
      // Browsers mutate contenteditable before the MutationObserver dispatches
      // a ProseMirror transaction. Preserve that ordering instead of using an
      // editor insertContent command, which bypasses the IME path.
      textNode.data = text;
      window.getSelection()!.collapse(textNode, text.length);
      composition("compositionupdate", data);
      editor.view.dom.dispatchEvent(new InputEvent("input", {
        data, inputType: "insertCompositionText", isComposing: true, bubbles: true
      }));
      await Promise.resolve();
    });
  }

  it("keeps the live composing text node through each Korean syllable update and parent rerender", async () => {
    const textNode = await mount();
    const originalDOM = editor.view.dom;
    act(() => { composition("compositionstart", ""); });

    for (const syllable of ["ㅎ", "하", "한"]) {
      await updateComposition(textNode, `prefix ${syllable}`, syllable);
      act(() => {
        replaceContent(documentWithText(`prefix ${syllable}`));
        rerenderParent();
      });
      expect(editor.view.composing).toBe(true);
      expect(editor.view.dom).toBe(originalDOM);
      expect(editor.view.dom.querySelector("p")!.firstChild).toBe(textNode);
      expect(editor.view.dom.textContent).toBe(`prefix ${syllable}`);
      expect(editor.getText()).toBe(`prefix ${syllable}`);
      expect(document.activeElement).toBe(originalDOM);
    }

    await act(async () => { composition("compositionend", "한"); });
    expect(editor.view.composing).toBe(false);
    expect(editor.getText()).toBe("prefix 한");
    expect(onChange.mock.lastCall?.[1]).toBe("prefix 한");
  });

  it("flushes the last DOM mutation when composition ends before the observer callback", async () => {
    const textNode = await mount();
    act(() => { composition("compositionstart", ""); });
    await updateComposition(textNode, "prefix 하", "하");

    await act(async () => {
      textNode.data = "prefix 한";
      window.getSelection()!.collapse(textNode, textNode.length);
      composition("compositionend", "한");
      await Promise.resolve();
    });

    expect(editor.view.composing).toBe(false);
    expect(editor.view.dom.textContent).toBe("prefix 한");
    expect(editor.getText()).toBe("prefix 한");
    expect(onChange.mock.lastCall?.[1]).toBe("prefix 한");
  });

  it("does not lose the pending syllable when focus leaves before the observer callback", async () => {
    const textNode = await mount();
    const outside = document.createElement("button");
    container.appendChild(outside);
    act(() => { composition("compositionstart", ""); });
    await updateComposition(textNode, "prefix 하", "하");

    await act(async () => {
      textNode.data = "prefix 한";
      window.getSelection()!.collapse(textNode, textNode.length);
      // A native IME normally also emits compositionend. This verifies that
      // the pending DOM mutation is preserved even when blur arrives first.
      outside.focus();
      // ProseMirror's blur handler stops/restarts its observer and schedules
      // queued records for a 20 ms flush. Wait for that documented path.
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(document.activeElement).toBe(outside);
    expect(editor.view.dom.textContent).toBe("prefix 한");
    expect(editor.getText()).toBe("prefix 한");
    expect(onChange.mock.lastCall?.[1]).toBe("prefix 한");
    await act(async () => { composition("compositionend", "한"); });
    expect(editor.view.composing).toBe(false);
  });

  it("defers Windows resize recovery until composition finishes and preserves final text, selection and undo", async () => {
    vi.useFakeTimers();
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const textNode = await mount();
    const originalEditor = editor;
    const originalDOM = editor.view.dom;
    cleanupRecovery = installWindowsImeRecovery();
    const blur = vi.spyOn(originalDOM, "blur");

    act(() => { composition("compositionstart", ""); });
    await updateComposition(textNode, "prefix 하", "하");
    window.dispatchEvent(new Event("resize"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(blur).not.toHaveBeenCalled();
    expect(editor.view.composing).toBe(true);
    expect(document.activeElement).toBe(originalDOM);

    await act(async () => {
      textNode.data = "prefix 한";
      window.getSelection()!.collapse(textNode, textNode.length);
      composition("compositionend", "한");
      await Promise.resolve();
    });
    expect(editor.getText()).toBe("prefix 한");
    expect(onChange.mock.lastCall?.[1]).toBe("prefix 한");
    act(() => { editor.commands.setTextSelection({ from: 9, to: 8 }); });
    const documentBeforeRecovery = editor.getJSON();
    const modelSelection = editor.state.selection.toJSON();
    const selection = window.getSelection()!;
    const domSelection = {
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode,
      focusOffset: selection.focusOffset,
    };

    await act(async () => { await vi.advanceTimersByTimeAsync(149); });
    expect(blur).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(blur).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
    await act(async () => { await vi.advanceTimersByTimeAsync(25); });

    expect(editor).toBe(originalEditor);
    expect(editor.view.dom).toBe(originalDOM);
    expect(originalDOM.querySelector("p")!.firstChild).toBe(textNode);
    expect(document.activeElement).toBe(originalDOM);
    expect(editor.getJSON()).toEqual(documentBeforeRecovery);
    expect(originalDOM.textContent).toBe("prefix 한");
    expect(editor.state.selection.toJSON()).toEqual(modelSelection);
    expect(window.getSelection()?.anchorNode).toBe(domSelection.anchorNode);
    expect(window.getSelection()?.anchorOffset).toBe(domSelection.anchorOffset);
    expect(window.getSelection()?.focusNode).toBe(domSelection.focusNode);
    expect(window.getSelection()?.focusOffset).toBe(domSelection.focusOffset);

    act(() => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.getText()).toBe("prefix ");
    act(() => { expect(editor.commands.redo()).toBe(true); });
    expect(editor.getJSON()).toEqual(documentBeforeRecovery);
    expect(originalDOM.textContent).toBe("prefix 한");
  });
});
