import { Editor as TiptapEditor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";

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
    <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5"/>
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
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
  onOpenSettings: () => void;
}

export default function Toolbar({
  editor,
  activeTitle,
  activeTabId,
  isTitleManual,
  onChangeTitle,
  onOpenSettings
}: ToolbarProps) {
  const { t } = useI18n();
  const [titleInput, setTitleInput] = useState(activeTitle);
  const [listMenuKey, setListMenuKey] = useState(0);
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

  const insertLink = () => {
    if (!editor) {
      return;
    }

    const previousUrl = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt(t("toolbar.linkPrompt"), previousUrl ?? "https://");

    if (url === null) {
      return;
    }

    if (!url.trim()) {
      editor.chain().focus().unsetLink().run();
      return;
    }

    editor.chain().focus().setLink({ href: url.trim() }).run();
  };

  const insertTable = () => {
    if (!editor) {
      return;
    }

    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
  };

  const isToggleBlockActive = editor?.isActive("toggleBlock") ?? false;

  return (
    <div className="toolbar">
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
          aria-label={t("toolbar.link")}
          title={t("toolbar.link")}
          onClick={insertLink}
        >
          {LinkIcon}
        </button>
        <button
          type="button"
          aria-label={t("toolbar.table")}
          title={t("toolbar.table")}
          onClick={insertTable}
        >
          {TableIcon}
        </button>
      </div>

      <div className="toolbar-right no-drag">
        <div className="toolbar-title-field">
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
                return;
              }

              if (event.key === "Escape") {
                event.preventDefault();
                setTitleInput(activeTitle);
              }
            }}
          />
          {isTitleManual ? (
            <button
              type="button"
              className="toolbar-title-reset"
              aria-label={t("common.untitled")}
              onClick={() => {
                setTitleInput("");
                onChangeTitle("");
              }}
              title={t("common.untitled")}
            >
              {CloseIcon}
            </button>
          ) : null}
        </div>
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
