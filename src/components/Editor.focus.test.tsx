// @vitest-environment jsdom

import type { Editor as TiptapEditor, JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/context";
import Editor from "./Editor";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  ...(text ? { content: [{ type: "text", text }] } : {})
});

describe("mounted editor focus and controlled content", () => {
  let container: HTMLDivElement;
  let root: Root;
  let editor: TiptapEditor;
  let replaceContent: (content: JSONContent) => void;
  let finishSave: () => void;
  const ready = vi.fn();
  const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  const originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

  beforeEach(() => {
    window.localStorage.clear();
    ready.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    // jsdom has no layout. These stubs support ProseMirror's scroll calculations;
    // key tests below exercise its handlers, not native character deletion.
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
    function Harness() {
      const [value, setValue] = useState(content);
      const [saveRevision, setSaveRevision] = useState(0);
      replaceContent = setValue;
      finishSave = () => setSaveRevision((revision) => revision + 1);

      return (
        <I18nProvider>
          <output>{saveRevision}</output>
          <Editor
            content={value}
            tabSize={4}
            spellcheck={false}
            autofocus={false}
            onChange={(nextContent) => setValue(nextContent)}
            onCursorChange={() => {}}
            onEditorReady={(nextEditor) => {
              ready(nextEditor);
              if (nextEditor) editor = nextEditor;
            }}
          />
        </I18nProvider>
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });
    expect(editor).toBeDefined();
  }

  function focusAt(position: number) {
    act(() => {
      editor.commands.setTextSelection(position);
      editor.view.focus();
    });
    expect(document.activeElement).toBe(editor.view.dom);
  }

  function pressKey(key: string, modifiers: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
    act(() => {
      editor.view.dom.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  }

  function expectFocused(originalEditor: TiptapEditor, originalDOM: HTMLElement) {
    expect(editor).toBe(originalEditor);
    expect(editor.view.dom).toBe(originalDOM);
    expect(document.activeElement).toBe(originalDOM);
    expect(editor.isFocused).toBe(true);
  }

  it("keeps the instance, DOM, caret and undo history through content echoes and save rerenders", async () => {
    await mount({ type: "doc", content: [paragraph("alpha")] });
    const originalEditor = editor;
    const originalDOM = editor.view.dom;
    const readyCount = ready.mock.calls.length;
    focusAt(3);

    act(() => {
      editor.commands.insertContent("X");
    });
    expect(editor.getText()).toBe("alXpha");
    expect(editor.state.selection.from).toBe(4);
    expectFocused(originalEditor, originalDOM);

    act(() => {
      finishSave();
    });
    expectFocused(originalEditor, originalDOM);
    expect(editor.state.selection.from).toBe(4);
    expect(ready.mock.calls.length).toBe(readyCount);
    pressKey("z", { ctrlKey: true });
    expect(editor.getText()).toBe("alpha");
    expectFocused(originalEditor, originalDOM);
  });

  it.each([
    ["JSON property order", {
      content: [{ content: [{ text: "alpha", type: "text" }], attrs: { level: 1 }, type: "heading" }],
      type: "doc"
    }],
    ["omitted default attributes", {
      type: "doc",
      content: [{ type: "heading", content: [{ type: "text", text: "alpha" }] }]
    }]
  ] satisfies [string, JSONContent][])("does not replace equal documents with %s differences", async (_label, incoming) => {
    await mount({ type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "alpha" }] }] });
    const originalEditor = editor;
    const originalDOM = editor.view.dom;
    focusAt(3);
    const transactions = vi.fn();
    editor.on("transaction", transactions);

    act(() => {
      replaceContent(incoming);
    });

    expect(editor.state.selection.from).toBe(3);
    expectFocused(originalEditor, originalDOM);
    expect(transactions.mock.calls.some(([{ transaction }]) => transaction.docChanged)).toBe(false);
  });

  it("still applies a genuinely changed document from the parent", async () => {
    await mount({ type: "doc", content: [paragraph("alpha")] });
    act(() => {
      replaceContent({ type: "doc", content: [paragraph("updated elsewhere")] });
    });
    expect(editor.getText()).toBe("updated elsewhere");
  });

  it("keeps focus when Backspace joins paragraphs and the join is undone", async () => {
    await mount({ type: "doc", content: [paragraph("alpha"), paragraph("beta")] });
    const originalEditor = editor;
    const originalDOM = editor.view.dom;
    focusAt(8);
    pressKey("Backspace");
    expect(editor.getText()).toBe("alphabeta");
    expect(editor.state.selection.from).toBe(6);
    expectFocused(originalEditor, originalDOM);
    pressKey("z", { ctrlKey: true });
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).textContent).toBe("beta");
    expectFocused(originalEditor, originalDOM);
  });

  it("keeps focus when Backspace removes an empty task and undo restores it", async () => {
    await mount({
      type: "doc",
      content: [{ type: "taskList", content: [
        { type: "taskItem", attrs: { checked: false }, content: [paragraph("alpha")] },
        { type: "taskItem", attrs: { checked: false }, content: [paragraph("")] }
      ] }]
    });
    const originalEditor = editor;
    const originalDOM = editor.view.dom;
    let emptyParagraphPosition = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "paragraph" && node.content.size === 0) emptyParagraphPosition = position + 1;
    });
    focusAt(emptyParagraphPosition);
    pressKey("Backspace");
    expect(editor.state.doc.child(0).childCount).toBe(1);
    expectFocused(originalEditor, originalDOM);
    pressKey("z", { ctrlKey: true });
    expect(editor.state.doc.child(0).childCount).toBe(2);
    expectFocused(originalEditor, originalDOM);
  });

  it("keeps focus when Backspace selects and unwraps a toggle, including undo", async () => {
    await mount({
      type: "doc",
      content: [
        { type: "toggleBlock", attrs: { open: true }, content: [
          { type: "toggleSummary", content: [{ type: "text", text: "Title" }] },
          { type: "toggleContent", content: [paragraph("body")] }
        ] },
        paragraph("tail")
      ]
    });
    const originalEditor = editor;
    const originalDOM = editor.view.dom;
    focusAt(editor.state.doc.child(0).nodeSize + 1);
    pressKey("Backspace");
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expectFocused(originalEditor, originalDOM);
    pressKey("Backspace");
    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    expect(editor.state.doc.child(0).textContent).toBe("Title");
    expect(editor.state.doc.child(1).textContent).toBe("body");
    expectFocused(originalEditor, originalDOM);
    pressKey("z", { ctrlKey: true });
    expect(editor.state.doc.child(0).type.name).toBe("toggleBlock");
    expectFocused(originalEditor, originalDOM);
  });
});
