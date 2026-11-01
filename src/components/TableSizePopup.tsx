import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/context";
import { isImeComposing } from "../lib/ime";

interface TableSizePopupProps {
  anchor: { x: number; y: number };
  onSelect: (rows: number, cols: number) => void;
  onClose: () => void;
}

const GRID_SIZE = 10;
const CELL_SIZE = 20;
const CELL_GAP = 2;
const POPUP_PADDING = 10;
const POPUP_WIDTH = GRID_SIZE * (CELL_SIZE + CELL_GAP) - CELL_GAP + POPUP_PADDING * 2;

export default function TableSizePopup({ anchor, onSelect, onClose }: TableSizePopupProps) {
  const { t } = useI18n();
  const popupRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<{ row: number; col: number } | null>(null);

  useEffect(() => {
    const isInsidePopup = (target: EventTarget | null) =>
      target instanceof Node && Boolean(popupRef.current?.contains(target));

    const handleMouseDown = (e: MouseEvent) => {
      if (isInsidePopup(e.target)) {
        return;
      }
      onClose();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isImeComposing(e) && e.key === "Escape") onClose();
    };

    // Like the other editor popups, only scrolling outside the popup closes it.
    const handleScroll = (e: Event) => {
      if (isInsidePopup(e.target)) {
        return;
      }
      onClose();
    };

    const close = () => onClose();

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

  const left = Math.min(anchor.x, window.innerWidth - POPUP_WIDTH - 8);

  return createPortal(
    <div
      ref={popupRef}
      className="table-size-popup"
      style={{ left: `${left}px`, top: `${anchor.y + 4}px` }}
    >
      <div className="table-size-label">
        {hovered ? `${hovered.row} x ${hovered.col}` : t("toolbar.tableSizeLabel")}
      </div>
      <div
        className="table-size-grid"
        onMouseLeave={() => setHovered(null)}
      >
        {Array.from({ length: GRID_SIZE }, (_, rowIdx) =>
          Array.from({ length: GRID_SIZE }, (_, colIdx) => {
            const row = rowIdx + 1;
            const col = colIdx + 1;
            const isHighlighted =
              hovered !== null && row <= hovered.row && col <= hovered.col;

            return (
              <div
                key={`${row}-${col}`}
                className={`table-size-cell${isHighlighted ? " highlighted" : ""}`}
                onMouseEnter={() => setHovered({ row, col })}
                onClick={() => onSelect(row, col)}
              />
            );
          })
        )}
      </div>
    </div>,
    document.body
  );
}
