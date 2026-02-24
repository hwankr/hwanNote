import Bold from "@tiptap/extension-bold";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import { TaskItemExtended } from "../extensions/taskItemExtended";
import TaskList from "@tiptap/extension-task-list";
import Italic from "@tiptap/extension-italic";
import StarterKit from "@tiptap/starter-kit";
import { Editor as TiptapEditor, EditorContent, useEditor } from "@tiptap/react";
import { type MouseEvent as ReactMouseEvent, useCallback, useEffect } from "react";
import { TabIndent } from "../extensions/tabIndent";
import { ToggleBlock, ToggleContent, ToggleSummary } from "../extensions/toggleBlock";
import { useI18n } from "../i18n/context";

interface EditorProps {
  content: string;
  tabSize: number;
  onChange: (content: string, plainText: string) => void;
  onCursorChange: (line: number, column: number, chars: number) => void;
  onEditorReady: (editor: TiptapEditor | null) => void;
}

function collectPlainText(editor: TiptapEditor) {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n");
}

function collectCursor(editor: TiptapEditor, existingPlainText?: string) {
  const plainText = existingPlainText ?? collectPlainText(editor);
  const cursorPos = editor.state.selection.from;
  const textBeforeCursor = editor.state.doc.textBetween(0, cursorPos, "\n", "\0");
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

export default function Editor({ content, tabSize, onChange, onCursorChange, onEditorReady }: EditorProps) {
  const { t } = useI18n();
  const placeholderText = t("editor.placeholder");
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        bold: false,
        heading: {
          levels: [1, 2, 3]
        },
        italic: false
      }),
      BoldWithoutShortcut,
      ItalicWithoutShortcut,
      TaskList,
      TaskItemExtended.configure({
        nested: true
      }),
      ToggleBlock,
      ToggleSummary,
      ToggleContent,
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true
      }),
      Table.configure({
        resizable: true
      }),
      TableRow,
      TableHeader,
      TableCell,
      Placeholder.configure({
        placeholder: placeholderText
      }),
      TabIndent.configure({
        tabSize
      })
    ],
    content,
    autofocus: "end",
    editorProps: {
      attributes: {
        class: "note-editor"
      }
    },
    onUpdate: ({ editor }) => {
      const plainText = collectPlainText(editor);
      const cursor = collectCursor(editor, plainText);
      onChange(editor.getHTML(), plainText);
      onCursorChange(cursor.line, cursor.column, cursor.chars);
    },
    onSelectionUpdate: ({ editor }) => {
      const cursor = collectCursor(editor);
      onCursorChange(cursor.line, cursor.column, cursor.chars);
    }
  }, [placeholderText]);

  useEffect(() => {
    onEditorReady(editor);
    return () => {
      onEditorReady(null);
    };
  }, [editor, onEditorReady]);

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

    if (editor.getHTML() !== content) {
      editor.commands.setContent(content, false);
      const cursor = collectCursor(editor);
      onCursorChange(cursor.line, cursor.column, cursor.chars);
    }
  }, [content, editor, onCursorChange]);

  const handleShellMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!editor) {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement | null;
    if (target?.closest(".note-editor")) {
      return;
    }

    editor.chain().focus("end").run();
  }, [editor]);

  return (
    <section className="editor-shell" onMouseDown={handleShellMouseDown}>
      <EditorContent className="editor-content" editor={editor} />
    </section>
  );
}

