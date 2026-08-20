use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::SystemTime;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha1::Digest;

const INDEX_FILENAME: &str = ".hwan-note-index.json";
pub const CALENDAR_FILENAME: &str = "calendar.json";

static TOGGLE_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^:::toggle\[(open|closed)\](?:\s+(.*))?$").unwrap());
static HEADING_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#{1,6}\s+").unwrap());
static TASK_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^- \[[ xX]\]\s*").unwrap());
static TOGGLE_END_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^:::\s*$").unwrap());
static UNSAFE_FILENAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[<>:"/\\|?*\x00-\x1F]"#).unwrap());
static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static TRAILING_DOTS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.+$").unwrap());
static PLAIN_TASK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\s*)- \[[ xX]\]\s*").unwrap());
static NOTE_INDEX_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

const TOGGLE_BLOCK_END: &str = ":::";
const MANUAL_TITLE_META_PREFIX: &str = "<!-- hwan-note:manual-title:";
const MANUAL_TITLE_META_SUFFIX: &str = " -->";

fn lock_note_index() -> MutexGuard<'static, ()> {
    NOTE_INDEX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndexEntry {
    pub relative_path: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteIndex {
    pub entries: HashMap<String, NoteIndexEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteLoadState {
    Ready,
    Incomplete,
    IndexCorrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteLoadIssueKind {
    Scan,
    FileRead,
    FileMetadata,
    Index,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteLoadIssue {
    pub kind: NoteLoadIssueKind,
    pub operation: String,
    pub path: String,
    pub reason: String,
}

impl NoteLoadIssue {
    fn new(
        kind: NoteLoadIssueKind,
        operation: impl Into<String>,
        path: &Path,
        reason: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            operation: operation.into(),
            path: path.to_string_lossy().to_string(),
            reason: reason.into(),
        }
    }

    fn display(&self) -> String {
        format!(
            "{} failed for {}: {}",
            self.operation, self.path, self.reason
        )
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownLibraryLoadResult {
    pub notes: Vec<LoadedNote>,
    pub folders: Vec<String>,
    pub load_state: NoteLoadState,
    pub issues: Vec<NoteLoadIssue>,
    pub index_source_path: Option<String>,
    pub index_backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSavePayload {
    pub note_id: String,
    pub title: String,
    pub content: String,
    pub folder_path: Option<String>,
    pub is_title_manual: Option<bool>,
    #[serde(default)]
    pub is_pinned: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveResult {
    pub file_path: String,
    pub note_id: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedNote {
    pub note_id: String,
    pub title: String,
    pub is_title_manual: bool,
    pub plain_text: String,
    pub markdown: String,
    pub folder_path: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub file_path: String,
    pub is_pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderDeleteResult {
    pub folders: Vec<String>,
    pub moved_note_ids: Vec<String>,
}

// ── Time helpers ──

fn system_time_to_millis(time: SystemTime) -> u64 {
    time.duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn now_millis() -> u64 {
    system_time_to_millis(SystemTime::now())
}

// ── String helpers ──

pub fn to_platform_line_endings(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n");

    #[cfg(windows)]
    {
        normalized.replace('\n', "\r\n")
    }

    #[cfg(not(windows))]
    {
        normalized
    }
}

fn to_posix(path: &str) -> String {
    path.replace('\\', "/")
}

pub fn sanitize_note_id(note_id: &str) -> String {
    note_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect()
}

fn strip_inbox_root_alias(path: &str) -> String {
    let mut segments: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    if segments
        .first()
        .is_some_and(|segment| segment.eq_ignore_ascii_case("inbox"))
    {
        segments.remove(0);
    }

    segments.join("/")
}

fn is_invalid_folder_segment(segment: &str) -> bool {
    segment == "."
        || segment == ".."
        || segment.ends_with(' ')
        || segment.ends_with('.')
        || segment.chars().any(|c| {
            c.is_ascii_control()
                || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
}

fn validate_folder_segment(segment: &str) -> Result<(), String> {
    if is_invalid_folder_segment(segment) {
        return Err(format!("Invalid folder name segment: {}", segment));
    }

    Ok(())
}

pub fn sanitize_folder_path(folder_path: Option<&str>) -> Result<String, String> {
    let folder_path = match folder_path {
        Some(p) if !p.trim().is_empty() => p,
        _ => return Ok(String::new()),
    };

    let mut segments = folder_path
        .replace('\\', "/")
        .split('/')
        .map(|segment| segment.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();

    if segments
        .first()
        .is_some_and(|segment| segment.eq_ignore_ascii_case("inbox"))
    {
        segments.remove(0);
    }

    for segment in &segments {
        validate_folder_segment(segment)?;
    }

    let normalized = strip_inbox_root_alias(&segments.join("/"));

    if normalized.is_empty() {
        return Ok(String::new());
    }

    Ok(normalized)
}

pub fn slugify_title(title: &str) -> String {
    let trimmed = title.trim();
    let slug = UNSAFE_FILENAME_RE.replace_all(trimmed, "");
    let slug = WHITESPACE_RE.replace_all(&slug, "-");
    let slug = TRAILING_DOTS_RE.replace_all(&slug, "");
    let slug: String = slug.chars().take(80).collect();

    if slug.is_empty() {
        "untitled".to_string()
    } else {
        slug
    }
}

fn normalize_manual_title(title: &str) -> Option<String> {
    let trimmed = title.trim();
    let sliced: String = trimmed.chars().take(50).collect();
    if sliced.is_empty() {
        None
    } else {
        Some(sliced)
    }
}

fn encode_manual_title_hex(title: &str) -> String {
    let mut encoded = String::with_capacity(title.len() * 2);
    for byte in title.as_bytes() {
        encoded.push_str(&format!("{:02x}", byte));
    }
    encoded
}

fn decode_manual_title_hex(value: &str) -> Option<String> {
    if !value.len().is_multiple_of(2) {
        return None;
    }

    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len() / 2);
    let decode_nibble = |byte: u8| -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    };

    let mut index = 0;
    while index < bytes.len() {
        let high = decode_nibble(bytes[index])?;
        let low = decode_nibble(bytes[index + 1])?;
        decoded.push((high << 4) | low);
        index += 2;
    }

    String::from_utf8(decoded)
        .ok()
        .and_then(|title| normalize_manual_title(&title))
}

fn parse_manual_title_metadata_line(line: &str) -> Option<String> {
    let encoded = line
        .strip_prefix(MANUAL_TITLE_META_PREFIX)?
        .strip_suffix(MANUAL_TITLE_META_SUFFIX)?;
    decode_manual_title_hex(encoded)
}

fn extract_manual_title_metadata(markdown: &str) -> (Option<String>, String) {
    let normalized = markdown.replace("\r\n", "\n");

    match normalized.split_once('\n') {
        Some((first_line, rest)) => {
            if let Some(title) = parse_manual_title_metadata_line(first_line) {
                (Some(title), rest.to_string())
            } else {
                (None, normalized)
            }
        }
        None => {
            if let Some(title) = parse_manual_title_metadata_line(&normalized) {
                (Some(title), String::new())
            } else {
                (None, normalized)
            }
        }
    }
}

#[derive(Debug)]
struct LibraryPathError {
    path: PathBuf,
    reason: String,
}

impl LibraryPathError {
    fn new(path: impl Into<PathBuf>, reason: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            reason: reason.into(),
        }
    }

    fn display(&self, operation: &str) -> String {
        format!(
            "{} failed for {}: {}",
            operation,
            self.path.display(),
            self.reason
        )
    }
}

fn metadata_is_symlink_or_reparse_point(metadata: &fs::Metadata) -> bool {
    let is_symlink = metadata.file_type().is_symlink();

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        is_symlink || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }

    #[cfg(not(windows))]
    {
        is_symlink
    }
}

fn ensure_trusted_library_root(root_dir: &Path) -> Result<(), LibraryPathError> {
    let metadata = match fs::symlink_metadata(root_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(root_dir).map_err(|create_error| {
                LibraryPathError::new(
                    root_dir,
                    format!("failed to create the note library root: {create_error}"),
                )
            })?;
            fs::symlink_metadata(root_dir).map_err(|inspect_error| {
                LibraryPathError::new(
                    root_dir,
                    format!("failed to verify the created note library root: {inspect_error}"),
                )
            })?
        }
        Err(error) => {
            return Err(LibraryPathError::new(
                root_dir,
                format!("failed to inspect the note library root: {error}"),
            ));
        }
    };

    if metadata_is_symlink_or_reparse_point(&metadata) {
        return Err(LibraryPathError::new(
            root_dir,
            "the note library root cannot be a symbolic link or reparse point",
        ));
    }
    if !metadata.is_dir() {
        return Err(LibraryPathError::new(
            root_dir,
            "the note library root must be a directory",
        ));
    }

    Ok(())
}

fn normalize_library_relative_path(
    root_dir: &Path,
    raw_path: &str,
) -> Result<PathBuf, LibraryPathError> {
    let displayed_path = root_dir.join(raw_path);
    if raw_path.is_empty() {
        return Err(LibraryPathError::new(
            displayed_path,
            "an empty relative path is not allowed",
        ));
    }

    let normalized = raw_path.replace('\\', "/");
    let has_windows_prefix = normalized
        .as_bytes()
        .get(1)
        .is_some_and(|separator| *separator == b':');
    if normalized.starts_with('/') || has_windows_prefix || Path::new(&normalized).is_absolute() {
        return Err(LibraryPathError::new(
            displayed_path,
            "absolute paths are not allowed beneath the note library",
        ));
    }

    let mut relative = PathBuf::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(LibraryPathError::new(
                displayed_path,
                format!("unsafe relative path component {segment:?}"),
            ));
        }
        relative.push(segment);
    }

    Ok(relative)
}

fn validate_no_symlink_beneath_root(
    root_dir: &Path,
    relative_path: &Path,
) -> Result<(), LibraryPathError> {
    let components = relative_path.components().collect::<Vec<_>>();
    let mut current = root_dir.to_path_buf();

    for (index, component) in components.iter().enumerate() {
        current.push(component.as_os_str());
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(LibraryPathError::new(
                    &current,
                    format!("failed to inspect path without following links: {error}"),
                ));
            }
        };

        if metadata_is_symlink_or_reparse_point(&metadata) {
            return Err(LibraryPathError::new(
                &current,
                "symbolic links and reparse points beneath the note library are not allowed",
            ));
        }
        if index + 1 < components.len() && !metadata.is_dir() {
            return Err(LibraryPathError::new(
                &current,
                "a non-directory path component cannot contain a note",
            ));
        }
    }

    Ok(())
}

fn validate_library_relative_path(
    root_dir: &Path,
    raw_path: &str,
) -> Result<PathBuf, LibraryPathError> {
    let relative_path = normalize_library_relative_path(root_dir, raw_path)?;
    validate_no_symlink_beneath_root(root_dir, &relative_path)?;
    Ok(relative_path)
}

fn validated_library_file_path(root_dir: &Path, raw_path: &str) -> Result<PathBuf, String> {
    validate_library_relative_path(root_dir, raw_path)
        .map(|relative_path| root_dir.join(relative_path))
        .map_err(|error| error.display("validate_library_path"))
}

fn ensure_library_subdirectory(root_dir: &Path, relative_path: &Path) -> Result<PathBuf, String> {
    ensure_trusted_library_root(root_dir)
        .map_err(|error| error.display("validate_library_root"))?;

    let mut current = root_dir.to_path_buf();
    for component in relative_path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if metadata_is_symlink_or_reparse_point(&metadata) {
                    return Err(format!(
                        "validate_library_directory failed for {}: symbolic links and reparse points beneath the note library are not allowed",
                        current.display()
                    ));
                }
                if !metadata.is_dir() {
                    return Err(format!(
                        "validate_library_directory failed for {}: expected a directory",
                        current.display()
                    ));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match fs::create_dir(&current) {
                    Ok(()) => {}
                    Err(create_error) if create_error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(create_error) => {
                        return Err(format!(
                            "create_library_directory failed for {}: {}",
                            current.display(),
                            create_error
                        ));
                    }
                }

                let metadata = fs::symlink_metadata(&current).map_err(|inspect_error| {
                    format!(
                        "verify_library_directory failed for {}: {}",
                        current.display(),
                        inspect_error
                    )
                })?;
                if metadata_is_symlink_or_reparse_point(&metadata) || !metadata.is_dir() {
                    return Err(format!(
                        "verify_library_directory failed for {}: newly created path is not a trusted directory",
                        current.display()
                    ));
                }
            }
            Err(error) => {
                return Err(format!(
                    "inspect_library_directory failed for {}: {}",
                    current.display(),
                    error
                ));
            }
        }
    }

    validate_no_symlink_beneath_root(root_dir, relative_path)
        .map_err(|error| error.display("validate_library_directory"))?;
    Ok(current)
}

fn embed_manual_title_metadata(markdown: &str, manual_title: Option<&str>) -> String {
    let (_, stripped_markdown) = extract_manual_title_metadata(markdown);
    let Some(title) = manual_title.and_then(normalize_manual_title) else {
        return stripped_markdown;
    };

    let metadata_line = format!(
        "{}{}{}",
        MANUAL_TITLE_META_PREFIX,
        encode_manual_title_hex(&title),
        MANUAL_TITLE_META_SUFFIX
    );

    if stripped_markdown.is_empty() {
        metadata_line
    } else {
        format!("{}\n{}", metadata_line, stripped_markdown)
    }
}

pub fn derive_title(markdown: &str) -> String {
    let (_, normalized) = extract_manual_title_metadata(markdown);
    let first_line = normalized
        .split('\n')
        .map(|line| line.trim())
        .find(|line| !line.is_empty());

    let first_line = match first_line {
        Some(line) => line,
        None => return "\u{c81c}\u{baa9} \u{c5c6}\u{c74c}".to_string(), // 제목 없음
    };

    if let Some(caps) = TOGGLE_BLOCK_RE.captures(first_line) {
        let summary = caps.get(2).map_or("", |m| m.as_str()).trim();
        return if summary.is_empty() {
            "\u{c81c}\u{baa9} \u{c5c6}\u{c74c}".to_string()
        } else {
            summary.to_string()
        };
    }

    let stripped = HEADING_PREFIX_RE.replace(first_line, "");
    let stripped = TASK_PREFIX_RE.replace(&stripped, "");
    let stripped = TOGGLE_END_RE.replace(&stripped, "");

    if stripped.is_empty() {
        "\u{c81c}\u{baa9} \u{c5c6}\u{c74c}".to_string()
    } else {
        stripped.to_string()
    }
}

pub fn markdown_to_plain_text(markdown: &str) -> String {
    let (_, normalized) = extract_manual_title_metadata(markdown);
    normalized
        .split('\n')
        .map(|line| {
            let trimmed = line.trim();

            if let Some(caps) = TOGGLE_BLOCK_RE.captures(trimmed) {
                return caps.get(2).map_or("", |m| m.as_str()).trim().to_string();
            }

            if trimmed == TOGGLE_BLOCK_END {
                return String::new();
            }

            PLAIN_TASK_RE.replace(line, "$1").to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

// ── Index I/O ──

fn get_index_path(auto_save_dir: &Path) -> PathBuf {
    auto_save_dir.join(INDEX_FILENAME)
}

#[derive(Debug)]
struct IndexSnapshot {
    index: NoteIndex,
    original_bytes: Option<Vec<u8>>,
}

#[derive(Debug)]
struct CorruptIndexState {
    issues: Vec<NoteLoadIssue>,
    backup_path: Option<PathBuf>,
}

#[derive(Debug)]
enum IndexReadState {
    Ready(IndexSnapshot),
    Corrupt(CorruptIndexState),
}

#[derive(Debug)]
enum IndexWriteFailure {
    Corrupt(CorruptIndexState),
    Issue(NoteLoadIssue),
}

fn empty_index() -> NoteIndex {
    NoteIndex {
        entries: HashMap::new(),
    }
}

fn validate_index_paths(
    auto_save_dir: &Path,
    index_path: &Path,
    index: &NoteIndex,
) -> Result<(), NoteLoadIssue> {
    let mut entries = index.entries.iter().collect::<Vec<_>>();
    entries.sort_by(|(left_id, _), (right_id, _)| left_id.cmp(right_id));

    for (note_id, entry) in entries {
        if let Err(error) = validate_library_relative_path(auto_save_dir, &entry.relative_path) {
            return Err(NoteLoadIssue::new(
                NoteLoadIssueKind::Index,
                "validate_index_path",
                &error.path,
                format!(
                    "index entry {note_id:?} has unsafe relativePath {:?}: {} (source index: {})",
                    entry.relative_path,
                    error.reason,
                    index_path.display()
                ),
            ));
        }
    }

    Ok(())
}

fn cleanup_file_with_reason(path: &Path, primary_reason: impl Into<String>) -> String {
    let primary_reason = primary_reason.into();
    match fs::remove_file(path) {
        Ok(()) => primary_reason,
        Err(cleanup_error) if cleanup_error.kind() == io::ErrorKind::NotFound => primary_reason,
        Err(cleanup_error) => format!(
            "{}; additionally failed to remove partial file {}: {}",
            primary_reason,
            path.display(),
            cleanup_error
        ),
    }
}

fn cleanup_failed_file(path: &Path, primary_error: io::Error) -> String {
    cleanup_file_with_reason(path, primary_error.to_string())
}

fn backup_corrupt_index(index_path: &Path, bytes: &[u8]) -> Result<PathBuf, NoteLoadIssue> {
    let parent = index_path.parent().unwrap_or_else(|| Path::new("."));
    let timestamp = now_millis();

    for counter in 0u32.. {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("-{}", counter + 1)
        };
        let candidate = parent.join(format!(
            "{}.corrupt-{}{}.bak",
            INDEX_FILENAME, timestamp, suffix
        ));
        let mut backup = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(NoteLoadIssue::new(
                    NoteLoadIssueKind::Index,
                    "backup_index",
                    &candidate,
                    error.to_string(),
                ));
            }
        };

        if let Err(error) = backup.write_all(bytes).and_then(|()| backup.sync_all()) {
            let reason = cleanup_failed_file(&candidate, error);
            return Err(NoteLoadIssue::new(
                NoteLoadIssueKind::Index,
                "backup_index",
                &candidate,
                reason,
            ));
        }

        return Ok(candidate);
    }

    unreachable!("corrupt index backup counter is unbounded")
}

fn read_index_state(auto_save_dir: &Path) -> IndexReadState {
    let index_path = get_index_path(auto_save_dir);
    if let Err(error) = ensure_trusted_library_root(auto_save_dir) {
        return IndexReadState::Corrupt(CorruptIndexState {
            issues: vec![NoteLoadIssue::new(
                NoteLoadIssueKind::Index,
                "validate_library_root",
                &error.path,
                error.reason,
            )],
            backup_path: None,
        });
    }
    match fs::symlink_metadata(&index_path) {
        Ok(metadata) if metadata_is_symlink_or_reparse_point(&metadata) => {
            return IndexReadState::Corrupt(CorruptIndexState {
                issues: vec![NoteLoadIssue::new(
                    NoteLoadIssueKind::Index,
                    "validate_index_file",
                    &index_path,
                    "the index file is a symbolic link or reparse point",
                )],
                backup_path: None,
            });
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return IndexReadState::Corrupt(CorruptIndexState {
                issues: vec![NoteLoadIssue::new(
                    NoteLoadIssueKind::Index,
                    "inspect_index_file",
                    &index_path,
                    error.to_string(),
                )],
                backup_path: None,
            });
        }
    }

    let bytes = match fs::read(&index_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return IndexReadState::Ready(IndexSnapshot {
                index: empty_index(),
                original_bytes: None,
            });
        }
        Err(error) => {
            return IndexReadState::Corrupt(CorruptIndexState {
                issues: vec![NoteLoadIssue::new(
                    NoteLoadIssueKind::Index,
                    "read_index",
                    &index_path,
                    error.to_string(),
                )],
                backup_path: None,
            });
        }
    };

    let parsed_index = serde_json::from_slice::<NoteIndex>(&bytes).map_err(|error| {
        NoteLoadIssue::new(
            NoteLoadIssueKind::Index,
            "parse_index",
            &index_path,
            error.to_string(),
        )
    });
    let validated_index = parsed_index.and_then(|index| {
        validate_index_paths(auto_save_dir, &index_path, &index)?;
        Ok(index)
    });

    match validated_index {
        Ok(index) => IndexReadState::Ready(IndexSnapshot {
            index,
            original_bytes: Some(bytes),
        }),
        Err(issue) => {
            let mut issues = vec![issue];
            let backup_path = match backup_corrupt_index(&index_path, &bytes) {
                Ok(path) => Some(path),
                Err(issue) => {
                    issues.push(issue);
                    None
                }
            };
            IndexReadState::Corrupt(CorruptIndexState {
                issues,
                backup_path,
            })
        }
    }
}

fn corrupt_index_error(state: &CorruptIndexState) -> String {
    let mut message = state
        .issues
        .iter()
        .map(NoteLoadIssue::display)
        .collect::<Vec<_>>()
        .join("; ");
    if let Some(path) = &state.backup_path {
        message.push_str(&format!("; corrupt index backup: {}", path.display()));
    }
    message
}

fn require_index_snapshot(auto_save_dir: &Path) -> Result<IndexSnapshot, String> {
    ensure_trusted_library_root(auto_save_dir)
        .map_err(|error| error.display("validate_library_root"))?;
    match read_index_state(auto_save_dir) {
        IndexReadState::Ready(snapshot) => Ok(snapshot),
        IndexReadState::Corrupt(state) => Err(corrupt_index_error(&state)),
    }
}

pub fn read_index(auto_save_dir: &Path) -> Result<NoteIndex, String> {
    require_index_snapshot(auto_save_dir).map(|snapshot| snapshot.index)
}

fn unique_index_tmp_path(index_path: &Path) -> Result<(PathBuf, fs::File), NoteLoadIssue> {
    let parent = index_path.parent().unwrap_or_else(|| Path::new("."));
    let timestamp = now_millis();

    for counter in 0u32.. {
        let candidate = parent.join(format!("{}.tmp-{}-{}", INDEX_FILENAME, timestamp, counter));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(NoteLoadIssue::new(
                    NoteLoadIssueKind::Index,
                    "create_index_temp",
                    &candidate,
                    error.to_string(),
                ));
            }
        }
    }

    unreachable!("index temp counter is unbounded")
}

