import type { JSONContent } from "@tiptap/core";
import MarkdownIt from "markdown-it";

type MarkdownToken = ReturnType<MarkdownIt["parse"]>[number];
type MarkdownMark = NonNullable<JSONContent["marks"]>[number];

const markdownParser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false
});

const TOGGLE_START = /^:::toggle\[(open|closed)\](?:\s+(.*))?\s*$/i;
const TOGGLE_END = /^:::\s*$/;
const FENCE_START = /^\s{0,3}(`{3,}|~{3,})/;

function createContainer(type: string, attrs?: Record<string, unknown>): JSONContent {
  return {
    type,
    ...(attrs ? { attrs } : {}),
    content: []
  };
}

function marksEqual(left: JSONContent["marks"], right: JSONContent["marks"]) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function appendText(target: JSONContent[], text: string, marks: MarkdownMark[] = []) {
  if (!text) {
    return;
  }

  const previous = target[target.length - 1];
  if (previous?.type === "text" && marksEqual(previous.marks, marks)) {
    previous.text = `${previous.text ?? ""}${text}`;
    return;
  }

  target.push({
    type: "text",
    text,
    ...(marks.length > 0 ? { marks: marks.map((mark) => ({ ...mark, attrs: mark.attrs ? { ...mark.attrs } : undefined })) } : {})
  });
}

function closeMark(markStack: MarkdownMark[], type: string) {
  for (let index = markStack.length - 1; index >= 0; index -= 1) {
    if (markStack[index].type === type) {
      markStack.splice(index, 1);
      return;
    }
  }
}

function appendTextWithOptionalBreaks(
  content: JSONContent[],
  text: string,
  marks: MarkdownMark[],
  parseHtmlBreaks: boolean
) {
  if (!parseHtmlBreaks) {
    appendText(content, text, marks);
    return;
  }

  const segments = text.split(/(<br\s*\/?\s*>)/gi);
  for (const segment of segments) {
    if (/^<br\s*\/?\s*>$/i.test(segment)) {
      content.push({ type: "hardBreak" });
    } else {
      appendText(content, segment, marks);
    }
  }
}

function parseInlineTokens(tokens: MarkdownToken[], parseHtmlBreaks = false): JSONContent[] {
  const content: JSONContent[] = [];
  const marks: MarkdownMark[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case "text":
        appendTextWithOptionalBreaks(content, token.content, marks, parseHtmlBreaks);
        break;

      case "strong_open":
        marks.push({ type: "bold" });
        break;
      case "strong_close":
        closeMark(marks, "bold");
        break;

      case "em_open":
        marks.push({ type: "italic" });
        break;
      case "em_close":
        closeMark(marks, "italic");
        break;

      case "s_open":
        marks.push({ type: "strike" });
        break;
      case "s_close":
        closeMark(marks, "strike");
        break;

      case "link_open":
        marks.push({
          type: "link",
          attrs: {
            href: token.attrGet("href") ?? "",
            title: token.attrGet("title")
          }
        });
        break;
      case "link_close":
        closeMark(marks, "link");
        break;

      case "code_inline":
        appendText(content, token.content, [{ type: "code" }]);
        break;

      case "hardbreak":
        content.push({ type: "hardBreak" });
        break;

      case "softbreak":
        appendText(content, " ", marks);
        break;

      case "image": {
        const href = token.attrGet("src") ?? "";
        const imageMarks = href
          ? [{ type: "link", attrs: { href } }]
          : marks;
        appendText(content, token.content || token.attrGet("alt") || href, imageMarks);
        break;
      }

      case "html_inline":
        appendText(content, token.content, marks);
        break;

      default:
        if (token.content) {
          appendText(content, token.content, marks);
        }
        break;
    }
  }

  return content;
}

function parseInlineMarkdown(markdown: string, parseHtmlBreaks = false) {
  const token = markdownParser.parseInline(markdown, {})[0];
  return parseInlineTokens(token?.children ?? [], parseHtmlBreaks);
}

function appendChild(parent: JSONContent, child: JSONContent) {
  parent.content ??= [];
  parent.content.push(child);
}

function parseStandardMarkdown(markdown: string): JSONContent[] {
  if (!markdown.trim()) {
    return [];
  }

  const root = createContainer("doc");
  const stack: JSONContent[] = [root];
  const current = () => stack[stack.length - 1];

  const open = (type: string, attrs?: Record<string, unknown>) => {
    const node = createContainer(type, attrs);
    appendChild(current(), node);
    stack.push(node);
  };
  const close = () => {
    if (stack.length > 1) {
      stack.pop();
    }
  };
  const openTableCell = (type: "tableHeader" | "tableCell") => {
    const cell = createContainer(type, {
      colspan: 1,
      rowspan: 1,
      colwidth: null
    });
    const paragraph = createContainer("paragraph");
    appendChild(cell, paragraph);
    appendChild(current(), cell);
    stack.push(cell, paragraph);
  };
  const closeTableCell = () => {
    close();
    close();
  };

  const tokens = markdownParser.parse(markdown, {});
  for (const token of tokens) {
    switch (token.type) {
      case "paragraph_open":
        open("paragraph");
        break;
      case "paragraph_close":
        close();
        break;

      case "heading_open": {
        const parsedLevel = Number.parseInt(token.tag.slice(1), 10);
        const level = Math.max(1, Math.min(6, Number.isFinite(parsedLevel) ? parsedLevel : 1));
        open("heading", { level });
        break;
      }
      case "heading_close":
        close();
        break;

      case "blockquote_open":
        open("blockquote");
        break;
      case "blockquote_close":
        close();
        break;

      case "bullet_list_open":
        open("bulletList");
        break;
      case "bullet_list_close":
        close();
        break;

      case "ordered_list_open": {
        const parsedStart = Number.parseInt(token.attrGet("start") ?? "1", 10);
        open("orderedList", { start: Number.isFinite(parsedStart) ? parsedStart : 1 });
        break;
      }
      case "ordered_list_close":
        close();
        break;

      case "list_item_open":
        open("listItem");
        break;
      case "list_item_close":
        close();
        break;

      case "table_open":
        open("table");
        break;
      case "table_close":
        close();
        break;
      case "tr_open":
        open("tableRow");
        break;
      case "tr_close":
        close();
        break;
      case "th_open":
        openTableCell("tableHeader");
        break;
      case "th_close":
        closeTableCell();
        break;
      case "td_open":
        openTableCell("tableCell");
        break;
      case "td_close":
        closeTableCell();
        break;

      case "inline":
        current().content ??= [];
        const parseHtmlBreaks =
          current().type === "heading" ||
          stack[stack.length - 2]?.type === "tableHeader" ||
          stack[stack.length - 2]?.type === "tableCell";
        current().content?.push(
          ...parseInlineTokens(token.children ?? [], parseHtmlBreaks)
        );
        break;

      case "fence":
      case "code_block": {
        const language = token.type === "fence" ? token.info.trim().split(/\s+/)[0] || null : null;
        const value = token.content.endsWith("\n") ? token.content.slice(0, -1) : token.content;
        const codeBlock = createContainer("codeBlock", { language });
        if (value) {
          codeBlock.content = [{ type: "text", text: value }];
        }
        appendChild(current(), codeBlock);
        break;
      }

      case "hr":
        appendChild(current(), { type: "horizontalRule" });
        break;

      case "html_block": {
        const paragraph = createContainer("paragraph");
        appendText(paragraph.content ?? [], token.content.trimEnd());
        appendChild(current(), paragraph);
        break;
      }

      case "thead_open":
      case "thead_close":
      case "tbody_open":
      case "tbody_close":
        break;

      default:
        break;
    }
  }

  return ensureRequiredBlockContent(normalizeTaskStructure(root)).content ?? [];
}

function stripTaskMarker(item: JSONContent) {
  if (item.type !== "listItem" || item.content?.[0]?.type !== "paragraph") {
    return null;
  }

  const paragraph = item.content[0];
  const firstTextIndex = paragraph.content?.findIndex((node) => node.type === "text") ?? -1;
  if (firstTextIndex < 0 || !paragraph.content) {
    return null;
  }

  const firstText = paragraph.content[firstTextIndex];
  const match = /^\[([ xX])\](?:[ \t]+|$)/.exec(firstText.text ?? "");
  if (!match) {
    return null;
  }

  const nextParagraphContent = [...paragraph.content];
  const remainingText = (firstText.text ?? "").slice(match[0].length);
  if (remainingText) {
    nextParagraphContent[firstTextIndex] = { ...firstText, text: remainingText };
  } else {
    nextParagraphContent.splice(firstTextIndex, 1);
  }

  return {
    checked: match[1].toLowerCase() === "x",
    item: {
      ...item,
      type: "taskItem",
      attrs: { checked: match[1].toLowerCase() === "x" },
      content: [
        { ...paragraph, content: nextParagraphContent },
        ...(item.content.slice(1) ?? [])
      ]
    } satisfies JSONContent
  };
}

function normalizeTaskStructure(node: JSONContent): JSONContent {
  const normalizeChildren = (children: JSONContent[]): JSONContent[] =>
    children.flatMap((child) => {
      const normalizedChild = normalizeTaskStructure(child);
      if (normalizedChild.type !== "bulletList" || !normalizedChild.content?.length) {
        return [normalizedChild];
      }

      const groups: Array<{ task: boolean; items: JSONContent[] }> = [];
      normalizedChild.content.forEach((item) => {
        const parsedTask = stripTaskMarker(item);
        const task = parsedTask !== null;
        const normalizedItem = parsedTask?.item ?? item;
        const previous = groups[groups.length - 1];
        if (previous?.task === task) {
          previous.items.push(normalizedItem);
        } else {
          groups.push({ task, items: [normalizedItem] });
        }
      });

      return groups.map((group) => ({
        type: group.task ? "taskList" : "bulletList",
        content: group.items
      }));
    });

  return node.content ? { ...node, content: normalizeChildren(node.content) } : { ...node };
}

function ensureRequiredBlockContent(node: JSONContent): JSONContent {
  const content = node.content?.map(ensureRequiredBlockContent) ?? [];
  if (["listItem", "taskItem"].includes(node.type ?? "") && content[0]?.type !== "paragraph") {
    content.unshift({ type: "paragraph" });
  }
  if (["blockquote", "tableCell", "tableHeader", "toggleContent"].includes(node.type ?? "") && content.length === 0) {
    content.push({ type: "paragraph" });
  }

  return {
    ...node,
    ...(node.content || content.length > 0 ? { content } : {})
  };
}

function fenceMarker(line: string) {
  return FENCE_START.exec(line)?.[1] ?? null;
}

function isMatchingFence(line: string, openingFence: string) {
  const candidate = fenceMarker(line);
  return Boolean(
    candidate &&
      candidate[0] === openingFence[0] &&
      candidate.length >= openingFence.length
  );
}

function toggleSyntax(line: string) {
  const indentation = /^[ \t]*/.exec(line)?.[0] ?? "";
  if (indentation.includes("\t") || indentation.length > 3) {
    return null;
  }
  return line.trim();
}

function findToggleEnd(lines: string[], startIndex: number) {
  let depth = 0;
  let activeFence: string | null = null;

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (activeFence) {
      if (isMatchingFence(line, activeFence)) {
        activeFence = null;
      }
      continue;
    }

    const nextFence = fenceMarker(line);
    if (nextFence) {
      activeFence = nextFence;
      continue;
    }

    const syntax = toggleSyntax(line);
    if (syntax && TOGGLE_START.test(syntax)) {
      depth += 1;
    } else if (syntax && TOGGLE_END.test(syntax)) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function parseToggleAwareBlocks(markdown: string): JSONContent[] {
  const lines = markdown.split("\n");
  const content: JSONContent[] = [];
  let regularStart = 0;
  let activeFence: string | null = null;

  const flushRegular = (end: number) => {
    const source = lines.slice(regularStart, end).join("\n");
    content.push(...parseStandardMarkdown(source));
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (activeFence) {
      if (isMatchingFence(line, activeFence)) {
        activeFence = null;
      }
      continue;
    }

    const nextFence = fenceMarker(line);
    if (nextFence) {
      activeFence = nextFence;
      continue;
    }

    const syntax = toggleSyntax(line);
    const match = syntax ? TOGGLE_START.exec(syntax) : null;
    if (!match) {
      continue;
    }

    const end = findToggleEnd(lines, index);
    if (end < 0) {
      continue;
    }

    flushRegular(index);
    const summary = match[2]?.trim() ?? "";
    const toggleContent = parseToggleAwareBlocks(lines.slice(index + 1, end).join("\n"));
    content.push({
      type: "toggleBlock",
      attrs: { open: match[1].toLowerCase() === "open" },
      content: [
        { type: "toggleSummary", content: parseInlineMarkdown(summary, true) },
        {
          type: "toggleContent",
          content: toggleContent.length > 0 ? toggleContent : [{ type: "paragraph" }]
        }
      ]
    });
    index = end;
    regularStart = end + 1;
  }

  flushRegular(lines.length);
  return content;
}

export function markdownToTiptapDocument(markdown: string): JSONContent {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const content = parseToggleAwareBlocks(normalized);
  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }]
  };
}

function longestBacktickRun(value: string) {
  return Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
}

function escapeInlineText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]~])/g, "\\$1")
    .replace(/#/g, "\\#")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/&/g, "\\&");
}

function serializeInlineCode(value: string) {
  const fence = "`".repeat(Math.max(1, longestBacktickRun(value) + 1));
  const needsPadding = /^`|`$|^\s|\s$/.test(value);
  return `${fence}${needsPadding ? ` ${value} ` : value}${fence}`;
}

