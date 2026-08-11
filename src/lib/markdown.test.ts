import { getSchema, type JSONContent } from "@tiptap/core";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { TaskItemExtended } from "../extensions/taskItemExtended";
import { LinkWithTitle } from "../extensions/linkWithTitle";
import { ToggleBlock, ToggleContent, ToggleSummary } from "../extensions/toggleBlock";
import {
  hasRichTextFormatting,
  markdownToTiptapDocument,
  plainTextToTiptapDocument,
  tiptapDocumentToMarkdown,
  tiptapDocumentToPlainText
} from "./markdown";

const editorSchema = getSchema([
  StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
  LinkWithTitle,
  Table,
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItemExtended.configure({ nested: true }),
  ToggleBlock,
  ToggleSummary,
  ToggleContent
]);

function walk(document: JSONContent) {
  const nodes: JSONContent[] = [];
  const visit = (node: JSONContent) => {
    nodes.push(node);
    node.content?.forEach(visit);
  };
  visit(document);
  return nodes;
}

function expectSchemaValid(document: JSONContent) {
  expect(() => editorSchema.nodeFromJSON(document).check()).not.toThrow();
}

describe("Tiptap JSON and Markdown round trips", () => {
  it("preserves headings, inline marks, link URLs, tables, and both list kinds", () => {
    const markdown = [
      "# Heading one",
      "",
      "## Heading two",
      "",
      "### Heading three",
      "",
      "Paragraph with **bold**, *italic*, and [a link](https://example.com/docs?q=1&lang=ko#part \"Docs\").",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| alpha | **beta** |",
      "| gamma | [delta](https://example.com/table) |",
      "",
      "- bullet one",
      "- bullet two",
      "    - nested bullet",
      "",
      "3. ordered three",
      "4. ordered four"
    ].join("\n");

    const document = markdownToTiptapDocument(markdown);
    const nodes = walk(document);

    expectSchemaValid(document);
    expect(nodes.filter((node) => node.type === "heading").map((node) => node.attrs?.level)).toEqual([1, 2, 3]);
    const table = nodes.find((node) => node.type === "table");
    expect(table?.content).toHaveLength(3);
    expect(table?.content?.every((row) => row.type === "tableRow" && row.content?.length === 2)).toBe(true);
    expect(nodes.some((node) => node.type === "bulletList")).toBe(true);
    expect(nodes.find((node) => node.type === "orderedList")?.attrs?.start).toBe(3);

    const markedText = nodes.filter((node) => node.type === "text");
    expect(markedText.find((node) => node.text === "bold")?.marks?.some((mark) => mark.type === "bold")).toBe(true);
    expect(markedText.find((node) => node.text === "italic")?.marks?.some((mark) => mark.type === "italic")).toBe(true);
    expect(
      markedText
        .find((node) => node.text === "a link")
        ?.marks?.find((mark) => mark.type === "link")
        ?.attrs?.href
    ).toBe("https://example.com/docs?q=1&lang=ko#part");
    expect(
      markedText
        .find((node) => node.text === "a link")
        ?.marks?.find((mark) => mark.type === "link")
        ?.attrs?.title
    ).toBe("Docs");

    const canonicalMarkdown = tiptapDocumentToMarkdown(document);
    const reparsed = markdownToTiptapDocument(canonicalMarkdown);
    expectSchemaValid(reparsed);
    expect(tiptapDocumentToMarkdown(reparsed)).toBe(canonicalMarkdown);
  });

  it("serializes a representative Tiptap document without flattening formatting", () => {
    const document: JSONContent = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "H1" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "H2" }] },
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "H3" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " and " },
            { type: "text", text: "italic", marks: [{ type: "italic" }] },
            { type: "text", text: " and " },
            {
              type: "text",
              text: "linked",
              marks: [{ type: "link", attrs: { href: "https://example.com/a_(b)?q=1&x=2" } }]
            }
          ]
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
                { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] }
              ]
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
                { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] }
              ]
            }
          ]
        },
        {
          type: "bulletList",
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "bullet" }] }] }]
        },
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "ordered" }] }] }]
        }
      ]
    };

    const markdown = tiptapDocumentToMarkdown(document);
    expect(markdown).toContain("# H1");
    expect(markdown).toContain("## H2");
    expect(markdown).toContain("### H3");
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("*italic*");
    expect(markdown).toContain("[linked](https://example.com/a_\\(b\\)?q=1&x=2)");
    expect(markdown).toContain("| A | B |");
    expect(markdown).toContain("- bullet");
    expect(markdown).toContain("1. ordered");

    const reparsed = markdownToTiptapDocument(markdown);
    expectSchemaValid(reparsed);
    const link = walk(reparsed)
      .flatMap((node) => node.marks ?? [])
      .find((mark) => mark.type === "link");
    expect(link?.attrs?.href).toBe("https://example.com/a_(b)?q=1&x=2");
    expect(tiptapDocumentToMarkdown(reparsed)).toBe(markdown);
  });

  it("keeps task state and toggle state in their existing Markdown syntax", () => {
    const markdown = [
      "- [x] completed",
      "- [ ] pending",
      "",
      ":::toggle[closed] **Details**",
      "Inside with [URL](https://example.com/toggle).",
      ":::"
    ].join("\n");

    const document = markdownToTiptapDocument(markdown);
    const nodes = walk(document);
    expectSchemaValid(document);
    expect(nodes.find((node) => node.type === "taskList")?.content?.map((item) => item.attrs?.checked)).toEqual([true, false]);
    expect(nodes.find((node) => node.type === "toggleBlock")?.attrs?.open).toBe(false);

    const serialized = tiptapDocumentToMarkdown(document);
    expect(serialized).toContain("- [x] completed");
    expect(serialized).toContain("- [ ] pending");
    expect(serialized).toContain(":::toggle[closed] **Details**");
    expect(tiptapDocumentToMarkdown(markdownToTiptapDocument(serialized))).toBe(serialized);
  });

  it("splits mixed task and bullet items without losing checkbox state", () => {
    const document = markdownToTiptapDocument("- [x] completed\n- ordinary\n- [ ] pending");
    const blocks = document.content ?? [];

    expectSchemaValid(document);
    expect(blocks.map((node) => node.type)).toEqual(["taskList", "bulletList", "taskList"]);
    expect(blocks[0].content?.[0]?.attrs?.checked).toBe(true);
    expect(blocks[2].content?.[0]?.attrs?.checked).toBe(false);
    expect(tiptapDocumentToMarkdown(document)).toContain("- [x] completed");
    expect(tiptapDocumentToMarkdown(document)).toContain("- ordinary");
    expect(tiptapDocumentToMarkdown(document)).toContain("- [ ] pending");
  });

  it("treats imported TXT lines as literal paragraphs", () => {
    const document = plainTextToTiptapDocument("# literal heading\n- literal bullet\n**literal bold**\n---");
    const markdown = tiptapDocumentToMarkdown(document);
    const reparsed = markdownToTiptapDocument(markdown);

    expect(markdown).toContain("\\# literal heading");
    expect(markdown).toContain("\\- literal bullet");
    expect(markdown).toContain("\\*\\*literal bold\\*\\*");
    expect(markdown).toContain("\\---");
    expect(walk(reparsed).filter((node) => node.type === "paragraph")).toHaveLength(4);
    expect(hasRichTextFormatting(document)).toBe(false);
  });

  it("detects structures that would be lost when switching to TXT", () => {
    expect(hasRichTextFormatting(plainTextToTiptapDocument("plain\ntext"))).toBe(false);
    expect(hasRichTextFormatting(markdownToTiptapDocument("**bold**"))).toBe(true);
    expect(hasRichTextFormatting(markdownToTiptapDocument("- list"))).toBe(true);
    expect(hasRichTextFormatting(markdownToTiptapDocument("| A |\n| --- |\n| B |"))).toBe(true);
  });

  it("keeps emphasis valid when a marked text node includes edge whitespace", () => {
    const document: JSONContent = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: " spaced ", marks: [{ type: "italic" }] }]
      }]
    };

    const markdown = tiptapDocumentToMarkdown(document);
    const reparsed = markdownToTiptapDocument(markdown);
    const nodes = walk(reparsed);

    expect(markdown).toBe(" *spaced* ");
    expect(nodes.some((node) => node.type === "bulletList")).toBe(false);
    expect(nodes.find((node) => node.text === "spaced")?.marks?.some((mark) => mark.type === "italic")).toBe(true);
  });

  it("indents nested lists far enough for multi-digit ordered markers", () => {
    const document: JSONContent = {
      type: "doc",
      content: [{
        type: "orderedList",
        attrs: { start: 100 },
        content: [{
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "outer" }] },
            {
              type: "bulletList",
              content: [{
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }]
              }]
            }
          ]
        }]
      }]
    };

    const markdown = tiptapDocumentToMarkdown(document);
    const reparsed = markdownToTiptapDocument(markdown);
    const orderedList = walk(reparsed).find((node) => node.type === "orderedList");

    expect(markdown).toContain("100. outer\n     - inner");
    expect(orderedList?.content?.[0]?.content?.some((node) => node.type === "bulletList")).toBe(true);
  });

  it("does not treat toggle-looking indented code as a toggle block", () => {
    const document = markdownToTiptapDocument("    :::toggle[open]\n    body\n    :::");
    const nodes = walk(document);

    expectSchemaValid(document);
    expect(nodes.some((node) => node.type === "toggleBlock")).toBe(false);
    expect(nodes.find((node) => node.type === "codeBlock")?.content?.[0]?.text).toContain(":::toggle[open]");
  });

  it("round-trips hard breaks inside table cells", () => {
    const document: JSONContent = {
      type: "doc",
      content: [{
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [{
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Header" }] }]
            }]
          },
          {
            type: "tableRow",
            content: [{
              type: "tableCell",
              content: [{
                type: "paragraph",
                content: [
                  { type: "text", text: "line one" },
                  { type: "hardBreak" },
                  { type: "text", text: "line two" }
                ]
              }]
            }]
          }
        ]
      }]
    };

    const markdown = tiptapDocumentToMarkdown(document);
    const reparsed = markdownToTiptapDocument(markdown);
    expect(markdown).toContain("line one<br>line two");
    expect(walk(reparsed).some((node) => node.type === "hardBreak")).toBe(true);
    expect(tiptapDocumentToMarkdown(reparsed)).toBe(markdown);
  });

  it("uses editor-compatible block separators for table plain text", () => {
    const document = markdownToTiptapDocument([
      "| A | B |",
      "| --- | --- |",
      "| C | D |"
    ].join("\n"));

    expect(tiptapDocumentToPlainText(document)).toBe("A\nB\nC\nD");
  });

  it("always produces schema-valid required block content", () => {
    const samples = [
      "-",
      ">",
      "- ```js\n  const value = 1;\n  ```"
    ];

    samples.forEach((markdown) => expectSchemaValid(markdownToTiptapDocument(markdown)));
  });

  it("escapes Markdown-looking literal paragraphs without changing their text", () => {
    const plainText = [
      ">quote",
      "    indented",
      "&copy;",
      ":::toggle[open]",
      ":::"
    ].join("\n");
    const markdown = tiptapDocumentToMarkdown(plainTextToTiptapDocument(plainText));
    const reparsed = markdownToTiptapDocument(markdown);

    expect(walk(reparsed).some((node) => ["blockquote", "codeBlock", "toggleBlock"].includes(node.type ?? ""))).toBe(false);
    expect(tiptapDocumentToPlainText(reparsed)).toBe(plainText);
  });

  it("preserves an intentional trailing newline inside a code block", () => {
    const document: JSONContent = {
      type: "doc",
      content: [{ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "value\n" }] }]
    };

    const markdown = tiptapDocumentToMarkdown(document);
    const reparsed = markdownToTiptapDocument(markdown);
    expect(walk(reparsed).find((node) => node.type === "codeBlock")?.content?.[0]?.text).toBe("value\n");
    expect(tiptapDocumentToMarkdown(reparsed)).toBe(markdown);
  });

  it("keeps hard breaks inside headings and toggle summaries", () => {
    const document: JSONContent = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" }]
        },
        {
          type: "toggleBlock",
          attrs: { open: true },
          content: [
            {
              type: "toggleSummary",
              content: [{ type: "text", text: "alpha" }, { type: "hardBreak" }, { type: "text", text: "beta" }]
            },
            { type: "toggleContent", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] }
          ]
        }
      ]
    };

    const markdown = tiptapDocumentToMarkdown(document);
    const reparsed = markdownToTiptapDocument(markdown);
    const heading = walk(reparsed).find((node) => node.type === "heading");
    const summary = walk(reparsed).find((node) => node.type === "toggleSummary");

    expect(markdown).toContain("## one<br>two");
    expect(markdown).toContain(":::toggle[open] alpha<br>beta");
    expect(heading?.content?.some((node) => node.type === "hardBreak")).toBe(true);
    expect(summary?.content?.some((node) => node.type === "hardBreak")).toBe(true);
    expect(tiptapDocumentToMarkdown(reparsed)).toBe(markdown);
  });

  it("does not silently downgrade headings already present above level three", () => {
    const markdown = "#### H4\n\n##### H5\n\n###### H6";
    const document = markdownToTiptapDocument(markdown);

    expectSchemaValid(document);
    expect(walk(document).filter((node) => node.type === "heading").map((node) => node.attrs?.level)).toEqual([4, 5, 6]);
    expect(tiptapDocumentToMarkdown(document)).toBe(markdown);
  });
});
