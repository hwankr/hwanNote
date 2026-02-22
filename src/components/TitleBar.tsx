import { useEffect, useMemo, useState } from "react";
import type { NoteTab } from "../stores/noteStore";

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
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

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

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <button
          type="button"
          className="titlebar-btn no-drag"
          aria-label="Toggle sidebar"
          onClick={onToggleSidebar}
        >
          Menu
        </button>
      </div>

      <div className="titlebar-center no-drag">
        <div className="tabs">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={`tab ${tab.id === activeTabId ? "active" : ""} ${
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
              {tab.isPinned ? <span className="tab-pin">PIN</span> : null}
              <span className="tab-title">{tab.title}</span>
              {tab.isDirty ? <span className="tab-dirty">*</span> : null}
              <span
                role="button"
                className="tab-close"
                aria-label={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                x
              </span>
            </button>
          ))}
        </div>

        <button type="button" className="titlebar-btn no-drag add-tab-btn" onClick={onCreateTab}>
          +
        </button>
      </div>

      <div className="titlebar-right no-drag">
        <button type="button" className="window-control" onClick={onMinimize} aria-label="Minimize">
          -
        </button>
        <button
          type="button"
          className="window-control"
          onClick={onToggleMaximize}
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? "R" : "M"}
        </button>
        <button
          type="button"
          className="window-control close"
          onClick={onCloseWindow}
          aria-label="Close"
        >
          X
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
            Close
          </button>
          <button
            type="button"
            onClick={() => {
              onCloseOtherTabs(menu.tabId);
              setMenu(null);
            }}
          >
            Close others
          </button>
          <button
            type="button"
            onClick={() => {
              onTogglePinTab(menu.tabId);
              setMenu(null);
            }}
          >
            {menuTarget.isPinned ? "Unpin" : "Pin"}
          </button>
        </div>
      ) : null}
    </header>
  );
}