fn verify_index_snapshot_unchanged(
    auto_save_dir: &Path,
    expected: &IndexSnapshot,
) -> Result<(), IndexWriteFailure> {
    let index_path = get_index_path(auto_save_dir);
    ensure_trusted_library_root(auto_save_dir).map_err(|error| {
        IndexWriteFailure::Issue(NoteLoadIssue::new(
            NoteLoadIssueKind::Index,
            "validate_library_root",
            &error.path,
            error.reason,
        ))
    })?;
    match read_index_state(auto_save_dir) {
        IndexReadState::Corrupt(state) => Err(IndexWriteFailure::Corrupt(state)),
        IndexReadState::Ready(current) if current.original_bytes == expected.original_bytes => {
            Ok(())
        }
        IndexReadState::Ready(_) => Err(IndexWriteFailure::Issue(NoteLoadIssue::new(
            NoteLoadIssueKind::Index,
            "verify_index_unchanged",
            &index_path,
            "the index changed while the operation was in progress; retry without overwriting it",
        ))),
    }
}

fn cleanup_index_temp_after_failure(
    tmp_path: &Path,
    mut failure: IndexWriteFailure,
) -> IndexWriteFailure {
    let cleanup_error = match fs::remove_file(tmp_path) {
        Ok(()) => return failure,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return failure,
        Err(error) => error,
    };
    let cleanup_reason = format!(
        "failed to remove index temp file {}: {}",
        tmp_path.display(),
        cleanup_error
    );

    match &mut failure {
        IndexWriteFailure::Corrupt(state) => state.issues.push(NoteLoadIssue::new(
            NoteLoadIssueKind::Index,
            "cleanup_index_temp",
            tmp_path,
            cleanup_reason,
        )),
        IndexWriteFailure::Issue(issue) => {
            issue.reason.push_str(&format!("; {cleanup_reason}"));
        }
    }
    failure
}

fn write_index_from_snapshot_after_temp_hook<F>(
    auto_save_dir: &Path,
    expected: &IndexSnapshot,
    index: &NoteIndex,
    before_final_verify: F,
) -> Result<(), IndexWriteFailure>
where
    F: FnOnce(),
{
    let index_path = get_index_path(auto_save_dir);
    verify_index_snapshot_unchanged(auto_save_dir, expected)?;
    validate_index_paths(auto_save_dir, &index_path, index).map_err(IndexWriteFailure::Issue)?;

    let json = serde_json::to_vec_pretty(index).map_err(|error| {
        IndexWriteFailure::Issue(NoteLoadIssue::new(
            NoteLoadIssueKind::Index,
            "serialize_index",
            &index_path,
            error.to_string(),
        ))
    })?;
    let (tmp_path, mut tmp_file) =
        unique_index_tmp_path(&index_path).map_err(IndexWriteFailure::Issue)?;

    if let Err(error) = tmp_file.write_all(&json).and_then(|()| tmp_file.sync_all()) {
        let reason = cleanup_failed_file(&tmp_path, error);
        return Err(IndexWriteFailure::Issue(NoteLoadIssue::new(
            NoteLoadIssueKind::Index,
            "write_index_temp",
            &tmp_path,
            reason,
        )));
    }
    drop(tmp_file);

    before_final_verify();
    if let Err(failure) = verify_index_snapshot_unchanged(auto_save_dir, expected) {
        return Err(cleanup_index_temp_after_failure(&tmp_path, failure));
    }

    if let Err(error) = fs::rename(&tmp_path, &index_path) {
        let reason = cleanup_failed_file(&tmp_path, error);
        return Err(IndexWriteFailure::Issue(NoteLoadIssue::new(
            NoteLoadIssueKind::Index,
            "replace_index",
            &index_path,
            reason,
        )));
    }

    Ok(())
}

fn write_index_from_snapshot(
    auto_save_dir: &Path,
    expected: &IndexSnapshot,
    index: &NoteIndex,
) -> Result<(), IndexWriteFailure> {
    write_index_from_snapshot_after_temp_hook(auto_save_dir, expected, index, || {})
}

fn index_write_failure_to_string(failure: IndexWriteFailure) -> String {
    match failure {
        IndexWriteFailure::Corrupt(state) => corrupt_index_error(&state),
        IndexWriteFailure::Issue(issue) => issue.display(),
    }
}

#[cfg(test)]
pub fn write_index(auto_save_dir: &Path, index: &NoteIndex) -> Result<(), String> {
    let expected = require_index_snapshot(auto_save_dir)?;
    write_index_from_snapshot(auto_save_dir, &expected, index)
        .map_err(index_write_failure_to_string)
}

// ── File system helpers ──

fn should_skip_subtree(path: &Path, skip_subtree: Option<&Path>) -> bool {
    skip_subtree.is_some_and(|skip| path.starts_with(skip))
}

