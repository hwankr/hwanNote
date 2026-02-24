import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/context";
import type { NoteTab } from "../stores/noteStore";

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

interface ContextMenuState {
  tabId: string;
  x: number;
  y: number;
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
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [tabsOverflowing, setTabsOverflowing] = useState(false);
  const tabsRef = useRef<HTMLDivElement | null>(null);

  const menuTarget = useMemo(() => tabs.find((tab) => tab.id === menu?.tabId), [tabs, menu]);

  useEffect(() => {
    if (!menu) {
      return;
    }

    const closeMenu = () => setMenu(null);

    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("resize", closeMenu);

    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("resize", closeMenu);
    };
  }, [menu]);

  useEffect(() => {
    const tabsElement = tabsRef.current;
    if (!tabsElement) {
      return;
    }

    const updateOverflowState = () => {
      const isOverflowing = tabsElement.scrollWidth > tabsElement.clientWidth + 1;
      setTabsOverflowing((prev) => (prev === isOverflowing ? prev : isOverflowing));
    };

    updateOverflowState();

    const resizeObserver = new ResizeObserver(updateOverflowState);
    resizeObserver.observe(tabsElement);
    window.addEventListener("resize", updateOverflowState);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateOverflowState);
    };
  }, [tabs]);

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
        <div ref={tabsRef} className={`tabs ${tabsOverflowing ? "no-drag" : ""}`}>
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={`tab no-drag ${tab.id === activeTabId ? "active" : ""} ${
                tab.id === dragOverTabId ? "drag-over" : ""
              }`}
              onClick={() => onSelectTab(tab.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
              }}
              onDragStart={(event) => {
                setDraggingTabId(tab.id);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", tab.id);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (draggingTabId && draggingTabId !== tab.id) {
                  setDragOverTabId(tab.id);
                }
              }}
              onDragLeave={() => {
                if (dragOverTabId === tab.id) {
                  setDragOverTabId(null);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = draggingTabId ?? event.dataTransfer.getData("text/plain");
                if (sourceId && sourceId !== tab.id) {
                  onReorderTabs(sourceId, tab.id);
                }
                setDraggingTabId(null);
                setDragOverTabId(null);
              }}
              onDragEnd={() => {
                setDraggingTabId(null);
                setDragOverTabId(null);
              }}
              title={tab.title}
              draggable
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
        <div
          className="tab-context-menu no-drag"
          style={{ left: `${menu.x}px`, top: `${menu.y}px` }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              onCloseTab(menu.tabId);
              setMenu(null);
            }}
          >
            {t("titlebar.context.close")}
          </button>
          <button
            type="button"
            onClick={() => {
              onCloseOtherTabs(menu.tabId);
              setMenu(null);
            }}
          >
            {t("titlebar.context.closeOthers")}
          </button>
          <button
            type="button"
            onClick={() => {
              onTogglePinTab(menu.tabId);
              setMenu(null);
            }}
          >
            {menuTarget.isPinned ? t("titlebar.context.unpin") : t("titlebar.context.pin")}
          </button>
        </div>
      ) : null}
    </header>
  );
}
