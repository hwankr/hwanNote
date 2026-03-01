import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/context";
import { useNoteStore } from "../stores/noteStore";
import ContextMenu, { type ContextMenuEntry } from "./ContextMenu";

interface FolderRow {
  path: string;
  label: string;
  depth: number;
}

interface FolderActions {
  onSelectFolder: (folderPath: string | null) => void;
  onCreateFolder: (folderPath: string) => void;
  onRenameFolder: (from: string, to: string) => void;
  onDeleteFolder: (folderPath: string) => void;
  onMoveNoteToFolder: (noteId: string, folderPath: string) => void;
}

interface FolderTreeProps {
  folders: string[];
  selectedFolder: string | null;
  searchQuery: string;
  actions: FolderActions;
}

const COLLAPSED_FOLDERS_KEY = "hwan-note:collapsed-folders";

const ChevronIcon = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3.5 2L7 5L3.5 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const FolderClosedIcon = (
  <svg className="folder-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M1.5 3.5C1.5 2.95 1.95 2.5 2.5 2.5H6L7.5 4H13.5C14.05 4 14.5 4.45 14.5 5V12.5C14.5 13.05 14.05 13.5 13.5 13.5H2.5C1.95 13.5 1.5 13.05 1.5 12.5V3.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
  </svg>
);

const FolderOpenIcon = (
  <svg className="folder-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M1.5 3.5C1.5 2.95 1.95 2.5 2.5 2.5H6L7.5 4H13.5C14.05 4 14.5 4.45 14.5 5V5.5H4.5L1.5 12.5V3.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
    <path d="M1.5 12.5L4.5 5.5H14.5L11.5 12.5H1.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
  </svg>
);

const AllNotesIcon = (
  <svg className="folder-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="3" y="1.5" width="10" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.1"/>
    <path d="M5.5 5H10.5M5.5 7.5H10.5M5.5 10H8.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
  </svg>
);

function buildFolderRows(folderPaths: string[], localeTag: string): FolderRow[] {
  const normalizedSet = new Set<string>();

  folderPaths
    .map((path) => path.trim().replace(/\\/g, "/"))
    .filter(Boolean)
    .forEach((path) => {
      const segments = path.split("/").filter(Boolean);
      let current = "";
      segments.forEach((segment) => {
        current = current ? `${current}/${segment}` : segment;
        normalizedSet.add(current);
      });
    });

  return Array.from(normalizedSet)
    .sort((a, b) => a.localeCompare(b, localeTag))
    .map((path) => {
      const segments = path.split("/");
      return { path, label: segments[segments.length - 1], depth: segments.length - 1 };
    });
}

function InlineFolderInput({
  defaultValue,
  depth,
  onCommit,
  onCancel,
}: {
  defaultValue: string;
  depth: number;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const handleCommit = () => {
    if (committedRef.current) return;
    const value = inputRef.current?.value.trim() ?? "";
    if (!value) {
      onCancel();
      return;
    }
    if (value.includes("/") || value.includes("\\")) {
      return;
    }
    committedRef.current = true;
    onCommit(value);
  };

  return (
    <div className="folder-row" style={{ paddingLeft: `${6 + depth * 16}px` }}>
      <span className="folder-chevron-spacer" />
      <span className="folder-icon-wrap">{FolderClosedIcon}</span>
      <input
        ref={inputRef}
        type="text"
        className="folder-inline-input"
        defaultValue={defaultValue}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); handleCommit(); }
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        onBlur={handleCommit}
      />
    </div>
  );
}

