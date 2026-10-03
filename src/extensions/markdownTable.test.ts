// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { Table, TableRow } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { MarkdownTableCell, MarkdownTableHeader } from "./markdownTable";
import { TaskItemExtended } from "./taskItemExtended";
import { ToggleBlock, ToggleContent, ToggleSummary } from "./toggleBlock";

function createEditor(cellType = "tableCell") {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      Table, TableRow, MarkdownTableHeader, MarkdownTableCell,
      TaskList, TaskItemExtended, ToggleBlock, ToggleSummary, ToggleContent
    ],
    content: {
      type: "doc",
      content: [{
        type: "table",
        content: [{ type: "tableRow", content: [{ type: cellType, content: [{
          type: "paragraph", content: [{ type: "text", text: "Original" }]
        }] }] }]
      }]
    }
  });
  editor.commands.setTextSelection(4);
  return editor;
}

describe("Markdown-compatible table editing", () => {
  it.each([
    ["heading", (editor: Editor) => editor.commands.setHeading({ level: 2 })],
    ["bullet list", (editor: Editor) => editor.commands.toggleBulletList()],
    ["ordered list", (editor: Editor) => editor.commands.toggleOrderedList()],
    ["task list", (editor: Editor) => editor.commands.toggleTaskList()],
    ["quote", (editor: Editor) => editor.commands.toggleBlockquote()],
    ["code block", (editor: Editor) => editor.commands.setCodeBlock()]
  ])("refuses %s formatting inside cells without changing their text", (_name, command) => {
    for (const cellType of ["tableCell", "tableHeader"]) {
      const editor = createEditor(cellType);
      try {
        const before = editor.getJSON();
        expect(command(editor)).toBe(false);
        expect(editor.getJSON()).toEqual(before);
      } finally {
        editor.destroy();
      }
    }
  });

  it("retains all text when pasting rich blocks into a cell", () => {
    const editor = createEditor();
    try {
      editor.view.pasteHTML([
        "<h2>Heading text</h2>",
        "<ul><li>First item</li><li>Second item</li></ul>",
        "<blockquote><p>Quoted text</p></blockquote>",
        "<pre><code>Code text</code></pre>",
        '<details data-type="toggleBlock" open><summary>Summary text</summary><div data-type="toggleContent"><p>Toggle body</p></div></details>'
      ].join(""), new Event("paste") as ClipboardEvent);
      for (const value of ["Heading text", "First item", "Second item", "Quoted text", "Code text", "Summary text", "Toggle body", "Original"]) {
        expect(editor.state.doc.textContent).toContain(value);
      }
      editor.state.doc.descendants((node) => {
        if (["tableCell", "tableHeader"].includes(node.type.name)) {
          node.forEach((child) => expect(child.type.name).toBe("paragraph"));
        }
      });
      expect(() => editor.state.doc.check()).not.toThrow();
    } finally {
      editor.destroy();
    }
  });
});
