import { TableCell, TableHeader } from "@tiptap/extension-table";

// The persisted Markdown table format supports inline text and line breaks.
// Keep block-only structures out of cells so saving cannot flatten their type.
export const MarkdownTableCell = TableCell.extend({ content: "paragraph+" });
export const MarkdownTableHeader = TableHeader.extend({ content: "paragraph+" });
