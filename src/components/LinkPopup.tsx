import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/context";

interface LinkPopupProps {
  anchor: { x: number; y: number };
  initialUrl: string;
  initialName: string;
  onConfirm: (url: string, displayName: string) => void;
  onClose: () => void;
}

const POPUP_WIDTH = 280;
const POPUP_HEIGHT = 160;

export default function LinkPopup({
  anchor,
  initialUrl,
  initialName,
  onConfirm,
  onClose
}: LinkPopupProps) {
  const { t } = useI18n();
  const popupRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [displayName, setDisplayName] = useState(initialName);

  useEffect(() => {
    urlRef.current?.focus();
    urlRef.current?.select();
  }, []);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (popupRef.current && popupRef.current.contains(e.target as Node)) {
        return;
      }
      onClose();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    const close = () => onClose();

    window.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const handleConfirm = () => {
    const trimmed = url.trim();
    onConfirm(trimmed, displayName.trim());
  };

  const left = Math.min(anchor.x, window.innerWidth - POPUP_WIDTH - 8);
  const top = Math.min(anchor.y + 4, window.innerHeight - POPUP_HEIGHT - 8);

  return createPortal(
    <div
      ref={popupRef}
      className="link-popup"
      style={{ left: `${left}px`, top: `${top}px` }}
    >
      <div className="link-popup-field">
        <label>{t("toolbar.linkUrl")}</label>
        <input
          ref={urlRef}
          type="url"
          value={url}
          placeholder="https://"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleConfirm();
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
            if (e.key === "Enter") {
              e.preventDefault();
              handleConfirm();
            }
          }}
        />
      </div>
      <div className="link-popup-actions">
        <button
          type="button"
          className="link-popup-cancel"
          onClick={onClose}
        >
          {t("toolbar.linkCancel")}
        </button>
        <button
          type="button"
          className="link-popup-confirm"
          onClick={handleConfirm}
        >
          {t("toolbar.linkConfirm")}
        </button>
      </div>
    </div>,
    document.body
  );
}
