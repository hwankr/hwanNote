import { useI18n } from "../i18n/context";
import type { NoteTab } from "../stores/noteStore";
import FolderTree from "./FolderTree";

export interface SidebarTag {
  name: string;
  count: number;
  color: string;
}

type SortMode = "updated" | "title" | "created";
type SearchMode = "all" | "title" | "content";

interface SidebarProps {
  visible: boolean;
  activeTabId: string;
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
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder
}: SidebarProps) {
  const { t, localeTag } = useI18n();

  return (
    <aside className={`sidebar ${visible ? "visible" : "hidden"}`}>
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
              className={`note-list-item ${note.id === activeTabId ? "active" : ""}`}
              onClick={() => onSelectNote(note.id)}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/note-id", note.id);
              }}
            >
              <div className="note-item-head">
                <span className="note-item-title">{note.title}</span>
                <span className="note-item-date">{formatUpdatedTime(note.updatedAt, localeTag)}</span>
              </div>
              <span className="note-item-preview">{buildPreview(note, t("sidebar.emptyPreview"))}</span>
              <span className="note-item-folder">/{note.folderPath}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
