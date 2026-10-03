// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { collectPlainText } from "./Editor";

describe("editor plain text for TXT saving", () => {
  it("preserves Shift+Enter, repeated hard breaks, and trailing empty paragraphs", () => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ trailingNode: false })],
      content: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "alpha" }] },
          { type: "paragraph" }
        ]
      }
    });
    try {
      editor.commands.setTextSelection(6);
      editor.commands.setHardBreak();
      editor.commands.insertContent("beta");
      editor.commands.setHardBreak();
      editor.commands.setHardBreak();
      editor.commands.insertContent("gamma");

      expect(collectPlainText(editor)).toBe("alpha\nbeta\n\ngamma\n");
    } finally {
      editor.destroy();
    }
  });
});
