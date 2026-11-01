import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/context";
import { isImeComposing } from "../lib/ime";

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
    const isInsidePopup = (target: EventTarget | null) =>
      target instanceof Node && Boolean(popupRef.current?.contains(target));

    const close = () => {
      // React may render a close started by scroll after the next animation
      // frame, where the editor checks whether focus was lost. Drop focus held
      // inside the popup now so it does not count as another control's focus.
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && isInsidePopup(activeElement)) {
        activeElement.blur();
      }
      onClose();
    };

    const handleMouseDown = (e: MouseEvent) => {
      if (isInsidePopup(e.target)) {
        return;
      }
      close();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isImeComposing(e) && e.key === "Escape") close();
    };

    // A URL field fires scroll when a long value scrolls inside it.
    const handleScroll = (e: Event) => {
      if (isInsidePopup(e.target)) {
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
            if (isImeComposing(e.nativeEvent)) return;
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
            if (isImeComposing(e.nativeEvent)) return;
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
