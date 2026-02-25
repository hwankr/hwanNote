import { getMarkRange } from "@tiptap/core";
import { Editor as TiptapEditor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/context";
import { restoreEditorFocus } from "./Editor";
import LinkPopup from "./LinkPopup";
import TableSizePopup from "./TableSizePopup";

const BoldIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 2.5h5a2.5 2.5 0 010 5H4V2.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    <path d="M4 7.5h5.5a2.5 2.5 0 010 5H4V7.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    <path d="M4 2.5v11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

const ItalicIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 2.5L6 13.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M5 2.5h6M5 13.5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

const ToggleIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M11 6h1M11 8h1M11 10h1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

const LinkIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6.5 9.5a3 3 0 004.24 0l2-2a3 3 0 00-4.24-4.24l-1 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M9.5 6.5a3 3 0 00-4.24 0l-2 2a3 3 0 004.24 4.24l1-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

const TableIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M2 6h12M2 10h12M6 2v12M10 2v12" stroke="currentColor" strokeWidth="1"/>
  </svg>
);

const SettingsIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6.5 2.2L9.5 2.2L9 4.1L10.8 5.2L12.2 3.8L13.8 6.5L11.9 7L11.9 9L13.8 9.5L12.2 12.2L10.8 10.8L9 11.9L9.5 13.8L6.5 13.8L7 11.9L5.2 10.8L3.8 12.2L2.2 9.5L4.1 9L4.1 7L2.2 6.5L3.8 3.8L5.2 5.2L7 4.1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5"/>
  </svg>
);

const ImportIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 2v8M8 10l-3-3M8 10l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

const CloseIcon = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

interface ToolbarProps {
  editor: TiptapEditor | null;
  activeTitle: string;
  activeTabId: string;
  isTitleManual: boolean;
  onChangeTitle: (title: string) => void;
  lastSavedAt: number;
  onOpenSettings: () => void;
  onImportTxt: () => void;
}