#[derive(Debug)]
struct FileSystemOperationError {
    operation: &'static str,
    path: PathBuf,
    reason: String,
}

impl FileSystemOperationError {
    fn from_io(operation: &'static str, path: &Path, error: io::Error) -> Self {
        Self {
            operation,
            path: path.to_path_buf(),
            reason: error.to_string(),
        }
    }

    #[cfg(test)]
    fn injected(operation: &'static str, path: &Path, reason: impl Into<String>) -> Self {
        Self {
            operation,
            path: path.to_path_buf(),
            reason: reason.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LibraryEntryType {
    Directory,
    File,
    Symlink,
    Other,
}

trait LibraryFileSystem {
    fn read_dir(&self, path: &Path) -> Result<Vec<PathBuf>, FileSystemOperationError>;
    fn entry_type(&self, path: &Path) -> Result<LibraryEntryType, FileSystemOperationError>;
    fn read_markdown(&self, path: &Path) -> Result<String, FileSystemOperationError>;
    fn markdown_metadata(&self, path: &Path) -> Result<fs::Metadata, FileSystemOperationError>;
}

#[derive(Debug, Default, Clone, Copy)]
struct ProductionFileSystem;

impl LibraryFileSystem for ProductionFileSystem {
    fn read_dir(&self, path: &Path) -> Result<Vec<PathBuf>, FileSystemOperationError> {
        let entries = fs::read_dir(path)
            .map_err(|error| FileSystemOperationError::from_io("read_dir", path, error))?;
        let mut paths = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| {
                FileSystemOperationError::from_io("read_dir_entry", path, error)
            })?;
            paths.push(entry.path());
        }
        paths.sort();
        Ok(paths)
    }

    fn entry_type(&self, path: &Path) -> Result<LibraryEntryType, FileSystemOperationError> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| FileSystemOperationError::from_io("entry_file_type", path, error))?;
        Ok(if metadata_is_symlink_or_reparse_point(&metadata) {
            LibraryEntryType::Symlink
        } else if metadata.is_dir() {
            LibraryEntryType::Directory
        } else if metadata.is_file() {
            LibraryEntryType::File
        } else {
            LibraryEntryType::Other
        })
    }

    fn read_markdown(&self, path: &Path) -> Result<String, FileSystemOperationError> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| FileSystemOperationError::from_io("read_markdown", path, error))?;
        if metadata_is_symlink_or_reparse_point(&metadata) {
            return Err(FileSystemOperationError {
                operation: "read_markdown",
                path: path.to_path_buf(),
                reason: "refusing to read a symbolic link or reparse point".to_string(),
            });
        }
        fs::read_to_string(path)
            .map_err(|error| FileSystemOperationError::from_io("read_markdown", path, error))
    }

    fn markdown_metadata(&self, path: &Path) -> Result<fs::Metadata, FileSystemOperationError> {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| FileSystemOperationError::from_io("read_metadata", path, error))?;
        if metadata_is_symlink_or_reparse_point(&metadata) {
            return Err(FileSystemOperationError {
                operation: "read_metadata",
                path: path.to_path_buf(),
                reason: "refusing metadata for a symbolic link or reparse point".to_string(),
            });
        }
        Ok(metadata)
    }
}

#[derive(Debug)]
struct ScannedMarkdown {
    full_path: PathBuf,
    markdown: String,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Default)]
struct LibraryScan {
    files: HashMap<String, ScannedMarkdown>,
    folders: Vec<String>,
    issues: Vec<NoteLoadIssue>,
}

impl LibraryScan {
    fn is_complete(&self) -> bool {
        self.issues.is_empty()
    }

    fn finish(&mut self) {
        self.folders.sort();
        self.folders.dedup();
    }
}

fn issue_kind_for_operation(operation: &str) -> NoteLoadIssueKind {
    match operation {
        "read_markdown" => NoteLoadIssueKind::FileRead,
        "read_metadata" | "read_modified_time" => NoteLoadIssueKind::FileMetadata,
        _ => NoteLoadIssueKind::Scan,
    }
}

fn scan_issue(error: FileSystemOperationError) -> NoteLoadIssue {
    NoteLoadIssue::new(
        issue_kind_for_operation(error.operation),
        error.operation,
        &error.path,
        error.reason,
    )
}

fn scan_library_directory<F: LibraryFileSystem>(
    file_system: &F,
    root_dir: &Path,
    current_dir: &Path,
    skip_subtree: Option<&Path>,
    include_markdown: bool,
    scan: &mut LibraryScan,
) {
    let entries = match file_system.read_dir(current_dir) {
        Ok(entries) => entries,
        Err(error) => {
            scan.issues.push(scan_issue(error));
            return;
        }
    };

    for path in entries {
        if should_skip_subtree(&path, skip_subtree) {
            continue;
        }

        let entry_type = match file_system.entry_type(&path) {
            Ok(entry_type) => entry_type,
            Err(error) => {
                scan.issues.push(scan_issue(error));
                continue;
            }
        };

        match entry_type {
            LibraryEntryType::Directory => {
                let relative = strip_inbox_root_alias(&relative_path(root_dir, &path));
                if !relative.is_empty() {
                    scan.folders.push(relative);
                }
                scan_library_directory(
                    file_system,
                    root_dir,
                    &path,
                    skip_subtree,
                    include_markdown,
                    scan,
                );
            }
            LibraryEntryType::File if include_markdown && is_markdown_path(&path) => {
                let markdown = file_system.read_markdown(&path);
                let metadata = file_system.markdown_metadata(&path);

                let markdown = match markdown {
                    Ok(markdown) => Some(markdown),
                    Err(error) => {
                        scan.issues.push(scan_issue(error));
                        None
                    }
                };
                let timestamps = match metadata {
                    Ok(metadata) => match metadata.modified() {
                        Ok(modified) => {
                            let updated_at = system_time_to_millis(modified);
                            let created_at = metadata
                                .created()
                                .map(system_time_to_millis)
                                .unwrap_or(updated_at);
                            Some((created_at, updated_at))
                        }
                        Err(error) => {
                            scan.issues.push(NoteLoadIssue::new(
                                NoteLoadIssueKind::FileMetadata,
                                "read_modified_time",
                                &path,
                                error.to_string(),
                            ));
                            None
                        }
                    },
                    Err(error) => {
                        scan.issues.push(scan_issue(error));
                        None
                    }
                };

                if let (Some(markdown), Some((created_at, updated_at))) = (markdown, timestamps) {
                    scan.files.insert(
                        relative_path(root_dir, &path),
                        ScannedMarkdown {
                            full_path: path,
                            markdown,
                            created_at,
                            updated_at,
                        },
                    );
                }
            }
            LibraryEntryType::Symlink => {
                scan.issues.push(NoteLoadIssue::new(
                    NoteLoadIssueKind::Scan,
                    "reject_symlink",
                    &path,
                    "symbolic links and reparse points beneath the note library are not allowed",
                ));
            }
            LibraryEntryType::File | LibraryEntryType::Other => {}
        }
    }
}

fn scan_library_tree<F: LibraryFileSystem>(
    file_system: &F,
    root_dir: &Path,
    skip_subtree: Option<&Path>,
    include_markdown: bool,
) -> LibraryScan {
    let mut scan = LibraryScan::default();
    if let Err(error) = ensure_trusted_library_root(root_dir) {
        scan.issues.push(NoteLoadIssue::new(
            NoteLoadIssueKind::Scan,
            "validate_library_root",
            &error.path,
            error.reason,
        ));
        return scan;
    }
    scan_library_directory(
        file_system,
        root_dir,
        root_dir,
        skip_subtree,
        include_markdown,
        &mut scan,
    );
    scan.finish();
    scan
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
}

