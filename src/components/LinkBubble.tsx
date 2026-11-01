import { hwanShell } from "../lib/tauriApi";
import { getMarkRange } from "@tiptap/core";
import { Editor as TiptapEditor } from "@tiptap/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/context";
import { isImeComposing } from "../lib/ime";

interface LinkBubbleProps {
  editor: TiptapEditor;
  anchor: { x: number; y: number };
  href: string;
  linkFrom: number;
  linkTo: number;
  onClose: () => void;
  onEditCancel: () => void;
}

const BUBBLE_WIDTH = 320;
const BUBBLE_HEIGHT = 44;
const BUBBLE_EDIT_HEIGHT = 180;

const OpenIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M7 3H4a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M10 2h4v4M14 2L8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const EditIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
  </svg>
);

const UnlinkIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6.5 9.5a3 3 0 004.24 0l2-2a3 3 0 00-4.24-4.24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M9.5 6.5a3 3 0 00-4.24 0l-2 2a3 3 0 004.24 4.24" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    <path d="M3 3l10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

export default function LinkBubble({
  editor,
  anchor,
  href,
  linkFrom,
  linkTo,
  onClose,
  onEditCancel
}: LinkBubbleProps) {
  const { t } = useI18n();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(href);
  const [displayName, setDisplayName] = useState("");
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const text = editor.state.doc.textBetween(linkFrom, linkTo);
    setDisplayName(text);
  }, [editor, linkFrom, linkTo]);

  useEffect(() => {
    if (editing) {
      urlInputRef.current?.focus();
      urlInputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    const isInsideBubble = (target: EventTarget | null) =>
      target instanceof Node && Boolean(bubbleRef.current?.contains(target));

    const close = () => {
      // React may render a close started by scroll after the next animation
      // frame, where the editor checks whether focus was lost. Drop focus held
      // inside the bubble now so it does not count as another control's focus.
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && isInsideBubble(activeElement)) {
        activeElement.blur();
      }
      onClose();
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (isInsideBubble(e.target)) {
        return;
      }
      close();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isImeComposing(e) && e.key === "Escape") close();
    };

    // A URL field fires scroll when a long value scrolls inside it.
    const handleScroll = (e: Event) => {
      if (isInsideBubble(e.target)) {
        return;
      }
      close();
    };

    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    onEditCancel();
  }, [onEditCancel]);

  const openExternal = useCallback(() => {
    hwanShell.openExternal(href);
    onClose();
  }, [href, onClose]);

  const removeLink = useCallback(() => {
    editor.chain().focus().setTextSelection({ from: linkFrom, to: linkTo }).unsetLink().run();
    onClose();
  }, [editor, linkFrom, linkTo, onClose]);

  const handleEditConfirm = useCallback(() => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      removeLink();
      return;
    }

    const textToInsert = displayName.trim() || trimmedUrl;
    const currentText = editor.state.doc.textBetween(linkFrom, linkTo);

    if (currentText === textToInsert) {
      editor.chain().focus().setTextSelection({ from: linkFrom, to: linkTo }).setLink({ href: trimmedUrl }).run();
    } else {
      editor.chain().focus().setTextSelection({ from: linkFrom, to: linkTo }).deleteSelection().insertContent({
        type: "text",
        text: textToInsert,
        marks: [{ type: "link", attrs: { href: trimmedUrl } }]
      }).run();
    }

    onClose();
  }, [editor, url, displayName, linkFrom, linkTo, removeLink, onClose]);

  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - BUBBLE_WIDTH - 8));
  const top = Math.min(anchor.y + 4, window.innerHeight - (editing ? BUBBLE_EDIT_HEIGHT : BUBBLE_HEIGHT) - 8);

  if (editing) {
    return createPortal(
      <div
        ref={bubbleRef}
        className="link-bubble link-bubble-edit"
        style={{ left: `${left}px`, top: `${top}px` }}
      >
        <div className="link-popup-field">
          <label>{t("toolbar.linkUrl")}</label>
          <input
            ref={urlInputRef}
            type="url"
            value={url}
            placeholder="https://"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e.nativeEvent)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                handleEditConfirm();
              }
            }}
          />
        </div>
        <div className="link-popup-field">
          <label>{t("toolbar.linkDisplayName")}</label>
          <input
            type="text"
            value={displayName}
            placeholder={t("toolbar.linkDisplayNamePlaceholder")}
            onChange={(e) => setDisplayName(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e.nativeEvent)) return;
              if (e.key === "Enter") {
                e.preventDefault();
                handleEditConfirm();
              }
            }}
          />
        </div>
        <div className="link-popup-actions">
          <button type="button" className="link-popup-cancel" onClick={cancelEdit}>
            {t("toolbar.linkCancel")}
          </button>
          <button type="button" className="link-popup-confirm" onClick={handleEditConfirm}>
            {t("toolbar.linkConfirm")}
          </button>
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={bubbleRef}
      className="link-bubble"
      style={{ left: `${left}px`, top: `${top}px` }}
    >
      <span className="link-bubble-url" title={href}>{href}</span>
      <div className="link-bubble-actions">
        <button type="button" title={t("linkBubble.open")} onClick={openExternal}>
          {OpenIcon}
        </button>
        <button type="button" title={t("linkBubble.edit")} onClick={() => setEditing(true)}>
          {EditIcon}
        </button>
        <button type="button" title={t("linkBubble.remove")} onClick={removeLink}>
          {UnlinkIcon}
        </button>
      </div>
    </div>,
    document.body
  );
}
