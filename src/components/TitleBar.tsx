import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/context";
import type { NoteTab } from "../stores/noteStore";
import ContextMenu, { type ContextMenuEntry } from "./ContextMenu";

const MenuIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

const CloseTabIcon = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

const AddTabIcon = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

const PinIcon = (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 2L6 6 3 5.5 2 7l3.5 3.5L4 14l1.5-1 3.5-3L9.5 13 11 10l4-4-5-4z" fill="currentColor"/>
  </svg>
);

const MinimizeIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 8h8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
  </svg>
);

const MaximizeIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3.5" y="3.5" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1"/>
  </svg>
);

const RestoreIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="4.5" y="5.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1"/>
    <path d="M6.5 5.5V4.5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-1" stroke="currentColor" strokeWidth="1"/>
  </svg>
);

const CloseWindowIcon = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
  </svg>
);

interface TitleBarProps {
  tabs: NoteTab[];
  activeTabId: string;
  isMaximized: boolean;
  onToggleSidebar: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseOtherTabs: (id: string) => void;
  onTogglePinTab: (id: string) => void;
  onReorderTabs: (sourceId: string, targetId: string) => void;
  onCreateTab: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onCloseWindow: () => void;
}

export default function TitleBar({
  tabs,
  activeTabId,
  isMaximized,
  onToggleSidebar,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onTogglePinTab,
  onReorderTabs,
  onCreateTab,
  onMinimize,
  onToggleMaximize,
  onCloseWindow
}: TitleBarProps) {
  const { t } = useI18n();
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ tabId: string; startX: number; active: boolean } | null>(null);
  const dragOverIdRef = useRef<string | null>(null);
  const didDragRef = useRef(false);

  const menuTarget = useMemo(() => tabs.find((tab) => tab.id === menu?.tabId), [tabs, menu]);

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      if (!drag.active) {
        if (Math.abs(e.clientX - drag.startX) > 5) {
          drag.active = true;
          setDraggingTabId(drag.tabId);
          document.body.classList.add("tab-dragging");
        }
        return;
      }

      const el = document.elementFromPoint(e.clientX, e.clientY);
      const tabEl = (el as HTMLElement | null)?.closest?.("[data-tab-id]") as HTMLElement | null;
      const targetId = tabEl?.dataset.tabId ?? null;
      const over = targetId && targetId !== drag.tabId ? targetId : null;

      if (over !== dragOverIdRef.current) {
        dragOverIdRef.current = over;
        setDragOverTabId(over);
      }
    };

    const handlePointerUp = () => {
      const drag = dragRef.current;
      if (drag?.active && dragOverIdRef.current) {
        onReorderTabs(drag.tabId, dragOverIdRef.current);
        didDragRef.current = true;
      }

      dragRef.current = null;
      dragOverIdRef.current = null;
      setDraggingTabId(null);
      setDragOverTabId(null);
      document.body.classList.remove("tab-dragging");
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      document.body.classList.remove("tab-dragging");
    };
  }, [onReorderTabs]);

  const menuItems = useMemo<ContextMenuEntry[]>(() => {
    if (!menu || !menuTarget) return [];
    return [
      { key: "close", label: t("titlebar.context.close"), onClick: () => { onCloseTab(menu.tabId); setMenu(null); } },
      { key: "closeOthers", label: t("titlebar.context.closeOthers"), onClick: () => { onCloseOtherTabs(menu.tabId); setMenu(null); } },
      { key: "pin", label: menuTarget.isPinned ? t("titlebar.context.unpin") : t("titlebar.context.pin"), onClick: () => { onTogglePinTab(menu.tabId); setMenu(null); } },
    ];
  }, [menu, menuTarget, t, onCloseTab, onCloseOtherTabs, onTogglePinTab]);

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <button
          type="button"
          className="titlebar-btn titlebar-menu-btn no-drag"
          aria-label={t("titlebar.toggleSidebar")}
          onClick={onToggleSidebar}
        >
          {MenuIcon}
        </button>
      </div>

      <div className="titlebar-center">
        <div ref={tabsRef} className="tabs no-drag">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={`tab no-drag ${tab.id === activeTabId ? "active" : ""} ${
                tab.id === draggingTabId ? "dragging" : ""
              } ${tab.id === dragOverTabId ? "drag-over" : ""}`}
              data-tab-id={tab.id}
              onClick={() => {
                if (didDragRef.current) {
                  didDragRef.current = false;
                  return;
                }
                onSelectTab(tab.id);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                dragRef.current = { tabId: tab.id, startX: event.clientX, active: false };
              }}
              title={tab.title}
            >
              {tab.isPinned ? <span className="tab-pin">{PinIcon}</span> : null}
              <span className="tab-title">{tab.title}</span>
              {tab.isDirty ? <span className="tab-dirty">*</span> : null}
              <span
                role="button"
                className="tab-close"
                aria-label={t("titlebar.closeTab", { title: tab.title })}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                {CloseTabIcon}
              </span>
            </button>
          ))}
          <button type="button" className="titlebar-btn no-drag add-tab-btn" onClick={onCreateTab}>
            {AddTabIcon}
          </button>
        </div>
        <div className="titlebar-tab-drag-space" aria-hidden="true" />
      </div>

      <div className="titlebar-right no-drag">
        <button
          type="button"
          className="window-control"
          onClick={onMinimize}
          aria-label={t("titlebar.minimize")}
        >
          {MinimizeIcon}
        </button>
        <button
          type="button"
          className="window-control"
          onClick={onToggleMaximize}
          aria-label={isMaximized ? t("titlebar.restore") : t("titlebar.maximize")}
        >
          {isMaximized ? RestoreIcon : MaximizeIcon}
        </button>
        <button
          type="button"
          className="window-control close"
          onClick={onCloseWindow}
          aria-label={t("titlebar.closeWindow")}
        >
          {CloseWindowIcon}
        </button>
      </div>

      {menu && menuTarget ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
          className="no-drag"
        />
      ) : null}
    </header>
  );
}
