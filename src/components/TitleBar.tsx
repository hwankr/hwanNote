import type { NoteTab } from "../stores/noteStore";

interface TitleBarProps {
  tabs: NoteTab[];
  activeTabId: string;
  isMaximized: boolean;
  onToggleSidebar: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
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
  onCreateTab,
  onMinimize,
  onToggleMaximize,
  onCloseWindow
}: TitleBarProps) {
  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <button
          type="button"
          className="titlebar-btn no-drag"
          aria-label="사이드바 토글"
          onClick={onToggleSidebar}
        >
          ☰
        </button>
      </div>

      <div className="titlebar-center no-drag">
        <div className="tabs">
          {tabs.map((tab) => (
            <button
              type="button"
              key={tab.id}
              className={`tab ${tab.id === activeTabId ? "active" : ""}`}
              onClick={() => onSelectTab(tab.id)}
              title={tab.title}
            >
              <span className="tab-title">{tab.title}</span>
              {tab.isDirty ? <span className="tab-dirty">●</span> : null}
              <span
                role="button"
                className="tab-close"
                aria-label={`${tab.title} 닫기`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>

        <button type="button" className="titlebar-btn no-drag add-tab-btn" onClick={onCreateTab}>
          +
        </button>
      </div>

      <div className="titlebar-right no-drag">
        <button type="button" className="window-control" onClick={onMinimize} aria-label="최소화">
          —
        </button>
        <button
          type="button"
          className="window-control"
          onClick={onToggleMaximize}
          aria-label={isMaximized ? "복원" : "최대화"}
        >
          {isMaximized ? "❐" : "□"}
        </button>
        <button
          type="button"
          className="window-control close"
          onClick={onCloseWindow}
          aria-label="닫기"
        >
          ✕
        </button>
      </div>
    </header>
  );
}
