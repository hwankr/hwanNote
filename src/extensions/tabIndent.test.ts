// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { TabIndent } from "./tabIndent";
import { TaskItemExtended } from "./taskItemExtended";

const editors: Editor[] = [];

afterEach(() => {
  editors.forEach((editor) => editor.destroy());
  editors.length = 0;
  document.body.replaceChildren();
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }]
});

function createEditor(content: JSONContent[]) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    // Match the ordering in Editor.tsx: TabIndent handles the key before
    // the list extensions, whose commands may return false at a boundary.
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      TaskList,
      TaskItemExtended.configure({ nested: true }),
      TabIndent.configure({ tabSize: 4 })
    ],
    // jsdom has no layout geometry for ProseMirror's scrollIntoView step.
    editorProps: { handleScrollToSelection: () => true },
    content: { type: "doc", content }
  });
  editors.push(editor);
  return editor;
}

function positionAt(editor: Editor, text: string) {
  let position = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) position = pos;
  });
  if (position < 0) throw new Error(`Missing text: ${text}`);
  return position;
}

function pressTab(editor: Editor, shiftKey = false) {
  editor.view.focus();
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    code: "Tab",
    keyCode: 9,
    shiftKey,
    bubbles: true,
    cancelable: true
  });
  editor.view.dom.dispatchEvent(event);
  // jsdom does not implement native Tab traversal. Preventing the default
  // is what keeps the real browser from moving focus out of the editor.
  expect(event.defaultPrevented).toBe(true);
  expect(editor.view.hasFocus()).toBe(true);
}

describe.each([
  { listType: "bulletList", itemType: "listItem" },
  { listType: "orderedList", itemType: "listItem" },
  { listType: "taskList", itemType: "taskItem" }
])("Tab focus in $listType", ({ listType, itemType }) => {
  const item = (text: string, children: JSONContent[] = []): JSONContent => ({
    type: itemType,
    content: [paragraph(text), ...children]
  });
  const list = (...items: JSONContent[]): JSONContent => ({ type: listType, content: items });

  it("consumes Tab on the first item when it cannot be indented", () => {
    const editor = createEditor([list(item("first"), item("second"))]);
    editor.commands.setTextSelection(positionAt(editor, "first"));
    const before = editor.getJSON();

    pressTab(editor);

    expect(editor.getJSON()).toEqual(before);
    expect(editor.state.selection.$from.parent.textContent).toBe("first");
  });

  it("still indents a following item exactly one level", () => {
    const editor = createEditor([list(item("first"), item("second"))]);
    editor.commands.setTextSelection(positionAt(editor, "second"));

    pressTab(editor);

    const outerList = editor.state.doc.firstChild!;
    expect(outerList.childCount).toBe(1);
    const nestedList = outerList.firstChild!.lastChild!;
    expect(nestedList.type.name).toBe(listType);
    expect(nestedList.childCount).toBe(1);
    expect(nestedList.firstChild!.textContent).toBe("second");
    expect(editor.state.selection.$from.parent.textContent).toBe("second");
  });

  it("still lifts a nested item exactly one level with Shift-Tab", () => {
    const editor = createEditor([list(item("first", [list(item("nested"))]))]);
    editor.commands.setTextSelection(positionAt(editor, "nested"));

    pressTab(editor, true);

    const outerList = editor.state.doc.firstChild!;
    expect(outerList.childCount).toBe(2);
    expect(outerList.firstChild!.childCount).toBe(1);
    expect(outerList.lastChild!.textContent).toBe("nested");
    expect(editor.state.selection.$from.parent.textContent).toBe("nested");
  });

  it("keeps Shift-Tab outdenting a selection across nested items", () => {
    const editor = createEditor([list(item("first", [list(item("nested one"), item("nested two"))]))]);
    editor.commands.setTextSelection({
      from: positionAt(editor, "nested one"),
      to: positionAt(editor, "nested two") + "nested two".length
    });

    pressTab(editor, true);

    const outerList = editor.state.doc.firstChild!;
    expect(outerList.childCount).toBe(3);
    expect(outerList.child(1).textContent).toBe("nested one");
    expect(outerList.child(2).textContent).toBe("nested two");
  });

  it("lifts a top-level item to a paragraph with Shift-Tab", () => {
    const editor = createEditor([list(item("first"))]);
    editor.commands.setTextSelection(positionAt(editor, "first"));

    pressTab(editor, true);

    expect(editor.getJSON().content).toEqual([paragraph("first")]);
  });
});

it("keeps Tab and Shift-Tab inserting and removing spaces in a paragraph", () => {
  const editor = createEditor([paragraph("text")]);
  editor.commands.setTextSelection(1);

  pressTab(editor);
  expect(editor.getText()).toBe("    text");

  pressTab(editor, true);
  expect(editor.getText()).toBe("text");
});

it("consumes Shift-Tab at the start of a paragraph with no indentation", () => {
  const editor = createEditor([paragraph("text")]);
  editor.commands.setTextSelection(1);
  const before = editor.getJSON();

  pressTab(editor, true);

  expect(editor.getJSON()).toEqual(before);
  expect(editor.state.selection.from).toBe(1);
});

it("consumes Shift-Tab with a paragraph selection without changing the text", () => {
  const editor = createEditor([paragraph("text")]);
  editor.commands.setTextSelection({ from: 1, to: 5 });
  const before = editor.getJSON();

  pressTab(editor, true);

  expect(editor.getJSON()).toEqual(before);
  expect(editor.state.selection.from).toBe(1);
  expect(editor.state.selection.to).toBe(5);
});
