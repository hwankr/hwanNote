import { useMemo, useState } from "react";
import { useI18n } from "../i18n/context";
import type { NoteTab } from "../stores/noteStore";
import ContextMenu, { type ContextMenuEntry } from "./ContextMenu";
import FolderTree from "./FolderTree";

export interface SidebarTag {
  name: string;
  count: number;
  color: string;
}

type SortMode = "updated" | "title" | "created";
type SearchMode = "all" | "title" | "content";

export type AppView = "notes" | "calendar";

interface SidebarProps {
  visible: boolean;
  activeView: AppView;
  onViewChange: (view: AppView) => void;
  activeTabId: string | null;
  folders: string[];
  tags: SidebarTag[];
  notes: NoteTab[];
  selectedFolder: string | null;
  selectedTag: string | null;
  searchQuery: string;
  searchMode: SearchMode;
  sortMode: SortMode;
  onSearchChange: (query: string) => void;
  onSearchModeChange: (mode: SearchMode) => void;
  onSelectFolder: (folderPath: string | null) => void;
  onSelectTag: (tag: string | null) => void;
  onSortModeChange: (mode: SortMode) => void;
  onSelectNote: (id: string) => void;
  onMoveNoteToFolder: (id: string, folderPath: string) => void;
  onTogglePinNote: (id: string) => void;
  onDeleteNote: (id: string) => void;
  onCreateNoteInFolder: (folderPath: string) => void;
  onCreateFolder: (folderPath: string) => void;
  onRenameFolder: (from: string, to: string) => void;
  onDeleteFolder: (folderPath: string) => void;
}

