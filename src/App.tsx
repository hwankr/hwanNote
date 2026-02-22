import { Editor as TiptapEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import Editor from "./components/Editor";
import SearchBar from "./components/SearchBar";
import Sidebar from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import Toolbar from "./components/Toolbar";
import { useAutoSave } from "./hooks/useAutoSave";
import { applyTheme } from "./styles/themes";
import { useNoteStore } from "./stores/noteStore";

function getDraftKey(tabId: string) {
  return `hwan-note:draft:${tabId}`;
}

export default function App() {
  const tabs = useNoteStore((state) => state.tabs);
  const activeTabId = useNoteStore((state) => state.activeTabId);
  const sidebarVisible = useNoteStore((state) => state.sidebarVisible);
  const createTab = useNoteStore((state) => state.createTab);
  const setActiveTab = useNoteStore((state) => state.setActiveTab);
  const closeTab = useNoteStore((state) => state.closeTab);
  const updateActiveContent = useNoteStore((state) => state.updateActiveContent);
  const markTabSaved = useNoteStore((state) => state.markTabSaved);
  const toggleSidebar = useNoteStore((state) => state.toggleSidebar);

  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1, chars: 0 });
  const [isMaximized, setIsMaximized] = useState(false);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [tabs, activeTabId]
  );

  const handleManualSave = useCallback(() => {
    if (!activeTab) {
      return;
    }

    window.localStorage.setItem(getDraftKey(activeTab.id), activeTab.content);
    markTabSaved(activeTab.id);
  }, [activeTab, markTabSaved]);

  useAutoSave({
    value: activeTab?.content ?? "",
    enabled: Boolean(activeTab?.isDirty),
    delay: 1000,
    onSave: handleManualSave
  });

  useEffect(() => {
    applyTheme("light");
  }, []);

  useEffect(() => {
    if (!activeTab) {
      return;
    }

    const draft = window.localStorage.getItem(getDraftKey(activeTab.id));
    if (!draft || draft === activeTab.content) {
      return;
    }

    const plainText = draft.replace(/<[^>]+>/g, "").trim();
    updateActiveContent(draft, plainText);
    markTabSaved(activeTab.id);
  }, [activeTab, markTabSaved, updateActiveContent]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === "s") {
        event.preventDefault();
        handleManualSave();
      }

      if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        createTab();
      }

      if (key === "w" && activeTab) {
        event.preventDefault();
        closeTab(activeTab.id);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, closeTab, createTab, handleManualSave]);

  const handleToggleMaximize = useCallback(async () => {
    const winApi = window.hwanNote?.window;
    if (!winApi) {
      return;
    }
    const nextState = await winApi.toggleMaximize();
    setIsMaximized(nextState);
  }, []);

  return (
    <div className="app-shell">
      <TitleBar
        tabs={tabs}
        activeTabId={activeTabId}
        isMaximized={isMaximized}
        onToggleSidebar={toggleSidebar}
        onSelectTab={setActiveTab}
        onCloseTab={closeTab}
        onCreateTab={createTab}
        onMinimize={() => void window.hwanNote?.window.minimize()}
        onToggleMaximize={() => void handleToggleMaximize()}
        onCloseWindow={() => void window.hwanNote?.window.close()}
      />

      <Toolbar editor={editor} />
      <SearchBar />

      <div className="workspace">
        <Sidebar visible={sidebarVisible} />

        <main className="editor-workspace">
          {activeTab ? (
            <Editor
              key={activeTab.id}
              content={activeTab.content}
              onEditorReady={setEditor}
              onChange={(content, plainText) => updateActiveContent(content, plainText)}
              onCursorChange={(line, column, chars) => setCursor({ line, column, chars })}
            />
          ) : null}
        </main>
      </div>

      <StatusBar line={cursor.line} column={cursor.column} chars={cursor.chars} />
    </div>
  );
}
