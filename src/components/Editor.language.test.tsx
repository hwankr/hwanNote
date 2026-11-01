// @vitest-environment jsdom

import type { Editor as TiptapEditor, JSONContent } from "@tiptap/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "../i18n/context";
import { translate, type AppLanguage } from "../i18n/messages";
import Editor from "./Editor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("editor language changes", () => {
  let container: HTMLDivElement;
  let root: Root;
  let editor: TiptapEditor;
  let setLanguage: (language: AppLanguage) => void;
  const ready = vi.fn();
  const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  const originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

  beforeEach(() => {
    window.localStorage.clear();
    ready.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // jsdom has no layout. ProseMirror reads these when it focuses and scrolls.
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
    Object.defineProperty(Range.prototype, "getBoundingClientRect", { configurable: true, value: () => new DOMRect() });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    if (originalRangeRects) Object.defineProperty(Range.prototype, "getClientRects", originalRangeRects);
    else Reflect.deleteProperty(Range.prototype, "getClientRects");
    if (originalRangeBounds) Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeBounds);
    else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  });

  async function mount(content: JSONContent) {
    function LanguageControl() {
      setLanguage = useI18n().setLanguage;
      return null;
    }

    await act(async () => {
      root.render(
        <I18nProvider>
          <LanguageControl />
          <Editor
            content={content}
            tabSize={4}
            spellcheck={false}
            autofocus={false}
            onChange={() => {}}
            onCursorChange={() => {}}
            onEditorReady={(nextEditor) => {
              ready(nextEditor);
              if (nextEditor) editor = nextEditor;
            }}
          />
        </I18nProvider>
      );
    });
    expect(editor).toBeDefined();
  }

  async function changeLanguage(language: AppLanguage) {
    await act(async () => {
      setLanguage(language);
    });
  }

  function placeholderOf(dom: HTMLElement) {
    return dom.querySelector("p.is-editor-empty")?.getAttribute("data-placeholder");
  }

  it("keeps the instance, DOM, selection, undo history and focus", async () => {
    await mount({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "alpha beta" }] }] });
    const originalEditor = editor;
    const originalDOM = editor.view.dom;
    const readyCount = ready.mock.calls.length;
    act(() => {
      editor.commands.setTextSelection(3);
      editor.view.focus();
      editor.commands.insertContent("X");
      editor.commands.setTextSelection({ from: 2, to: 6 });
    });
    expect(document.activeElement).toBe(originalDOM);
    const setOptions = vi.spyOn(originalEditor, "setOptions");

    await changeLanguage("en");

    expect(originalEditor.isDestroyed).toBe(false);
    expect(editor).toBe(originalEditor);
    expect(ready.mock.calls.length).toBe(readyCount);
    expect(container.querySelector(".note-editor")).toBe(originalDOM);
    expect(editor.view.dom).toBe(originalDOM);
    expect(editor.state.selection.from).toBe(2);
    expect(editor.state.selection.to).toBe(6);
    expect(editor.can().undo()).toBe(true);
    expect(document.activeElement).toBe(originalDOM);
    expect(editor.isFocused).toBe(true);
    act(() => {
      editor.commands.undo();
    });
    expect(editor.getText()).toBe("alpha beta");

    // Typing rerenders the editor on every transaction. The dependency list
    // must not make @tiptap/react push options into the view on each one.
    act(() => {
      editor.commands.insertContent("Y");
    });
    expect(editor.getText()).toBe("alYpha beta");
    expect(setOptions).not.toHaveBeenCalled();
  });

  it("shows the empty-document placeholder in the new language right away", async () => {
    await mount({ type: "doc", content: [{ type: "paragraph" }] });
    const originalEditor = editor;
    const originalDOM = editor.view.dom;
    act(() => {
      editor.commands.setTextSelection(1);
      editor.view.focus();
      editor.view.dispatch(editor.state.tr.insertText("a"));
      editor.view.dispatch(editor.state.tr.delete(1, 2));
    });
    expect(editor.isEmpty).toBe(true);
    expect(placeholderOf(originalDOM)).toBe(translate("ko", "editor.placeholder"));

    await changeLanguage("en");

    expect(originalEditor.isDestroyed).toBe(false);
    expect(editor).toBe(originalEditor);
    expect(editor.view.dom).toBe(originalDOM);
    expect(placeholderOf(originalDOM)).toBe(translate("en", "editor.placeholder"));
    expect(editor.state.selection.from).toBe(1);
    expect(editor.can().undo()).toBe(true);
    expect(document.activeElement).toBe(originalDOM);

    await changeLanguage("ko");

    expect(editor).toBe(originalEditor);
    expect(placeholderOf(originalDOM)).toBe(translate("ko", "editor.placeholder"));
  });
});