function escapeLinkDestination(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\s/g, (character) => encodeURIComponent(character));
}

function serializeTextNode(node: JSONContent) {
  const marks = node.marks ?? [];
  const code = marks.some((mark) => mark.type === "code");
  const hasDelimitedMark = !code && marks.some((mark) => ["bold", "italic", "strike", "link"].includes(mark.type));
  const rawValue = node.text ?? "";
  const leadingWhitespace = hasDelimitedMark ? /^\s*/.exec(rawValue)?.[0] ?? "" : "";
  const trailingWhitespace = hasDelimitedMark ? /\s*$/.exec(rawValue.slice(leadingWhitespace.length))?.[0] ?? "" : "";
  const coreEnd = rawValue.length - trailingWhitespace.length;
  const coreValue = rawValue.slice(leadingWhitespace.length, coreEnd);

  if (hasDelimitedMark && !coreValue) {
    return escapeInlineText(rawValue);
  }

  let value = code ? serializeInlineCode(rawValue) : escapeInlineText(coreValue || rawValue);

  if (!code) {
    if (marks.some((mark) => mark.type === "bold")) {
      value = `**${value}**`;
    }
    if (marks.some((mark) => mark.type === "italic")) {
      value = `*${value}*`;
    }
    if (marks.some((mark) => mark.type === "strike")) {
      value = `~~${value}~~`;
    }
  }

  const link = marks.find((mark) => mark.type === "link");
  const href = typeof link?.attrs?.href === "string" ? link.attrs.href : "";
  if (href) {
    const rawTitle = typeof link?.attrs?.title === "string" ? link.attrs.title : "";
    const title = rawTitle ? ` "${rawTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : "";
    value = `[${value}](${escapeLinkDestination(href)}${title})`;
  }

  return `${escapeInlineText(leadingWhitespace)}${value}${escapeInlineText(trailingWhitespace)}`;
}

function serializeInline(content: JSONContent[] = [], hardBreak = "  \n"): string {
  return content
    .map((node) => {
      if (node.type === "text") {
        return serializeTextNode(node);
      }
      if (node.type === "hardBreak") {
        return hardBreak;
      }
      return serializeInline(node.content ?? [], hardBreak);
    })
    .join("");
}

function escapeParagraphOpening(value: string) {
  return value
    .replace(/^\t/, "&#9;")
    .replace(/^ {4}/, "&#32;   ")
    .replace(/^(\s{0,3})(:::)/, "$1\\$2")
    .replace(/^(\s{0,3})(-{3,})(\s*)$/, (_match, leading: string, dashes: string, trailing: string) =>
      `${leading}\\${dashes}${trailing}`
    )
    .replace(/^(\s{0,3})([-+>])(?=\s)/, "$1\\$2")
    .replace(/^(\s{0,3})(\d+)([.)])(?=\s)/, "$1$2\\$3");
}

function indent(value: string, spaces = 4) {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function serializeCodeBlock(node: JSONContent) {
  const value = node.content?.map((child) => child.text ?? "").join("") ?? "";
  const fence = "`".repeat(Math.max(3, longestBacktickRun(value) + 1));
  const rawLanguage = typeof node.attrs?.language === "string" ? node.attrs.language : "";
  const language = /^[\w+-]+$/.test(rawLanguage) ? rawLanguage : "";
  return `${fence}${language}\n${value}${value ? "\n" : ""}${fence}`;
}

function serializeList(node: JSONContent) {
  const start = Number.isFinite(Number(node.attrs?.start)) ? Number(node.attrs?.start) : 1;
  return (node.content ?? [])
    .map((item, index) => {
      const marker =
        node.type === "orderedList"
          ? `${start + index}.`
          : node.type === "taskList"
            ? `- [${item.attrs?.checked ? "x" : " "}]`
            : "-";
      const blocks = item.content ?? [];
      const first = blocks[0];
      const firstValue = first?.type === "paragraph"
        ? escapeParagraphOpening(serializeInline(first.content ?? []))
        : first
          ? serializeBlock(first)
          : "";
      const firstLines = firstValue.split("\n");
      const continuation = " ".repeat(marker.length + 1);
      const lines = [
        firstLines[0] ? `${marker} ${firstLines[0]}` : marker,
        ...firstLines.slice(1).map((line) => `${continuation}${line}`)
      ];

      for (const child of blocks.slice(1)) {
        const serialized = serializeBlock(child);
        if (!serialized) {
          continue;
        }
        const childIndent = marker.length + 1;
        if (["bulletList", "orderedList", "taskList"].includes(child.type ?? "")) {
          lines.push(indent(serialized, childIndent));
        } else {
          lines.push("", indent(serialized, childIndent));
        }
      }

      return lines.join("\n");
    })
    .join("\n");
}

function serializeTableCell(node: JSONContent) {
  return (node.content ?? [])
    .map((block) => block.type === "paragraph" ? serializeInline(block.content ?? [], "<br>") : serializeBlock(block))
    .join("<br>")
    .replace(/ {2}\r?\n/g, "<br>")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

function serializeTable(node: JSONContent) {
  const rows = (node.content ?? []).filter((row) => row.type === "tableRow");
  if (rows.length === 0) {
    return "";
  }

  const columnCount = Math.max(1, ...rows.map((row) => row.content?.length ?? 0));
  const serializeRow = (row: JSONContent) => {
    const cells = Array.from({ length: columnCount }, (_, index) => serializeTableCell(row.content?.[index] ?? {}));
    return `| ${cells.join(" | ")} |`;
  };

  return [
    serializeRow(rows[0]),
    `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`,
    ...rows.slice(1).map(serializeRow)
  ].join("\n");
}

function serializeToggle(node: JSONContent) {
  const summary = node.content?.find((child) => child.type === "toggleSummary");
  const body = node.content?.find((child) => child.type === "toggleContent");
  const summaryMarkdown = serializeInline(summary?.content ?? [], "<br>");
  const bodyMarkdown = serializeBlocks(body?.content ?? []);
  const header = `:::toggle[${node.attrs?.open === false ? "closed" : "open"}]${summaryMarkdown ? ` ${summaryMarkdown}` : ""}`;
  return `${header}\n${bodyMarkdown}${bodyMarkdown ? "\n" : ""}:::`;
}

function serializeBlock(node: JSONContent): string {
  switch (node.type) {
    case "paragraph":
      return escapeParagraphOpening(serializeInline(node.content ?? []));
    case "heading": {
      const level = Math.max(1, Math.min(6, Number(node.attrs?.level) || 1));
      return `${"#".repeat(level)} ${serializeInline(node.content ?? [], "<br>")}`.trimEnd();
    }
    case "blockquote":
      return serializeBlocks(node.content ?? [])
        .split("\n")
        .map((line) => line ? `> ${line}` : ">")
        .join("\n");
    case "bulletList":
    case "orderedList":
    case "taskList":
      return serializeList(node);
    case "table":
      return serializeTable(node);
    case "codeBlock":
      return serializeCodeBlock(node);
    case "horizontalRule":
      return "---";
    case "toggleBlock":
      return serializeToggle(node);
    case "toggleContent":
      return serializeBlocks(node.content ?? []);
    case "toggleSummary":
      return serializeInline(node.content ?? [], "<br>");
    default:
      return node.content ? serializeBlocks(node.content) : "";
  }
}

function serializeBlocks(content: JSONContent[]) {
  return content.map(serializeBlock).join("\n\n");
}

export function tiptapDocumentToMarkdown(document: JSONContent) {
  const blocks = document.type === "doc" ? document.content ?? [] : [document];
  return serializeBlocks(blocks);
}

export function plainTextToTiptapDocument(text: string): JSONContent {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {})
    }))
  };
}

export function tiptapDocumentToPlainText(document: JSONContent) {
  const read = (node: JSONContent): string => {
    if (node.type === "text") {
      return node.text ?? "";
    }
    if (node.type === "hardBreak") {
      return "\n";
    }

    const children = node.content ?? [];
    if (["paragraph", "heading", "codeBlock", "toggleSummary"].includes(node.type ?? "")) {
      return children.map(read).join("");
    }
    if (node.type === "tableRow") {
      return children.map(read).join("\n");
    }

    return children.map(read).join("\n");
  };

  return read(document).trimEnd();
}

export function hasRichTextFormatting(document: JSONContent) {
  const visit = (node: JSONContent): boolean => {
    if (node.marks?.length) {
      return true;
    }
    if (node.type && !["doc", "paragraph", "text", "hardBreak"].includes(node.type)) {
      return true;
    }
    return node.content?.some(visit) ?? false;
  };

  return visit(document);
}
