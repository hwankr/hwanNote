import { hwanShell } from "../lib/tauriApi";
import Bold from "@tiptap/extension-bold";
import Placeholder from "@tiptap/extension-placeholder";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import { MarkdownTableCell, MarkdownTableHeader } from "../extensions/markdownTable";
import { TaskItemExtended } from "../extensions/taskItemExtended";
import TaskList from "@tiptap/extension-task-list";
import Italic from "@tiptap/extension-italic";
import { UndoRedo } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import { createDocument, getMarkRange, type JSONContent } from "@tiptap/core";
import { Editor as TiptapEditor, EditorContent, useEditor } from "@tiptap/react";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TabIndent } from "../extensions/tabIndent";
import { LinkWithTitle } from "../extensions/linkWithTitle";
import { ToggleBlock, ToggleContent, ToggleSummary } from "../extensions/toggleBlock";
import { useI18n } from "../i18n/context";
import { cancelEditorFocusRequestFor, requestEditorFocus } from "../lib/editorFocusRestore";
import LinkBubble from "./LinkBubble";

interface EditorProps {
  content: JSONContent;
  tabSize: number;
  spellcheck: boolean;
  autofocus?: boolean;
  onChange: (content: JSONContent, plainText: string) => void;
  onCursorChange: (line: number, column: number, chars: number) => void;
  onEditorReady: (editor: TiptapEditor | null) => void;
  onFocus?: () => void;
}

export function collectPlainText(editor: TiptapEditor) {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n", (node) =>
    node.type.name === "hardBreak" ? "\n" : ""
  );
}

function collectCursor(editor: TiptapEditor, existingPlainText?: string) {
  const plainText = existingPlainText ?? collectPlainText(editor);
  const cursorPos = editor.state.selection.from;
  const textBeforeCursor = editor.state.doc.textBetween(0, cursorPos, "\n", (node) =>
    node.type.name === "hardBreak" ? "\n" : "\0"
  );
  const lines = textBeforeCursor.split("\n");
  const line = lines.length;
  const lastLine = lines[lines.length - 1] ?? "";
  const column = lastLine.length + 1;

  return {
    line,
    column,
    chars: plainText.length
  };
}

const BoldWithoutShortcut = Bold.extend({
  addKeyboardShortcuts() {
    return {};
  }
});

const ItalicWithoutShortcut = Italic.extend({
  addKeyboardShortcuts() {
    return {};
  }
});

const HistoryWithInputRuleUndo = UndoRedo.extend({
  addKeyboardShortcuts() {
    return {
      "Mod-z": () =>
        this.editor.commands.undoInputRule() ||
        this.editor.commands.undo(),
      "Shift-Mod-z": () => this.editor.commands.redo(),
      "Mod-y": () => this.editor.commands.redo(),
      "Mod-\u044f": () =>
        this.editor.commands.undoInputRule() ||
        this.editor.commands.undo(),
      "Shift-Mod-\u044f": () => this.editor.commands.redo(),
    };
  },
});

interface LinkBubbleState {
  anchor: { x: number; y: number };
  href: string;
  from: number;
  to: number;
}

// Keep one editor instance for the component's lifetime. A changing value
// would make @tiptap/react destroy and recreate the editor (losing its DOM,
// selection, undo history and focus), and an empty list would make it call
// setOptions on every render.
const EDITOR_INSTANCE_DEPS = ["editor"] as const;

// Gives focus back to the editor after a popup or panel closes. The check runs
// in the next frame, and again after the window becomes active if it is
// inactive then (see editorFocusRestore.ts).
export function restoreEditorFocus(editor: TiptapEditor | null) {
  if (!editor || editor.isDestroyed) return;
  requestEditorFocus(editor, {
    start: "frame",
    permission: () => {
      const { view } = editor;
      const editorDOM = view.dom;
      // Only take focus back when the closed UI dropped it on the page. A click
      // that closed it may have focused another field, button or editor.
      const ownerDocument = editorDOM.ownerDocument;
      const activeElement = ownerDocument.activeElement;
      if (activeElement && activeElement !== ownerDocument.body && !editorDOM.contains(activeElement)) {
        return "deny";
      }
      return view.hasFocus() ? "already-focused" : "allow";
    },
    // The module focuses in the frame that checked. editor.commands.focus()
    // would wait one more frame, where focus the user has moved since would be
    // taken back. Like that command, keep the selection and scroll the cursor
    // into view, only when focus was actually restored.
    onFocused: () => {
      editor.commands.scrollIntoView();
    },
  });
}