fn ensure_unique_file_path(
    target_dir: &Path,
    base_name: &str,
    except_path: Option<&Path>,
) -> Result<PathBuf, String> {
    let mut counter = 1;

    loop {
        let suffix = if counter == 1 {
            String::new()
        } else {
            format!("-{}", counter)
        };
        let candidate = target_dir.join(format!("{}{}.md", base_name, suffix));

        if let Some(except) = except_path {
            if to_posix(&candidate.to_string_lossy()) == to_posix(&except.to_string_lossy()) {
                match fs::symlink_metadata(&candidate) {
                    Ok(metadata) if metadata_is_symlink_or_reparse_point(&metadata) => {
                        return Err(format!(
                            "validate_note_target failed for {}: symbolic links and reparse points are not allowed",
                            candidate.display()
                        ));
                    }
                    Ok(_) => return Ok(candidate),
                    Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
                    Err(error) => {
                        return Err(format!(
                            "inspect_note_target failed for {}: {}",
                            candidate.display(),
                            error
                        ));
                    }
                }
            }
        }

        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata_is_symlink_or_reparse_point(&metadata) => {
                return Err(format!(
                    "validate_note_target failed for {}: symbolic links and reparse points are not allowed",
                    candidate.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => {
                return Err(format!(
                    "inspect_note_target failed for {}: {}",
                    candidate.display(),
                    error
                ));
            }
        }

        counter += 1;
    }
}

fn unique_note_temp_file(destination: &Path) -> Result<(PathBuf, fs::File), String> {
    let target_dir = destination.parent().ok_or_else(|| {
        format!(
            "create_note_temp failed for {}: destination has no parent directory",
            destination.display()
        )
    })?;
    let timestamp = now_millis();

    for counter in 0u32.. {
        let candidate = target_dir.join(format!(
            ".hwan-note-write-{}-{}-{}.tmp",
            process_id(),
            timestamp,
            counter
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => return Ok((candidate, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(format!(
                    "create_note_temp failed for {}: {}",
                    candidate.display(),
                    error
                ));
            }
        }
    }

    unreachable!("note temp counter is unbounded")
}

fn process_id() -> u32 {
    std::process::id()
}

fn validate_note_destination_before_replace(
    root_dir: &Path,
    destination: &Path,
) -> Result<(), String> {
    ensure_trusted_library_root(root_dir)
        .map_err(|error| error.display("validate_library_root"))?;
    let relative_path = destination.strip_prefix(root_dir).map_err(|error| {
        format!(
            "validate_note_destination failed for {}: destination is outside {}: {}",
            destination.display(),
            root_dir.display(),
            error
        )
    })?;
    if relative_path.as_os_str().is_empty() {
        return Err(format!(
            "validate_note_destination failed for {}: destination cannot be the library root",
            destination.display()
        ));
    }
    validate_no_symlink_beneath_root(root_dir, relative_path)
        .map_err(|error| error.display("validate_note_destination"))
}

fn write_note_file_atomically_after_temp_hook<F>(
    root_dir: &Path,
    destination: &Path,
    content: &str,
    before_destination_validation: F,
) -> Result<(), String>
where
    F: FnOnce(),
{
    validate_note_destination_before_replace(root_dir, destination)?;
    let (tmp_path, mut tmp_file) = unique_note_temp_file(destination)?;
    let write_result = tmp_file
        .write_all(content.as_bytes())
        .and_then(|()| tmp_file.sync_all());
    if let Err(error) = write_result {
        drop(tmp_file);
        return Err(cleanup_file_with_reason(
            &tmp_path,
            format!(
                "write_note_temp failed for {} before replacing {}: {}",
                tmp_path.display(),
                destination.display(),
                error
            ),
        ));
    }
    drop(tmp_file);

    before_destination_validation();
    if let Err(error) = validate_note_destination_before_replace(root_dir, destination) {
        return Err(cleanup_file_with_reason(&tmp_path, error));
    }
    if let Err(error) = fs::rename(&tmp_path, destination) {
        return Err(cleanup_file_with_reason(
            &tmp_path,
            format!(
                "replace_note failed for {} using {}: {}",
                destination.display(),
                tmp_path.display(),
                error
            ),
        ));
    }

    Ok(())
}

fn write_note_file_atomically(
    root_dir: &Path,
    destination: &Path,
    content: &str,
) -> Result<(), String> {
    write_note_file_atomically_after_temp_hook(root_dir, destination, content, || {})
}

fn relative_path(from: &Path, to: &Path) -> String {
    match to.strip_prefix(from) {
        Ok(rel) => to_posix(&rel.to_string_lossy()),
        Err(_) => to_posix(&to.to_string_lossy()),
    }
}

fn reconcile_index_with_scan(index: &NoteIndex, scan: &LibraryScan) -> (NoteIndex, bool) {
    let mut reconciled = index.clone();
    let mut used_paths: HashSet<String> = HashSet::new();
    let mut index_changed = false;

    let missing_ids: Vec<String> = reconciled
        .entries
        .iter()
        .filter(|(_, entry)| !scan.files.contains_key(&entry.relative_path))
        .map(|(id, _)| id.clone())
        .collect();

    for id in &missing_ids {
        reconciled.entries.remove(id);
        index_changed = true;
    }

    for entry in reconciled.entries.values() {
        used_paths.insert(entry.relative_path.clone());
    }
    let mut existing_ids = reconciled.entries.keys().cloned().collect::<HashSet<_>>();

    let mut relative_paths = scan.files.keys().cloned().collect::<Vec<_>>();
    relative_paths.sort();
    for rel_path in relative_paths {
        if used_paths.contains(&rel_path) {
            continue;
        }

        let scanned = scan
            .files
            .get(&rel_path)
            .expect("relative path came from the scan map");
        let generated_id = ensure_unique_note_id(&existing_ids, &rel_path);
        let manual_title = extract_manual_title_metadata(&scanned.markdown).0;

        reconciled.entries.insert(
            generated_id.clone(),
            NoteIndexEntry {
                relative_path: rel_path.clone(),
                created_at: scanned.created_at,
                manual_title,
                is_pinned: None,
            },
        );
        existing_ids.insert(generated_id);
        used_paths.insert(rel_path);
        index_changed = true;
    }

    for entry in reconciled.entries.values_mut() {
        if entry.manual_title.is_some() {
            continue;
        }
        let Some(scanned) = scan.files.get(&entry.relative_path) else {
            continue;
        };
        if let Some(recovered_title) = extract_manual_title_metadata(&scanned.markdown).0 {
            entry.manual_title = Some(recovered_title);
            index_changed = true;
        }
    }

    (reconciled, index_changed)
}

fn ensure_unique_note_id(existing_ids: &HashSet<String>, seed: &str) -> String {
    let mut counter = 0u32;

    loop {
        let candidate_seed = if counter == 0 {
            seed.to_string()
        } else {
            format!("{}#{}", seed, counter + 1)
        };
        let candidate = generate_note_id(&candidate_seed);
        if !existing_ids.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

pub fn generate_note_id(relative_file_path: &str) -> String {
    let mut hasher = sha1::Sha1::new();
    hasher.update(relative_file_path.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("note-{}", &hash[..12])
}

// ── Public API ──

pub fn get_auto_save_dir(documents_dir: &Path) -> PathBuf {
    documents_dir.join("HwanNote").join("Notes")
}

pub fn save_markdown_file(file_path: &Path, content: &str) -> Result<(), String> {
    let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext.to_lowercase() != "md" {
        return Err("Only .md files are supported.".to_string());
    }
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(file_path, content).map_err(|e| e.to_string())
}

pub fn read_markdown_file(file_path: &Path) -> Result<String, String> {
    let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext.to_lowercase() != "md" {
        return Err("Only .md files are supported.".to_string());
    }
    fs::read_to_string(file_path).map_err(|e| e.to_string())
}

pub fn list_markdown_files(dir_path: &Path) -> Result<Vec<String>, String> {
    ensure_trusted_library_root(dir_path)
        .map_err(|error| error.display("validate_library_root"))?;
    let entries = fs::read_dir(dir_path)
        .map_err(|error| format!("read_dir failed for {}: {}", dir_path.display(), error))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "read_dir_entry failed for {}: {}",
                dir_path.display(),
                error
            )
        })?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("entry_file_type failed for {}: {}", path.display(), error))?;
        if metadata_is_symlink_or_reparse_point(&metadata) {
            return Err(format!(
                "reject_symlink failed for {}: symbolic links and reparse points beneath the note library are not allowed",
                path.display()
            ));
        }
        if metadata.is_file() && is_markdown_path(&path) {
            files.push(path.to_string_lossy().to_string());
        }
    }
    Ok(files)
}

fn list_folders_with_fs<F: LibraryFileSystem>(
    auto_save_dir: &Path,
    file_system: &F,
) -> Result<Vec<String>, String> {
    ensure_trusted_library_root(auto_save_dir)
        .map_err(|error| error.display("validate_library_root"))?;

    let scan = scan_library_tree(file_system, auto_save_dir, None, false);
    if scan.is_complete() {
        Ok(scan.folders)
    } else {
        Err(scan
            .issues
            .iter()
            .map(NoteLoadIssue::display)
            .collect::<Vec<_>>()
            .join("; "))
    }
}

pub fn list_folders(auto_save_dir: &Path) -> Result<Vec<String>, String> {
    list_folders_with_fs(auto_save_dir, &ProductionFileSystem)
}

pub fn create_folder(auto_save_dir: &Path, folder_path: &str) -> Result<Vec<String>, String> {
    let normalized = sanitize_folder_path(Some(folder_path))?;
    if normalized.is_empty() {
        return Err("Folder path is required.".to_string());
    }

    let relative_path = normalize_library_relative_path(auto_save_dir, &normalized)
        .map_err(|error| error.display("validate_folder_path"))?;
    ensure_library_subdirectory(auto_save_dir, &relative_path)?;
    list_folders(auto_save_dir)
}

pub fn rename_folder(auto_save_dir: &Path, from: &str, to: &str) -> Result<Vec<String>, String> {
    ensure_trusted_library_root(auto_save_dir)
        .map_err(|error| error.display("validate_library_root"))?;

    let from_path = sanitize_folder_path(Some(from))?;
    let to_path = sanitize_folder_path(Some(to))?;

    if from_path.is_empty() || to_path.is_empty() {
        return Err("Folder path is required.".to_string());
    }
    if from_path == to_path {
        return list_folders(auto_save_dir);
    }
    if to_path.starts_with(&format!("{}/", from_path)) {
        return Err("Cannot move a folder into its own child.".to_string());
    }
    let from_relative = normalize_library_relative_path(auto_save_dir, &from_path)
        .map_err(|error| error.display("validate_source_folder"))?;
    let to_relative = normalize_library_relative_path(auto_save_dir, &to_path)
        .map_err(|error| error.display("validate_target_folder"))?;

    let _index_guard = lock_note_index();
    let index_snapshot = require_index_snapshot(auto_save_dir)?;
    let mut index = index_snapshot.index.clone();

    validate_no_symlink_beneath_root(auto_save_dir, &from_relative)
        .map_err(|error| error.display("validate_source_folder"))?;
    let source_dir = auto_save_dir.join(&from_relative);
    if !source_dir.exists() {
        return Err("Folder not found.".to_string());
    }

    validate_no_symlink_beneath_root(auto_save_dir, &to_relative)
        .map_err(|error| error.display("validate_target_folder"))?;
    let target_dir = auto_save_dir.join(&to_relative);
    if target_dir.exists() {
        return Err("Target folder already exists.".to_string());
    }

    if let Some(parent_relative) = to_relative.parent() {
        ensure_library_subdirectory(auto_save_dir, parent_relative)?;
    }

    fs::rename(&source_dir, &target_dir).map_err(|e| e.to_string())?;

    let from_prefix = format!("{}/", from_path);
    let to_prefix = format!("{}/", to_path);
    let mut index_changed = false;

    for entry in index.entries.values_mut() {
        if entry.relative_path.starts_with(&from_prefix) {
            entry.relative_path =
                format!("{}{}", to_prefix, &entry.relative_path[from_prefix.len()..]);
            index_changed = true;
        }
    }

    if index_changed {
        write_index_from_snapshot(auto_save_dir, &index_snapshot, &index)
            .map_err(index_write_failure_to_string)?;
    }

    list_folders(auto_save_dir)
}

pub fn delete_folder(
    auto_save_dir: &Path,
    folder_path: &str,
) -> Result<FolderDeleteResult, String> {
    ensure_trusted_library_root(auto_save_dir)
        .map_err(|error| error.display("validate_library_root"))?;

    let normalized = sanitize_folder_path(Some(folder_path))?;
    if normalized.is_empty() {
        return Err("Folder path is required.".to_string());
    }

    let _index_guard = lock_note_index();
    let index_snapshot = require_index_snapshot(auto_save_dir)?;
    let folder_relative = normalize_library_relative_path(auto_save_dir, &normalized)
        .map_err(|error| error.display("validate_folder_path"))?;
    validate_no_symlink_beneath_root(auto_save_dir, &folder_relative)
        .map_err(|error| error.display("validate_folder_path"))?;

    let source_dir = auto_save_dir.join(&folder_relative);
    let prefix = format!("{}/", normalized);
    let mut index = index_snapshot.index.clone();
    let matching_entries = index
        .entries
        .iter()
        .filter_map(|(note_id, entry)| {
            if entry.relative_path.starts_with(&prefix) {
                Some((note_id.clone(), entry.relative_path.clone()))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    if !source_dir.exists() && matching_entries.is_empty() {
        return Err("Folder not found.".to_string());
    }

    let mut moved_note_ids = Vec::new();

    for (note_id, old_relative_path) in matching_entries {
        let old_path = validated_library_file_path(auto_save_dir, &old_relative_path)?;
        if !old_path.exists() {
            return Err(format!(
                "Note file missing during folder delete: {}",
                old_relative_path
            ));
        }

        let base_name = old_path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("untitled");
        let new_path = ensure_unique_file_path(auto_save_dir, base_name, None)?;
        fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;

        if let Some(entry) = index.entries.get_mut(&note_id) {
            entry.relative_path = relative_path(auto_save_dir, &new_path);
        }
        moved_note_ids.push(note_id);
    }

    write_index_from_snapshot(auto_save_dir, &index_snapshot, &index)
        .map_err(index_write_failure_to_string)?;

    if source_dir.exists() {
        fs::remove_dir_all(&source_dir).map_err(|e| e.to_string())?;
    }

    Ok(FolderDeleteResult {
        folders: list_folders(auto_save_dir)?,
        moved_note_ids,
    })
}

pub fn auto_save_markdown_note(
    auto_save_dir: &Path,
    payload: &AutoSavePayload,
) -> Result<AutoSaveResult, String> {
    let safe_id = {
        let sanitized = sanitize_note_id(&payload.note_id);
        if sanitized.is_empty() {
            "note".to_string()
        } else {
            sanitized
        }
    };
    let safe_folder = sanitize_folder_path(payload.folder_path.as_deref())?;
    let safe_folder_path = if safe_folder.is_empty() {
        PathBuf::new()
    } else {
        normalize_library_relative_path(auto_save_dir, &safe_folder)
            .map_err(|error| error.display("validate_note_folder"))?
    };

    let _index_guard = lock_note_index();
    let index_snapshot = require_index_snapshot(auto_save_dir)?;
    let mut index = index_snapshot.index.clone();

    let target_dir = ensure_library_subdirectory(auto_save_dir, &safe_folder_path)?;
    let existing_entry = index.entries.get(&safe_id).cloned();
    let existing_path = existing_entry
        .as_ref()
        .map(|entry| validated_library_file_path(auto_save_dir, &entry.relative_path))
        .transpose()?;

    let title_for_slug = if payload.title.is_empty() {
        derive_title(&payload.content)
    } else {
        payload.title.clone()
    };
    let base_name = slugify_title(&title_for_slug);
    let next_file_path =
        ensure_unique_file_path(&target_dir, &base_name, existing_path.as_deref())?;
    let manual_title = if payload.is_title_manual.unwrap_or(false) {
        normalize_manual_title(&payload.title)
    } else {
        None
    };
    let stored_markdown = embed_manual_title_metadata(&payload.content, manual_title.as_deref());

    validate_no_symlink_beneath_root(auto_save_dir, &safe_folder_path)
        .map_err(|error| error.display("validate_note_folder"))?;
    write_note_file_atomically(
        auto_save_dir,
        &next_file_path,
        &to_platform_line_endings(&stored_markdown),
    )?;

    // Remove old file if path changed
    if let Some(ref old_path) = existing_path {
        if to_posix(&old_path.to_string_lossy()) != to_posix(&next_file_path.to_string_lossy()) {
            fs::remove_file(old_path).map_err(|error| {
                format!(
                    "remove_old_note failed for {}: {}",
                    old_path.display(),
                    error
                )
            })?;
        }
    }

    let metadata = fs::symlink_metadata(&next_file_path).map_err(|error| {
        format!(
            "read_saved_note_metadata failed for {}: {}",
            next_file_path.display(),
            error
        )
    })?;
    if metadata_is_symlink_or_reparse_point(&metadata) {
        return Err(format!(
            "validate_saved_note failed for {}: symbolic links and reparse points are not allowed",
            next_file_path.display()
        ));
    }
    let created_at = existing_entry
        .map(|e| e.created_at)
        .unwrap_or_else(now_millis);
    let updated_at = system_time_to_millis(metadata.modified().map_err(|error| {
        format!(
            "read_saved_note_modified_time failed for {}: {}",
            next_file_path.display(),
            error
        )
    })?);

    let rel = relative_path(auto_save_dir, &next_file_path);

    index.entries.insert(
        safe_id.clone(),
        NoteIndexEntry {
            relative_path: rel,
            created_at,
            manual_title,
            is_pinned: payload.is_pinned,
        },
    );

    write_index_from_snapshot(auto_save_dir, &index_snapshot, &index)
        .map_err(index_write_failure_to_string)?;

    Ok(AutoSaveResult {
        file_path: next_file_path.to_string_lossy().to_string(),
        note_id: safe_id,
        created_at,
        updated_at,
    })
}

fn materialize_notes(index: &NoteIndex, scan: &LibraryScan) -> Vec<LoadedNote> {
    let mut notes = Vec::new();

    for (note_id, entry) in &index.entries {
        let Some(scanned) = scan.files.get(&entry.relative_path) else {
            continue;
        };
        let (embedded_manual_title, markdown) = extract_manual_title_metadata(&scanned.markdown);
        let indexed_manual_title = entry
            .manual_title
            .as_deref()
            .and_then(normalize_manual_title);
        let effective_manual_title = indexed_manual_title.or(embedded_manual_title);
        let title = effective_manual_title
            .clone()
            .unwrap_or_else(|| derive_title(&markdown));
        let folder_path = entry
            .relative_path
            .rfind('/')
            .map(|index| strip_inbox_root_alias(&entry.relative_path[..index]))
            .unwrap_or_default();

        notes.push(LoadedNote {
            note_id: note_id.clone(),
            title,
            is_title_manual: effective_manual_title.is_some(),
            plain_text: markdown_to_plain_text(&markdown),
            markdown,
            folder_path,
            created_at: entry.created_at,
            updated_at: scanned.updated_at,
            file_path: scanned.full_path.to_string_lossy().to_string(),
            is_pinned: entry.is_pinned.unwrap_or(false),
        });
    }

    notes.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.note_id.cmp(&right.note_id))
    });
    notes
}

fn incomplete_load_result(
    auto_save_dir: &Path,
    index: &NoteIndex,
    scan: LibraryScan,
    issues: Vec<NoteLoadIssue>,
) -> MarkdownLibraryLoadResult {
    MarkdownLibraryLoadResult {
        notes: materialize_notes(index, &scan),
        folders: scan.folders,
        load_state: NoteLoadState::Incomplete,
        issues,
        index_source_path: Some(get_index_path(auto_save_dir).to_string_lossy().to_string()),
        index_backup_path: None,
    }
}

fn load_markdown_library_with_fs<F: LibraryFileSystem>(
    auto_save_dir: &Path,
    file_system: &F,
) -> MarkdownLibraryLoadResult {
    let index_source_path = get_index_path(auto_save_dir);
    if let Err(error) = ensure_trusted_library_root(auto_save_dir) {
        return MarkdownLibraryLoadResult {
            notes: Vec::new(),
            folders: Vec::new(),
            load_state: NoteLoadState::Incomplete,
            issues: vec![NoteLoadIssue::new(
                NoteLoadIssueKind::Scan,
                "validate_library_root",
                &error.path,
                error.reason,
            )],
            index_source_path: Some(index_source_path.to_string_lossy().to_string()),
            index_backup_path: None,
        };
    }

    let _index_guard = lock_note_index();
    let index_snapshot = match read_index_state(auto_save_dir) {
        IndexReadState::Ready(snapshot) => snapshot,
        IndexReadState::Corrupt(state) => {
            return MarkdownLibraryLoadResult {
                notes: Vec::new(),
                folders: Vec::new(),
                load_state: NoteLoadState::IndexCorrupt,
                issues: state.issues,
                index_source_path: Some(index_source_path.to_string_lossy().to_string()),
                index_backup_path: state
                    .backup_path
                    .map(|path| path.to_string_lossy().to_string()),
            };
        }
    };

    let scan = scan_library_tree(file_system, auto_save_dir, None, true);
    if !scan.is_complete() {
        let issues = scan.issues.clone();
        return incomplete_load_result(auto_save_dir, &index_snapshot.index, scan, issues);
    }

    let (reconciled_index, index_changed) = reconcile_index_with_scan(&index_snapshot.index, &scan);
    let notes = materialize_notes(&reconciled_index, &scan);

    if index_changed {
        match write_index_from_snapshot(auto_save_dir, &index_snapshot, &reconciled_index) {
            Ok(()) => {}
            Err(IndexWriteFailure::Corrupt(state)) => {
                return MarkdownLibraryLoadResult {
                    notes: materialize_notes(&index_snapshot.index, &scan),
                    folders: scan.folders,
                    load_state: NoteLoadState::IndexCorrupt,
                    issues: state.issues,
                    index_source_path: Some(index_source_path.to_string_lossy().to_string()),
                    index_backup_path: state
                        .backup_path
                        .map(|path| path.to_string_lossy().to_string()),
                };
            }
            Err(IndexWriteFailure::Issue(issue)) => {
                return incomplete_load_result(
                    auto_save_dir,
                    &index_snapshot.index,
                    scan,
                    vec![issue],
                );
            }
        }
    }

    MarkdownLibraryLoadResult {
        notes,
        folders: scan.folders,
        load_state: NoteLoadState::Ready,
        issues: Vec::new(),
        index_source_path: Some(index_source_path.to_string_lossy().to_string()),
        index_backup_path: None,
    }
}

pub fn load_markdown_library(auto_save_dir: &Path) -> MarkdownLibraryLoadResult {
    load_markdown_library_with_fs(auto_save_dir, &ProductionFileSystem)
}

#[cfg(test)]
pub fn load_markdown_notes(auto_save_dir: &Path) -> Result<Vec<LoadedNote>, String> {
    let result = load_markdown_library(auto_save_dir);
    if result.load_state == NoteLoadState::Ready {
        Ok(result.notes)
    } else {
        let mut message = result
            .issues
            .iter()
            .map(NoteLoadIssue::display)
            .collect::<Vec<_>>()
            .join("; ");
        if let Some(path) = result.index_backup_path {
            message.push_str(&format!("; corrupt index backup: {path}"));
        }
        Err(message)
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn resolve_note_file_path(
    auto_save_dir: &Path,
    note_id: &str,
) -> Result<Option<PathBuf>, String> {
    let _index_guard = lock_note_index();
    resolve_note_file_path_unlocked(auto_save_dir, note_id)
}

fn resolve_note_file_path_unlocked(
    auto_save_dir: &Path,
    note_id: &str,
) -> Result<Option<PathBuf>, String> {
    let safe_id = sanitize_note_id(note_id);
    if safe_id.is_empty() {
        return Ok(None);
    }

    let index = read_index(auto_save_dir)?;
    let entry = match index.entries.get(&safe_id) {
        Some(e) => e,
        None => return Ok(None),
    };

    Ok(Some(validated_library_file_path(
        auto_save_dir,
        &entry.relative_path,
    )?))
}

fn trash_note_file_or_accept_missing<F>(file_path: &Path, delete_file: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    match delete_file(file_path) {
        Ok(()) => Ok(()),
        Err(delete_error) => match file_path
            .try_exists()
            .map_err(|e| format!("Failed to recheck note file after trash error: {e}"))?
        {
            false => Ok(()),
            true => Err(delete_error),
        },
    }
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn remove_note_from_index_if_path(
    auto_save_dir: &Path,
    note_id: &str,
    expected_file_path: &Path,
) -> Result<Option<PathBuf>, String> {
    let safe_id = sanitize_note_id(note_id);
    if safe_id.is_empty() {
        return Ok(None);
    }

    let _index_guard = lock_note_index();
    remove_note_from_index_if_path_unlocked(auto_save_dir, note_id, expected_file_path)
}

fn remove_note_from_index_if_path_unlocked(
    auto_save_dir: &Path,
    note_id: &str,
    expected_file_path: &Path,
) -> Result<Option<PathBuf>, String> {
    let safe_id = sanitize_note_id(note_id);
    if safe_id.is_empty() {
        return Ok(None);
    }

    let index_snapshot = require_index_snapshot(auto_save_dir)?;
    let mut index = index_snapshot.index.clone();
    let entry = match index.entries.get(&safe_id) {
        Some(e) => e.clone(),
        None => return Ok(None),
    };

    let file_path = validated_library_file_path(auto_save_dir, &entry.relative_path)?;
    if file_path != expected_file_path {
        return Err("Note index changed before delete completed".to_string());
    }
    if expected_file_path
        .try_exists()
        .map_err(|e| format!("Failed to check note file before delete cleanup: {e}"))?
    {
        return Err("Note file changed before delete completed".to_string());
    }

    index.entries.remove(&safe_id);
    write_index_from_snapshot(auto_save_dir, &index_snapshot, &index)
        .map_err(index_write_failure_to_string)?;
    Ok(Some(file_path))
}

pub fn delete_note_file_and_index<F>(
    auto_save_dir: &Path,
    note_id: &str,
    delete_file: F,
) -> Result<bool, String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let _index_guard = lock_note_index();
    let file_path = match resolve_note_file_path_unlocked(auto_save_dir, note_id)? {
        Some(p) => p,
        None => return Ok(false),
    };

    if file_path
        .try_exists()
        .map_err(|e| format!("Failed to check note file before delete: {e}"))?
    {
        trash_note_file_or_accept_missing(&file_path, delete_file)?;
    }

    let removed = remove_note_from_index_if_path_unlocked(auto_save_dir, note_id, &file_path)?;
    Ok(removed.is_some())
}

pub fn normalize_external_txt_path(
    raw_path: &str,
    base_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim().trim_matches('"');
    if trimmed.is_empty() {
        return Err("File path is required.".to_string());
    }

    let candidate = PathBuf::from(trimmed);
    let resolved = if candidate.is_absolute() {
        candidate
    } else if let Some(base) = base_dir {
        base.join(candidate)
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(candidate)
    };

    let normalized = fs::canonicalize(&resolved).map_err(|_| "Text file not found.".to_string())?;
    let metadata = fs::metadata(&normalized).map_err(|e| e.to_string())?;

    if !metadata.is_file() {
        return Err("Only files can be opened.".to_string());
    }

    let ext = normalized
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if !ext.eq_ignore_ascii_case("txt") {
        return Err("Only .txt files are supported.".to_string());
    }

    Ok(normalized)
}

pub fn read_text_file(file_path: &Path) -> Result<String, String> {
    fs::read_to_string(file_path).map_err(|e| e.to_string())
}

pub fn save_text_file(file_path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(file_path, to_platform_line_endings(content)).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationResult {
    pub files_copied: u32,
    pub index_copied: bool,
}

/// Merge all .md files from src_dir into dst_dir without overwriting
/// existing destination notes or replacing the destination index.
/// Preserves relative directory structure and creates empty folders.
pub fn migrate_notes(src_dir: &Path, dst_dir: &Path) -> Result<MigrationResult, String> {
    ensure_trusted_library_root(src_dir)
        .map_err(|error| error.display("validate_source_library_root"))?;
    ensure_trusted_library_root(dst_dir)
        .map_err(|error| error.display("validate_destination_library_root"))?;

    // When the current local library root is the parent of the cloud library root
    // (for example `.../HwanNote` -> `.../HwanNote/Notes`), skip the destination
    // subtree while collecting source files so we do not recursively copy the
    // cloud library back into itself.
    let skip_src_subtree = dst_dir.starts_with(src_dir).then_some(dst_dir);

    let _index_guard = lock_note_index();
    let src_snapshot = require_index_snapshot(src_dir)?;
    let dst_snapshot = require_index_snapshot(dst_dir)?;
    let src_scan = scan_library_tree(&ProductionFileSystem, src_dir, skip_src_subtree, true);
    let dst_scan = scan_library_tree(&ProductionFileSystem, dst_dir, None, true);

    if !src_scan.is_complete() || !dst_scan.is_complete() {
        return Err(src_scan
            .issues
            .iter()
            .chain(dst_scan.issues.iter())
            .map(NoteLoadIssue::display)
            .collect::<Vec<_>>()
            .join("; "));
    }

    let (src_index, src_index_changed) = reconcile_index_with_scan(&src_snapshot.index, &src_scan);
    let (mut dst_index, mut dst_index_changed) =
        reconcile_index_with_scan(&dst_snapshot.index, &dst_scan);

    for folder in &src_scan.folders {
        let relative_folder = normalize_library_relative_path(dst_dir, folder)
            .map_err(|error| error.display("validate_migration_folder"))?;
        ensure_library_subdirectory(dst_dir, &relative_folder)?;
    }

    let mut existing_dst_paths: HashSet<String> = dst_scan.files.keys().cloned().collect();
    let mut existing_dst_ids: HashSet<String> = dst_index.entries.keys().cloned().collect();
    let mut files_copied: u32 = 0;

    let mut source_entries: Vec<_> = src_index.entries.iter().collect();
    source_entries.sort_by(|(left_id, _), (right_id, _)| left_id.cmp(right_id));

    for (src_note_id, src_entry) in source_entries {
        let Some(src_file) = src_scan.files.get(&src_entry.relative_path) else {
            continue;
        };

        if let Some(existing_entry) = dst_index.entries.get(src_note_id) {
            if dst_scan.files.contains_key(&existing_entry.relative_path) {
                continue;
            }
        }

        let desired_relative = normalize_library_relative_path(dst_dir, &src_entry.relative_path)
            .map_err(|error| error.display("validate_migration_note_path"))?;
        validate_no_symlink_beneath_root(dst_dir, &desired_relative)
            .map_err(|error| error.display("validate_migration_note_path"))?;
        let desired_path = dst_dir.join(&desired_relative);
        let parent_dir = desired_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| dst_dir.to_path_buf());
        let base_name = src_file
            .full_path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("untitled");

        let final_path =
            if existing_dst_paths.contains(&src_entry.relative_path) || desired_path.exists() {
                ensure_unique_file_path(&parent_dir, base_name, None)?
            } else {
                desired_path
            };

        if let Some(parent) = final_path.parent() {
            let parent_relative = parent.strip_prefix(dst_dir).map_err(|error| {
                format!(
                    "validate_migration_parent failed for {}: {}",
                    parent.display(),
                    error
                )
            })?;
            ensure_library_subdirectory(dst_dir, parent_relative)?;
        }

        fs::copy(&src_file.full_path, &final_path).map_err(|e| {
            format!(
                "Failed to copy {} to {}: {}",
                src_file.full_path.display(),
                final_path.display(),
                e
            )
        })?;
        files_copied += 1;

        let final_rel = relative_path(dst_dir, &final_path);
        let final_note_id = if existing_dst_ids.contains(src_note_id) {
            ensure_unique_note_id(&existing_dst_ids, &final_rel)
        } else {
            src_note_id.clone()
        };

        dst_index.entries.insert(
            final_note_id.clone(),
            NoteIndexEntry {
                relative_path: final_rel.clone(),
                created_at: src_entry.created_at,
                manual_title: src_entry.manual_title.clone(),
                is_pinned: src_entry.is_pinned,
            },
        );
        existing_dst_paths.insert(final_rel);
        existing_dst_ids.insert(final_note_id);
        dst_index_changed = true;
    }

    if dst_index_changed {
        write_index_from_snapshot(dst_dir, &dst_snapshot, &dst_index)
            .map_err(index_write_failure_to_string)?;
    }
    if src_index_changed {
        write_index_from_snapshot(src_dir, &src_snapshot, &src_index)
            .map_err(index_write_failure_to_string)?;
    }

    Ok(MigrationResult {
        files_copied,
        index_copied: dst_index_changed,
    })
}

pub fn migrate_calendar_file(src_dir: &Path, dst_dir: &Path) -> Result<bool, String> {
    ensure_trusted_library_root(src_dir)
        .map_err(|error| error.display("validate_source_library_root"))?;
    ensure_trusted_library_root(dst_dir)
        .map_err(|error| error.display("validate_destination_library_root"))?;
    let src_path = src_dir.join(CALENDAR_FILENAME);
    if !src_path.exists() {
        return Ok(false);
    }

    let dst_path = dst_dir.join(CALENDAR_FILENAME);
    let bytes = fs::read(&src_path).map_err(|e| format!("Failed to read {:?}: {}", src_path, e))?;
    let mut dst_file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&dst_path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(format!("Failed to create {:?}: {}", dst_path, error)),
    };

    dst_file
        .write_all(&bytes)
        .map_err(|e| format!("Failed to copy {:?}: {}", src_path, e))?;
    Ok(true)
}

pub fn title_from_filename(file_path: &Path) -> String {
    let stem = file_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let title: String = stem.trim().chars().take(50).collect();
    if title.is_empty() {
        "\u{c81c}\u{baa9} \u{c5c6}\u{c74c}".to_string() // 제목 없음
    } else {
        title
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process;

    fn make_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hwan-note-{}-{}-{}",
            name,
            process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup_temp_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    #[derive(Default)]
    struct FaultInjectingFileSystem {
        failures: HashMap<(&'static str, PathBuf), String>,
        entry_type_overrides: HashMap<PathBuf, LibraryEntryType>,
    }

    impl FaultInjectingFileSystem {
        fn failing(
            operation: &'static str,
            path: impl Into<PathBuf>,
            reason: impl Into<String>,
        ) -> Self {
            Self {
                failures: HashMap::from([((operation, path.into()), reason.into())]),
                entry_type_overrides: HashMap::new(),
            }
        }

        fn reporting_entry_type(path: impl Into<PathBuf>, entry_type: LibraryEntryType) -> Self {
            Self {
                failures: HashMap::new(),
                entry_type_overrides: HashMap::from([(path.into(), entry_type)]),
            }
        }

        fn failure(
            &self,
            operation: &'static str,
            path: &Path,
        ) -> Option<FileSystemOperationError> {
            self.failures
                .get(&(operation, path.to_path_buf()))
                .map(|reason| FileSystemOperationError::injected(operation, path, reason))
        }
    }

    impl LibraryFileSystem for FaultInjectingFileSystem {
        fn read_dir(&self, path: &Path) -> Result<Vec<PathBuf>, FileSystemOperationError> {
            if let Some(error) = self.failure("read_dir", path) {
                return Err(error);
            }
            ProductionFileSystem.read_dir(path)
        }

        fn entry_type(&self, path: &Path) -> Result<LibraryEntryType, FileSystemOperationError> {
            if let Some(error) = self.failure("entry_file_type", path) {
                return Err(error);
            }
            if let Some(entry_type) = self.entry_type_overrides.get(path) {
                return Ok(*entry_type);
            }
            ProductionFileSystem.entry_type(path)
        }

        fn read_markdown(&self, path: &Path) -> Result<String, FileSystemOperationError> {
            if let Some(error) = self.failure("read_markdown", path) {
                return Err(error);
            }
            ProductionFileSystem.read_markdown(path)
        }

        fn markdown_metadata(&self, path: &Path) -> Result<fs::Metadata, FileSystemOperationError> {
            if let Some(error) = self.failure("read_metadata", path) {
                return Err(error);
            }
            ProductionFileSystem.markdown_metadata(path)
        }
    }

    fn assert_issue(
        result: &MarkdownLibraryLoadResult,
        kind: NoteLoadIssueKind,
        operation: &str,
        path: &Path,
        reason_fragment: &str,
    ) {
        assert!(result.issues.iter().any(|issue| {
            issue.kind == kind
                && issue.operation == operation
                && Path::new(&issue.path) == path
                && issue.reason.contains(reason_fragment)
        }));
    }

    #[test]
    fn sanitize_folder_path_preserves_valid_segments() {
        assert_eq!(sanitize_folder_path(Some(".folder")).unwrap(), ".folder");
        assert_eq!(
            sanitize_folder_path(Some(" inbox/.config/dev ")).unwrap(),
            ".config/dev"
        );
        assert_eq!(
            sanitize_folder_path(Some("team-alpha")).unwrap(),
            "team-alpha"
        );
    }

    #[test]
    fn sanitize_folder_path_rejects_invalid_segments() {
        assert!(sanitize_folder_path(Some(".")).is_err());
        assert!(sanitize_folder_path(Some("..")).is_err());
        assert!(sanitize_folder_path(Some("bad<name>")).is_err());
        assert!(sanitize_folder_path(Some("traildot.")).is_err());
        assert!(sanitize_folder_path(Some("bad|name")).is_err());
    }

    #[test]
    fn derive_title_strips_all_markdown_heading_levels() {
        for level in 1..=6 {
            let markdown = format!("{} Heading", "#".repeat(level));
            assert_eq!(derive_title(&markdown), "Heading");
        }
    }

    #[test]
    fn create_and_list_folders_include_empty_directories() {
        let dir = make_temp_dir("folder-list");
        let result = (|| -> Result<(), String> {
            create_folder(&dir, "alpha")?;
            create_folder(&dir, "parent/child")?;
            create_folder(&dir, ".folder")?;

            let folders = list_folders(&dir)?;
            assert_eq!(
                folders,
                vec![
                    ".folder".to_string(),
                    "alpha".to_string(),
                    "parent".to_string(),
                    "parent/child".to_string()
                ]
            );
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn rename_folder_moves_directory_and_updates_index() {
        let dir = make_temp_dir("folder-rename");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha".to_string(),
                    folder_path: Some("alpha".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let folders = rename_folder(&dir, "alpha", "beta")?;
            assert!(folders.contains(&"beta".to_string()));
            assert!(!folders.contains(&"alpha".to_string()));

            let notes = load_markdown_notes(&dir)?;
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].folder_path, "beta");

            let index = read_index(&dir)?;
            let entry = index.entries.get("note-1").unwrap();
            assert!(entry.relative_path.starts_with("beta/"));
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn delete_folder_moves_notes_to_root_and_removes_directory() {
        let dir = make_temp_dir("folder-delete");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha".to_string(),
                    folder_path: Some("alpha".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-2".to_string(),
                    title: "Beta".to_string(),
                    content: "# Beta".to_string(),
                    folder_path: Some("alpha/child".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let result = delete_folder(&dir, "alpha")?;
            assert_eq!(result.moved_note_ids.len(), 2);
            assert!(!dir.join("alpha").exists());

            let notes = load_markdown_notes(&dir)?;
            assert_eq!(notes.len(), 2);
            assert!(notes.iter().all(|note| note.folder_path.is_empty()));

            let folders = list_folders(&dir)?;
            assert!(folders.is_empty());
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn auto_save_embeds_manual_title_metadata_and_load_hides_it() {
        let dir = make_temp_dir("manual-title-meta");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Project Launch".to_string(),
                    content: "Body first line\nSecond line".to_string(),
                    folder_path: None,
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let files = list_markdown_files(&dir)?;
            assert_eq!(files.len(), 1);

            let raw_markdown = fs::read_to_string(&files[0]).unwrap();
            assert!(raw_markdown.starts_with(MANUAL_TITLE_META_PREFIX));
            assert!(raw_markdown.contains("Body first line"));

            #[cfg(windows)]
            assert!(raw_markdown.contains("\r\n"));

            #[cfg(not(windows))]
            assert!(!raw_markdown.contains("\r\n"));

            let notes = load_markdown_notes(&dir)?;
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].title, "Project Launch");
            assert!(notes[0].is_title_manual);
            assert_eq!(notes[0].plain_text, "Body first line\nSecond line");
            assert!(!notes[0].markdown.contains("hwan-note:manual-title"));
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn resolve_note_file_path_does_not_remove_index_entry() {
        let dir = make_temp_dir("resolve-note-path");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha".to_string(),
                    folder_path: None,
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let path = resolve_note_file_path(&dir, "note-1")?
                .ok_or_else(|| "missing note path".to_string())?;
            assert!(path.exists());

            let index = read_index(&dir)?;
            assert!(index.entries.contains_key("note-1"));

            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn remove_note_from_index_if_path_removes_matching_index_entry() {
        let dir = make_temp_dir("conditional-remove-matching-path");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha".to_string(),
                    folder_path: Some("alpha".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let path = resolve_note_file_path(&dir, "note-1")?
                .ok_or_else(|| "missing note path".to_string())?;
            fs::remove_file(&path).map_err(|e| e.to_string())?;
            let removed = remove_note_from_index_if_path(&dir, "note-1", &path)?;

            assert_eq!(removed.as_deref(), Some(path.as_path()));
            let index = read_index(&dir)?;
            assert!(!index.entries.contains_key("note-1"));

            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn remove_note_from_index_if_path_removes_stale_missing_file_entry() {
        let dir = make_temp_dir("conditional-remove-missing-file");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha".to_string(),
                    folder_path: Some("alpha".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let path = resolve_note_file_path(&dir, "note-1")?
                .ok_or_else(|| "missing note path".to_string())?;
            fs::remove_file(&path).map_err(|e| e.to_string())?;

            let removed = remove_note_from_index_if_path(&dir, "note-1", &path)?;

            assert_eq!(removed.as_deref(), Some(path.as_path()));
            let index = read_index(&dir)?;
            assert!(!index.entries.contains_key("note-1"));

            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn remove_note_from_index_if_path_preserves_recreated_same_path_entry() {
        let dir = make_temp_dir("conditional-remove-recreated-path");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha".to_string(),
                    folder_path: Some("alpha".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let path = resolve_note_file_path(&dir, "note-1")?
                .ok_or_else(|| "missing note path".to_string())?;
            fs::remove_file(&path).map_err(|e| e.to_string())?;

            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha recreated".to_string(),
                    folder_path: Some("alpha".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let result = remove_note_from_index_if_path(&dir, "note-1", &path);
            assert!(result.is_err());

            let index = read_index(&dir)?;
            assert!(index.entries.contains_key("note-1"));
            assert!(path.exists());

            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn delete_note_file_and_index_removes_index_when_delete_removes_file() {
        let dir = make_temp_dir("delete-note-success");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha".to_string(),
                    folder_path: Some("alpha".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let path = resolve_note_file_path(&dir, "note-1")?
                .ok_or_else(|| "missing note path".to_string())?;
            let removed = delete_note_file_and_index(&dir, "note-1", |path| {
                fs::remove_file(path).map_err(|e| e.to_string())
            })?;

            assert!(removed);
            assert!(!path.exists());
            let index = read_index(&dir)?;
            assert!(!index.entries.contains_key("note-1"));

            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn delete_note_file_and_index_preserves_index_when_delete_error_leaves_file() {
        let dir = make_temp_dir("delete-note-error-present");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha".to_string(),
                    folder_path: Some("alpha".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let result =
                delete_note_file_and_index(&dir, "note-1", |_| Err("trash canceled".to_string()));

            assert_eq!(result.unwrap_err(), "trash canceled");
            let index = read_index(&dir)?;
            assert!(index.entries.contains_key("note-1"));
            let path = resolve_note_file_path(&dir, "note-1")?
                .ok_or_else(|| "missing note path".to_string())?;
            assert!(path.exists());

            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn delete_note_file_and_index_accepts_delete_error_when_file_is_missing() {
        let dir = make_temp_dir("delete-note-error-missing");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha".to_string(),
                    folder_path: Some("alpha".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let path = resolve_note_file_path(&dir, "note-1")?
                .ok_or_else(|| "missing note path".to_string())?;
            let removed = delete_note_file_and_index(&dir, "note-1", |path| {
                fs::remove_file(path).map_err(|e| e.to_string())?;
                Err("file disappeared".to_string())
            })?;

            assert!(removed);
            assert!(!path.exists());
            let index = read_index(&dir)?;
            assert!(!index.entries.contains_key("note-1"));

            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn delete_note_file_and_index_preserves_recreated_same_path_file() {
        let dir = make_temp_dir("delete-recreated-same-path");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha".to_string(),
                    folder_path: Some("alpha".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let result = delete_note_file_and_index(&dir, "note-1", |path| {
                fs::remove_file(path).map_err(|e| e.to_string())?;
                fs::write(path, "# Alpha recreated").map_err(|e| e.to_string())?;
                Ok(())
            });

            assert!(result.is_err());
            let index = read_index(&dir)?;
            assert!(index.entries.contains_key("note-1"));
            let path = resolve_note_file_path(&dir, "note-1")?
                .ok_or_else(|| "missing note path".to_string())?;
            assert!(path.exists());

            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn remove_note_from_index_if_path_preserves_changed_index_entry() {
        let dir = make_temp_dir("conditional-remove-changed-path");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha".to_string(),
                    folder_path: Some("alpha".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let old_path = resolve_note_file_path(&dir, "note-1")?
                .ok_or_else(|| "missing old note path".to_string())?;

            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "note-1".to_string(),
                    title: "Alpha".to_string(),
                    content: "# Alpha moved".to_string(),
                    folder_path: Some("beta".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let result = remove_note_from_index_if_path(&dir, "note-1", &old_path);
            assert!(result.is_err());

            let index = read_index(&dir)?;
            let entry = index.entries.get("note-1").unwrap();
            assert!(entry.relative_path.starts_with("beta/"));

            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn load_backfills_index_from_embedded_manual_title_metadata() {
        let dir = make_temp_dir("manual-title-backfill");
        let result = (|| -> Result<(), String> {
            let relative_path = "topic.md".to_string();
            let note_id = generate_note_id(&relative_path);
            let manual_title = "Exact Sync Title";

            fs::write(
                dir.join(&relative_path),
                to_platform_line_endings(&format!(
                    "{}\nBody first line",
                    embed_manual_title_metadata("", Some(manual_title))
                )),
            )
            .unwrap();

            write_index(
                &dir,
                &NoteIndex {
                    entries: HashMap::from([(
                        note_id.clone(),
                        NoteIndexEntry {
                            relative_path: relative_path.clone(),
                            created_at: now_millis(),
                            manual_title: None,
                            is_pinned: None,
                        },
                    )]),
                },
            )?;

            let notes = load_markdown_notes(&dir)?;
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].title, manual_title);
            assert!(notes[0].is_title_manual);

            let index = read_index(&dir)?;
            let entry = index.entries.get(&note_id).unwrap();
            assert_eq!(entry.manual_title.as_deref(), Some(manual_title));
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn migrate_notes_preserves_cloud_state_and_imports_local_conflicts_safely() {
        let src = make_temp_dir("migrate-src");
        let dst = make_temp_dir("migrate-dst");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dst,
                &AutoSavePayload {
                    note_id: "cloud-note".to_string(),
                    title: "Shared".to_string(),
                    content: "# Cloud version".to_string(),
                    folder_path: Some("team".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;
            auto_save_markdown_note(
                &src,
                &AutoSavePayload {
                    note_id: "local-note".to_string(),
                    title: "Shared".to_string(),
                    content: "# Local version".to_string(),
                    folder_path: Some("team".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;
            create_folder(&src, "empty")?;

            let migration = migrate_notes(&src, &dst)?;
            assert_eq!(migration.files_copied, 1);
            assert!(migration.index_copied);
            assert!(dst.join("empty").exists());

            let index = read_index(&dst)?;
            let cloud_entry = index.entries.get("cloud-note").unwrap();
            let local_entry = index.entries.get("local-note").unwrap();

            assert_eq!(cloud_entry.relative_path, "team/Shared.md");
            assert_ne!(local_entry.relative_path, cloud_entry.relative_path);
            assert!(local_entry.relative_path.starts_with("team/Shared"));

            let cloud_text = fs::read_to_string(dst.join(&cloud_entry.relative_path)).unwrap();
            let local_text = fs::read_to_string(dst.join(&local_entry.relative_path)).unwrap();
            assert!(cloud_text.contains("Cloud version"));
            assert!(local_text.contains("Local version"));
            Ok(())
        })();
        cleanup_temp_dir(&src);
        cleanup_temp_dir(&dst);
        result.unwrap();
    }

    #[test]
    fn migrate_notes_skips_nested_destination_subtree_when_source_contains_it() {
        let root = make_temp_dir("migrate-nested-root");
        let src = root.join("HwanNote");
        let dst = src.join("Notes");
        let result = (|| -> Result<(), String> {
            fs::create_dir_all(&src).unwrap();

            auto_save_markdown_note(
                &src,
                &AutoSavePayload {
                    note_id: "local-note".to_string(),
                    title: "Local Root".to_string(),
                    content: "# Local root version".to_string(),
                    folder_path: Some("team".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;
            auto_save_markdown_note(
                &dst,
                &AutoSavePayload {
                    note_id: "cloud-note".to_string(),
                    title: "Cloud Existing".to_string(),
                    content: "# Cloud version".to_string(),
                    folder_path: Some("team".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let migration = migrate_notes(&src, &dst)?;
            assert_eq!(migration.files_copied, 1);
            assert!(!dst.join("Notes").exists());

            let index = read_index(&dst)?;
            assert!(index.entries.contains_key("cloud-note"));
            assert!(index.entries.contains_key("local-note"));
            assert_eq!(
                index.entries.get("local-note").unwrap().relative_path,
                "team/Local-Root.md"
            );
            assert_eq!(
                index.entries.get("cloud-note").unwrap().relative_path,
                "team/Cloud-Existing.md"
            );
            Ok(())
        })();
        cleanup_temp_dir(&root);
        result.unwrap();
    }

    #[test]
    fn migrate_calendar_file_copies_when_destination_is_missing() {
        let src = make_temp_dir("migrate-calendar-src");
        let dst = make_temp_dir("migrate-calendar-dst");
        let result = (|| -> Result<(), String> {
            let src_calendar = src.join(CALENDAR_FILENAME);
            fs::write(&src_calendar, "{\"events\":[1]}").map_err(|e| e.to_string())?;
            fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;

            let copied = migrate_calendar_file(&src, &dst)?;

            assert!(copied);
            assert_eq!(
                fs::read_to_string(dst.join(CALENDAR_FILENAME)).map_err(|e| e.to_string())?,
                "{\"events\":[1]}"
            );
            Ok(())
        })();
        cleanup_temp_dir(&src);
        cleanup_temp_dir(&dst);
        result.unwrap();
    }

    #[test]
    fn migrate_calendar_file_preserves_existing_destination_calendar() {
        let src = make_temp_dir("migrate-calendar-existing-src");
        let dst = make_temp_dir("migrate-calendar-existing-dst");
        let result = (|| -> Result<(), String> {
            fs::write(src.join(CALENDAR_FILENAME), "{\"events\":[1]}")
                .map_err(|e| e.to_string())?;
            fs::write(dst.join(CALENDAR_FILENAME), "{\"events\":[2]}")
                .map_err(|e| e.to_string())?;

            let copied = migrate_calendar_file(&src, &dst)?;

            assert!(!copied);
            assert_eq!(
                fs::read_to_string(dst.join(CALENDAR_FILENAME)).map_err(|e| e.to_string())?,
                "{\"events\":[2]}"
            );
            Ok(())
        })();
        cleanup_temp_dir(&src);
        cleanup_temp_dir(&dst);
        result.unwrap();
    }

    #[test]
    fn to_platform_line_endings_are_explicit_per_host() {
        let converted = to_platform_line_endings("alpha\r\nbeta\n");

        #[cfg(windows)]
        assert_eq!(converted, "alpha\r\nbeta\r\n");

        #[cfg(not(windows))]
        assert_eq!(converted, "alpha\nbeta\n");
    }

    #[test]
    fn save_text_file_uses_host_platform_line_endings() {
        let dir = make_temp_dir("save-text-line-endings");
        let path = dir.join("note.txt");
        let result = (|| -> Result<(), String> {
            save_text_file(&path, "line 1\r\nline 2\nline 3")?;
            let raw = fs::read_to_string(&path).unwrap();

            #[cfg(windows)]
            assert!(raw.contains("\r\n"));

            #[cfg(not(windows))]
            assert!(!raw.contains("\r\n"));

            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn load_markdown_notes_returns_raw_markdown_for_the_editor_parser() {
        let dir = make_temp_dir("load-raw-markdown");
        let markdown = concat!(
            "# Heading\n\n",
            "**bold** and *italic* with [link](https://example.com/path?q=1)\n\n",
            "| Name | Value |\n| --- | --- |\n| alpha | beta |\n\n",
            "- bullet\n1. ordered\n"
        );
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "formatted-note".to_string(),
                    title: "Heading".to_string(),
                    content: markdown.to_string(),
                    folder_path: None,
                    is_title_manual: Some(false),
                    is_pinned: Some(false),
                },
            )?;

            let notes = load_markdown_notes(&dir)?;
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].markdown, markdown);
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn incomplete_nested_read_dir_preserves_index_bytes_and_metadata() {
        let dir = make_temp_dir("incomplete-nested-read-dir");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "root-note".to_string(),
                    title: "Root".to_string(),
                    content: "# Root".to_string(),
                    folder_path: None,
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "nested-note".to_string(),
                    title: "Nested".to_string(),
                    content: "# Nested".to_string(),
                    folder_path: Some("blocked".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(true),
                },
            )?;
            fs::write(dir.join("unindexed.md"), "# Unindexed").map_err(|e| e.to_string())?;

            let index_path = get_index_path(&dir);
            let before_bytes = fs::read(&index_path).map_err(|e| e.to_string())?;
            let before_index = read_index(&dir)?;
            let nested_before = before_index
                .entries
                .get("nested-note")
                .cloned()
                .ok_or_else(|| "nested note missing before scan".to_string())?;
            let blocked_dir = dir.join("blocked");
            let file_system = FaultInjectingFileSystem::failing(
                "read_dir",
                &blocked_dir,
                "injected nested directory denial",
            );

            let load = load_markdown_library_with_fs(&dir, &file_system);

            assert_eq!(load.load_state, NoteLoadState::Incomplete);
            assert_issue(
                &load,
                NoteLoadIssueKind::Scan,
                "read_dir",
                &blocked_dir,
                "injected nested directory denial",
            );
            assert!(load.notes.iter().any(|note| note.note_id == "root-note"));
            assert!(!load
                .notes
                .iter()
                .any(|note| note.note_id == generate_note_id("unindexed.md")));
            assert_eq!(
                fs::read(&index_path).map_err(|e| e.to_string())?,
                before_bytes
            );

            let after_index = read_index(&dir)?;
            let nested_after = after_index
                .entries
                .get("nested-note")
                .ok_or_else(|| "nested note removed after incomplete scan".to_string())?;
            assert_eq!(nested_after.created_at, nested_before.created_at);
            assert_eq!(nested_after.manual_title, nested_before.manual_title);
            assert_eq!(nested_after.is_pinned, nested_before.is_pinned);

            let folder_error = list_folders_with_fs(&dir, &file_system).unwrap_err();
            assert!(folder_error.contains("read_dir"));
            assert!(folder_error.contains(&blocked_dir.to_string_lossy().to_string()));
            assert!(folder_error.contains("injected nested directory denial"));
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn incomplete_markdown_read_preserves_exact_index_bytes() {
        let dir = make_temp_dir("incomplete-markdown-read");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "stable-note".to_string(),
                    title: "Stable".to_string(),
                    content: "# Stable".to_string(),
                    folder_path: Some("project".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(true),
                },
            )?;
            let note_path = resolve_note_file_path(&dir, "stable-note")?
                .ok_or_else(|| "stable note path missing".to_string())?;
            let index_path = get_index_path(&dir);
            let before_bytes = fs::read(&index_path).map_err(|e| e.to_string())?;
            let before_entry = read_index(&dir)?
                .entries
                .get("stable-note")
                .cloned()
                .ok_or_else(|| "stable note index entry missing".to_string())?;
            let file_system = FaultInjectingFileSystem::failing(
                "read_markdown",
                &note_path,
                "injected markdown read failure",
            );

            let load = load_markdown_library_with_fs(&dir, &file_system);

            assert_eq!(load.load_state, NoteLoadState::Incomplete);
            assert_issue(
                &load,
                NoteLoadIssueKind::FileRead,
                "read_markdown",
                &note_path,
                "injected markdown read failure",
            );
            assert_eq!(
                fs::read(&index_path).map_err(|e| e.to_string())?,
                before_bytes
            );
            let after_entry = read_index(&dir)?
                .entries
                .get("stable-note")
                .cloned()
                .ok_or_else(|| "stable note index entry removed".to_string())?;
            assert_eq!(after_entry.created_at, before_entry.created_at);
            assert_eq!(after_entry.manual_title, before_entry.manual_title);
            assert_eq!(after_entry.is_pinned, before_entry.is_pinned);
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn incomplete_markdown_metadata_preserves_exact_index_bytes() {
        let dir = make_temp_dir("incomplete-markdown-metadata");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "stable-note".to_string(),
                    title: "Stable".to_string(),
                    content: "# Stable".to_string(),
                    folder_path: None,
                    is_title_manual: Some(true),
                    is_pinned: Some(true),
                },
            )?;
            let note_path = resolve_note_file_path(&dir, "stable-note")?
                .ok_or_else(|| "stable note path missing".to_string())?;
            let index_path = get_index_path(&dir);
            let before_bytes = fs::read(&index_path).map_err(|e| e.to_string())?;
            let before_entry = read_index(&dir)?
                .entries
                .get("stable-note")
                .cloned()
                .ok_or_else(|| "stable note index entry missing".to_string())?;
            let file_system = FaultInjectingFileSystem::failing(
                "read_metadata",
                &note_path,
                "injected markdown metadata failure",
            );

            let load = load_markdown_library_with_fs(&dir, &file_system);

            assert_eq!(load.load_state, NoteLoadState::Incomplete);
            assert_issue(
                &load,
                NoteLoadIssueKind::FileMetadata,
                "read_metadata",
                &note_path,
                "injected markdown metadata failure",
            );
            assert_eq!(
                fs::read(&index_path).map_err(|e| e.to_string())?,
                before_bytes
            );
            let after_entry = read_index(&dir)?
                .entries
                .get("stable-note")
                .cloned()
                .ok_or_else(|| "stable note index entry removed".to_string())?;
            assert_eq!(after_entry.created_at, before_entry.created_at);
            assert_eq!(after_entry.manual_title, before_entry.manual_title);
            assert_eq!(after_entry.is_pinned, before_entry.is_pinned);
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn corrupt_index_is_backed_up_uniquely_and_blocks_writers() {
        let dir = make_temp_dir("corrupt-index");
        let result = (|| -> Result<(), String> {
            let index_path = get_index_path(&dir);
            let corrupt_bytes = b"{ this is not valid index JSON".to_vec();
            fs::write(&index_path, &corrupt_bytes).map_err(|e| e.to_string())?;

            let first = load_markdown_library(&dir);
            assert_eq!(first.load_state, NoteLoadState::IndexCorrupt);
            assert_issue(
                &first,
                NoteLoadIssueKind::Index,
                "parse_index",
                &index_path,
                "line 1",
            );
            let first_backup = first
                .index_backup_path
                .as_deref()
                .map(PathBuf::from)
                .ok_or_else(|| "first corrupt backup was not created".to_string())?;
            assert_eq!(
                fs::read(&first_backup).map_err(|e| e.to_string())?,
                corrupt_bytes
            );
            assert_eq!(
                fs::read(&index_path).map_err(|e| e.to_string())?,
                corrupt_bytes
            );

            let second = load_markdown_library(&dir);
            assert_eq!(second.load_state, NoteLoadState::IndexCorrupt);
            let second_backup = second
                .index_backup_path
                .as_deref()
                .map(PathBuf::from)
                .ok_or_else(|| "second corrupt backup was not created".to_string())?;
            assert_ne!(second_backup, first_backup);
            assert_eq!(
                fs::read(&second_backup).map_err(|e| e.to_string())?,
                corrupt_bytes
            );

            let writer_error = write_index(&dir, &empty_index()).unwrap_err();
            assert!(writer_error.contains("parse_index"));
            let save_error = auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "must-not-save".to_string(),
                    title: "Blocked".to_string(),
                    content: "# Blocked".to_string(),
                    folder_path: None,
                    is_title_manual: Some(true),
                    is_pinned: Some(true),
                },
            )
            .unwrap_err();
            assert!(save_error.contains("parse_index"));
            assert_eq!(
                fs::read(&index_path).map_err(|e| e.to_string())?,
                corrupt_bytes
            );
            assert!(list_markdown_files(&dir)?.is_empty());
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn complete_scan_prunes_only_truly_deleted_file_and_preserves_survivor_metadata() {
        let dir = make_temp_dir("complete-real-deletion");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "survivor".to_string(),
                    title: "Survivor title".to_string(),
                    content: "# Survivor".to_string(),
                    folder_path: Some("project".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(true),
                },
            )?;
            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "deleted".to_string(),
                    title: "Deleted".to_string(),
                    content: "# Deleted".to_string(),
                    folder_path: Some("project".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;
            let before = read_index(&dir)?;
            let survivor_before = before
                .entries
                .get("survivor")
                .cloned()
                .ok_or_else(|| "survivor missing before deletion".to_string())?;
            let deleted_path = resolve_note_file_path(&dir, "deleted")?
                .ok_or_else(|| "deleted note path missing".to_string())?;
            fs::remove_file(&deleted_path).map_err(|e| e.to_string())?;

            let load = load_markdown_library(&dir);

            assert_eq!(load.load_state, NoteLoadState::Ready);
            assert!(load.issues.is_empty());
            assert_eq!(load.notes.len(), 1);
            assert_eq!(load.notes[0].note_id, "survivor");
            assert!(load.notes[0].is_pinned);
            let after = read_index(&dir)?;
            assert!(!after.entries.contains_key("deleted"));
            let survivor_after = after
                .entries
                .get("survivor")
                .ok_or_else(|| "survivor removed by reconciliation".to_string())?;
            assert_eq!(survivor_after.relative_path, survivor_before.relative_path);
            assert_eq!(survivor_after.created_at, survivor_before.created_at);
            assert_eq!(survivor_after.manual_title, survivor_before.manual_title);
            assert_eq!(survivor_after.is_pinned, survivor_before.is_pinned);
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn scanner_rejects_symlink_entries_without_descending_into_them() {
        let dir = make_temp_dir("scanner-rejects-symlink");
        let result = (|| -> Result<(), String> {
            let reported_link = dir.join("reported-link");
            fs::create_dir_all(&reported_link).map_err(|e| e.to_string())?;
            fs::write(reported_link.join("outside.md"), "# Must not load")
                .map_err(|e| e.to_string())?;
            let file_system = FaultInjectingFileSystem::reporting_entry_type(
                &reported_link,
                LibraryEntryType::Symlink,
            );

            let load = load_markdown_library_with_fs(&dir, &file_system);

            assert_eq!(load.load_state, NoteLoadState::Incomplete);
            assert_issue(
                &load,
                NoteLoadIssueKind::Scan,
                "reject_symlink",
                &reported_link,
                "symbolic links and reparse points",
            );
            assert!(load.notes.is_empty());
            assert!(load.folders.is_empty());
            assert!(!get_index_path(&dir).exists());
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn unsafe_index_parent_path_is_corrupt_and_blocks_file_mutations() {
        use std::cell::Cell;

        let dir = make_temp_dir("unsafe-index-parent-path");
        let result = (|| -> Result<(), String> {
            let index_path = get_index_path(&dir);
            let unsafe_index = NoteIndex {
                entries: HashMap::from([(
                    "escape-note".to_string(),
                    NoteIndexEntry {
                        relative_path: "../escape.md".to_string(),
                        created_at: 123,
                        manual_title: Some("Escape".to_string()),
                        is_pinned: Some(true),
                    },
                )]),
            };
            let unsafe_bytes =
                serde_json::to_vec_pretty(&unsafe_index).map_err(|e| e.to_string())?;
            fs::write(&index_path, &unsafe_bytes).map_err(|e| e.to_string())?;

            let load = load_markdown_library(&dir);

            assert_eq!(load.load_state, NoteLoadState::IndexCorrupt);
            assert_issue(
                &load,
                NoteLoadIssueKind::Index,
                "validate_index_path",
                &dir.join("../escape.md"),
                "unsafe relative path component",
            );
            let backup_path = load
                .index_backup_path
                .as_deref()
                .map(PathBuf::from)
                .ok_or_else(|| "unsafe index backup missing".to_string())?;
            assert_eq!(
                fs::read(&backup_path).map_err(|e| e.to_string())?,
                unsafe_bytes
            );
            assert_eq!(
                fs::read(&index_path).map_err(|e| e.to_string())?,
                unsafe_bytes
            );

            let resolve_error = resolve_note_file_path(&dir, "escape-note").unwrap_err();
            assert!(resolve_error.contains("validate_index_path"));

            let delete_called = Cell::new(false);
            let delete_error = delete_note_file_and_index(&dir, "escape-note", |_| {
                delete_called.set(true);
                Ok(())
            })
            .unwrap_err();
            assert!(delete_error.contains("validate_index_path"));
            assert!(!delete_called.get());

            let save_error = auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "escape-note".to_string(),
                    title: "Blocked".to_string(),
                    content: "# Blocked".to_string(),
                    folder_path: Some("safe".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )
            .unwrap_err();
            assert!(save_error.contains("validate_index_path"));
            assert!(!dir.join("safe").exists());
            assert_eq!(
                fs::read(&index_path).map_err(|e| e.to_string())?,
                unsafe_bytes
            );
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn relative_path_validation_rejects_absolute_and_parent_components() {
        let root = Path::new("library-root");
        for unsafe_path in [
            "/absolute.md",
            "../escape.md",
            "safe/../../escape.md",
            r"C:\outside\escape.md",
            r"safe\..\escape.md",
        ] {
            assert!(normalize_library_relative_path(root, unsafe_path).is_err());
        }
        assert_eq!(
            normalize_library_relative_path(root, "safe/note.md").unwrap(),
            PathBuf::from("safe").join("note.md")
        );
    }

    #[test]
    fn non_directory_library_root_is_fail_closed_for_load_and_save() {
        let parent = make_temp_dir("non-directory-library-root");
        let root = parent.join("notes-root");
        let result = (|| -> Result<(), String> {
            fs::write(&root, "not a directory").map_err(|e| e.to_string())?;

            let load = load_markdown_library(&root);
            assert_eq!(load.load_state, NoteLoadState::Incomplete);
            assert_issue(
                &load,
                NoteLoadIssueKind::Scan,
                "validate_library_root",
                &root,
                "must be a directory",
            );

            let save_error = auto_save_markdown_note(
                &root,
                &AutoSavePayload {
                    note_id: "blocked".to_string(),
                    title: "Blocked".to_string(),
                    content: "# Blocked".to_string(),
                    folder_path: None,
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )
            .unwrap_err();
            assert!(save_error.contains("validate_library_root"));
            assert_eq!(
                fs::read_to_string(&root).map_err(|e| e.to_string())?,
                "not a directory"
            );
            Ok(())
        })();
        cleanup_temp_dir(&parent);
        result.unwrap();
    }

    #[test]
    fn second_index_verification_preserves_concurrent_replacement_and_cleans_temp() {
        let dir = make_temp_dir("index-second-verification");
        let result = (|| -> Result<(), String> {
            write_index(&dir, &empty_index())?;
            let snapshot = require_index_snapshot(&dir)?;
            let planned_index = NoteIndex {
                entries: HashMap::from([(
                    "planned".to_string(),
                    NoteIndexEntry {
                        relative_path: "planned.md".to_string(),
                        created_at: 1,
                        manual_title: None,
                        is_pinned: Some(false),
                    },
                )]),
            };
            let concurrent_index = NoteIndex {
                entries: HashMap::from([(
                    "concurrent".to_string(),
                    NoteIndexEntry {
                        relative_path: "concurrent.md".to_string(),
                        created_at: 2,
                        manual_title: Some("Concurrent".to_string()),
                        is_pinned: Some(true),
                    },
                )]),
            };
            let concurrent_bytes =
                serde_json::to_vec_pretty(&concurrent_index).map_err(|e| e.to_string())?;
            let index_path = get_index_path(&dir);

            let write_result =
                write_index_from_snapshot_after_temp_hook(&dir, &snapshot, &planned_index, || {
                    fs::write(&index_path, &concurrent_bytes).unwrap();
                });

            match write_result {
                Err(IndexWriteFailure::Issue(issue)) => {
                    assert_eq!(issue.operation, "verify_index_unchanged");
                    assert_eq!(Path::new(&issue.path), index_path);
                }
                other => panic!("expected second verification failure, got {other:?}"),
            }
            assert_eq!(
                fs::read(&index_path).map_err(|e| e.to_string())?,
                concurrent_bytes
            );
            let temp_prefix = format!("{INDEX_FILENAME}.tmp-");
            for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                assert!(!entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(&temp_prefix));
            }
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn production_scan_and_auto_save_reject_real_symlink_ancestors() {
        use std::os::unix::fs::symlink;

        let dir = make_temp_dir("real-symlink-library");
        let outside = make_temp_dir("real-symlink-outside");
        let result = (|| -> Result<(), String> {
            fs::write(outside.join("outside.md"), "# Outside").map_err(|e| e.to_string())?;
            let link = dir.join("linked");
            symlink(&outside, &link).map_err(|e| e.to_string())?;

            let load = load_markdown_library(&dir);
            assert_eq!(load.load_state, NoteLoadState::Incomplete);
            assert_issue(
                &load,
                NoteLoadIssueKind::Scan,
                "reject_symlink",
                &link,
                "symbolic links and reparse points",
            );
            assert!(load.notes.is_empty());

            let save_error = auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "blocked".to_string(),
                    title: "Blocked".to_string(),
                    content: "# Blocked".to_string(),
                    folder_path: Some("linked".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )
            .unwrap_err();
            assert!(save_error.contains("symbolic links and reparse points"));
            assert!(!outside.join("Blocked.md").exists());
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        cleanup_temp_dir(&outside);
        result.unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_note_write_rejects_destination_symlink_swap_after_temp_sync() {
        use std::os::unix::fs::symlink;

        let dir = make_temp_dir("atomic-note-symlink-swap");
        let outside = make_temp_dir("atomic-note-symlink-swap-outside");
        let destination = dir.join("target.md");
        let outside_file = outside.join("victim.md");
        let result = (|| -> Result<(), String> {
            fs::write(&outside_file, "outside-original").map_err(|e| e.to_string())?;

            let write_result = write_note_file_atomically_after_temp_hook(
                &dir,
                &destination,
                "must-not-escape",
                || {
                    symlink(&outside_file, &destination).unwrap();
                },
            );

            let error = write_result.unwrap_err();
            assert!(error.contains("symbolic links and reparse points"));
            assert_eq!(
                fs::read_to_string(&outside_file).map_err(|e| e.to_string())?,
                "outside-original"
            );
            assert!(fs::symlink_metadata(&destination)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink());
            for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                assert!(!entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".hwan-note-write-"));
            }
            fs::remove_file(&destination).map_err(|e| e.to_string())?;
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        cleanup_temp_dir(&outside);
        result.unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn library_root_symlink_is_rejected_before_load_or_save() {
        use std::os::unix::fs::symlink;

        let parent = make_temp_dir("root-symlink-parent");
        let outside = make_temp_dir("root-symlink-outside");
        let root_link = parent.join("notes-link");
        let result = (|| -> Result<(), String> {
            fs::write(outside.join("outside.md"), "# Outside").map_err(|e| e.to_string())?;
            symlink(&outside, &root_link).map_err(|e| e.to_string())?;

            let load = load_markdown_library(&root_link);
            assert_eq!(load.load_state, NoteLoadState::Incomplete);
            assert_issue(
                &load,
                NoteLoadIssueKind::Scan,
                "validate_library_root",
                &root_link,
                "cannot be a symbolic link or reparse point",
            );
            assert!(load.notes.is_empty());

            let save_error = auto_save_markdown_note(
                &root_link,
                &AutoSavePayload {
                    note_id: "blocked".to_string(),
                    title: "Blocked".to_string(),
                    content: "# Blocked".to_string(),
                    folder_path: None,
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )
            .unwrap_err();
            assert!(save_error.contains("validate_library_root"));
            assert!(!outside.join("Blocked.md").exists());
            fs::remove_file(&root_link).map_err(|e| e.to_string())?;
            Ok(())
        })();
        cleanup_temp_dir(&parent);
        cleanup_temp_dir(&outside);
        result.unwrap();
    }
}
