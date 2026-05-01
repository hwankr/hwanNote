import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/context";
import { hwanNote } from "../lib/tauriApi";
import type { NoteTab } from "../stores/noteStore";
import type { AppView } from "./Sidebar";
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
  activeTabId: string | null;
  splitTabIds: ReadonlySet<string>;
  activeView: AppView;
  onViewChange: (view: AppView) => void;
  isMaximized: boolean;
  onToggleSidebar: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseOtherTabs: (id: string) => void;
  onTogglePinTab: (id: string) => void;
  onReorderTabs: (sourceId: string, targetId: string) => void;
  onDropTabOutside: (tabId: string, clientX: number, clientY: number) => void;
  onTabDragPreview: (tabId: string, clientX: number, clientY: number) => void;
  onTabDragEnd: () => void;
  onUnsplit: (tabId: string) => void;
  onCreateTab: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onCloseWindow: () => void;
}

export default function TitleBar({
  tabs,
  activeTabId,
  splitTabIds,
  activeView,
  onViewChange,
  isMaximized,
  onToggleSidebar,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onTogglePinTab,
  onReorderTabs,
  onDropTabOutside,
  onTabDragPreview,
  onTabDragEnd,
  onUnsplit,
  onCreateTab,
  onMinimize,
  onToggleMaximize,
  onCloseWindow
}: TitleBarProps) {
  const { t } = useI18n();
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<"before" | "after" | null>(null);
  const [dragGhost, setDragGhost] = useState<{
    tabId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ tabId: string; startX: number; startY: number; active: boolean } | null>(null);
  const dragOverIdRef = useRef<string | null>(null);
  const dragOverPositionRef = useRef<"before" | "after" | null>(null);
  const didDragRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  const menuTarget = useMemo(() => tabs.find((tab) => tab.id === menu?.tabId), [tabs, menu]);
  const draggingTab = useMemo(() => tabs.find((tab) => tab.id === draggingTabId) ?? null, [tabs, draggingTabId]);
  const menuTargetIsSplit = Boolean(menuTarget && splitTabIds.has(menuTarget.id));

  const handleWindowDragStart = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (
      target?.closest(
        ".no-drag, .tab, .tab-drag-ghost, .context-menu, button, a, input, select, textarea, [role='button']"
      )
    ) {
      return;
    }

    void hwanNote.window.startDragging();
  };

  useEffect(() => {
    const resetDragState = () => {
      dragRef.current = null;
      dragOverIdRef.current = null;
      dragOverPositionRef.current = null;
      setDraggingTabId(null);
      setDragOverTabId(null);
      setDragOverPosition(null);
      setDragGhost(null);
      lastPointerRef.current = null;
      document.body.classList.remove("tab-dragging");
    };

    const setDropTarget = (over: string | null, position: "before" | "after" | null) => {
      if (over !== dragOverIdRef.current || position !== dragOverPositionRef.current) {
        dragOverIdRef.current = over;
        dragOverPositionRef.current = position;
        setDragOverTabId(over);
        setDragOverPosition(position);
      }
    };

    const handlePointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };

      if (!drag.active) {
        const deltaX = e.clientX - drag.startX;
        const deltaY = e.clientY - drag.startY;
        if (Math.hypot(deltaX, deltaY) > 5) {
          drag.active = true;
          const tabNodes = tabsRef.current
            ? Array.from(tabsRef.current.querySelectorAll<HTMLElement>("[data-tab-id]"))
            : [];
          const tabEl = tabNodes.find((node) => node.dataset.tabId === drag.tabId);
          if (tabEl) {
            const rect = tabEl.getBoundingClientRect();
            setDragGhost({
              tabId: drag.tabId,
              width: rect.width,
              height: rect.height,
              offsetX: e.clientX - rect.left,
              offsetY: e.clientY - rect.top,
              x: rect.left,
              y: rect.top
            });
          } else {
            setDragGhost({
              tabId: drag.tabId,
              width: 140,
              height: 32,
              offsetX: 14,
              offsetY: 16,
              x: e.clientX - 14,
              y: e.clientY - 16
            });
          }
          setDraggingTabId(drag.tabId);
          document.body.classList.add("tab-dragging");
          onTabDragPreview(drag.tabId, e.clientX, e.clientY);
        }
        return;
      }

      setDragGhost((prev) => {
        if (!prev || prev.tabId !== drag.tabId) return prev;
        return {
          ...prev,
          x: e.clientX - prev.offsetX,
          y: e.clientY - prev.offsetY
        };
      });

      const el = document.elementFromPoint(e.clientX, e.clientY);
      const tabEl = (el as HTMLElement | null)?.closest?.("[data-tab-id]") as HTMLElement | null;
      const targetId = tabEl?.dataset.tabId ?? null;
      const over = targetId && targetId !== drag.tabId ? targetId : null;
      let position: "before" | "after" | null = null;
      if (over) {
        const sourceIndex = tabs.findIndex((tab) => tab.id === drag.tabId);
        const targetIndex = tabs.findIndex((tab) => tab.id === over);
        if (sourceIndex >= 0 && targetIndex >= 0) {
          if (sourceIndex < targetIndex) {
            position = "after";
          } else if (sourceIndex > targetIndex) {
            position = "before";
          }
        }
      }

      setDropTarget(over, position);
      onTabDragPreview(drag.tabId, e.clientX, e.clientY);
    };

    const finalizeDrag = (event?: PointerEvent) => {
      const drag = dragRef.current;
      if (drag?.active) {
        if (dragOverIdRef.current) {
          onReorderTabs(drag.tabId, dragOverIdRef.current);
        } else {
          const pointer = event
            ? { x: event.clientX, y: event.clientY }
            : lastPointerRef.current;
          if (pointer) {
            onDropTabOutside(drag.tabId, pointer.x, pointer.y);
          }
        }
        didDragRef.current = true;
      }
      resetDragState();
      onTabDragEnd();
    };

    const handlePointerUp = (event: PointerEvent) => {
      finalizeDrag(event);
    };

    const handlePointerCancel = (event: PointerEvent) => {
      finalizeDrag(event);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      resetDragState();
    };
  }, [onDropTabOutside, onReorderTabs, onTabDragEnd, onTabDragPreview, tabs]);

  const menuItems = useMemo<ContextMenuEntry[]>(() => {
    if (!menu || !menuTarget) return [];
    const items: ContextMenuEntry[] = [
      { key: "close", label: t("titlebar.context.close"), onClick: () => { onCloseTab(menu.tabId); setMenu(null); } },
      { key: "closeOthers", label: t("titlebar.context.closeOthers"), onClick: () => { onCloseOtherTabs(menu.tabId); setMenu(null); } },
      { key: "pin", label: menuTarget.isPinned ? t("titlebar.context.unpin") : t("titlebar.context.pin"), onClick: () => { onTogglePinTab(menu.tabId); setMenu(null); } },
    ];
    if (menuTargetIsSplit) {
      items.push(
        { key: "separator-unsplit", separator: true },
        { key: "unsplit", label: t("titlebar.context.unsplit"), onClick: () => { onUnsplit(menu.tabId); setMenu(null); } }
      );
    }
    return items;
  }, [menu, menuTarget, menuTargetIsSplit, t, onCloseTab, onCloseOtherTabs, onTogglePinTab, onUnsplit]);

  return (
    <header className="titlebar" onPointerDown={handleWindowDragStart}>
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
        <div ref={tabsRef} className="tabs">
          {tabs.map((tab) => {
            const isSplitMember = splitTabIds.has(tab.id);
            return (
              <button
                type="button"
                key={tab.id}
                className={`tab no-drag ${tab.id === activeTabId ? "active" : ""} ${
                  tab.id === draggingTabId ? "dragging" : ""
                } ${isSplitMember ? "split-member" : ""} ${tab.id === dragOverTabId ? "drag-over" : ""} ${
                  tab.id === dragOverTabId && dragOverPosition === "before" ? "drag-over-before" : ""
                } ${tab.id === dragOverTabId && dragOverPosition === "after" ? "drag-over-after" : ""}`}
                data-tab-id={tab.id}
                onClick={() => {
                  if (didDragRef.current) {
                    didDragRef.current = false;
                    return;
                  }
                  if (activeView !== "notes") {
                    onViewChange("notes");
                  }
                  onSelectTab(tab.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const target = event.target as HTMLElement | null;
                  if (
                    target?.closest(
                      ".tab-close, [data-tab-control], a, input, select, textarea, [role='button']"
                    )
                  ) {
                    return;
                  }
                  dragRef.current = {
                    tabId: tab.id,
                    startX: event.clientX,
                    startY: event.clientY,
                    active: false
                  };
                  lastPointerRef.current = { x: event.clientX, y: event.clientY };
                }}
                title={tab.title}
              >
                {tab.isPinned ? <span className="tab-pin">{PinIcon}</span> : null}
                {isSplitMember ? <span className="tab-split-badge">{t("titlebar.splitBadge")}</span> : null}
                <span className="tab-title">{tab.title}</span>
                {tab.isDirty ? <span className="tab-dirty">*</span> : null}
                <span
                  role="button"
                  className="tab-close"
                  data-tab-control="close"
                  aria-label={t("titlebar.closeTab", { title: tab.title })}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenu(null);
                    onCloseTab(tab.id);
                  }}
                >
                  {CloseTabIcon}
                </span>
              </button>
            );
          })}
          <button type="button" className="titlebar-btn add-tab-btn no-drag" onClick={onCreateTab}>
            {AddTabIcon}
          </button>
        </div>
        <button
          type="button"
          className={`tab calendar-tab no-drag ${activeView === "calendar" ? "active" : ""}`}
          onClick={() => onViewChange("calendar")}
          title={t("view.calendar")}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 1v1H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V3a1 1 0 00-1-1h-2V1h-1v1H6V1H5zm-2 4v8h10V5H3zm2 1h2v2H5V6zm3 0h2v2H8V6zm-3 3h2v2H5V9z" fill="currentColor"/>
          </svg>
          <span className="tab-title">{t("view.calendar")}</span>
        </button>
        {dragGhost && draggingTab ? (
          <div
            className={`tab tab-drag-ghost ${draggingTab.id === activeTabId ? "active" : ""}`}
            aria-hidden="true"
            style={{
              width: `${dragGhost.width}px`,
              height: `${dragGhost.height}px`,
              left: `${dragGhost.x}px`,
              top: `${dragGhost.y}px`
            }}
          >
            {draggingTab.isPinned ? <span className="tab-pin">{PinIcon}</span> : null}
            {splitTabIds.has(draggingTab.id) ? <span className="tab-split-badge">{t("titlebar.splitBadge")}</span> : null}
            <span className="tab-title">{draggingTab.title}</span>
            {draggingTab.isDirty ? <span className="tab-dirty">*</span> : null}
          </div>
        ) : null}
        <div className="titlebar-drag-handle" aria-hidden="true" />
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