export default function Editor({
  content,
  tabSize,
  spellcheck,
  autofocus = true,
  onChange,
  onCursorChange,
  onEditorReady,
  onFocus
}: EditorProps) {
  const { t } = useI18n();
  const placeholderText = t("editor.placeholder");
  const placeholderTextRef = useRef(placeholderText);
  placeholderTextRef.current = placeholderText;
  const appliedPlaceholderTextRef = useRef(placeholderText);
  const [linkBubble, setLinkBubble] = useState<LinkBubbleState | null>(null);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;

  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;

  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;

  const initialAutofocusRef = useRef(autofocus);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        bold: false,
        heading: {
          levels: [1, 2, 3, 4, 5, 6]
        },
        italic: false,
        undoRedo: false,
        link: false,
        underline: false,
        trailingNode: false
      }),
      HistoryWithInputRuleUndo,
      BoldWithoutShortcut,
      ItalicWithoutShortcut,
      TaskList,
      TaskItemExtended.configure({
        nested: true
      }),
      ToggleBlock,
      ToggleSummary,
      ToggleContent,
      LinkWithTitle.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true
      }),
      Table.configure({
        resizable: true
      }),
      TableRow,
      MarkdownTableHeader,
      MarkdownTableCell,
      Placeholder.configure({
        placeholder: () => placeholderTextRef.current
      }),
      TabIndent.configure({
        tabSize
      })
    ],
    coreExtensionOptions: {
      clipboardTextSerializer: {
        blockSeparator: "\n"
      }
    },
    content,
    shouldRerenderOnTransaction: true,
    autofocus: initialAutofocusRef.current ? "end" : false,
    editorProps: {
      attributes: {
        class: "note-editor",
        spellcheck: spellcheck ? "true" : "false"
      }
    },
    onUpdate: ({ editor }) => {
      const plainText = collectPlainText(editor);
      const cursor = collectCursor(editor, plainText);
      onChangeRef.current(editor.getJSON(), plainText);
      onCursorChangeRef.current(cursor.line, cursor.column, cursor.chars);
    },
    onSelectionUpdate: ({ editor }) => {
      const cursor = collectCursor(editor);
      onCursorChangeRef.current(cursor.line, cursor.column, cursor.chars);
    },
    onFocus: () => {
      onFocusRef.current?.();
    }
  }, EDITOR_INSTANCE_DEPS);

  const closeLinkBubble = useCallback(() => {
    setLinkBubble(null);
    restoreEditorFocus(editor);
  }, [editor]);

  const handleLinkEditCancel = useCallback(() => {
    restoreEditorFocus(editor);
  }, [editor]);

  useEffect(() => {
    onEditorReadyRef.current(editor);
    return () => {
      onEditorReadyRef.current(null);
    };
  }, [editor]);

  // A focus restore that still waits for this editor ends when the editor
  // unmounts, in the same commit; @tiptap/react destroys it only later. A
  // closing popup does not unmount the editor and keeps its restore. Only this
  // instance's request is dropped, never one for another editor.
  useLayoutEffect(() => {
    if (!editor) return;
    return () => {
      cancelEditorFocusRequestFor(editor);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const tabIndentExt = editor.extensionManager.extensions.find((ext) => ext.name === "tabIndent");
    if (tabIndentExt) {
      tabIndentExt.options.tabSize = tabSize;
    }
  }, [editor, tabSize]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    editor.view.dom.setAttribute("spellcheck", spellcheck ? "true" : "false");
  }, [editor, spellcheck]);

  useEffect(() => {
    if (!editor || editor.isDestroyed || appliedPlaceholderTextRef.current === placeholderText) {
      return;
    }

    appliedPlaceholderTextRef.current = placeholderText;
    // Placeholder decorations are rebuilt on each view update. An empty
    // transaction redraws them in the new language without changing the
    // document, selection or undo history.
    editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
  }, [editor, placeholderText]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    // Reloaded JSON can omit default attributes or use a different property
    // order. Replacing an equivalent document resets the user's selection.
    const incomingDocument = createDocument(content, editor.schema);
    if (!editor.state.doc.eq(incomingDocument)) {
      editor.commands.setContent(incomingDocument, { emitUpdate: false });
      const cursor = collectCursor(editor);
      onCursorChangeRef.current(cursor.line, cursor.column, cursor.chars);
    }
  }, [content, editor]);

  const handleShellMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!editor) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    // React also delivers events from the link bubble, which is portaled to
    // the page body. Only presses on the shell itself are empty-area clicks.
    if (!event.currentTarget.contains(event.target as Node)) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest(".note-editor")) {
      return;
    }

    editor.chain().focus().run();
  }, [editor]);

  const handleEditorClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!editor) return;

    const target = event.target as HTMLElement;
    const linkEl = target.closest("a");

    if (!linkEl) {
      setLinkBubble(null);
      return;
    }

    const href = linkEl.getAttribute("href");
    if (!href) return;

    // Ctrl+click (or Cmd+click on Mac) -> open in browser
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      hwanShell.openExternal(href);
      return;
    }

    // Normal click -> show bubble tooltip
    event.preventDefault();
    const rect = linkEl.getBoundingClientRect();

    // Find the link mark range in the document
    const rawPos = editor.view.posAtDOM(linkEl, 0);
    const pos = Math.max(0, Math.min(rawPos, editor.state.doc.content.size));
    const $pos = editor.state.doc.resolve(pos);
    const linkType = editor.schema.marks.link;
    const range = linkType ? getMarkRange($pos, linkType) : undefined;

    if (range) {
      setLinkBubble({
        anchor: { x: rect.left, y: rect.bottom },
        href,
        from: range.from,
        to: range.to
      });
    }
  }, [editor]);

  return (
    <section className="editor-shell" onMouseDown={handleShellMouseDown}>
      <EditorContent className="editor-content" editor={editor} onClick={handleEditorClick} />
      {linkBubble && editor && (
        <LinkBubble
          editor={editor}
          anchor={linkBubble.anchor}
          href={linkBubble.href}
          linkFrom={linkBubble.from}
          linkTo={linkBubble.to}
          onClose={closeLinkBubble}
          onEditCancel={handleLinkEditCancel}
        />
      )}
    </section>
  );
}