export default function Toolbar({
  editor,
  activeTitle,
  activeTabId,
  isTitleManual,
  onChangeTitle,
  lastSavedAt,
  onOpenSettings,
  onImportTxt
}: ToolbarProps) {
  const { t, localeTag } = useI18n();
  const [titleInput, setTitleInput] = useState(activeTitle);
  const [listMenuKey, setListMenuKey] = useState(0);
  const [tablePopupAnchor, setTablePopupAnchor] = useState<{ x: number; y: number } | null>(null);
  const [linkPopupAnchor, setLinkPopupAnchor] = useState<{ x: number; y: number } | null>(null);
  const [linkContext, setLinkContext] = useState<{ url: string; name: string; from: number; to: number }>({ url: "https://", name: "", from: 0, to: 0 });
  const tableButtonRef = useRef<HTMLButtonElement>(null);
  const linkButtonRef = useRef<HTMLButtonElement>(null);
  const closeTablePopup = useCallback(() => {
    setTablePopupAnchor(null);
    restoreEditorFocus(editor);
  }, [editor]);
  const closeLinkPopup = useCallback(() => {
    setLinkPopupAnchor(null);
    restoreEditorFocus(editor);
  }, [editor]);
  const normalizeTitle = (value: string) => value.trim().slice(0, 50);

  useEffect(() => {
    setTitleInput(activeTitle);
  }, [activeTitle, activeTabId]);

  const commitTitle = () => {
    if (normalizeTitle(titleInput) === normalizeTitle(activeTitle)) {
      return;
    }
    onChangeTitle(titleInput);
  };

  const setHeading = (value: string) => {
    if (!editor) {
      return;
    }

    if (value === "paragraph") {
      editor.chain().focus().setParagraph().run();
      return;
    }

    const level = Number(value) as 1 | 2 | 3;
    editor.chain().focus().toggleHeading({ level }).run();
  };

  const setList = (value: string) => {
    if (!editor) {
      return;
    }

    switch (value) {
      case "bullet":
        editor.chain().focus().toggleBulletList().run();
        break;
      case "ordered":
        editor.chain().focus().toggleOrderedList().run();
        break;
      case "task":
        editor.chain().focus().toggleTaskList().run();
        break;
      case "toggle":
        editor.chain().focus().insertToggleBlock().run();
        break;
      default:
        break;
    }
  };

  const insertToggleBlock = () => {
    if (!editor) {
      return;
    }

    editor.chain().focus().insertToggleBlock().run();
  };

  const toggleLinkPopup = () => {
    if (linkPopupAnchor) {
      setLinkPopupAnchor(null);
      return;
    }
    if (!editor) return;

    let { from, to } = editor.state.selection;
    const previousUrl = editor.getAttributes("link").href as string | undefined;

    let name = "";
    if (from !== to) {
      name = editor.state.doc.textBetween(from, to);
    } else if (previousUrl) {
      const $from = editor.state.doc.resolve(from);
      const linkType = editor.schema.marks.link;
      const range = linkType ? getMarkRange($from, linkType) : undefined;
      if (range) {
        name = editor.state.doc.textBetween(range.from, range.to);
        from = range.from;
        to = range.to;
      }
    }

    const rect = linkButtonRef.current?.getBoundingClientRect();
    if (rect) {
      setLinkContext({ url: previousUrl ?? "https://", name, from, to });
      setLinkPopupAnchor({ x: rect.left, y: rect.bottom });
    }
  };

  const handleLinkConfirm = useCallback((url: string, displayName: string) => {
    if (!editor) {
      setLinkPopupAnchor(null);
      return;
    }

    if (!url) {
      editor.chain().focus().setTextSelection({ from: linkContext.from, to: linkContext.to }).unsetLink().run();
      setLinkPopupAnchor(null);
      return;
    }

    const textToInsert = displayName || url;
    const { from, to } = linkContext;

    if (from === to) {
      editor.chain().focus().setTextSelection(from).insertContent({
        type: "text",
        text: textToInsert,
        marks: [{ type: "link", attrs: { href: url } }]
      }).run();
    } else {
      const selectedText = editor.state.doc.textBetween(from, to);
      if (selectedText === textToInsert) {
        editor.chain().focus().setTextSelection({ from, to }).setLink({ href: url }).run();
      } else {
        editor.chain().focus().setTextSelection({ from, to }).deleteSelection().insertContent({
          type: "text",
          text: textToInsert,
          marks: [{ type: "link", attrs: { href: url } }]
        }).run();
      }
    }

    setLinkPopupAnchor(null);
  }, [editor, linkContext]);

  const toggleTablePopup = () => {
    if (tablePopupAnchor) {
      setTablePopupAnchor(null);
      return;
    }
    const rect = tableButtonRef.current?.getBoundingClientRect();
    if (rect) {
      setTablePopupAnchor({ x: rect.left, y: rect.bottom });
    }
  };

  const handleTableSelect = (rows: number, cols: number) => {
    if (!editor) {
      return;
    }
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    setTablePopupAnchor(null);
  };

  const isToggleBlockActive = editor?.isActive("toggleBlock") ?? false;

  return (
    <div className="toolbar">
      <div className="toolbar-title-field no-drag">
        <input
          type="text"
          value={titleInput}
          placeholder={t("common.untitled")}
          aria-label="Note title"
          onChange={(event) => setTitleInput(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitTitle();
              editor?.commands.focus();
              return;
            }

            if (event.key === "Escape") {
              event.preventDefault();
              setTitleInput(activeTitle);
              editor?.commands.focus();
            }
          }}
        />
      </div>

      <div className="toolbar-format no-drag">
        <select
          className="toolbar-select"
          aria-label={t("toolbar.headingAria")}
          defaultValue="paragraph"
          onChange={(event) => setHeading(event.target.value)}
        >
          <option value="paragraph">{t("toolbar.paragraph")}</option>
          <option value="1">H1</option>
          <option value="2">H2</option>
          <option value="3">H3</option>
        </select>

        <select
          className="toolbar-select"
          key={listMenuKey}
          aria-label={t("toolbar.listAria")}
          defaultValue=""
          onChange={(event) => {
            setList(event.target.value);
            setListMenuKey((prev) => prev + 1);
          }}
        >
          <option value="">{t("toolbar.listDefault")}</option>
          <option value="bullet">{t("toolbar.listBullet")}</option>
          <option value="ordered">{t("toolbar.listOrdered")}</option>
          <option value="task">{t("toolbar.listTask")}</option>
          <option value="toggle">{t("toolbar.listToggle")}</option>
        </select>

        <span className="toolbar-separator" />

        <button
          type="button"
          aria-label="Bold"
          title="Bold"
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          {BoldIcon}
        </button>
        <button
          type="button"
          aria-label="Italic"
          title="Italic"
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          {ItalicIcon}
        </button>

        <span className="toolbar-separator" />

        <button
          type="button"
          className={isToggleBlockActive ? "is-active" : undefined}
          aria-label={t("toolbar.listToggle")}
          title={t("toolbar.listToggle")}
          onClick={insertToggleBlock}
        >
          {ToggleIcon}
        </button>
        <button
          type="button"
          ref={linkButtonRef}
          aria-label={t("toolbar.link")}
          title={t("toolbar.link")}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={toggleLinkPopup}
        >
          {LinkIcon}
        </button>
        <button
          type="button"
          ref={tableButtonRef}
          aria-label={t("toolbar.table")}
          title={t("toolbar.table")}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={toggleTablePopup}
        >
          {TableIcon}
        </button>
      </div>

      {tablePopupAnchor && (
        <TableSizePopup
          anchor={tablePopupAnchor}
          onSelect={handleTableSelect}
          onClose={closeTablePopup}
        />
      )}

      {linkPopupAnchor && (
        <LinkPopup
          anchor={linkPopupAnchor}
          initialUrl={linkContext.url}
          initialName={linkContext.name}
          onConfirm={handleLinkConfirm}
          onClose={closeLinkPopup}
        />
      )}

      <div className="toolbar-right no-drag">
        {lastSavedAt > 0 && (
          <span className="toolbar-save-time">
            {t("toolbar.savedAt", {
              time: new Intl.DateTimeFormat(localeTag, {
                hour: "2-digit",
                minute: "2-digit"
              }).format(new Date(lastSavedAt))
            })}
          </span>
        )}
        <button
          type="button"
          aria-label={t("toolbar.importTxt")}
          title={t("toolbar.importTxt")}
          onClick={onImportTxt}
        >
          {ImportIcon}
        </button>
        <button
          type="button"
          aria-label={t("toolbar.openSettings")}
          title={t("toolbar.settings")}
          onClick={onOpenSettings}
        >
          {SettingsIcon}
        </button>
      </div>
    </div>
  );
}
