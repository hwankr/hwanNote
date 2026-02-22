import { Editor as TiptapEditor } from "@tiptap/react";

interface ToolbarProps {
  editor: TiptapEditor | null;
  onOpenSettings: () => void;
}

export default function Toolbar({ editor, onOpenSettings }: ToolbarProps) {
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
    const url = window.prompt("링크 주소를 입력하세요.", previousUrl ?? "https://");

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
        <button type="button">파일(F)</button>
        <button type="button">편집(E)</button>
        <button type="button">보기(V)</button>
      </div>

      <div className="toolbar-center no-drag">
        <select aria-label="Heading" defaultValue="paragraph" onChange={(event) => setHeading(event.target.value)}>
          <option value="paragraph">본문</option>
          <option value="1">H1</option>
          <option value="2">H2</option>
          <option value="3">H3</option>
        </select>

        <select aria-label="List type" defaultValue="" onChange={(event) => setList(event.target.value)}>
          <option value="">목록</option>
          <option value="bullet">글머리 기호</option>
          <option value="ordered">번호 매기기</option>
          <option value="task">체크리스트</option>
        </select>

        <button type="button" onClick={() => editor?.chain().focus().toggleBold().run()}>
          B
        </button>
        <button type="button" onClick={() => editor?.chain().focus().toggleItalic().run()}>
          I
        </button>
        <button type="button" onClick={insertLink}>
          링크
        </button>
        <button type="button" onClick={insertTable}>
          표
        </button>
      </div>

      <div className="toolbar-right no-drag">
        <button type="button" onClick={onOpenSettings} aria-label="설정 열기">
          설정
        </button>
      </div>
    </div>
  );
}
