import { Editor as TiptapEditor } from "@tiptap/react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/context";

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
      default:
        break;
    }
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

  return (
    <div className="toolbar">
      <div className="toolbar-left no-drag">
        <button type="button">{t("toolbar.file")}</button>
        <button type="button">{t("toolbar.edit")}</button>
        <button type="button">{t("toolbar.view")}</button>
      </div>

      <div className="toolbar-center no-drag">
        <select
          aria-label={t("toolbar.headingAria")}
          defaultValue="paragraph"
          onChange={(event) => setHeading(event.target.value)}
        >
          <option value="paragraph">{t("toolbar.paragraph")}</option>
          <option value="1">H1</option>
          <option value="2">H2</option>
          <option value="3">H3</option>
        </select>

        <select aria-label={t("toolbar.listAria")} defaultValue="" onChange={(event) => setList(event.target.value)}>
          <option value="">{t("toolbar.listDefault")}</option>
          <option value="bullet">{t("toolbar.listBullet")}</option>
          <option value="ordered">{t("toolbar.listOrdered")}</option>
          <option value="task">{t("toolbar.listTask")}</option>
        </select>

        <button type="button" onClick={() => editor?.chain().focus().toggleBold().run()}>
          B
        </button>
        <button type="button" onClick={() => editor?.chain().focus().toggleItalic().run()}>
          I
        </button>
        <button type="button" onClick={insertLink}>
          {t("toolbar.link")}
        </button>
        <button type="button" onClick={insertTable}>
          {t("toolbar.table")}
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
              onClick={() => {
                setTitleInput("");
                onChangeTitle("");
              }}
              title={t("common.untitled")}
            >
              x
            </button>
          ) : null}
        </div>
        <button type="button" onClick={onOpenSettings} aria-label={t("toolbar.openSettings")}>
          {t("toolbar.settings")}
        </button>
      </div>
    </div>
  );
}