export default function FolderTree({
  folders,
  selectedFolder,
  searchQuery,
  actions,
}: FolderTreeProps) {
  const { t, localeTag } = useI18n();
  const allNotes = useNoteStore((state) => state.allNotes);

  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tab of allNotes) {
      const fp = tab.folderPath;
      // Count for exact folder
      counts.set(fp, (counts.get(fp) ?? 0) + 1);
      // Count for ancestor folders (so parent shows total of descendants)
      const segments = fp.split("/");
      let ancestor = "";
      for (let i = 0; i < segments.length - 1; i++) {
        ancestor = ancestor ? `${ancestor}/${segments[i]}` : segments[i];
        counts.set(ancestor, (counts.get(ancestor) ?? 0) + 1);
      }
    }
    return counts;
  }, [allNotes]);

  const totalNoteCount = allNotes.length;

  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_FOLDERS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          return new Set(parsed.filter((e): e is string => typeof e === "string"));
        }
      }
    } catch { /* ignore */ }
    return new Set<string>();
  });

  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify(Array.from(collapsedFolders)));
  }, [collapsedFolders]);

  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [creatingFolderIn, setCreatingFolderIn] = useState<string | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ folderPath: string; x: number; y: number } | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);

  const folderRows = useMemo(() => buildFolderRows(folders, localeTag), [folders, localeTag]);

  const hasChildren = useMemo(() => {
    const set = new Set<string>();
    for (const row of folderRows) {
      const parentIdx = row.path.lastIndexOf("/");
      if (parentIdx > 0) {
        set.add(row.path.slice(0, parentIdx));
      }
    }
    return set;
  }, [folderRows]);

  const visibleRows = useMemo(() => {
    if (searchQuery.trim()) {
      return folderRows;
    }
    return folderRows.filter((row) => {
      const segments = row.path.split("/");
      let ancestor = "";
      for (let i = 0; i < segments.length - 1; i++) {
        ancestor = ancestor ? `${ancestor}/${segments[i]}` : segments[i];
        if (collapsedFolders.has(ancestor)) {
          return false;
        }
      }
      return true;
    });
  }, [folderRows, collapsedFolders, searchQuery]);

  const toggleCollapse = useCallback((path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((folderPath: string, x: number, y: number) => {
    setFolderMenu({ folderPath, x, y });
  }, []);

  const handleNewSubfolder = useCallback(() => {
    if (!folderMenu) return;
    const parentPath = folderMenu.folderPath;
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      next.delete(parentPath);
      return next;
    });
    setCreatingFolderIn(parentPath);
    setFolderMenu(null);
  }, [folderMenu]);

  const handleRenameStart = useCallback(() => {
    if (!folderMenu) return;
    setRenamingFolder(folderMenu.folderPath);
    setFolderMenu(null);
  }, [folderMenu]);

  const handleDelete = useCallback(() => {
    if (!folderMenu) return;
    const path = folderMenu.folderPath;
    const ok = window.confirm(t("sidebar.deleteFolderConfirm", { path }));
    if (ok) {
      actions.onDeleteFolder(path);
    }
    setFolderMenu(null);
  }, [folderMenu, actions, t]);

  const contextMenuItems = useMemo<ContextMenuEntry[]>(() => {
    if (!folderMenu) return [];

    return [
      { key: "newSub", label: t("sidebar.newSubfolder"), onClick: handleNewSubfolder },
      { key: "sep1", separator: true },
      { key: "rename", label: t("sidebar.renameFolder"), onClick: handleRenameStart },
      { key: "sep2", separator: true },
      { key: "delete", label: t("sidebar.deleteFolder"), danger: true, onClick: handleDelete },
    ];
  }, [folderMenu, t, handleNewSubfolder, handleRenameStart, handleDelete]);

  const getCreatingDepth = useCallback((parentPath: string) => {
    if (parentPath === "") return 0;
    return parentPath.split("/").length;
  }, []);

  const handleCreateCommit = useCallback((name: string) => {
    if (creatingFolderIn === null) return;
    const fullPath = creatingFolderIn ? `${creatingFolderIn}/${name}` : name;
    actions.onCreateFolder(fullPath);
    setCreatingFolderIn(null);
  }, [creatingFolderIn, actions]);

  const handleRenameCommit = useCallback((folder: FolderRow, newName: string) => {
    const parentPath = folder.path.includes("/")
      ? folder.path.slice(0, folder.path.lastIndexOf("/"))
      : "";
    const newPath = parentPath ? `${parentPath}/${newName}` : newName;
    if (newPath !== folder.path) {
      actions.onRenameFolder(folder.path, newPath);
    }
    setRenamingFolder(null);
  }, [actions]);

  const getFolderIcon = (folder: FolderRow) => {
    const isExpanded = !collapsedFolders.has(folder.path) && hasChildren.has(folder.path);
    return isExpanded ? FolderOpenIcon : FolderClosedIcon;
  };

  const renderFolderRow = (folder: FolderRow) => {
    if (renamingFolder === folder.path) {
      return (
        <InlineFolderInput
          key={`rename-${folder.path}`}
          defaultValue={folder.label}
          depth={folder.depth}
          onCommit={(newName) => handleRenameCommit(folder, newName)}
          onCancel={() => setRenamingFolder(null)}
        />
      );
    }

    const isExpanded = !collapsedFolders.has(folder.path);
    const showChevron = hasChildren.has(folder.path);
    const isActive = selectedFolder === folder.path;
    const isDragOver = dragOverFolder === folder.path;

    return (
      <div
        key={folder.path}
        className={`folder-row ${isActive ? "active" : ""} ${isDragOver ? "drag-over" : ""}`}
        style={{ paddingLeft: `${6 + folder.depth * 16}px` }}
      >
        {folder.depth > 0 && (
          <span className="folder-indent-guide" style={{ left: `${6 + (folder.depth - 1) * 16 + 8}px` }} />
        )}
        {showChevron ? (
          <button
            type="button"
            className={`folder-chevron ${isExpanded ? "expanded" : ""}`}
            onClick={(e) => { e.stopPropagation(); toggleCollapse(folder.path); }}
          >
            {ChevronIcon}
          </button>
        ) : (
          <span className="folder-chevron-spacer" />
        )}
        <span className="folder-icon-wrap">{getFolderIcon(folder)}</span>
        <button
          type="button"
          className="folder-label"
          onClick={() => actions.onSelectFolder(folder.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            handleContextMenu(folder.path, e.clientX, e.clientY);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverFolder(folder.path);
          }}
          onDragLeave={() => {
            setDragOverFolder((prev) => prev === folder.path ? null : prev);
          }}
          onDrop={(e) => {
            e.preventDefault();
            const noteId = e.dataTransfer.getData("text/note-id");
            if (noteId) {
              actions.onMoveNoteToFolder(noteId, folder.path);
            }
            setDragOverFolder(null);
          }}
          title={folder.path}
        >
          {folder.label}
        </button>
        {(noteCounts.get(folder.path) ?? 0) > 0 && (
          <span className="folder-count">{noteCounts.get(folder.path)}</span>
        )}
      </div>
    );
  };

  const renderCreatingInput = (afterPath: string) => {
    if (creatingFolderIn === null || creatingFolderIn !== afterPath) return null;
    return (
      <InlineFolderInput
        key={`create-${afterPath}`}
        defaultValue=""
        depth={getCreatingDepth(afterPath)}
        onCommit={handleCreateCommit}
        onCancel={() => setCreatingFolderIn(null)}
      />
    );
  };

  const buildRenderedRows = () => {
    const elements: React.ReactNode[] = [];

    for (let i = 0; i < visibleRows.length; i++) {
      const folder = visibleRows[i];
      elements.push(renderFolderRow(folder));

      if (creatingFolderIn !== null && creatingFolderIn !== "") {
        const nextRow = visibleRows[i + 1];
        const isParentOrDescendant = folder.path === creatingFolderIn || folder.path.startsWith(`${creatingFolderIn}/`);
        const nextIsNotChild = !nextRow || !nextRow.path.startsWith(`${creatingFolderIn}/`);

        if (isParentOrDescendant && nextIsNotChild) {
          elements.push(renderCreatingInput(creatingFolderIn));
        }
      }
    }

    if (creatingFolderIn === "") {
      elements.push(renderCreatingInput(""));
    }

    return elements;
  };

  return (
    <>
      <div className="sidebar-section-head">
        <h3>{t("sidebar.folders")}</h3>
        <button
          type="button"
          className="sidebar-mini-btn"
          onClick={() => setCreatingFolderIn("")}
          title={t("sidebar.newSubfolder")}
        >
          +
        </button>
      </div>

      <div
        className={`folder-row all-notes-row ${selectedFolder === null ? "active" : ""}`}
        onClick={() => actions.onSelectFolder(null)}
      >
        <span className="folder-chevron-spacer" />
        <span className="folder-icon-wrap">{AllNotesIcon}</span>
        <span className="folder-label-text">{t("sidebar.allNotes")}</span>
        {totalNoteCount > 0 && (
          <span className="folder-count">{totalNoteCount}</span>
        )}
      </div>

      <div className="folder-tree-divider" />

      <div className="folder-tree">
        {buildRenderedRows()}
      </div>

      {folderMenu ? (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={contextMenuItems}
          onClose={() => setFolderMenu(null)}
        />
      ) : null}
    </>
  );
}