function formatUpdatedTime(timestamp: number, localeTag: string) {
  const date = new Date(timestamp);
  return date.toLocaleString(localeTag, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildPreview(note: NoteTab, emptyLabel: string) {
  const lines = note.plainText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return emptyLabel;
  }

  if (lines[0] === note.title) {
    return lines.slice(1).join(" ").slice(0, 60) || emptyLabel;
  }

  return lines.join(" ").slice(0, 60);
}

export default function Sidebar({
  visible,
  activeView,
  onViewChange,
  activeTabId,
  folders,
  tags,
  notes,
  selectedFolder,
  selectedTag,
  searchQuery,
  searchMode,
  sortMode,
  onSearchChange,
  onSearchModeChange,
  onSelectFolder,
  onSelectTag,
  onSortModeChange,
  onSelectNote,
  onMoveNoteToFolder,
  onTogglePinNote,
  onDeleteNote,
  onCreateNoteInFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder
}: SidebarProps) {
  const { t, localeTag } = useI18n();
  const [noteMenu, setNoteMenu] = useState<{ noteId: string; x: number; y: number } | null>(null);
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);

  const noteMenuTarget = useMemo(
    () => notes.find((n) => n.id === noteMenu?.noteId),
    [notes, noteMenu]
  );

  const noteMenuItems = useMemo<ContextMenuEntry[]>(() => {
    if (!noteMenu || !noteMenuTarget) return [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- new i18n keys are valid but ts needs rebuild
    const tt = t as (key: string, vars?: Record<string, string | number>) => string;

    const items: ContextMenuEntry[] = [
      {
        key: "pin",
        label: noteMenuTarget.isPinned ? tt("sidebar.noteUnpin") : tt("sidebar.notePin"),
        onClick: () => { onTogglePinNote(noteMenu.noteId); setNoteMenu(null); }
      },
    ];

    const otherFolders = folders.filter((f) => f !== noteMenuTarget.folderPath);
    if (otherFolders.length > 0) {
      items.push({ key: "sep-folder", separator: true });
      for (const folder of otherFolders) {
        items.push({
          key: `move-${folder}`,
          label: `/${folder}`,
          onClick: () => { onMoveNoteToFolder(noteMenu.noteId, folder); setNoteMenu(null); }
        });
      }
    }

    items.push({ key: "sep-delete", separator: true });
    items.push({
      key: "delete",
      label: tt("sidebar.noteDelete"),
      danger: true,
      onClick: () => {
        setNoteMenu(null);
        const confirmed = window.confirm(
          tt("sidebar.noteDeleteConfirm", { title: noteMenuTarget.title })
        );
        if (confirmed) {
          onDeleteNote(noteMenu.noteId);
        }
      }
    });

    return items;
  }, [noteMenu, noteMenuTarget, folders, t, onTogglePinNote, onMoveNoteToFolder, onDeleteNote]);

  return (
    <aside className={`sidebar ${visible ? "visible" : "hidden"}`}>
      <div className="sidebar-view-toggle">
        <button
          type="button"
          className={`view-toggle-btn ${activeView === "notes" ? "active" : ""}`}
          onClick={() => onViewChange("notes")}
          title={t("view.switchToNotes")}
          aria-label={t("view.notes")}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zm1 2v2h8V4H4zm0 4v1h8V8H4zm0 3v1h5v-1H4z" fill="currentColor"/>
          </svg>
          <span>{t("view.notes")}</span>
        </button>
        <button
          type="button"
          className={`view-toggle-btn ${activeView === "calendar" ? "active" : ""}`}
          onClick={() => onViewChange("calendar")}
          title={t("view.switchToCalendar")}
          aria-label={t("view.calendar")}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M5 1v1H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V3a1 1 0 00-1-1h-2V1h-1v1H6V1H5zm-2 4v8h10V5H3zm2 1h2v2H5V6zm3 0h2v2H8V6zm-3 3h2v2H5V9z" fill="currentColor"/>
          </svg>
          <span>{t("view.calendar")}</span>
        </button>
      </div>

      <div className="sidebar-section">
        <h3>{t("sidebar.search")}</h3>
        <input
          type="text"
          placeholder={t("sidebar.searchPlaceholder")}
          value={searchQuery}
          onChange={(event) => onSearchChange(event.target.value)}
        />
        <div className="search-mode-group">
          {(["all", "title", "content"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`search-mode-btn ${searchMode === mode ? "active" : ""}`}
              onClick={() => onSearchModeChange(mode)}
            >
              {t(`sidebar.search${mode[0].toUpperCase()}${mode.slice(1)}` as "sidebar.searchAll" | "sidebar.searchTitle" | "sidebar.searchContent")}
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-section">
        <FolderTree
          folders={folders}
          selectedFolder={selectedFolder}
          searchQuery={searchQuery}
          actions={{
            onSelectFolder,
            onCreateNote: onCreateNoteInFolder,
            onCreateFolder,
            onRenameFolder,
            onDeleteFolder,
            onMoveNoteToFolder,
          }}
        />
      </div>

      <div className="sidebar-section">
        <h3>{t("sidebar.tags")}</h3>
        <div className="tag-list">
          <button
            type="button"
            className={`tag-chip ${selectedTag === null ? "active" : ""}`}
            onClick={() => onSelectTag(null)}
          >
            {t("sidebar.allTags")}
          </button>

          {tags.map((tag) => (
            <button
              key={tag.name}
              type="button"
              className={`tag-chip ${selectedTag === tag.name ? "active" : ""}`}
              style={{ borderColor: tag.color }}
              onClick={() => onSelectTag(tag.name)}
            >
              #{tag.name} ({tag.count})
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-section sidebar-notes-section">
        <div className="sidebar-section-head">
          <h3>{t("sidebar.notes")}</h3>
          <select
            value={sortMode}
            onChange={(event) => onSortModeChange(event.target.value as SortMode)}
            aria-label={t("sidebar.sortAria")}
          >
            <option value="updated">{t("sidebar.sortUpdated")}</option>
            <option value="title">{t("sidebar.sortTitle")}</option>
            <option value="created">{t("sidebar.sortCreated")}</option>
          </select>
        </div>

        <div className="note-list">
          {notes.length === 0 ? <p className="empty-note-list">{t("sidebar.noNotes")}</p> : null}

          {notes.map((note) => (
            <button
              type="button"
              key={note.id}
              className={`note-list-item ${note.id === activeTabId ? "active" : ""} ${draggingNoteId === note.id ? "dragging" : ""}`}
              onClick={() => onSelectNote(note.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setNoteMenu({ noteId: note.id, x: event.clientX, y: event.clientY });
              }}
              draggable
              aria-grabbed={draggingNoteId === note.id}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/note-id", note.id);
                setDraggingNoteId(note.id);
              }}
              onDragEnd={() => {
                setDraggingNoteId((current) => (current === note.id ? null : current));
              }}
            >
              <div className="note-item-head">
                <span className="note-item-title">
                  {note.isPinned ? <span className="note-item-pin" aria-label="pinned">&#128204;</span> : null}
                  {note.title}
                </span>
                <span className="note-item-date">{formatUpdatedTime(note.updatedAt, localeTag)}</span>
              </div>
              <span className="note-item-preview">{buildPreview(note, t("sidebar.emptyPreview"))}</span>
              {note.folderPath && (
                <span className="note-item-folder">/{note.folderPath}</span>
              )}
            </button>
          ))}
        </div>

        {noteMenu && noteMenuTarget ? (
          <ContextMenu
            x={noteMenu.x}
            y={noteMenu.y}
            items={noteMenuItems}
            onClose={() => setNoteMenu(null)}
          />
        ) : null}
      </div>
    </aside>
  );
}
