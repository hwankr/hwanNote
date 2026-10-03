// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import { Table, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { ToggleBlock, ToggleContent, ToggleSummary } from "./toggleBlock";
import { MarkdownTableCell, MarkdownTableHeader } from "./markdownTable";

const paragraph: JSONContent = { type: "paragraph", content: [{ type: "text", text: "Keep this text" }] };

function createEditor(content: JSONContent) {
  return new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      Table, TableRow, MarkdownTableHeader, MarkdownTableCell,
      ToggleBlock, ToggleSummary, ToggleContent
    ],
    content
  });
}

describe("toggle block insertion", () => {
  it.each(["tableHeader", "tableCell"])("refuses a toggle inside %s without changing the document", (cellType) => {
    const editor = createEditor({
      type: "doc",
      content: [{ type: "table", content: [{ type: "tableRow", content: [{ type: cellType, content: [paragraph] }] }] }]
    });
    try {
      editor.commands.setTextSelection(4);
      const before = editor.getJSON();
      expect(editor.can().insertToggleBlock()).toBe(false);
      expect(editor.commands.insertToggleBlock()).toBe(false);
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  it("still inserts toggles outside a table", () => {
    const editor = createEditor({ type: "doc", content: [paragraph] });
    try {
      expect(editor.commands.insertToggleBlock("Details")).toBe(true);
      expect(editor.getJSON().content?.some((node) => node.type === "toggleBlock")).toBe(true);
    } finally {
      editor.destroy();
    }
  });
});
