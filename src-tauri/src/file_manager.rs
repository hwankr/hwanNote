use crate::atomic_file::{publish_temp_file, sync_parent_directory};

use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::SystemTime;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256};

const INDEX_FILENAME: &str = ".hwan-note-index.json";
pub const CALENDAR_FILENAME: &str = "calendar.json";
const AUTOSAVE_JOURNAL_FILENAME: &str = ".hwan-note-autosave.json";
const AUTOSAVE_JOURNAL_TEMP_FILENAME: &str = ".hwan-note-autosave.json.next";
const AUTOSAVE_TRANSACTION_VERSION: u32 = 1;

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
static AUTOSAVE_OPERATION_COUNTER: AtomicU64 = AtomicU64::new(0);

const TOGGLE_BLOCK_END: &str = ":::";
const MANUAL_TITLE_META_PREFIX: &str = "<!-- hwan-note:manual-title:";
const MANUAL_TITLE_META_SUFFIX: &str = " -->";

fn lock_note_index() -> MutexGuard<'static, ()> {
    NOTE_INDEX_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ── Types ──

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndexEntry {
    pub relative_path: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_pinned: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteIndex {
    pub entries: HashMap<String, NoteIndexEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AutosaveTransactionPhase {
    Prepared,
    Staged,
    NotePublished,
    IndexPublished,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutosaveTransactionJournal {
    version: u32,
    operation_id: String,
    phase: AutosaveTransactionPhase,
    note_id: String,
    previous_relative_path: Option<String>,
    next_relative_path: String,
    note_temp_relative_path: String,
    index_temp_relative_path: String,
    expected_index_digest: Option<String>,
    next_index: NoteIndex,
    next_note_digest: String,
    previous_note_digest: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum AutosaveFaultPoint {
    JournalTempCreate,
    JournalTempWrite,
    JournalTempSync,
    JournalPublish,
    JournalPublishReported,
    NoteTempCreate,
    NoteTempWrite,
    NoteTempSync,
    NotePublish,
    NotePublishReported,
    IndexTempCreate,
    IndexTempWrite,
    IndexTempSync,
    IndexPublish,
    IndexPublishReported,
    OldFileCleanup,
    JournalCleanup,
}

trait AutosaveFaultInjector {
    fn check(&self, point: AutosaveFaultPoint) -> Result<(), String>;
}

struct NoopAutosaveFaultInjector;

impl AutosaveFaultInjector for NoopAutosaveFaultInjector {
    fn check(&self, _point: AutosaveFaultPoint) -> Result<(), String> {
        Ok(())
    }
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

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
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

/// Canonical note-library boundary.
///
/// Policy: the configured root itself must be a real directory, every path used
/// by library I/O is anchored beneath its canonical identity, and every
/// symlink or Windows reparse point below it is rejected rather than followed.
#[derive(Debug, Clone)]
pub(crate) struct TrustedLibraryRoot {
    canonical: PathBuf,
}

impl TrustedLibraryRoot {
    pub(crate) fn open(root_dir: &Path) -> Result<Self, String> {
        resolve_trusted_library_root(root_dir)
            .map_err(|error| error.display("validate_library_root"))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.canonical
    }

    pub(crate) fn file_path(
        &self,
        relative_path: &str,
        must_exist: bool,
    ) -> Result<PathBuf, String> {
        let relative = validate_library_relative_path(self, relative_path)
            .map_err(|error| error.display("validate_library_file"))?;
        let path = self.path().join(relative);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == io::ErrorKind::NotFound && !must_exist => None,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(format!(
                    "validate_library_file failed for {}: file not found",
                    path.display()
                ));
            }
            Err(error) => return Err(error.to_string()),
        };
        if let Some(metadata) = metadata {
            if metadata_is_symlink_or_reparse_point(&metadata) || !metadata.is_file() {
                return Err(format!(
                    "validate_library_file failed for {}: not a regular file or is a symbolic link/reparse point",
                    path.display()
                ));
            }
            let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
            ensure_path_within_canonical_root(self, &canonical)
                .map_err(|error| error.display("validate_library_file"))?;
            return Ok(canonical);
        }

        ensure_path_within_canonical_root(self, &path)
            .map_err(|error| error.display("validate_library_file"))?;
        Ok(path)
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

fn resolve_trusted_library_root(root_dir: &Path) -> Result<TrustedLibraryRoot, LibraryPathError> {
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

    let canonical = fs::canonicalize(root_dir).map_err(|error| {
        LibraryPathError::new(
            root_dir,
            format!("failed to canonicalize the note library root: {error}"),
        )
    })?;

    let canonical_metadata = fs::symlink_metadata(&canonical).map_err(|error| {
        LibraryPathError::new(
            &canonical,
            format!("failed to inspect the canonical note library root: {error}"),
        )
    })?;
    if metadata_is_symlink_or_reparse_point(&canonical_metadata) || !canonical_metadata.is_dir() {
        return Err(LibraryPathError::new(
            &canonical,
            "the canonical note library root must be a trusted directory",
        ));
    }

    Ok(TrustedLibraryRoot { canonical })
}

fn ensure_path_within_canonical_root(
    trusted_root: &TrustedLibraryRoot,
    path: &Path,
) -> Result<(), LibraryPathError> {
    if !path.starts_with(trusted_root.path()) {
        return Err(LibraryPathError::new(
            path,
            format!(
                "the path is outside the canonical note library root {}",
                trusted_root.path().display()
            ),
        ));
    }

    let mut candidate = path;
    let existing = loop {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) => {
                if metadata_is_symlink_or_reparse_point(&metadata) {
                    return Err(LibraryPathError::new(
                        candidate,
                        "symbolic links and reparse points beneath the note library are not allowed",
                    ));
                }
                break candidate;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                candidate = candidate.parent().ok_or_else(|| {
                    LibraryPathError::new(
                        path,
                        format!(
                            "failed to confirm that the path stays beneath the canonical note library root {}",
                            trusted_root.path().display()
                        ),
                    )
                })?;
            }
            Err(error) => {
                return Err(LibraryPathError::new(
                    candidate,
                    format!("failed to inspect the path for boundary verification: {error}"),
                ));
            }
        }
    };

    let canonical_existing = fs::canonicalize(existing).map_err(|error| {
        LibraryPathError::new(
            existing,
            format!("failed to canonicalize the path for boundary verification: {error}"),
        )
    })?;

    if !canonical_existing.starts_with(trusted_root.path()) {
        return Err(LibraryPathError::new(
            path,
            format!(
                "the resolved path escapes the canonical note library root {}",
                trusted_root.path().display()
            ),
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
    trusted_root: &TrustedLibraryRoot,
    relative_path: &Path,
) -> Result<(), LibraryPathError> {
    let components = relative_path.components().collect::<Vec<_>>();
    let mut current = trusted_root.path().to_path_buf();

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

        ensure_path_within_canonical_root(trusted_root, &current)?;
    }

    Ok(())
}

fn validate_library_relative_path(
    trusted_root: &TrustedLibraryRoot,
    raw_path: &str,
) -> Result<PathBuf, LibraryPathError> {
    let relative_path = normalize_library_relative_path(trusted_root.path(), raw_path)?;
    validate_no_symlink_beneath_root(trusted_root, &relative_path)?;
    Ok(relative_path)
}

fn validated_library_file_path(
    trusted_root: &TrustedLibraryRoot,
    raw_path: &str,
) -> Result<PathBuf, String> {
    let relative_path = validate_library_relative_path(trusted_root, raw_path)
        .map_err(|error| error.display("validate_library_path"))?;
    let path = trusted_root.path().join(relative_path);
    ensure_path_within_canonical_root(trusted_root, &path)
        .map_err(|error| error.display("validate_library_path"))?;
    Ok(path)
}

fn canonicalize_expected_library_path(
    trusted_root: &TrustedLibraryRoot,
    requested_root: &Path,
    path: &Path,
) -> Result<PathBuf, String> {
    let candidate = if path.starts_with(trusted_root.path()) {
        path.to_path_buf()
    } else if let Ok(relative) = path.strip_prefix(requested_root) {
        trusted_root.path().join(relative)
    } else {
        match fs::canonicalize(path) {
            Ok(canonical) => canonical,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(format!(
                    "validate_library_path failed for {}: path is not rooted beneath {}",
                    path.display(),
                    requested_root.display()
                ));
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    ensure_path_within_canonical_root(trusted_root, &candidate)
        .map_err(|error| error.display("validate_library_path"))?;
    Ok(candidate)
}

fn ensure_library_subdirectory(
    trusted_root: &TrustedLibraryRoot,
    relative_path: &Path,
) -> Result<PathBuf, String> {
    let mut current = trusted_root.path().to_path_buf();
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

        ensure_path_within_canonical_root(trusted_root, &current)
            .map_err(|error| error.display("validate_library_directory"))?;
    }

    validate_no_symlink_beneath_root(trusted_root, relative_path)
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
    trusted_root: &TrustedLibraryRoot,
    index_path: &Path,
    index: &NoteIndex,
) -> Result<(), NoteLoadIssue> {
    let mut entries = index.entries.iter().collect::<Vec<_>>();
    entries.sort_by(|(left_id, _), (right_id, _)| left_id.cmp(right_id));

    for (note_id, entry) in entries {
        if let Err(error) = validate_library_relative_path(trusted_root, &entry.relative_path) {
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

fn read_index_state(trusted_root: &TrustedLibraryRoot) -> IndexReadState {
    let index_path = get_index_path(trusted_root.path());
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
        validate_index_paths(trusted_root, &index_path, &index)?;
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

fn require_index_snapshot(trusted_root: &TrustedLibraryRoot) -> Result<IndexSnapshot, String> {
    match read_index_state(trusted_root) {
        IndexReadState::Ready(snapshot) => Ok(snapshot),
        IndexReadState::Corrupt(state) => Err(corrupt_index_error(&state)),
    }
}

#[cfg(test)]
pub fn read_index(auto_save_dir: &Path) -> Result<NoteIndex, String> {
    let trusted_root = TrustedLibraryRoot::open(auto_save_dir)?;
    require_index_snapshot(&trusted_root).map(|snapshot| snapshot.index)
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
    trusted_root: &TrustedLibraryRoot,
    expected: &IndexSnapshot,
) -> Result<(), IndexWriteFailure> {
    let index_path = get_index_path(trusted_root.path());
    match read_index_state(trusted_root) {
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
    trusted_root: &TrustedLibraryRoot,
    expected: &IndexSnapshot,
    index: &NoteIndex,
    before_final_verify: F,
) -> Result<(), IndexWriteFailure>
where
    F: FnOnce(),
{
    let index_path = get_index_path(trusted_root.path());
    verify_index_snapshot_unchanged(trusted_root, expected)?;
    validate_index_paths(trusted_root, &index_path, index).map_err(IndexWriteFailure::Issue)?;

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
    if let Err(failure) = verify_index_snapshot_unchanged(trusted_root, expected) {
        return Err(cleanup_index_temp_after_failure(&tmp_path, failure));
    }
    if let Err(reason) =
        validate_trusted_publish_destination(trusted_root, &index_path, "replace_index")
    {
        return Err(IndexWriteFailure::Issue(NoteLoadIssue::new(
            NoteLoadIssueKind::Index,
            "replace_index",
            &index_path,
            cleanup_file_with_reason(&tmp_path, reason),
        )));
    }

    if let Err(reason) = publish_temp_file(&tmp_path, &index_path, "replace_index") {
        return Err(IndexWriteFailure::Issue(NoteLoadIssue::new(
            NoteLoadIssueKind::Index,
            "replace_index",
            &index_path,
            cleanup_file_with_reason(&tmp_path, reason),
        )));
    }

    Ok(())
}

fn write_index_from_snapshot(
    trusted_root: &TrustedLibraryRoot,
    expected: &IndexSnapshot,
    index: &NoteIndex,
) -> Result<(), IndexWriteFailure> {
    write_index_from_snapshot_after_temp_hook(trusted_root, expected, index, || {})
}

fn index_write_failure_to_string(failure: IndexWriteFailure) -> String {
    match failure {
        IndexWriteFailure::Corrupt(state) => corrupt_index_error(&state),
        IndexWriteFailure::Issue(issue) => issue.display(),
    }
}

#[cfg(test)]
pub fn write_index(auto_save_dir: &Path, index: &NoteIndex) -> Result<(), String> {
    let trusted_root = TrustedLibraryRoot::open(auto_save_dir)?;
    let expected = require_index_snapshot(&trusted_root)?;
    write_index_from_snapshot(&trusted_root, &expected, index)
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
    fn canonicalize_path(&self, path: &Path) -> Result<PathBuf, FileSystemOperationError>;
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

    fn canonicalize_path(&self, path: &Path) -> Result<PathBuf, FileSystemOperationError> {
        fs::canonicalize(path)
            .map_err(|error| FileSystemOperationError::from_io("canonicalize_path", path, error))
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
    visited_directories: HashSet<PathBuf>,
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
    trusted_root: &TrustedLibraryRoot,
    current_dir: &Path,
    skip_subtree: Option<&Path>,
    include_markdown: bool,
    scan: &mut LibraryScan,
) {
    let canonical_current = match file_system.canonicalize_path(current_dir) {
        Ok(path) => path,
        Err(error) => {
            scan.issues.push(scan_issue(error));
            return;
        }
    };

    if !canonical_current.starts_with(trusted_root.path()) {
        scan.issues.push(NoteLoadIssue::new(
            NoteLoadIssueKind::Scan,
            "validate_canonical_scan_root",
            current_dir,
            format!(
                "resolved outside the canonical note library root {}",
                trusted_root.path().display()
            ),
        ));
        return;
    }

    if !scan.visited_directories.insert(canonical_current) {
        scan.issues.push(NoteLoadIssue::new(
            NoteLoadIssueKind::Scan,
            "detect_cycle",
            current_dir,
            "refusing to scan the same canonical directory twice",
        ));
        return;
    }

    let entries = match file_system.read_dir(current_dir) {
        Ok(entries) => entries,
        Err(error) => {
            scan.issues.push(scan_issue(error));
            return;
        }
    };

    for path in entries {
        if !path.starts_with(trusted_root.path()) {
            scan.issues.push(NoteLoadIssue::new(
                NoteLoadIssueKind::Scan,
                "validate_scan_entry",
                &path,
                format!(
                    "entry is outside the canonical note library root {}",
                    trusted_root.path().display()
                ),
            ));
            continue;
        }
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
                let relative = strip_inbox_root_alias(&relative_path(trusted_root.path(), &path));
                if !relative.is_empty() {
                    scan.folders.push(relative);
                }
                scan_library_directory(
                    file_system,
                    trusted_root,
                    &path,
                    skip_subtree,
                    include_markdown,
                    scan,
                );
            }
            LibraryEntryType::File if include_markdown && is_markdown_path(&path) => {
                let canonical_path = match file_system.canonicalize_path(&path) {
                    Ok(canonical_path) if canonical_path.starts_with(trusted_root.path()) => {
                        canonical_path
                    }
                    Ok(canonical_path) => {
                        scan.issues.push(NoteLoadIssue::new(
                            NoteLoadIssueKind::Scan,
                            "validate_canonical_file_path",
                            &path,
                            format!(
                                "resolved to {} outside the canonical note library root {}",
                                canonical_path.display(),
                                trusted_root.path().display()
                            ),
                        ));
                        continue;
                    }
                    Err(error) => {
                        scan.issues.push(scan_issue(error));
                        continue;
                    }
                };
                let markdown = file_system.read_markdown(&canonical_path);
                let metadata = file_system.markdown_metadata(&canonical_path);

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
                                &canonical_path,
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
                        relative_path(trusted_root.path(), &canonical_path),
                        ScannedMarkdown {
                            full_path: canonical_path,
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
    trusted_root: &TrustedLibraryRoot,
    skip_subtree: Option<&Path>,
    include_markdown: bool,
) -> LibraryScan {
    let mut scan = LibraryScan::default();
    scan_library_directory(
        file_system,
        trusted_root,
        trusted_root.path(),
        skip_subtree,
        include_markdown,
        &mut scan,
    );
    scan.finish();
    scan
}

fn scan_library_subtree<F: LibraryFileSystem>(
    file_system: &F,
    trusted_root: &TrustedLibraryRoot,
    start_dir: &Path,
    include_markdown: bool,
) -> LibraryScan {
    let mut scan = LibraryScan::default();
    scan_library_directory(
        file_system,
        trusted_root,
        start_dir,
        None,
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
    trusted_root: &TrustedLibraryRoot,
    destination: &Path,
) -> Result<(), String> {
    let relative_path = destination
        .strip_prefix(trusted_root.path())
        .map_err(|error| {
            format!(
                "validate_note_destination failed for {}: destination is outside {}: {}",
                destination.display(),
                trusted_root.path().display(),
                error
            )
        })?;
    if relative_path.as_os_str().is_empty() {
        return Err(format!(
            "validate_note_destination failed for {}: destination cannot be the library root",
            destination.display()
        ));
    }
    validate_no_symlink_beneath_root(trusted_root, relative_path)
        .map_err(|error| error.display("validate_note_destination"))?;
    ensure_path_within_canonical_root(trusted_root, destination)
        .map_err(|error| error.display("validate_note_destination"))
}

fn validate_existing_trusted_file(
    trusted_root: &TrustedLibraryRoot,
    path: &Path,
    operation: &str,
) -> Result<(), String> {
    let relative = path.strip_prefix(trusted_root.path()).map_err(|error| {
        format!(
            "{operation} failed for {}: path is outside {}: {}",
            path.display(),
            trusted_root.path().display(),
            error
        )
    })?;
    validate_no_symlink_beneath_root(trusted_root, relative)
        .map_err(|error| error.display(operation))?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("{operation} failed for {}: {error}", path.display()))?;
    if metadata_is_symlink_or_reparse_point(&metadata) || !metadata.is_file() {
        return Err(format!(
            "{operation} failed for {}: expected a trusted regular file",
            path.display()
        ));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| format!("{operation} failed for {}: {error}", path.display()))?;
    ensure_path_within_canonical_root(trusted_root, &canonical)
        .map_err(|error| error.display(operation))?;
    if canonical != path {
        return Err(format!(
            "{operation} failed for {}: canonical identity changed to {}",
            path.display(),
            canonical.display()
        ));
    }
    Ok(())
}

fn read_trusted_file_bytes(
    trusted_root: &TrustedLibraryRoot,
    path: &Path,
    operation: &str,
) -> Result<Vec<u8>, String> {
    validate_existing_trusted_file(trusted_root, path, operation)?;
    fs::read(path).map_err(|error| format!("{operation} failed for {}: {error}", path.display()))
}

fn read_existing_file_digest(
    trusted_root: &TrustedLibraryRoot,
    path: &Path,
    operation: &str,
) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(Some(sha256_hex(&read_trusted_file_bytes(
            trusted_root,
            path,
            operation,
        )?))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "{operation} failed for {}: {error}",
            path.display()
        )),
    }
}

fn file_digest_matches(
    trusted_root: &TrustedLibraryRoot,
    path: &Path,
    expected_digest: &str,
    operation: &str,
) -> Result<bool, String> {
    Ok(read_existing_file_digest(trusted_root, path, operation)?
        .is_some_and(|digest| digest == expected_digest))
}

fn autosave_journal_path(trusted_root: &TrustedLibraryRoot) -> PathBuf {
    trusted_root.path().join(AUTOSAVE_JOURNAL_FILENAME)
}

fn autosave_journal_next_path(trusted_root: &TrustedLibraryRoot) -> PathBuf {
    trusted_root.path().join(AUTOSAVE_JOURNAL_TEMP_FILENAME)
}

fn next_autosave_operation_id() -> String {
    let sequence = AUTOSAVE_OPERATION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{sequence}", process_id(), now_millis())
}

fn is_valid_autosave_operation_id(operation_id: &str) -> bool {
    let parts = operation_id.split('-').collect::<Vec<_>>();
    parts.len() == 3
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn note_temp_path_for_operation(destination: &Path, operation_id: &str) -> Result<PathBuf, String> {
    let parent = destination.parent().ok_or_else(|| {
        format!(
            "create_note_temp failed for {}: destination has no parent directory",
            destination.display()
        )
    })?;
    Ok(parent.join(format!(".hwan-note-write-{operation_id}.tmp")))
}

fn index_temp_path_for_operation(trusted_root: &TrustedLibraryRoot, operation_id: &str) -> PathBuf {
    trusted_root
        .path()
        .join(format!(".hwan-note-index-{operation_id}.tmp"))
}

fn create_synced_temp_file_with_faults(
    temp_path: &Path,
    bytes: &[u8],
    operation: &str,
    create_fault: AutosaveFaultPoint,
    write_fault: AutosaveFaultPoint,
    sync_fault: AutosaveFaultPoint,
    faults: &impl AutosaveFaultInjector,
) -> Result<(), String> {
    faults.check(create_fault)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp_path)
        .map_err(|error| format!("{operation} failed for {}: {error}", temp_path.display()))?;
    if let Err(error) = faults.check(write_fault) {
        drop(file);
        return Err(cleanup_file_with_reason(temp_path, error));
    }
    if let Err(error) = file.write_all(bytes) {
        drop(file);
        return Err(cleanup_file_with_reason(
            temp_path,
            format!("{operation} failed for {}: {error}", temp_path.display()),
        ));
    }
    if let Err(error) = faults.check(sync_fault) {
        drop(file);
        return Err(cleanup_file_with_reason(temp_path, error));
    }
    if let Err(error) = file.sync_all() {
        drop(file);
        return Err(cleanup_file_with_reason(
            temp_path,
            format!("{operation} failed for {}: {error}", temp_path.display()),
        ));
    }
    sync_parent_directory(temp_path, operation)?;
    Ok(())
}

fn persist_autosave_journal_after_temp_hook<F>(
    trusted_root: &TrustedLibraryRoot,
    journal: &AutosaveTransactionJournal,
    faults: &impl AutosaveFaultInjector,
    before_publish: F,
) -> Result<(), String>
where
    F: FnOnce(),
{
    let journal_path = autosave_journal_path(trusted_root);
    let next_path = autosave_journal_next_path(trusted_root);
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| {
        format!(
            "serialize_autosave_journal failed for {}: {error}",
            journal_path.display()
        )
    })?;
    create_synced_temp_file_with_faults(
        &next_path,
        &bytes,
        "write_autosave_journal_temp",
        AutosaveFaultPoint::JournalTempCreate,
        AutosaveFaultPoint::JournalTempWrite,
        AutosaveFaultPoint::JournalTempSync,
        faults,
    )?;
    before_publish();
    validate_trusted_publish_destination(trusted_root, &journal_path, "publish_autosave_journal")?;
    faults.check(AutosaveFaultPoint::JournalPublish)?;
    publish_temp_file(&next_path, &journal_path, "publish_autosave_journal")?;
    faults.check(AutosaveFaultPoint::JournalPublishReported)?;
    Ok(())
}

fn persist_autosave_journal(
    trusted_root: &TrustedLibraryRoot,
    journal: &AutosaveTransactionJournal,
    faults: &impl AutosaveFaultInjector,
) -> Result<(), String> {
    persist_autosave_journal_after_temp_hook(trusted_root, journal, faults, || {})
}

#[derive(Debug)]
enum OptionalJournalState {
    Missing,
    Parsed(Box<AutosaveTransactionJournal>),
    Invalid(String),
}

fn read_optional_autosave_journal(path: &Path) -> OptionalJournalState {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return OptionalJournalState::Missing
        }
        Err(error) => {
            return OptionalJournalState::Invalid(format!(
                "inspect_autosave_journal failed for {}: {error}",
                path.display()
            ))
        }
    };
    if metadata_is_symlink_or_reparse_point(&metadata) || !metadata.is_file() {
        return OptionalJournalState::Invalid(format!(
            "validate_autosave_journal failed for {}: expected a trusted regular file",
            path.display()
        ));
    }
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return OptionalJournalState::Invalid(format!(
                "read_autosave_journal failed for {}: {error}",
                path.display()
            ))
        }
    };
    match serde_json::from_slice::<AutosaveTransactionJournal>(&bytes) {
        Ok(journal) => OptionalJournalState::Parsed(Box::new(journal)),
        Err(error) => OptionalJournalState::Invalid(format!(
            "parse_autosave_journal failed for {}: {error}",
            path.display()
        )),
    }
}

fn current_index_matches_digest(
    trusted_root: &TrustedLibraryRoot,
    expected_digest: Option<&str>,
) -> Result<bool, String> {
    let snapshot = require_index_snapshot(trusted_root)?;
    Ok(match (&snapshot.original_bytes, expected_digest) {
        (None, None) => true,
        (Some(bytes), Some(expected)) => sha256_hex(bytes) == expected,
        _ => false,
    })
}

fn current_index_matches_next_index(
    trusted_root: &TrustedLibraryRoot,
    expected_index: &NoteIndex,
) -> Result<bool, String> {
    Ok(require_index_snapshot(trusted_root)?.index == *expected_index)
}

fn validate_trusted_publish_destination(
    trusted_root: &TrustedLibraryRoot,
    destination: &Path,
    operation: &str,
) -> Result<(), String> {
    let relative_path = destination
        .strip_prefix(trusted_root.path())
        .map_err(|error| {
            format!(
                "{operation} failed for {}: destination is outside {}: {}",
                destination.display(),
                trusted_root.path().display(),
                error
            )
        })?;
    if relative_path.as_os_str().is_empty() {
        return Err(format!(
            "{operation} failed for {}: destination cannot be the library root",
            destination.display()
        ));
    }
    validate_no_symlink_beneath_root(trusted_root, relative_path)
        .map_err(|error| error.display(operation))?;
    ensure_path_within_canonical_root(trusted_root, destination)
        .map_err(|error| error.display(operation))?;
    match fs::symlink_metadata(destination) {
        Ok(_) => validate_existing_trusted_file(trusted_root, destination, operation),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "{operation} failed for {}: {error}",
            destination.display()
        )),
    }
}

fn validate_journal_previous_entry_against_current_index(
    trusted_root: &TrustedLibraryRoot,
    journal: &AutosaveTransactionJournal,
) -> Result<(), String> {
    if !current_index_matches_digest(trusted_root, journal.expected_index_digest.as_deref())? {
        return Ok(());
    }
    let snapshot = require_index_snapshot(trusted_root)?;
    let current_entry = snapshot.index.entries.get(&journal.note_id);
    match (current_entry, journal.previous_relative_path.as_deref()) {
        (None, None) => Ok(()),
        (Some(entry), Some(previous_relative_path))
            if entry.relative_path == previous_relative_path =>
        {
            Ok(())
        }
        (Some(entry), None) if entry.relative_path == journal.next_relative_path => Ok(()),
        (None, Some(_)) => Err(format!(
            "validate_autosave_journal failed for {}: current index no longer contains the recorded previous note entry",
            autosave_journal_path(trusted_root).display()
        )),
        (Some(_), None) => Err(format!(
            "validate_autosave_journal failed for {}: current index already contains the recorded note id",
            autosave_journal_path(trusted_root).display()
        )),
        (Some(entry), Some(previous_relative_path)) => Err(format!(
            "validate_autosave_journal failed for {}: current index path {} does not match the recorded previous note path {}",
            autosave_journal_path(trusted_root).display(),
            entry.relative_path,
            previous_relative_path
        )),
    }
}

fn remove_regular_file_if_exists(path: &Path, operation: &str) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata_is_symlink_or_reparse_point(&metadata) || !metadata.is_file() {
                return Err(format!(
                    "{operation} failed for {}: expected a trusted regular file",
                    path.display()
                ));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "{operation} failed for {}: {error}",
                path.display()
            ))
        }
    }

    fs::remove_file(path)
        .map_err(|error| format!("{operation} failed for {}: {error}", path.display()))?;
    Ok(true)
}

fn remove_regular_file_if_exists_and_sync(path: &Path, operation: &str) -> Result<(), String> {
    if remove_regular_file_if_exists(path, operation)? {
        sync_parent_directory(path, operation)?;
    }
    Ok(())
}

fn ensure_directory_tree_trusted(
    trusted_root: &TrustedLibraryRoot,
    relative_path: &Path,
) -> Result<(), String> {
    validate_no_symlink_beneath_root(trusted_root, relative_path)
        .map_err(|error| error.display("validate_directory_tree"))?;
    let directory = trusted_root.path().join(relative_path);
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "validate_directory_tree failed for {}: {}",
                directory.display(),
                error
            ));
        }
    };
    if metadata_is_symlink_or_reparse_point(&metadata) || !metadata.is_dir() {
        return Err(format!(
            "validate_directory_tree failed for {}: expected a trusted directory",
            directory.display()
        ));
    }
    ensure_path_within_canonical_root(trusted_root, &directory)
        .map_err(|error| error.display("validate_directory_tree"))?;

    let scan = scan_library_subtree(&ProductionFileSystem, trusted_root, &directory, false);
    if !scan.is_complete() {
        return Err(scan
            .issues
            .iter()
            .map(NoteLoadIssue::display)
            .collect::<Vec<_>>()
            .join("; "));
    }

    Ok(())
}

#[derive(Debug)]
struct ResolvedAutosaveJournal {
    journal: AutosaveTransactionJournal,
    next_note_path: PathBuf,
    note_temp_path: PathBuf,
    index_temp_path: PathBuf,
    previous_note_path: Option<PathBuf>,
}

fn resolve_autosave_journal(
    trusted_root: &TrustedLibraryRoot,
    journal: AutosaveTransactionJournal,
) -> Result<ResolvedAutosaveJournal, String> {
    if journal.version != AUTOSAVE_TRANSACTION_VERSION {
        return Err(format!(
            "validate_autosave_journal failed for {}: unsupported version {}",
            autosave_journal_path(trusted_root).display(),
            journal.version
        ));
    }
    if journal.operation_id.trim().is_empty() {
        return Err(format!(
            "validate_autosave_journal failed for {}: operation_id is required",
            autosave_journal_path(trusted_root).display()
        ));
    }
    if !is_valid_autosave_operation_id(&journal.operation_id) {
        return Err(format!(
            "validate_autosave_journal failed for {}: operation_id has an invalid format",
            autosave_journal_path(trusted_root).display()
        ));
    }
    validate_index_paths(
        trusted_root,
        &get_index_path(trusted_root.path()),
        &journal.next_index,
    )
    .map_err(|issue| issue.display())?;
    let indexed_entry = journal
        .next_index
        .entries
        .get(&journal.note_id)
        .ok_or_else(|| {
            format!(
            "validate_autosave_journal failed for {}: next_index is missing the recorded note id",
            autosave_journal_path(trusted_root).display()
        )
        })?;
    if indexed_entry.relative_path != journal.next_relative_path {
        return Err(format!(
            "validate_autosave_journal failed for {}: next_index path does not match the recorded next note path",
            autosave_journal_path(trusted_root).display()
        ));
    }
    let next_note_path = validated_library_file_path(trusted_root, &journal.next_relative_path)?;
    let note_temp_path =
        validated_library_file_path(trusted_root, &journal.note_temp_relative_path)?;
    let expected_note_temp_path =
        note_temp_path_for_operation(&next_note_path, &journal.operation_id)?;
    if note_temp_path != expected_note_temp_path {
        return Err(format!(
            "validate_autosave_journal failed for {}: note temp path does not match the recorded operation id",
            autosave_journal_path(trusted_root).display()
        ));
    }
    let index_temp_path =
        validated_library_file_path(trusted_root, &journal.index_temp_relative_path)?;
    let expected_index_temp_path =
        index_temp_path_for_operation(trusted_root, &journal.operation_id);
    if index_temp_path != expected_index_temp_path {
        return Err(format!(
            "validate_autosave_journal failed for {}: index temp path does not match the recorded operation id",
            autosave_journal_path(trusted_root).display()
        ));
    }
    if journal.previous_relative_path.is_some() != journal.previous_note_digest.is_some() {
        return Err(format!(
            "validate_autosave_journal failed for {}: previous note path and digest must either both be present or both be absent",
            autosave_journal_path(trusted_root).display()
        ));
    }
    let previous_note_path = journal
        .previous_relative_path
        .as_deref()
        .map(|path| validated_library_file_path(trusted_root, path))
        .transpose()?;
    validate_journal_previous_entry_against_current_index(trusted_root, &journal)?;

    Ok(ResolvedAutosaveJournal {
        journal,
        next_note_path,
        note_temp_path,
        index_temp_path,
        previous_note_path,
    })
}

fn cleanup_pending_autosave_journal_files(trusted_root: &TrustedLibraryRoot) -> Result<(), String> {
    remove_regular_file_if_exists_and_sync(
        &autosave_journal_next_path(trusted_root),
        "cleanup_autosave_journal_candidate",
    )?;
    remove_regular_file_if_exists_and_sync(
        &autosave_journal_path(trusted_root),
        "cleanup_autosave_journal",
    )
}

fn discover_pending_autosave_journal(
    trusted_root: &TrustedLibraryRoot,
) -> Result<Option<AutosaveTransactionJournal>, String> {
    let primary_path = autosave_journal_path(trusted_root);
    let next_path = autosave_journal_next_path(trusted_root);
    let primary = read_optional_autosave_journal(&primary_path);
    let next = read_optional_autosave_journal(&next_path);

    match (primary, next) {
        (OptionalJournalState::Missing, OptionalJournalState::Missing) => Ok(None),
        (OptionalJournalState::Parsed(primary), OptionalJournalState::Missing) => {
            Ok(Some(*primary))
        }
        (OptionalJournalState::Parsed(primary), OptionalJournalState::Parsed(next_journal)) => {
            if primary.operation_id != next_journal.operation_id {
                return Err(format!(
                    "validate_autosave_journal failed for {} and {}: journal identities differ",
                    primary_path.display(),
                    next_path.display()
                ));
            }
            remove_regular_file_if_exists_and_sync(
                &next_path,
                "cleanup_stale_autosave_journal_candidate",
            )?;
            Ok(Some(*primary))
        }
        (OptionalJournalState::Parsed(primary), OptionalJournalState::Invalid(_)) => {
            remove_regular_file_if_exists_and_sync(
                &next_path,
                "cleanup_invalid_autosave_journal_candidate",
            )?;
            Ok(Some(*primary))
        }
        (OptionalJournalState::Missing, OptionalJournalState::Parsed(next_journal)) => {
            validate_trusted_publish_destination(
                trusted_root,
                &primary_path,
                "promote_autosave_journal_candidate",
            )?;
            publish_temp_file(
                &next_path,
                &primary_path,
                "promote_autosave_journal_candidate",
            )?;
            Ok(Some(*next_journal))
        }
        (OptionalJournalState::Missing, OptionalJournalState::Invalid(reason)) => Err(reason),
        (OptionalJournalState::Invalid(reason), OptionalJournalState::Missing) => Err(reason),
        (OptionalJournalState::Invalid(reason), OptionalJournalState::Parsed(_)) => Err(reason),
        (OptionalJournalState::Invalid(reason), OptionalJournalState::Invalid(_)) => Err(reason),
    }
}

fn cleanup_prepared_autosave_transaction(
    trusted_root: &TrustedLibraryRoot,
    resolved: &ResolvedAutosaveJournal,
) -> Result<(), String> {
    remove_regular_file_if_exists_and_sync(&resolved.note_temp_path, "cleanup_prepared_note_temp")?;
    remove_regular_file_if_exists_and_sync(
        &resolved.index_temp_path,
        "cleanup_prepared_index_temp",
    )?;
    cleanup_pending_autosave_journal_files(trusted_root)
}

fn publish_recovered_note_file(
    trusted_root: &TrustedLibraryRoot,
    resolved: &ResolvedAutosaveJournal,
    faults: &impl AutosaveFaultInjector,
) -> Result<(), String> {
    validate_existing_trusted_file(
        trusted_root,
        &resolved.note_temp_path,
        "validate_recovered_note_temp",
    )?;
    if sha256_hex(&read_trusted_file_bytes(
        trusted_root,
        &resolved.note_temp_path,
        "verify_recovered_note_temp_digest",
    )?) != resolved.journal.next_note_digest
    {
        return Err(format!(
            "verify_recovered_note_temp_digest failed for {}: staged note bytes do not match the recorded digest",
            resolved.note_temp_path.display()
        ));
    }
    validate_autosave_note_publish_target(
        trusted_root,
        &resolved.next_note_path,
        resolved.previous_note_path.as_deref(),
        resolved.journal.previous_note_digest.as_deref(),
        &resolved.journal.next_note_digest,
        "publish_recovered_note",
    )?;
    faults.check(AutosaveFaultPoint::NotePublish)?;
    publish_temp_file(
        &resolved.note_temp_path,
        &resolved.next_note_path,
        "publish_recovered_note",
    )?;
    faults.check(AutosaveFaultPoint::NotePublishReported)?;
    Ok(())
}

fn stage_autosave_index_temp_if_missing(
    trusted_root: &TrustedLibraryRoot,
    resolved: &ResolvedAutosaveJournal,
) -> Result<(), String> {
    match fs::symlink_metadata(&resolved.index_temp_path) {
        Ok(_) => {
            validate_existing_trusted_file(
                trusted_root,
                &resolved.index_temp_path,
                "validate_recovered_index_temp",
            )?;
            let bytes = read_trusted_file_bytes(
                trusted_root,
                &resolved.index_temp_path,
                "validate_recovered_index_temp",
            )?;
            let parsed = serde_json::from_slice::<NoteIndex>(&bytes).map_err(|error| {
                format!(
                    "parse_recovered_index_temp failed for {}: {error}",
                    resolved.index_temp_path.display()
                )
            })?;
            if parsed != resolved.journal.next_index {
                return Err(format!(
                    "validate_recovered_index_temp failed for {}: staged index bytes do not match the recorded next index",
                    resolved.index_temp_path.display()
                ));
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let bytes =
                serde_json::to_vec_pretty(&resolved.journal.next_index).map_err(|error| {
                    format!(
                        "serialize_recovered_index failed for {}: {error}",
                        get_index_path(trusted_root.path()).display()
                    )
                })?;
            create_synced_temp_file_with_faults(
                &resolved.index_temp_path,
                &bytes,
                "stage_recovered_index_temp",
                AutosaveFaultPoint::IndexTempCreate,
                AutosaveFaultPoint::IndexTempWrite,
                AutosaveFaultPoint::IndexTempSync,
                &NoopAutosaveFaultInjector,
            )
        }
        Err(error) => Err(format!(
            "inspect_recovered_index_temp failed for {}: {error}",
            resolved.index_temp_path.display()
        )),
    }
}

fn publish_staged_autosave_index(
    trusted_root: &TrustedLibraryRoot,
    resolved: &ResolvedAutosaveJournal,
    faults: &impl AutosaveFaultInjector,
) -> Result<(), String> {
    if !current_index_matches_digest(
        trusted_root,
        resolved.journal.expected_index_digest.as_deref(),
    )? {
        return Err(format!(
            "verify_autosave_index_precondition failed for {}: the index changed while the autosave transaction was in progress",
            get_index_path(trusted_root.path()).display()
        ));
    }
    stage_autosave_index_temp_if_missing(trusted_root, resolved)?;
    validate_trusted_publish_destination(
        trusted_root,
        &get_index_path(trusted_root.path()),
        "publish_autosave_index",
    )?;
    faults.check(AutosaveFaultPoint::IndexPublish)?;
    publish_temp_file(
        &resolved.index_temp_path,
        &get_index_path(trusted_root.path()),
        "publish_autosave_index",
    )?;
    faults.check(AutosaveFaultPoint::IndexPublishReported)?;
    Ok(())
}

fn cleanup_index_published_autosave_transaction(
    trusted_root: &TrustedLibraryRoot,
    resolved: &ResolvedAutosaveJournal,
    faults: &impl AutosaveFaultInjector,
) -> Result<(), String> {
    if let (Some(previous_path), Some(previous_digest)) = (
        resolved.previous_note_path.as_ref(),
        resolved.journal.previous_note_digest.as_deref(),
    ) {
        if previous_path != &resolved.next_note_path {
            match fs::symlink_metadata(previous_path) {
                Ok(_) => {
                    validate_existing_trusted_file(
                        trusted_root,
                        previous_path,
                        "validate_old_note_cleanup",
                    )?;
                    if !file_digest_matches(
                        trusted_root,
                        previous_path,
                        previous_digest,
                        "validate_old_note_cleanup",
                    )? {
                        return Err(format!(
                            "validate_old_note_cleanup failed for {}: content no longer matches the recorded previous note digest",
                            previous_path.display()
                        ));
                    }
                    faults.check(AutosaveFaultPoint::OldFileCleanup)?;
                    fs::remove_file(previous_path).map_err(|error| {
                        format!(
                            "remove_old_note_cleanup failed for {}: {error}",
                            previous_path.display()
                        )
                    })?;
                    sync_parent_directory(previous_path, "remove_old_note_cleanup")?;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "inspect_old_note_cleanup failed for {}: {error}",
                        previous_path.display()
                    ))
                }
            }
        }
    }

    remove_regular_file_if_exists_and_sync(&resolved.note_temp_path, "cleanup_note_temp")?;
    remove_regular_file_if_exists_and_sync(&resolved.index_temp_path, "cleanup_index_temp")?;
    faults.check(AutosaveFaultPoint::JournalCleanup)?;
    cleanup_pending_autosave_journal_files(trusted_root)
}

fn recover_pending_note_save_unlocked_with_faults(
    trusted_root: &TrustedLibraryRoot,
    faults: &impl AutosaveFaultInjector,
) -> Result<(), String> {
    loop {
        let Some(journal) = discover_pending_autosave_journal(trusted_root)? else {
            return Ok(());
        };
        let resolved = resolve_autosave_journal(trusted_root, journal)?;

        match resolved.journal.phase {
            AutosaveTransactionPhase::Prepared => {
                cleanup_prepared_autosave_transaction(trusted_root, &resolved)?;
            }
            AutosaveTransactionPhase::Staged => {
                if !file_digest_matches(
                    trusted_root,
                    &resolved.next_note_path,
                    &resolved.journal.next_note_digest,
                    "verify_staged_note",
                )? {
                    match fs::symlink_metadata(&resolved.note_temp_path) {
                        Ok(_) => publish_recovered_note_file(trusted_root, &resolved, faults)?,
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {
                            if current_index_matches_digest(
                                trusted_root,
                                resolved.journal.expected_index_digest.as_deref(),
                            )? {
                                cleanup_prepared_autosave_transaction(trusted_root, &resolved)?;
                                continue;
                            }
                            return Err(format!(
                                "recover_staged_note failed for {}: neither the final note nor the staged temp file is available",
                                resolved.next_note_path.display()
                            ));
                        }
                        Err(error) => {
                            return Err(format!(
                                "inspect_staged_note_temp failed for {}: {error}",
                                resolved.note_temp_path.display()
                            ))
                        }
                    }
                }

                let mut next_journal = resolved.journal.clone();
                next_journal.phase = AutosaveTransactionPhase::NotePublished;
                persist_autosave_journal(trusted_root, &next_journal, faults)?;
            }
            AutosaveTransactionPhase::NotePublished => {
                if !file_digest_matches(
                    trusted_root,
                    &resolved.next_note_path,
                    &resolved.journal.next_note_digest,
                    "verify_note_published",
                )? {
                    return Err(format!(
                        "verify_note_published failed for {}: content no longer matches the recorded note digest",
                        resolved.next_note_path.display()
                    ));
                }

                if !current_index_matches_next_index(trusted_root, &resolved.journal.next_index)? {
                    publish_staged_autosave_index(trusted_root, &resolved, faults)?;
                }

                let mut next_journal = resolved.journal.clone();
                next_journal.phase = AutosaveTransactionPhase::IndexPublished;
                persist_autosave_journal(trusted_root, &next_journal, faults)?;
            }
            AutosaveTransactionPhase::IndexPublished => {
                if !file_digest_matches(
                    trusted_root,
                    &resolved.next_note_path,
                    &resolved.journal.next_note_digest,
                    "verify_index_published_note",
                )? {
                    return Err(format!(
                        "verify_index_published_note failed for {}: content no longer matches the recorded note digest",
                        resolved.next_note_path.display()
                    ));
                }
                if !current_index_matches_next_index(trusted_root, &resolved.journal.next_index)? {
                    return Err(format!(
                        "verify_index_published failed for {}: the current index does not match the committed autosave transaction",
                        get_index_path(trusted_root.path()).display()
                    ));
                }
                cleanup_index_published_autosave_transaction(trusted_root, &resolved, faults)?;
            }
        }
    }
}

fn recover_pending_note_save_unlocked(trusted_root: &TrustedLibraryRoot) -> Result<(), String> {
    recover_pending_note_save_unlocked_with_faults(trusted_root, &NoopAutosaveFaultInjector)
}

fn write_note_file_atomically_after_temp_hook<F>(
    trusted_root: &TrustedLibraryRoot,
    destination: &Path,
    content: &str,
    before_destination_validation: F,
) -> Result<(), String>
where
    F: FnOnce(),
{
    validate_note_destination_before_replace(trusted_root, destination)?;
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
    if let Err(error) = validate_note_destination_before_replace(trusted_root, destination) {
        return Err(cleanup_file_with_reason(&tmp_path, error));
    }
    publish_temp_file(&tmp_path, destination, "replace_note")?;

    Ok(())
}

fn write_note_file_atomically(
    trusted_root: &TrustedLibraryRoot,
    destination: &Path,
    content: &str,
) -> Result<(), String> {
    write_note_file_atomically_after_temp_hook(trusted_root, destination, content, || {})
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

fn remove_trusted_directory_tree(
    trusted_root: &TrustedLibraryRoot,
    directory: &Path,
) -> Result<(), String> {
    ensure_path_within_canonical_root(trusted_root, directory)
        .map_err(|error| error.display("validate_folder_delete"))?;
    let metadata = fs::symlink_metadata(directory).map_err(|error| {
        format!(
            "inspect_folder_delete failed for {}: {}",
            directory.display(),
            error
        )
    })?;
    if metadata_is_symlink_or_reparse_point(&metadata) || !metadata.is_dir() {
        return Err(format!(
            "validate_folder_delete failed for {}: expected a trusted directory",
            directory.display()
        ));
    }

    let entries = fs::read_dir(directory).map_err(|error| {
        format!(
            "read_folder_delete failed for {}: {}",
            directory.display(),
            error
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "read_folder_delete_entry failed for {}: {}",
                directory.display(),
                error
            )
        })?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            format!(
                "inspect_folder_delete_entry failed for {}: {}",
                path.display(),
                error
            )
        })?;
        if metadata_is_symlink_or_reparse_point(&metadata) {
            return Err(format!(
                "reject_symlink failed for {}: symbolic links and reparse points beneath the note library are not allowed",
                path.display()
            ));
        }
        ensure_path_within_canonical_root(trusted_root, &path)
            .map_err(|error| error.display("validate_folder_delete_entry"))?;

        if metadata.is_dir() {
            remove_trusted_directory_tree(trusted_root, &path)?;
        } else {
            fs::remove_file(&path).map_err(|error| {
                format!(
                    "remove_folder_file failed for {}: {}",
                    path.display(),
                    error
                )
            })?;
        }
    }

    let metadata = fs::symlink_metadata(directory).map_err(|error| {
        format!(
            "reinspect_folder_delete failed for {}: {}",
            directory.display(),
            error
        )
    })?;
    if metadata_is_symlink_or_reparse_point(&metadata) || !metadata.is_dir() {
        return Err(format!(
            "validate_folder_delete failed for {}: directory changed before removal",
            directory.display()
        ));
    }
    ensure_path_within_canonical_root(trusted_root, directory)
        .map_err(|error| error.display("validate_folder_delete"))?;
    fs::remove_dir(directory).map_err(|error| {
        format!(
            "remove_folder_directory failed for {}: {}",
            directory.display(),
            error
        )
    })
}

pub fn generate_note_id(relative_file_path: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(relative_file_path.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("note-{}", &hash[..12])
}

// ── Public API ──

pub fn get_auto_save_dir(documents_dir: &Path) -> PathBuf {
    documents_dir.join("HwanNote").join("Notes")
}

fn library_candidate_relative_path(
    trusted_root: &TrustedLibraryRoot,
    requested_root: &Path,
    candidate: &Path,
    allow_root: bool,
) -> Result<PathBuf, String> {
    let relative = if candidate.is_absolute() {
        if candidate == requested_root || candidate == trusted_root.path() {
            PathBuf::new()
        } else if let Ok(relative) = candidate.strip_prefix(trusted_root.path()) {
            relative.to_path_buf()
        } else if let Ok(relative) = candidate.strip_prefix(requested_root) {
            relative.to_path_buf()
        } else {
            return Err(format!(
                "validate_library_path failed for {}: path is outside the configured note library",
                candidate.display()
            ));
        }
    } else {
        candidate.to_path_buf()
    };

    if relative.as_os_str().is_empty() {
        return if allow_root {
            Ok(relative)
        } else {
            Err("The library root cannot be used as a file path.".to_string())
        };
    }

    normalize_library_relative_path(trusted_root.path(), &to_posix(&relative.to_string_lossy()))
        .map_err(|error| error.display("validate_library_path"))
}

pub fn save_markdown_file(
    library_root: &Path,
    file_path: &Path,
    content: &str,
) -> Result<(), String> {
    let trusted_root = TrustedLibraryRoot::open(library_root)?;
    let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if !ext.eq_ignore_ascii_case("md") {
        return Err("Only .md files are supported.".to_string());
    }
    let relative = library_candidate_relative_path(&trusted_root, library_root, file_path, false)?;
    let parent_relative = relative.parent().unwrap_or_else(|| Path::new(""));
    ensure_library_subdirectory(&trusted_root, parent_relative)?;
    let destination = trusted_root.path().join(relative);
    write_note_file_atomically(&trusted_root, &destination, content)
}

pub fn read_markdown_file(library_root: &Path, file_path: &Path) -> Result<String, String> {
    let trusted_root = TrustedLibraryRoot::open(library_root)?;
    let ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if !ext.eq_ignore_ascii_case("md") {
        return Err("Only .md files are supported.".to_string());
    }
    let relative = library_candidate_relative_path(&trusted_root, library_root, file_path, false)?;
    let path = trusted_root.file_path(&to_posix(&relative.to_string_lossy()), true)?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata_is_symlink_or_reparse_point(&metadata) || !metadata.is_file() {
        return Err(format!(
            "validate_markdown_file failed for {}: expected a trusted regular file",
            path.display()
        ));
    }
    let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
    ensure_path_within_canonical_root(&trusted_root, &canonical)
        .map_err(|error| error.display("validate_markdown_file"))?;
    fs::read_to_string(canonical).map_err(|e| e.to_string())
}

pub fn list_markdown_files(library_root: &Path, dir_path: &Path) -> Result<Vec<String>, String> {
    let trusted_root = TrustedLibraryRoot::open(library_root)?;
    let relative = library_candidate_relative_path(&trusted_root, library_root, dir_path, true)?;
    validate_no_symlink_beneath_root(&trusted_root, &relative)
        .map_err(|error| error.display("validate_library_directory"))?;
    let directory = trusted_root.path().join(relative);
    let metadata = fs::symlink_metadata(&directory).map_err(|error| error.to_string())?;
    if metadata_is_symlink_or_reparse_point(&metadata) || !metadata.is_dir() {
        return Err(format!(
            "validate_library_directory failed for {}: expected a trusted directory",
            directory.display()
        ));
    }
    ensure_path_within_canonical_root(&trusted_root, &directory)
        .map_err(|error| error.display("validate_library_directory"))?;

    let entries = fs::read_dir(&directory)
        .map_err(|error| format!("read_dir failed for {}: {}", directory.display(), error))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!(
                "read_dir_entry failed for {}: {}",
                directory.display(),
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
            let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
            ensure_path_within_canonical_root(&trusted_root, &canonical)
                .map_err(|error| error.display("validate_markdown_file"))?;
            files.push(canonical.to_string_lossy().to_string());
        }
    }
    Ok(files)
}

fn list_folders_with_fs<F: LibraryFileSystem>(
    auto_save_dir: &Path,
    file_system: &F,
) -> Result<Vec<String>, String> {
    let trusted_root = TrustedLibraryRoot::open(auto_save_dir)?;

    list_folders_with_root(&trusted_root, file_system)
}

fn list_folders_with_root<F: LibraryFileSystem>(
    trusted_root: &TrustedLibraryRoot,
    file_system: &F,
) -> Result<Vec<String>, String> {
    let scan = scan_library_tree(file_system, trusted_root, None, false);
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
    let trusted_root = TrustedLibraryRoot::open(auto_save_dir)?;
    let normalized = sanitize_folder_path(Some(folder_path))?;
    if normalized.is_empty() {
        return Err("Folder path is required.".to_string());
    }

    let relative_path = normalize_library_relative_path(trusted_root.path(), &normalized)
        .map_err(|error| error.display("validate_folder_path"))?;
    ensure_library_subdirectory(&trusted_root, &relative_path)?;
    list_folders_with_root(&trusted_root, &ProductionFileSystem)
}

pub fn rename_folder(auto_save_dir: &Path, from: &str, to: &str) -> Result<Vec<String>, String> {
    let trusted_root = TrustedLibraryRoot::open(auto_save_dir)?;

    let from_path = sanitize_folder_path(Some(from))?;
    let to_path = sanitize_folder_path(Some(to))?;

    if from_path.is_empty() || to_path.is_empty() {
        return Err("Folder path is required.".to_string());
    }
    if from_path == to_path {
        return list_folders_with_root(&trusted_root, &ProductionFileSystem);
    }
    if to_path.starts_with(&format!("{}/", from_path)) {
        return Err("Cannot move a folder into its own child.".to_string());
    }
    let from_relative = normalize_library_relative_path(trusted_root.path(), &from_path)
        .map_err(|error| error.display("validate_source_folder"))?;
    let to_relative = normalize_library_relative_path(trusted_root.path(), &to_path)
        .map_err(|error| error.display("validate_target_folder"))?;

    let _index_guard = lock_note_index();
    recover_pending_note_save_unlocked(&trusted_root)?;
    let index_snapshot = require_index_snapshot(&trusted_root)?;
    let mut index = index_snapshot.index.clone();

    validate_no_symlink_beneath_root(&trusted_root, &from_relative)
        .map_err(|error| error.display("validate_source_folder"))?;
    let source_dir = trusted_root.path().join(&from_relative);
    match fs::symlink_metadata(&source_dir) {
        Ok(metadata) if metadata.is_dir() && !metadata_is_symlink_or_reparse_point(&metadata) => {}
        Ok(_) => return Err("Folder is not a trusted directory.".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err("Folder not found.".to_string());
        }
        Err(error) => return Err(error.to_string()),
    }
    ensure_directory_tree_trusted(&trusted_root, &from_relative)?;

    validate_no_symlink_beneath_root(&trusted_root, &to_relative)
        .map_err(|error| error.display("validate_target_folder"))?;
    let target_dir = trusted_root.path().join(&to_relative);
    match fs::symlink_metadata(&target_dir) {
        Ok(_) => return Err("Target folder already exists.".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }

    if let Some(parent_relative) = to_relative.parent() {
        ensure_library_subdirectory(&trusted_root, parent_relative)?;
    }

    ensure_directory_tree_trusted(&trusted_root, &from_relative)?;
    validate_no_symlink_beneath_root(&trusted_root, &to_relative)
        .map_err(|error| error.display("validate_target_folder"))?;
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
        write_index_from_snapshot(&trusted_root, &index_snapshot, &index)
            .map_err(index_write_failure_to_string)?;
    }

    list_folders_with_root(&trusted_root, &ProductionFileSystem)
}

pub fn delete_folder(
    auto_save_dir: &Path,
    folder_path: &str,
) -> Result<FolderDeleteResult, String> {
    let trusted_root = TrustedLibraryRoot::open(auto_save_dir)?;

    let normalized = sanitize_folder_path(Some(folder_path))?;
    if normalized.is_empty() {
        return Err("Folder path is required.".to_string());
    }

    let _index_guard = lock_note_index();
    recover_pending_note_save_unlocked(&trusted_root)?;
    let index_snapshot = require_index_snapshot(&trusted_root)?;
    let folder_relative = normalize_library_relative_path(trusted_root.path(), &normalized)
        .map_err(|error| error.display("validate_folder_path"))?;
    validate_no_symlink_beneath_root(&trusted_root, &folder_relative)
        .map_err(|error| error.display("validate_folder_path"))?;
    ensure_directory_tree_trusted(&trusted_root, &folder_relative)?;

    let source_dir = trusted_root.path().join(&folder_relative);
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

    let source_exists = match fs::symlink_metadata(&source_dir) {
        Ok(metadata) if metadata.is_dir() && !metadata_is_symlink_or_reparse_point(&metadata) => {
            true
        }
        Ok(_) => return Err("Folder is not a trusted directory.".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.to_string()),
    };
    if !source_exists && matching_entries.is_empty() {
        return Err("Folder not found.".to_string());
    }

    let mut moved_note_ids = Vec::new();

    for (note_id, old_relative_path) in matching_entries {
        let old_path = validated_library_file_path(&trusted_root, &old_relative_path)?;
        validate_existing_trusted_file(&trusted_root, &old_path, "validate_folder_note")?;

        let base_name = old_path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("untitled");
        let new_path = ensure_unique_file_path(trusted_root.path(), base_name, None)?;
        validate_note_destination_before_replace(&trusted_root, &new_path)?;
        validate_existing_trusted_file(&trusted_root, &old_path, "validate_folder_note")?;
        validate_note_destination_before_replace(&trusted_root, &new_path)?;
        fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;

        if let Some(entry) = index.entries.get_mut(&note_id) {
            entry.relative_path = relative_path(trusted_root.path(), &new_path);
        }
        moved_note_ids.push(note_id);
    }

    write_index_from_snapshot(&trusted_root, &index_snapshot, &index)
        .map_err(index_write_failure_to_string)?;

    if source_exists {
        remove_trusted_directory_tree(&trusted_root, &source_dir)?;
    }

    Ok(FolderDeleteResult {
        folders: list_folders_with_root(&trusted_root, &ProductionFileSystem)?,
        moved_note_ids,
    })
}

fn validate_autosave_note_publish_target(
    trusted_root: &TrustedLibraryRoot,
    target_path: &Path,
    previous_path: Option<&Path>,
    previous_digest: Option<&str>,
    next_digest: &str,
    operation: &str,
) -> Result<(), String> {
    validate_note_destination_before_replace(trusted_root, target_path)?;
    match fs::symlink_metadata(target_path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Ok(_) => {
            validate_existing_trusted_file(trusted_root, target_path, operation)?;
            if Some(target_path) == previous_path {
                let expected_previous = previous_digest.ok_or_else(|| {
                    format!(
                        "{operation} failed for {}: previous note digest is required for an in-place autosave update",
                        target_path.display()
                    )
                })?;
                if !file_digest_matches(trusted_root, target_path, expected_previous, operation)? {
                    return Err(format!(
                        "{operation} failed for {}: the current file no longer matches the recorded previous note digest",
                        target_path.display()
                    ));
                }
                return Ok(());
            }
            if file_digest_matches(trusted_root, target_path, next_digest, operation)? {
                return Ok(());
            }
            Err(format!(
                "{operation} failed for {}: the destination already exists with unexpected content",
                target_path.display()
            ))
        }
        Err(error) => Err(format!(
            "{operation} failed for {}: {error}",
            target_path.display()
        )),
    }
}

fn auto_save_markdown_note_with_faults(
    trusted_root: &TrustedLibraryRoot,
    payload: &AutoSavePayload,
    faults: &impl AutosaveFaultInjector,
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
        normalize_library_relative_path(trusted_root.path(), &safe_folder)
            .map_err(|error| error.display("validate_note_folder"))?
    };

    let _index_guard = lock_note_index();
    recover_pending_note_save_unlocked(trusted_root)?;
    let index_snapshot = require_index_snapshot(trusted_root)?;
    let mut next_index = index_snapshot.index.clone();

    let target_dir = ensure_library_subdirectory(trusted_root, &safe_folder_path)?;
    let existing_entry = next_index.entries.get(&safe_id).cloned();
    let existing_path = existing_entry
        .as_ref()
        .map(|entry| validated_library_file_path(trusted_root, &entry.relative_path))
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
    let note_bytes = to_platform_line_endings(&stored_markdown).into_bytes();
    let created_at = existing_entry
        .as_ref()
        .map(|entry| entry.created_at)
        .unwrap_or_else(now_millis);
    let previous_note_digest = existing_path
        .as_ref()
        .map(|path| read_existing_file_digest(trusted_root, path, "read_previous_note_digest"))
        .transpose()?
        .flatten();
    let previous_relative_path = existing_path
        .as_ref()
        .zip(previous_note_digest.as_ref())
        .map(|(path, _)| relative_path(trusted_root.path(), path));
    let operation_id = next_autosave_operation_id();
    let note_temp_path = note_temp_path_for_operation(&next_file_path, &operation_id)?;
    let index_temp_path = index_temp_path_for_operation(trusted_root, &operation_id);

    let relative_path_string = relative_path(trusted_root.path(), &next_file_path);
    next_index.entries.insert(
        safe_id.clone(),
        NoteIndexEntry {
            relative_path: relative_path_string.clone(),
            created_at,
            manual_title: manual_title.clone(),
            is_pinned: payload.is_pinned,
        },
    );

    let journal_base = AutosaveTransactionJournal {
        version: AUTOSAVE_TRANSACTION_VERSION,
        operation_id: operation_id.clone(),
        phase: AutosaveTransactionPhase::Prepared,
        note_id: safe_id.clone(),
        previous_relative_path,
        next_relative_path: relative_path_string,
        note_temp_relative_path: relative_path(trusted_root.path(), &note_temp_path),
        index_temp_relative_path: relative_path(trusted_root.path(), &index_temp_path),
        expected_index_digest: index_snapshot.original_bytes.as_deref().map(sha256_hex),
        next_index: next_index.clone(),
        next_note_digest: sha256_hex(&note_bytes),
        previous_note_digest,
    };
    let journal_index_bytes = serde_json::to_vec_pretty(&next_index).map_err(|error| {
        format!(
            "serialize_autosave_index failed for {}: {error}",
            get_index_path(trusted_root.path()).display()
        )
    })?;

    persist_autosave_journal(trusted_root, &journal_base, faults)?;
    create_synced_temp_file_with_faults(
        &note_temp_path,
        &note_bytes,
        "write_note_temp",
        AutosaveFaultPoint::NoteTempCreate,
        AutosaveFaultPoint::NoteTempWrite,
        AutosaveFaultPoint::NoteTempSync,
        faults,
    )?;
    create_synced_temp_file_with_faults(
        &index_temp_path,
        &journal_index_bytes,
        "write_index_temp",
        AutosaveFaultPoint::IndexTempCreate,
        AutosaveFaultPoint::IndexTempWrite,
        AutosaveFaultPoint::IndexTempSync,
        faults,
    )?;

    let mut staged_journal = journal_base.clone();
    staged_journal.phase = AutosaveTransactionPhase::Staged;
    persist_autosave_journal(trusted_root, &staged_journal, faults)?;

    validate_no_symlink_beneath_root(trusted_root, &safe_folder_path)
        .map_err(|error| error.display("validate_note_folder"))?;
    validate_autosave_note_publish_target(
        trusted_root,
        &next_file_path,
        existing_path.as_deref(),
        staged_journal.previous_note_digest.as_deref(),
        &staged_journal.next_note_digest,
        "publish_note",
    )?;
    if sha256_hex(&read_trusted_file_bytes(
        trusted_root,
        &note_temp_path,
        "verify_note_temp_digest",
    )?) != staged_journal.next_note_digest
    {
        return Err(format!(
            "verify_note_temp_digest failed for {}: staged note bytes do not match the recorded digest",
            note_temp_path.display()
        ));
    }
    faults.check(AutosaveFaultPoint::NotePublish)?;
    publish_temp_file(&note_temp_path, &next_file_path, "publish_note")?;
    faults.check(AutosaveFaultPoint::NotePublishReported)?;

    let mut note_published_journal = staged_journal.clone();
    note_published_journal.phase = AutosaveTransactionPhase::NotePublished;
    persist_autosave_journal(trusted_root, &note_published_journal, faults)?;

    let resolved_note_published =
        resolve_autosave_journal(trusted_root, note_published_journal.clone())?;
    publish_staged_autosave_index(trusted_root, &resolved_note_published, faults)?;

    let mut index_published_journal = note_published_journal.clone();
    index_published_journal.phase = AutosaveTransactionPhase::IndexPublished;
    persist_autosave_journal(trusted_root, &index_published_journal, faults)?;

    let resolved_index_published = resolve_autosave_journal(trusted_root, index_published_journal)?;
    cleanup_index_published_autosave_transaction(trusted_root, &resolved_index_published, faults)?;

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
    let updated_at = system_time_to_millis(metadata.modified().map_err(|error| {
        format!(
            "read_saved_note_modified_time failed for {}: {}",
            next_file_path.display(),
            error
        )
    })?);

    Ok(AutoSaveResult {
        file_path: next_file_path.to_string_lossy().to_string(),
        note_id: safe_id,
        created_at,
        updated_at,
    })
}

pub fn auto_save_markdown_note(
    auto_save_dir: &Path,
    payload: &AutoSavePayload,
) -> Result<AutoSaveResult, String> {
    let trusted_root = TrustedLibraryRoot::open(auto_save_dir)?;
    auto_save_markdown_note_with_faults(&trusted_root, payload, &NoopAutosaveFaultInjector)
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
    trusted_root: &TrustedLibraryRoot,
    index: &NoteIndex,
    scan: LibraryScan,
    issues: Vec<NoteLoadIssue>,
) -> MarkdownLibraryLoadResult {
    MarkdownLibraryLoadResult {
        notes: materialize_notes(index, &scan),
        folders: scan.folders,
        load_state: NoteLoadState::Incomplete,
        issues,
        index_source_path: Some(
            get_index_path(trusted_root.path())
                .to_string_lossy()
                .to_string(),
        ),
        index_backup_path: None,
    }
}

fn load_markdown_library_with_fs<F: LibraryFileSystem>(
    auto_save_dir: &Path,
    file_system: &F,
) -> MarkdownLibraryLoadResult {
    let trusted_root = match resolve_trusted_library_root(auto_save_dir) {
        Ok(trusted_root) => trusted_root,
        Err(error) => {
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
                index_source_path: Some(
                    get_index_path(auto_save_dir).to_string_lossy().to_string(),
                ),
                index_backup_path: None,
            };
        }
    };
    let index_source_path = get_index_path(trusted_root.path());

    let _index_guard = lock_note_index();
    if let Err(reason) = recover_pending_note_save_unlocked(&trusted_root) {
        return MarkdownLibraryLoadResult {
            notes: Vec::new(),
            folders: Vec::new(),
            load_state: NoteLoadState::Incomplete,
            issues: vec![NoteLoadIssue::new(
                NoteLoadIssueKind::Index,
                "recover_pending_note_save",
                &autosave_journal_path(&trusted_root),
                reason,
            )],
            index_source_path: Some(index_source_path.to_string_lossy().to_string()),
            index_backup_path: None,
        };
    }
    let index_snapshot = match read_index_state(&trusted_root) {
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

    let scan = scan_library_tree(file_system, &trusted_root, None, true);
    if !scan.is_complete() {
        let issues = scan.issues.clone();
        return incomplete_load_result(&trusted_root, &index_snapshot.index, scan, issues);
    }

    let (reconciled_index, index_changed) = reconcile_index_with_scan(&index_snapshot.index, &scan);
    let notes = materialize_notes(&reconciled_index, &scan);

    if index_changed {
        match write_index_from_snapshot(&trusted_root, &index_snapshot, &reconciled_index) {
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
                    &trusted_root,
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
    let trusted_root = TrustedLibraryRoot::open(auto_save_dir)?;
    let _index_guard = lock_note_index();
    recover_pending_note_save_unlocked(&trusted_root)?;
    resolve_note_file_path_unlocked(&trusted_root, note_id)
}

fn resolve_note_file_path_unlocked(
    trusted_root: &TrustedLibraryRoot,
    note_id: &str,
) -> Result<Option<PathBuf>, String> {
    let safe_id = sanitize_note_id(note_id);
    if safe_id.is_empty() {
        return Ok(None);
    }

    let index = require_index_snapshot(trusted_root)?.index;
    let entry = match index.entries.get(&safe_id) {
        Some(e) => e,
        None => return Ok(None),
    };

    Ok(Some(validated_library_file_path(
        trusted_root,
        &entry.relative_path,
    )?))
}

fn trash_note_file_or_accept_missing<F>(file_path: &Path, delete_file: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    match delete_file(file_path) {
        Ok(()) => Ok(()),
        Err(delete_error) => match fs::symlink_metadata(file_path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Ok(_) => Err(delete_error),
            Err(error) => Err(format!(
                "Failed to recheck note file after trash error: {error}"
            )),
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

    let trusted_root = resolve_trusted_library_root(auto_save_dir)
        .map_err(|error| error.display("validate_library_root"))?;
    let _index_guard = lock_note_index();
    recover_pending_note_save_unlocked(&trusted_root)?;
    let expected_file_path =
        canonicalize_expected_library_path(&trusted_root, auto_save_dir, expected_file_path)?;
    remove_note_from_index_if_path_unlocked(&trusted_root, note_id, &expected_file_path)
}

fn remove_note_from_index_if_path_unlocked(
    trusted_root: &TrustedLibraryRoot,
    note_id: &str,
    expected_file_path: &Path,
) -> Result<Option<PathBuf>, String> {
    let safe_id = sanitize_note_id(note_id);
    if safe_id.is_empty() {
        return Ok(None);
    }

    let index_snapshot = require_index_snapshot(trusted_root)?;
    let mut index = index_snapshot.index.clone();
    let entry = match index.entries.get(&safe_id) {
        Some(e) => e.clone(),
        None => return Ok(None),
    };

    let file_path = validated_library_file_path(trusted_root, &entry.relative_path)?;
    if file_path != expected_file_path {
        return Err("Note index changed before delete completed".to_string());
    }
    match fs::symlink_metadata(expected_file_path) {
        Ok(_) => return Err("Note file changed before delete completed".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Failed to check note file before delete cleanup: {error}"
            ));
        }
    }

    index.entries.remove(&safe_id);
    write_index_from_snapshot(trusted_root, &index_snapshot, &index)
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
    let trusted_root = resolve_trusted_library_root(auto_save_dir)
        .map_err(|error| error.display("validate_library_root"))?;
    let _index_guard = lock_note_index();
    recover_pending_note_save_unlocked(&trusted_root)?;
    let file_path = match resolve_note_file_path_unlocked(&trusted_root, note_id)? {
        Some(p) => p,
        None => return Ok(false),
    };

    match fs::symlink_metadata(&file_path) {
        Ok(_) => {
            validate_existing_trusted_file(&trusted_root, &file_path, "validate_note_delete")?;
            validate_existing_trusted_file(&trusted_root, &file_path, "validate_note_delete")?;
            trash_note_file_or_accept_missing(&file_path, delete_file)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Failed to check note file before delete: {error}")),
    }

    let removed = remove_note_from_index_if_path_unlocked(&trusted_root, note_id, &file_path)?;
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

fn copy_trusted_library_file(
    src_root: &TrustedLibraryRoot,
    src_path: &Path,
    dst_root: &TrustedLibraryRoot,
    dst_path: &Path,
) -> Result<(), String> {
    validate_existing_trusted_file(src_root, src_path, "validate_migration_source")?;
    let mut src_file = fs::File::open(src_path).map_err(|error| {
        format!(
            "open_migration_source failed for {}: {}",
            src_path.display(),
            error
        )
    })?;
    validate_existing_trusted_file(src_root, src_path, "validate_migration_source")?;
    validate_note_destination_before_replace(dst_root, dst_path)?;
    let mut dst_file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dst_path)
        .map_err(|error| {
            format!(
                "create_migration_destination failed for {}: {}",
                dst_path.display(),
                error
            )
        })?;

    if let Err(error) = io::copy(&mut src_file, &mut dst_file).and_then(|_| dst_file.sync_all()) {
        drop(dst_file);
        return Err(cleanup_file_with_reason(
            dst_path,
            format!(
                "copy_migration_file failed from {} to {}: {}",
                src_path.display(),
                dst_path.display(),
                error
            ),
        ));
    }
    Ok(())
}

/// Merge all .md files from src_dir into dst_dir without overwriting
/// existing destination notes or replacing the destination index.
/// Preserves relative directory structure and creates empty folders.
pub fn migrate_notes(src_dir: &Path, dst_dir: &Path) -> Result<MigrationResult, String> {
    let src_root = resolve_trusted_library_root(src_dir)
        .map_err(|error| error.display("validate_source_library_root"))?;
    let dst_root = resolve_trusted_library_root(dst_dir)
        .map_err(|error| error.display("validate_destination_library_root"))?;

    if src_root.path() == dst_root.path() {
        return Ok(MigrationResult {
            files_copied: 0,
            index_copied: false,
        });
    }

    // When the current local library root is the parent of the cloud library root
    // (for example `.../HwanNote` -> `.../HwanNote/Notes`), skip the destination
    // subtree while collecting source files so we do not recursively copy the
    // cloud library back into itself.
    let skip_src_subtree = dst_root
        .path()
        .starts_with(src_root.path())
        .then_some(dst_root.path());

    let _index_guard = lock_note_index();
    recover_pending_note_save_unlocked(&src_root)?;
    if src_root.path() != dst_root.path() {
        recover_pending_note_save_unlocked(&dst_root)?;
    }
    let src_snapshot = require_index_snapshot(&src_root)?;
    let dst_snapshot = require_index_snapshot(&dst_root)?;
    let src_scan = scan_library_tree(&ProductionFileSystem, &src_root, skip_src_subtree, true);
    let dst_scan = scan_library_tree(&ProductionFileSystem, &dst_root, None, true);

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
        let relative_folder = normalize_library_relative_path(dst_root.path(), folder)
            .map_err(|error| error.display("validate_migration_folder"))?;
        ensure_library_subdirectory(&dst_root, &relative_folder)?;
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

        let desired_relative =
            normalize_library_relative_path(dst_root.path(), &src_entry.relative_path)
                .map_err(|error| error.display("validate_migration_note_path"))?;
        validate_no_symlink_beneath_root(&dst_root, &desired_relative)
            .map_err(|error| error.display("validate_migration_note_path"))?;
        let desired_path = dst_root.path().join(&desired_relative);
        let parent_dir = desired_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| dst_root.path().to_path_buf());
        let base_name = src_file
            .full_path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("untitled");

        let desired_exists = match fs::symlink_metadata(&desired_path) {
            Ok(_) => true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.to_string()),
        };
        let final_path = if existing_dst_paths.contains(&src_entry.relative_path) || desired_exists
        {
            ensure_unique_file_path(&parent_dir, base_name, None)?
        } else {
            desired_path
        };

        if let Some(parent) = final_path.parent() {
            let parent_relative = parent.strip_prefix(dst_root.path()).map_err(|error| {
                format!(
                    "validate_migration_parent failed for {}: {}",
                    parent.display(),
                    error
                )
            })?;
            ensure_library_subdirectory(&dst_root, parent_relative)?;
        }

        copy_trusted_library_file(&src_root, &src_file.full_path, &dst_root, &final_path)?;
        files_copied += 1;

        let final_rel = relative_path(dst_root.path(), &final_path);
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
        write_index_from_snapshot(&dst_root, &dst_snapshot, &dst_index)
            .map_err(index_write_failure_to_string)?;
    }
    if src_index_changed {
        write_index_from_snapshot(&src_root, &src_snapshot, &src_index)
            .map_err(index_write_failure_to_string)?;
    }

    Ok(MigrationResult {
        files_copied,
        index_copied: dst_index_changed,
    })
}

pub fn migrate_calendar_file(src_dir: &Path, dst_dir: &Path) -> Result<bool, String> {
    let src_root = resolve_trusted_library_root(src_dir)
        .map_err(|error| error.display("validate_source_library_root"))?;
    let dst_root = resolve_trusted_library_root(dst_dir)
        .map_err(|error| error.display("validate_destination_library_root"))?;
    let src_path = src_root.path().join(CALENDAR_FILENAME);
    let src_metadata = match fs::symlink_metadata(&src_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "inspect_calendar_source failed for {}: {}",
                src_path.display(),
                error
            ));
        }
    };
    if metadata_is_symlink_or_reparse_point(&src_metadata) || !src_metadata.is_file() {
        return Err(format!(
            "validate_calendar_source failed for {}: expected a trusted regular file",
            src_path.display()
        ));
    }
    validate_no_symlink_beneath_root(&src_root, Path::new(CALENDAR_FILENAME))
        .map_err(|error| error.display("validate_calendar_source"))?;
    ensure_path_within_canonical_root(&src_root, &src_path)
        .map_err(|error| error.display("validate_calendar_source"))?;

    let dst_path = dst_root.path().join(CALENDAR_FILENAME);
    match fs::symlink_metadata(&dst_path) {
        Ok(metadata) => {
            if metadata_is_symlink_or_reparse_point(&metadata) {
                return Err(format!(
                    "validate_calendar_destination failed for {}: symbolic links and reparse points are not allowed",
                    dst_path.display()
                ));
            }
            return Ok(false);
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "inspect_calendar_destination failed for {}: {}",
                dst_path.display(),
                error
            ));
        }
    }
    validate_no_symlink_beneath_root(&dst_root, Path::new(CALENDAR_FILENAME))
        .map_err(|error| error.display("validate_calendar_destination"))?;
    ensure_path_within_canonical_root(&dst_root, &dst_path)
        .map_err(|error| error.display("validate_calendar_destination"))?;
    copy_trusted_library_file(&src_root, &src_path, &dst_root, &dst_path)?;
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
    #[cfg(windows)]
    use std::process::Command;

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

    fn normalized_test_path(path: &Path) -> PathBuf {
        let Some(parent) = path.parent() else {
            return path.to_path_buf();
        };
        let Some(file_name) = path.file_name() else {
            return fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        };
        fs::canonicalize(parent)
            .map(|canonical_parent| canonical_parent.join(file_name))
            .unwrap_or_else(|_| path.to_path_buf())
    }

    fn test_paths_equal(left: &Path, right: &Path) -> bool {
        normalized_test_path(left) == normalized_test_path(right)
    }

    #[derive(Default)]
    struct FaultInjectingFileSystem {
        failures: HashMap<(&'static str, PathBuf), String>,
        entry_type_overrides: HashMap<PathBuf, LibraryEntryType>,
        canonical_dir_overrides: HashMap<PathBuf, PathBuf>,
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
                canonical_dir_overrides: HashMap::new(),
            }
        }

        fn reporting_entry_type(path: impl Into<PathBuf>, entry_type: LibraryEntryType) -> Self {
            Self {
                failures: HashMap::new(),
                entry_type_overrides: HashMap::from([(path.into(), entry_type)]),
                canonical_dir_overrides: HashMap::new(),
            }
        }

        fn with_canonical_dir_override(
            mut self,
            path: impl Into<PathBuf>,
            canonical: impl Into<PathBuf>,
        ) -> Self {
            self.canonical_dir_overrides
                .insert(path.into(), canonical.into());
            self
        }

        fn with_entry_type_override(
            mut self,
            path: impl Into<PathBuf>,
            entry_type: LibraryEntryType,
        ) -> Self {
            self.entry_type_overrides.insert(path.into(), entry_type);
            self
        }

        fn failure(
            &self,
            operation: &'static str,
            path: &Path,
        ) -> Option<FileSystemOperationError> {
            self.failures
                .iter()
                .find(|((candidate_operation, candidate_path), _)| {
                    *candidate_operation == operation && test_paths_equal(candidate_path, path)
                })
                .map(|(_, reason)| FileSystemOperationError::injected(operation, path, reason))
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
            if let Some((_, entry_type)) = self
                .entry_type_overrides
                .iter()
                .find(|(candidate, _)| test_paths_equal(candidate, path))
            {
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

        fn canonicalize_path(&self, path: &Path) -> Result<PathBuf, FileSystemOperationError> {
            if let Some(error) = self.failure("canonicalize_path", path) {
                return Err(error);
            }
            if let Some((_, canonical)) = self
                .canonical_dir_overrides
                .iter()
                .find(|(candidate, _)| test_paths_equal(candidate, path))
            {
                return Ok(fs::canonicalize(canonical).unwrap_or_else(|_| canonical.clone()));
            }
            ProductionFileSystem.canonicalize_path(path)
        }

        fn markdown_metadata(&self, path: &Path) -> Result<fs::Metadata, FileSystemOperationError> {
            if let Some(error) = self.failure("read_metadata", path) {
                return Err(error);
            }
            ProductionFileSystem.markdown_metadata(path)
        }
    }

    #[derive(Default)]
    struct FailOnceAutosaveFaultInjector {
        fail_on_nth_hit: Mutex<HashMap<AutosaveFaultPoint, usize>>,
        seen_hits: Mutex<HashMap<AutosaveFaultPoint, usize>>,
    }

    impl FailOnceAutosaveFaultInjector {
        fn fail_on(point: AutosaveFaultPoint, nth_hit: usize) -> Self {
            Self {
                fail_on_nth_hit: Mutex::new(HashMap::from([(point, nth_hit)])),
                seen_hits: Mutex::new(HashMap::new()),
            }
        }
    }

    impl AutosaveFaultInjector for FailOnceAutosaveFaultInjector {
        fn check(&self, point: AutosaveFaultPoint) -> Result<(), String> {
            let mut seen_hits = self.seen_hits.lock().unwrap();
            let hit = seen_hits.entry(point).or_insert(0);
            *hit += 1;
            let mut fail_on_nth_hit = self.fail_on_nth_hit.lock().unwrap();
            if fail_on_nth_hit
                .get(&point)
                .copied()
                .is_some_and(|expected_hit| expected_hit == *hit)
            {
                fail_on_nth_hit.remove(&point);
                return Err(format!("injected autosave fault at {point:?}"));
            }
            Ok(())
        }
    }

    fn autosave_payload(
        note_id: &str,
        title: &str,
        content: &str,
        folder_path: Option<&str>,
    ) -> AutoSavePayload {
        AutoSavePayload {
            note_id: note_id.to_string(),
            title: title.to_string(),
            content: content.to_string(),
            folder_path: folder_path.map(str::to_string),
            is_title_manual: Some(true),
            is_pinned: Some(true),
        }
    }

    fn count_markdown_files_recursively(root: &Path) -> Result<usize, String> {
        fn visit(dir: &Path, count: &mut usize) -> Result<(), String> {
            for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
                if metadata.is_dir() {
                    visit(&path, count)?;
                } else if metadata.is_file() && is_markdown_path(&path) {
                    *count += 1;
                }
            }
            Ok(())
        }

        let mut count = 0;
        visit(root, &mut count)?;
        Ok(count)
    }

    fn count_autosave_artifacts_recursively(root: &Path) -> Result<usize, String> {
        fn visit(dir: &Path, count: &mut usize) -> Result<(), String> {
            for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
                if metadata.is_dir() {
                    visit(&path, count)?;
                    continue;
                }
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if name == AUTOSAVE_JOURNAL_FILENAME
                    || name == AUTOSAVE_JOURNAL_TEMP_FILENAME
                    || name.starts_with(".hwan-note-write-")
                    || name.starts_with(".hwan-note-index-")
                {
                    *count += 1;
                }
            }
            Ok(())
        }

        let mut count = 0;
        visit(root, &mut count)?;
        Ok(count)
    }

    fn load_ready_note_by_id(root: &Path, note_id: &str) -> Result<LoadedNote, String> {
        let load = load_markdown_library(root);
        assert_eq!(load.load_state, NoteLoadState::Ready);
        load.notes
            .into_iter()
            .find(|note| note.note_id == note_id)
            .ok_or_else(|| format!("expected note {note_id}"))
    }

    fn assert_recovery_load_incomplete_with_reason(root: &Path, fragment: &str) {
        let load = load_markdown_library(root);
        assert_eq!(load.load_state, NoteLoadState::Incomplete);
        assert!(load
            .issues
            .iter()
            .any(|issue| issue.reason.contains(fragment) || issue.operation.contains(fragment)));
    }

    fn run_faulted_autosave(
        root: &Path,
        payload: &AutoSavePayload,
        point: AutosaveFaultPoint,
        nth_hit: usize,
    ) -> Result<AutoSaveResult, String> {
        let trusted_root = TrustedLibraryRoot::open(root)?;
        let injector = FailOnceAutosaveFaultInjector::fail_on(point, nth_hit);
        auto_save_markdown_note_with_faults(&trusted_root, payload, &injector)
    }

    #[cfg(unix)]
    fn create_directory_link(link: &Path, target: &Path) -> Result<bool, String> {
        match std::os::unix::fs::symlink(target, link) {
            Ok(()) => Ok(true),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported
                ) =>
            {
                eprintln!("skipping link test: directory symlink creation is unavailable: {error}");
                Ok(false)
            }
            Err(error) => Err(error.to_string()),
        }
    }

    #[cfg(windows)]
    fn create_directory_link(link: &Path, target: &Path) -> Result<bool, String> {
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => Ok(true),
            Err(symlink_error) => {
                let is_privilege_error = symlink_error.kind() == io::ErrorKind::PermissionDenied
                    || symlink_error.kind() == io::ErrorKind::Unsupported
                    || symlink_error.raw_os_error() == Some(1314);
                if !is_privilege_error {
                    return Err(symlink_error.to_string());
                }

                let output = Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(link)
                    .arg(target)
                    .output()
                    .map_err(|command_error| {
                        format!(
                            "symlink_dir failed with {symlink_error}; mklink /J could not run: {command_error}"
                        )
                    })?;
                if output.status.success() {
                    Ok(true)
                } else {
                    eprintln!(
                        "skipping link test: symlink privilege is unavailable and junction creation failed ({}): {}",
                        output.status,
                        String::from_utf8_lossy(&output.stderr).trim()
                    );
                    Ok(false)
                }
            }
        }
    }

    #[cfg(unix)]
    fn create_file_link(link: &Path, target: &Path) -> Result<bool, String> {
        match std::os::unix::fs::symlink(target, link) {
            Ok(()) => Ok(true),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported
                ) =>
            {
                eprintln!("skipping link test: file symlink creation is unavailable: {error}");
                Ok(false)
            }
            Err(error) => Err(error.to_string()),
        }
    }

    #[cfg(windows)]
    fn create_file_link(link: &Path, target: &Path) -> Result<bool, String> {
        match std::os::windows::fs::symlink_file(target, link) {
            Ok(()) => Ok(true),
            Err(error)
                if error.kind() == io::ErrorKind::PermissionDenied
                    || error.kind() == io::ErrorKind::Unsupported
                    || error.raw_os_error() == Some(1314) =>
            {
                eprintln!("skipping link test: file symlink privilege is unavailable: {error}");
                Ok(false)
            }
            Err(error) => Err(error.to_string()),
        }
    }

    struct TestLinkGuard {
        path: PathBuf,
        directory: bool,
        active: bool,
    }

    impl TestLinkGuard {
        fn directory(path: &Path) -> Self {
            Self {
                path: path.to_path_buf(),
                directory: true,
                active: true,
            }
        }

        fn file(path: &Path) -> Self {
            Self {
                path: path.to_path_buf(),
                directory: false,
                active: true,
            }
        }

        fn unlink(mut self) -> Result<(), String> {
            remove_test_link(&self.path, self.directory).map_err(|error| error.to_string())?;
            self.active = false;
            Ok(())
        }
    }

    impl Drop for TestLinkGuard {
        fn drop(&mut self) {
            if self.active {
                let _ = remove_test_link(&self.path, self.directory);
            }
        }
    }

    #[cfg(unix)]
    fn remove_test_link(path: &Path, _directory: bool) -> io::Result<()> {
        fs::remove_file(path)
    }

    #[cfg(windows)]
    fn remove_test_link(path: &Path, directory: bool) -> io::Result<()> {
        if directory {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
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
                && test_paths_equal(Path::new(&issue.path), path)
                && issue.reason.contains(reason_fragment)
        }));
    }

    #[test]
    fn autosave_note_temp_write_failure_reconciles_cleanly_on_restart() {
        let dir = make_temp_dir("autosave-note-temp-write-failure");
        let result = (|| -> Result<(), String> {
            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            let injector =
                FailOnceAutosaveFaultInjector::fail_on(AutosaveFaultPoint::NoteTempWrite, 1);

            let error = auto_save_markdown_note_with_faults(
                &trusted_root,
                &autosave_payload("temp-fail", "Temp fail", "# Temp fail", None),
                &injector,
            )
            .unwrap_err();
            assert!(error.contains("NoteTempWrite") || error.contains("write_note_temp"));

            let load = load_markdown_library(&dir);
            assert_eq!(load.load_state, NoteLoadState::Ready);
            assert!(load.notes.is_empty());
            assert_eq!(list_markdown_files(&dir, &dir)?.len(), 0);
            assert!(!autosave_journal_path(&trusted_root).exists());
            assert!(!autosave_journal_next_path(&trusted_root).exists());

            auto_save_markdown_note(
                &dir,
                &autosave_payload("temp-fail", "Recovered", "# Recovered", None),
            )?;
            assert_eq!(count_markdown_files_recursively(&dir)?, 1);
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn autosave_note_publish_failure_recovers_folder_move_without_duplicates() {
        let dir = make_temp_dir("autosave-note-publish-recovery");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &autosave_payload("stable-note", "Alpha", "# Alpha", Some("alpha")),
            )?;
            let before = load_markdown_notes(&dir)?
                .into_iter()
                .find(|note| note.note_id == "stable-note")
                .ok_or_else(|| "baseline note missing".to_string())?;
            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            let injector =
                FailOnceAutosaveFaultInjector::fail_on(AutosaveFaultPoint::NotePublish, 1);

            let error = auto_save_markdown_note_with_faults(
                &trusted_root,
                &autosave_payload("stable-note", "Beta", "# Beta", Some("beta")),
                &injector,
            )
            .unwrap_err();
            assert!(error.contains("NotePublish") || error.contains("publish_note"));
            assert!(
                autosave_journal_path(&trusted_root).exists()
                    || autosave_journal_next_path(&trusted_root).exists()
            );

            let load = load_markdown_library(&dir);
            assert_eq!(load.load_state, NoteLoadState::Ready);
            let note = load
                .notes
                .iter()
                .find(|note| note.note_id == "stable-note")
                .ok_or_else(|| "recovered note missing".to_string())?;
            assert_eq!(note.folder_path, "beta");
            assert_eq!(note.markdown, "# Beta");
            assert_eq!(note.created_at, before.created_at);
            assert_eq!(count_markdown_files_recursively(&dir)?, 1);
            assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);
            assert!(!autosave_journal_path(&trusted_root).exists());
            assert!(!autosave_journal_next_path(&trusted_root).exists());
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn autosave_old_file_cleanup_failure_rolls_forward_on_restart() {
        let dir = make_temp_dir("autosave-old-cleanup-recovery");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &autosave_payload("cleanup-note", "Alpha", "# Alpha", Some("alpha")),
            )?;
            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            let injector =
                FailOnceAutosaveFaultInjector::fail_on(AutosaveFaultPoint::OldFileCleanup, 1);

            let error = auto_save_markdown_note_with_faults(
                &trusted_root,
                &autosave_payload("cleanup-note", "Beta", "# Beta", Some("beta")),
                &injector,
            )
            .unwrap_err();
            assert!(error.contains("OldFileCleanup") || error.contains("remove_old_note_cleanup"));
            assert_eq!(count_markdown_files_recursively(&dir)?, 2);

            let load = load_markdown_library(&dir);
            assert_eq!(load.load_state, NoteLoadState::Ready);
            let note = load
                .notes
                .iter()
                .find(|note| note.note_id == "cleanup-note")
                .ok_or_else(|| "recovered note missing".to_string())?;
            assert_eq!(note.folder_path, "beta");
            assert_eq!(note.markdown, "# Beta");
            assert_eq!(count_markdown_files_recursively(&dir)?, 1);
            assert!(!autosave_journal_path(&trusted_root).exists());
            assert!(!autosave_journal_next_path(&trusted_root).exists());
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn autosave_index_publish_failure_recovers_before_scan_reconcile() {
        let dir = make_temp_dir("autosave-index-publish-recovery");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &autosave_payload("index-note", "Alpha", "# Alpha", Some("alpha")),
            )?;
            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            let injector =
                FailOnceAutosaveFaultInjector::fail_on(AutosaveFaultPoint::IndexPublish, 1);

            let error = auto_save_markdown_note_with_faults(
                &trusted_root,
                &autosave_payload("index-note", "Beta", "# Beta", Some("beta")),
                &injector,
            )
            .unwrap_err();
            assert!(error.contains("IndexPublish") || error.contains("publish_autosave_index"));

            let load = load_markdown_library(&dir);
            assert_eq!(load.load_state, NoteLoadState::Ready);
            let note = load
                .notes
                .iter()
                .find(|note| note.note_id == "index-note")
                .ok_or_else(|| "recovered note missing".to_string())?;
            assert_eq!(note.folder_path, "beta");
            assert_eq!(note.markdown, "# Beta");
            assert_eq!(count_markdown_files_recursively(&dir)?, 1);
            assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn autosave_note_temp_stage_failures_reconcile_cleanly_on_restart() {
        for (point, label) in [
            (AutosaveFaultPoint::NoteTempCreate, "create"),
            (AutosaveFaultPoint::NoteTempWrite, "write"),
            (AutosaveFaultPoint::NoteTempSync, "sync"),
        ] {
            let dir = make_temp_dir(&format!("autosave-note-temp-{label}"));
            let result = (|| -> Result<(), String> {
                let error = run_faulted_autosave(
                    &dir,
                    &autosave_payload("stage-note", "Stage", "# Stage", Some("alpha")),
                    point,
                    1,
                )
                .unwrap_err();
                assert!(
                    error.contains("injected autosave fault") || error.contains("write_note_temp")
                );

                let load = load_markdown_library(&dir);
                assert_eq!(load.load_state, NoteLoadState::Ready);
                assert!(load.notes.is_empty());
                assert_eq!(count_markdown_files_recursively(&dir)?, 0);
                assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);

                let saved = auto_save_markdown_note(
                    &dir,
                    &autosave_payload("stage-note", "Stage", "# Stage", Some("alpha")),
                )?;
                assert_eq!(saved.note_id, "stage-note");
                assert_eq!(count_markdown_files_recursively(&dir)?, 1);
                Ok(())
            })();
            cleanup_temp_dir(&dir);
            result.unwrap();
        }
    }

    #[test]
    fn autosave_initial_journal_temp_failures_leave_no_committed_state_and_retry_cleanly() {
        for (point, label) in [
            (AutosaveFaultPoint::JournalTempCreate, "create"),
            (AutosaveFaultPoint::JournalTempWrite, "write"),
            (AutosaveFaultPoint::JournalTempSync, "sync"),
        ] {
            let dir = make_temp_dir(&format!("autosave-initial-journal-temp-{label}"));
            let result = (|| -> Result<(), String> {
                let error = run_faulted_autosave(
                    &dir,
                    &autosave_payload("journal-stage", "Journal", "# Journal", Some("alpha")),
                    point,
                    1,
                )
                .unwrap_err();
                assert!(
                    error.contains("injected autosave fault")
                        || error.contains("write_autosave_journal_temp")
                );

                let load = load_markdown_library(&dir);
                assert_eq!(load.load_state, NoteLoadState::Ready);
                assert!(load.notes.is_empty());
                assert_eq!(count_markdown_files_recursively(&dir)?, 0);
                assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);

                let saved = auto_save_markdown_note(
                    &dir,
                    &autosave_payload("journal-stage", "Journal", "# Journal", Some("alpha")),
                )?;
                assert_eq!(saved.note_id, "journal-stage");
                assert_eq!(count_markdown_files_recursively(&dir)?, 1);
                assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);
                let note = load_ready_note_by_id(&dir, "journal-stage")?;
                assert_eq!(note.markdown, "# Journal");
                Ok(())
            })();
            cleanup_temp_dir(&dir);
            result.unwrap();
        }
    }

    #[test]
    fn index_write_rejects_destination_file_link_swap_without_touching_external_target() {
        let dir = make_temp_dir("index-link-swap");
        let outside = make_temp_dir("index-link-swap-outside");
        let result = (|| -> Result<(), String> {
            let outside_file = outside.join("victim-index.json");
            fs::write(&outside_file, "outside-index-original").map_err(|e| e.to_string())?;

            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            let snapshot = require_index_snapshot(&trusted_root)?;
            let index_path = get_index_path(&dir);
            let planned_index = NoteIndex {
                entries: HashMap::from([(
                    "planned".to_string(),
                    NoteIndexEntry {
                        relative_path: "planned.md".to_string(),
                        created_at: 1,
                        manual_title: Some("Planned".to_string()),
                        is_pinned: Some(false),
                    },
                )]),
            };
            let mut link_guard = None;

            let write_result = write_index_from_snapshot_after_temp_hook(
                &trusted_root,
                &snapshot,
                &planned_index,
                || {
                    if create_file_link(&index_path, &outside_file).unwrap_or(false) {
                        link_guard = Some(TestLinkGuard::file(&index_path));
                    }
                },
            );
            if link_guard.is_none() {
                return Ok(());
            }

            match write_result {
                Err(IndexWriteFailure::Issue(issue)) => {
                    assert_eq!(issue.operation, "replace_index");
                    assert!(issue.reason.contains("symbolic links and reparse points"));
                }
                other => panic!("expected trusted-destination failure, got {other:?}"),
            }
            assert_eq!(
                fs::read_to_string(&outside_file).map_err(|e| e.to_string())?,
                "outside-index-original"
            );
            link_guard.unwrap().unlink()?;
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        cleanup_temp_dir(&outside);
        result.unwrap();
    }

    #[test]
    fn journal_persist_rejects_primary_file_link_swap_without_touching_external_target() {
        let dir = make_temp_dir("journal-link-swap");
        let outside = make_temp_dir("journal-link-swap-outside");
        let result = (|| -> Result<(), String> {
            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            let outside_file = outside.join("victim-journal.json");
            fs::write(&outside_file, "outside-journal-original").map_err(|e| e.to_string())?;
            let journal_path = autosave_journal_path(&trusted_root);
            let probe_link = dir.join("journal-link-probe");
            if !create_file_link(&probe_link, &outside_file)? {
                return Ok(());
            }
            TestLinkGuard::file(&probe_link).unlink()?;
            let mut link_guard = None;

            let next_note_path = trusted_root.path().join("alpha").join("Journal.md");
            let operation_id = "1-2-3".to_string();
            let journal = AutosaveTransactionJournal {
                version: AUTOSAVE_TRANSACTION_VERSION,
                operation_id: operation_id.clone(),
                phase: AutosaveTransactionPhase::Prepared,
                note_id: "journal-note".to_string(),
                previous_relative_path: None,
                next_relative_path: "alpha/Journal.md".to_string(),
                note_temp_relative_path: relative_path(
                    trusted_root.path(),
                    &note_temp_path_for_operation(&next_note_path, &operation_id)?,
                ),
                index_temp_relative_path: relative_path(
                    trusted_root.path(),
                    &index_temp_path_for_operation(&trusted_root, &operation_id),
                ),
                expected_index_digest: None,
                next_index: NoteIndex {
                    entries: HashMap::from([(
                        "journal-note".to_string(),
                        NoteIndexEntry {
                            relative_path: "alpha/Journal.md".to_string(),
                            created_at: 1,
                            manual_title: Some("Journal".to_string()),
                            is_pinned: Some(false),
                        },
                    )]),
                },
                next_note_digest: sha256_hex(b"# Journal"),
                previous_note_digest: None,
            };

            let error = persist_autosave_journal_after_temp_hook(
                &trusted_root,
                &journal,
                &NoopAutosaveFaultInjector,
                || {
                    if create_file_link(&journal_path, &outside_file).unwrap_or(false) {
                        link_guard = Some(TestLinkGuard::file(&journal_path));
                    }
                },
            )
            .unwrap_err();
            if link_guard.is_none() {
                return Ok(());
            }
            assert!(error.contains("symbolic links and reparse points"));
            assert_eq!(
                fs::read_to_string(&outside_file).map_err(|e| e.to_string())?,
                "outside-journal-original"
            );
            link_guard.unwrap().unlink()?;
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        cleanup_temp_dir(&outside);
        result.unwrap();
    }

    #[test]
    fn autosave_post_publish_reported_failures_recover_with_one_note_and_no_artifacts() {
        for (point, nth_hit, label) in [
            (AutosaveFaultPoint::NotePublishReported, 1usize, "note"),
            (AutosaveFaultPoint::IndexPublishReported, 1usize, "index"),
            (
                AutosaveFaultPoint::JournalPublishReported,
                2usize,
                "journal",
            ),
        ] {
            let dir = make_temp_dir(&format!("autosave-post-publish-{label}"));
            let result = (|| -> Result<(), String> {
                auto_save_markdown_note(
                    &dir,
                    &autosave_payload("post-publish", "Alpha", "# Alpha", Some("alpha")),
                )?;

                let error = run_faulted_autosave(
                    &dir,
                    &autosave_payload("post-publish", "Beta", "# Beta", Some("beta")),
                    point,
                    nth_hit,
                )
                .unwrap_err();
                assert!(error.contains("injected autosave fault"));

                let note = load_ready_note_by_id(&dir, "post-publish")?;
                assert_eq!(note.folder_path, "beta");
                assert_eq!(note.markdown, "# Beta");
                assert_eq!(count_markdown_files_recursively(&dir)?, 1);
                assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);
                Ok(())
            })();
            cleanup_temp_dir(&dir);
            result.unwrap();
        }
    }

    #[test]
    fn autosave_index_temp_stage_failures_reconcile_cleanly_on_restart() {
        for (point, label) in [
            (AutosaveFaultPoint::IndexTempCreate, "create"),
            (AutosaveFaultPoint::IndexTempWrite, "write"),
            (AutosaveFaultPoint::IndexTempSync, "sync"),
        ] {
            let dir = make_temp_dir(&format!("autosave-index-temp-{label}"));
            let result = (|| -> Result<(), String> {
                let error = run_faulted_autosave(
                    &dir,
                    &autosave_payload("stage-index", "Index", "# Index", Some("alpha")),
                    point,
                    1,
                )
                .unwrap_err();
                assert!(
                    error.contains("injected autosave fault") || error.contains("write_index_temp")
                );

                let load = load_markdown_library(&dir);
                assert_eq!(load.load_state, NoteLoadState::Ready);
                assert!(load.notes.is_empty());
                assert_eq!(count_markdown_files_recursively(&dir)?, 0);
                assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);

                let saved = auto_save_markdown_note(
                    &dir,
                    &autosave_payload("stage-index", "Index", "# Index", Some("alpha")),
                )?;
                assert_eq!(saved.note_id, "stage-index");
                assert_eq!(count_markdown_files_recursively(&dir)?, 1);
                Ok(())
            })();
            cleanup_temp_dir(&dir);
            result.unwrap();
        }
    }

    #[test]
    fn autosave_journal_publish_failures_across_phase_transitions_recover_deterministically() {
        for (nth_hit, expected_markdown_count, expected_content) in [
            (2usize, 0usize, None),
            (3usize, 1usize, Some("# Journal")),
            (4usize, 1usize, Some("# Journal")),
        ] {
            let dir = make_temp_dir(&format!("autosave-journal-publish-{nth_hit}"));
            let result = (|| -> Result<(), String> {
                let error = run_faulted_autosave(
                    &dir,
                    &autosave_payload("journal-note", "Journal", "# Journal", Some("alpha")),
                    AutosaveFaultPoint::JournalPublish,
                    nth_hit,
                )
                .unwrap_err();
                assert!(
                    error.contains("injected autosave fault")
                        || error.contains("publish_autosave_journal")
                );

                let load = load_markdown_library(&dir);
                assert_eq!(load.load_state, NoteLoadState::Ready);
                assert_eq!(
                    count_markdown_files_recursively(&dir)?,
                    expected_markdown_count
                );
                assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);
                if let Some(expected_content) = expected_content {
                    let note = load
                        .notes
                        .iter()
                        .find(|note| note.note_id == "journal-note")
                        .ok_or_else(|| "journal note missing".to_string())?;
                    assert_eq!(note.markdown, expected_content);
                } else {
                    assert!(load.notes.is_empty());
                }
                Ok(())
            })();
            cleanup_temp_dir(&dir);
            result.unwrap();
        }
    }

    #[test]
    fn autosave_title_change_retry_preserves_note_id_without_duplicate_files() {
        let dir = make_temp_dir("autosave-title-change-retry");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &autosave_payload("title-note", "Alpha", "# Alpha", None),
            )?;
            let before = load_ready_note_by_id(&dir, "title-note")?;

            let error = run_faulted_autosave(
                &dir,
                &autosave_payload("title-note", "Beta", "# Beta", None),
                AutosaveFaultPoint::NotePublish,
                1,
            )
            .unwrap_err();
            assert!(error.contains("NotePublish") || error.contains("publish_note"));

            let after = load_ready_note_by_id(&dir, "title-note")?;
            assert_eq!(after.note_id, "title-note");
            assert_eq!(after.created_at, before.created_at);
            assert_eq!(after.markdown, "# Beta");
            assert_eq!(count_markdown_files_recursively(&dir)?, 1);
            assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn autosave_journal_cleanup_failure_recovers_and_repeated_loads_are_noops() {
        let dir = make_temp_dir("autosave-journal-cleanup");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &autosave_payload("cleanup-journal", "Alpha", "# Alpha", Some("alpha")),
            )?;
            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            let injector =
                FailOnceAutosaveFaultInjector::fail_on(AutosaveFaultPoint::JournalCleanup, 1);

            let error = auto_save_markdown_note_with_faults(
                &trusted_root,
                &autosave_payload("cleanup-journal", "Beta", "# Beta", Some("beta")),
                &injector,
            )
            .unwrap_err();
            assert!(error.contains("JournalCleanup") || error.contains("cleanup_autosave_journal"));

            let first = load_ready_note_by_id(&dir, "cleanup-journal")?;
            assert_eq!(first.markdown, "# Beta");
            assert_eq!(count_markdown_files_recursively(&dir)?, 1);
            assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);

            let second = load_ready_note_by_id(&dir, "cleanup-journal")?;
            assert_eq!(second.markdown, "# Beta");
            assert_eq!(count_markdown_files_recursively(&dir)?, 1);
            assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn autosave_valid_next_only_journal_is_promoted_and_replayed() {
        let dir = make_temp_dir("autosave-next-only");
        let result = (|| -> Result<(), String> {
            let error = run_faulted_autosave(
                &dir,
                &autosave_payload("next-only", "Alpha", "# Alpha", None),
                AutosaveFaultPoint::JournalPublish,
                1,
            )
            .unwrap_err();
            assert!(error.contains("JournalPublish") || error.contains("publish_autosave_journal"));

            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            assert!(!autosave_journal_path(&trusted_root).exists());
            assert!(autosave_journal_next_path(&trusted_root).exists());

            let load = load_markdown_library(&dir);
            assert_eq!(load.load_state, NoteLoadState::Ready);
            assert!(load.notes.is_empty());
            assert_eq!(count_markdown_files_recursively(&dir)?, 0);
            assert_eq!(count_autosave_artifacts_recursively(&dir)?, 0);
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn autosave_invalid_next_only_journal_fails_closed() {
        let dir = make_temp_dir("autosave-invalid-next-only");
        let result = (|| -> Result<(), String> {
            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            fs::write(autosave_journal_next_path(&trusted_root), "{not-json")
                .map_err(|e| e.to_string())?;

            assert_recovery_load_incomplete_with_reason(&dir, "parse_autosave_journal");
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn autosave_primary_and_next_with_different_operation_ids_fail_closed() {
        let dir = make_temp_dir("autosave-journal-op-mismatch");
        let result = (|| -> Result<(), String> {
            let error = run_faulted_autosave(
                &dir,
                &autosave_payload("mismatch", "Alpha", "# Alpha", None),
                AutosaveFaultPoint::JournalPublish,
                2,
            )
            .unwrap_err();
            assert!(error.contains("JournalPublish") || error.contains("publish_autosave_journal"));

            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            let mut next_journal: AutosaveTransactionJournal = serde_json::from_slice(
                &fs::read(autosave_journal_next_path(&trusted_root)).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            next_journal.operation_id = "9-9-9".to_string();
            fs::write(
                autosave_journal_next_path(&trusted_root),
                serde_json::to_vec_pretty(&next_journal).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;

            assert_recovery_load_incomplete_with_reason(&dir, "journal identities differ");
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn autosave_stale_next_cleanup_failure_fails_closed() {
        let dir = make_temp_dir("autosave-stale-next-cleanup");
        let result = (|| -> Result<(), String> {
            let error = run_faulted_autosave(
                &dir,
                &autosave_payload("stale-next", "Alpha", "# Alpha", None),
                AutosaveFaultPoint::JournalPublish,
                2,
            )
            .unwrap_err();
            assert!(error.contains("JournalPublish") || error.contains("publish_autosave_journal"));

            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            fs::remove_file(autosave_journal_next_path(&trusted_root))
                .map_err(|e| e.to_string())?;
            fs::create_dir(autosave_journal_next_path(&trusted_root)).map_err(|e| e.to_string())?;

            assert_recovery_load_incomplete_with_reason(
                &dir,
                "cleanup_invalid_autosave_journal_candidate",
            );
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn autosave_conflicting_index_and_note_cleanup_states_fail_closed() {
        let dir = make_temp_dir("autosave-conflicts");
        let result = (|| -> Result<(), String> {
            auto_save_markdown_note(
                &dir,
                &autosave_payload("conflict-note", "Alpha", "# Alpha", Some("alpha")),
            )?;

            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            let index_error = auto_save_markdown_note_with_faults(
                &trusted_root,
                &autosave_payload("conflict-note", "Beta", "# Beta", Some("beta")),
                &FailOnceAutosaveFaultInjector::fail_on(AutosaveFaultPoint::IndexPublish, 1),
            )
            .unwrap_err();
            assert!(
                index_error.contains("IndexPublish")
                    || index_error.contains("publish_autosave_index")
            );
            let unrelated_index = NoteIndex {
                entries: HashMap::from([(
                    "other".to_string(),
                    NoteIndexEntry {
                        relative_path: "other.md".to_string(),
                        created_at: 1,
                        manual_title: Some("Other".to_string()),
                        is_pinned: Some(false),
                    },
                )]),
            };
            write_index(&dir, &unrelated_index)?;
            assert_recovery_load_incomplete_with_reason(&dir, "verify_autosave_index_precondition");

            cleanup_pending_autosave_journal_files(&trusted_root)?;
            fs::remove_dir_all(dir.join("alpha")).ok();
            fs::remove_dir_all(dir.join("beta")).ok();
            write_index(&dir, &empty_index())?;

            auto_save_markdown_note(
                &dir,
                &autosave_payload("conflict-note", "Alpha", "# Alpha", Some("alpha")),
            )?;
            let old_cleanup_error = auto_save_markdown_note_with_faults(
                &trusted_root,
                &autosave_payload("conflict-note", "Beta", "# Beta", Some("beta")),
                &FailOnceAutosaveFaultInjector::fail_on(AutosaveFaultPoint::OldFileCleanup, 1),
            )
            .unwrap_err();
            assert!(
                old_cleanup_error.contains("OldFileCleanup")
                    || old_cleanup_error.contains("remove_old_note_cleanup")
            );
            fs::write(dir.join("alpha").join("Alpha.md"), "# tampered")
                .map_err(|e| e.to_string())?;
            assert_recovery_load_incomplete_with_reason(&dir, "validate_old_note_cleanup");

            cleanup_pending_autosave_journal_files(&trusted_root)?;
            fs::remove_dir_all(dir.join("alpha")).ok();
            fs::remove_dir_all(dir.join("beta")).ok();
            write_index(&dir, &empty_index())?;

            auto_save_markdown_note(
                &dir,
                &autosave_payload("conflict-note", "Alpha", "# Alpha", Some("alpha")),
            )?;
            let note_error = auto_save_markdown_note_with_faults(
                &trusted_root,
                &autosave_payload("conflict-note", "Beta", "# Beta", Some("beta")),
                &FailOnceAutosaveFaultInjector::fail_on(AutosaveFaultPoint::IndexPublish, 1),
            )
            .unwrap_err();
            assert!(
                note_error.contains("IndexPublish")
                    || note_error.contains("publish_autosave_index")
            );
            fs::write(dir.join("beta").join("Beta.md"), "# tampered").map_err(|e| e.to_string())?;
            assert_recovery_load_incomplete_with_reason(&dir, "verify_note_published");
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn autosave_unsafe_journal_paths_fail_closed() {
        let dir = make_temp_dir("autosave-unsafe-journal");
        let result = (|| -> Result<(), String> {
            let trusted_root = TrustedLibraryRoot::open(&dir)?;
            let journal = AutosaveTransactionJournal {
                version: AUTOSAVE_TRANSACTION_VERSION,
                operation_id: "1-2-3".to_string(),
                phase: AutosaveTransactionPhase::Prepared,
                note_id: "unsafe".to_string(),
                previous_relative_path: None,
                next_relative_path: "../escape.md".to_string(),
                note_temp_relative_path: "../escape.tmp".to_string(),
                index_temp_relative_path: ".hwan-note-index-1-2-3.tmp".to_string(),
                expected_index_digest: None,
                next_index: NoteIndex {
                    entries: HashMap::from([(
                        "unsafe".to_string(),
                        NoteIndexEntry {
                            relative_path: "../escape.md".to_string(),
                            created_at: 1,
                            manual_title: Some("Unsafe".to_string()),
                            is_pinned: Some(false),
                        },
                    )]),
                },
                next_note_digest: "abc".to_string(),
                previous_note_digest: None,
            };
            fs::write(
                autosave_journal_path(&trusted_root),
                serde_json::to_vec_pretty(&journal).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;

            assert_recovery_load_incomplete_with_reason(&dir, "validate_index_path");
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
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

            let files = list_markdown_files(&dir, &dir)?;
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
    fn migrate_notes_rejects_directory_links_in_source_tree_without_copying_external_notes() {
        let src = make_temp_dir("migrate-link-src");
        let dst = make_temp_dir("migrate-link-dst");
        let outside = make_temp_dir("migrate-link-outside");
        let result = (|| -> Result<(), String> {
            fs::write(outside.join("outside.md"), "# Outside").map_err(|e| e.to_string())?;
            let linked = src.join("linked");
            if !create_directory_link(&linked, &outside)? {
                return Ok(());
            }
            let link_guard = TestLinkGuard::directory(&linked);

            let error = migrate_notes(&src, &dst).unwrap_err();
            assert!(error.contains("reject_symlink"));
            assert!(load_markdown_notes(&dst)?.is_empty());
            assert_eq!(
                fs::read_to_string(outside.join("outside.md")).map_err(|e| e.to_string())?,
                "# Outside"
            );
            link_guard.unlink()?;
            Ok(())
        })();
        cleanup_temp_dir(&src);
        cleanup_temp_dir(&dst);
        cleanup_temp_dir(&outside);
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
    fn normal_nested_folders_support_save_rename_and_delete() {
        let dir = make_temp_dir("normal-nested-boundary");
        let result = (|| -> Result<(), String> {
            let folders = create_folder(&dir, "projects/rust/security")?;
            assert!(folders.contains(&"projects/rust/security".to_string()));

            auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "nested-note".to_string(),
                    title: "Nested".to_string(),
                    content: "# Nested".to_string(),
                    folder_path: Some("projects/rust/security".to_string()),
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;

            let renamed = rename_folder(&dir, "projects", "archive")?;
            assert!(renamed.contains(&"archive/rust/security".to_string()));
            let deleted = delete_folder(&dir, "archive")?;
            assert_eq!(deleted.moved_note_ids, vec!["nested-note".to_string()]);

            let notes = load_markdown_notes(&dir)?;
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].folder_path, "");
            assert_eq!(notes[0].markdown, "# Nested");
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn folder_mutations_reject_directory_links_without_touching_external_tree() {
        let dir = make_temp_dir("folder-link-boundary");
        let outside = make_temp_dir("folder-link-boundary-outside");
        let result = (|| -> Result<(), String> {
            let container = dir.join("container");
            fs::create_dir_all(&container).map_err(|e| e.to_string())?;
            let sentinel = outside.join("sentinel.md");
            fs::write(&sentinel, "outside-original").map_err(|e| e.to_string())?;
            let link = container.join("linked");
            if !create_directory_link(&link, &outside)? {
                return Ok(());
            }
            let link_guard = TestLinkGuard::directory(&link);

            let create_error = create_folder(&dir, "container/linked/new").unwrap_err();
            assert!(create_error.contains("symbolic links and reparse points"));
            let rename_error = rename_folder(&dir, "container", "renamed").unwrap_err();
            assert!(rename_error.contains("reject_symlink"));
            let delete_error = delete_folder(&dir, "container").unwrap_err();
            assert!(delete_error.contains("reject_symlink"));

            assert!(container.exists());
            assert!(!dir.join("renamed").exists());
            assert_eq!(
                fs::read_to_string(&sentinel).map_err(|e| e.to_string())?,
                "outside-original"
            );
            link_guard.unlink()?;
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        let outside_contents = fs::read_to_string(outside.join("sentinel.md"));
        cleanup_temp_dir(&outside);
        result.unwrap();
        assert_eq!(outside_contents.unwrap(), "outside-original");
    }

    #[test]
    fn note_delete_rejects_file_links_without_invoking_the_deleter() {
        use std::cell::Cell;

        let dir = make_temp_dir("delete-file-link-boundary");
        let outside = make_temp_dir("delete-file-link-boundary-outside");
        let result = (|| -> Result<(), String> {
            let saved = auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "linked-delete".to_string(),
                    title: "Linked Delete".to_string(),
                    content: "# Internal".to_string(),
                    folder_path: None,
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )?;
            let note_path = PathBuf::from(saved.file_path);
            fs::remove_file(&note_path).map_err(|e| e.to_string())?;

            let outside_file = outside.join("victim.md");
            fs::write(&outside_file, "outside-original").map_err(|e| e.to_string())?;
            if !create_file_link(&note_path, &outside_file)? {
                return Ok(());
            }
            let link_guard = TestLinkGuard::file(&note_path);
            let delete_called = Cell::new(false);

            let error = delete_note_file_and_index(&dir, "linked-delete", |_| {
                delete_called.set(true);
                Ok(())
            })
            .unwrap_err();
            assert!(error.contains("symbolic links and reparse points"));
            assert!(!delete_called.get());
            assert_eq!(
                fs::read_to_string(&outside_file).map_err(|e| e.to_string())?,
                "outside-original"
            );
            link_guard.unlink()?;
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        let outside_contents = fs::read_to_string(outside.join("victim.md"));
        cleanup_temp_dir(&outside);
        result.unwrap();
        assert_eq!(outside_contents.unwrap(), "outside-original");
    }

    #[test]
    fn calendar_migration_rejects_source_and_destination_file_links() {
        let src = make_temp_dir("calendar-link-src");
        let dst = make_temp_dir("calendar-link-dst");
        let outside = make_temp_dir("calendar-link-outside");
        let result = (|| -> Result<(), String> {
            let outside_source = outside.join("source.json");
            fs::write(&outside_source, "outside-source").map_err(|e| e.to_string())?;
            let outside_destination = outside.join("destination.json");
            fs::write(&outside_destination, "outside-destination").map_err(|e| e.to_string())?;
            let linked_source = src.join(CALENDAR_FILENAME);
            if !create_file_link(&linked_source, &outside_source)? {
                return Ok(());
            }
            let source_guard = TestLinkGuard::file(&linked_source);
            let source_error = migrate_calendar_file(&src, &dst).unwrap_err();
            assert!(source_error.contains("trusted regular file"));
            assert!(!dst.join(CALENDAR_FILENAME).exists());
            assert_eq!(
                fs::read_to_string(&outside_source).map_err(|e| e.to_string())?,
                "outside-source"
            );
            source_guard.unlink()?;

            fs::write(src.join(CALENDAR_FILENAME), "internal-calendar")
                .map_err(|e| e.to_string())?;
            let linked_destination = dst.join(CALENDAR_FILENAME);
            if !create_file_link(&linked_destination, &outside_destination)? {
                return Ok(());
            }
            let destination_guard = TestLinkGuard::file(&linked_destination);
            let destination_error = migrate_calendar_file(&src, &dst).unwrap_err();
            assert!(destination_error.contains("symbolic links and reparse points"));
            assert_eq!(
                fs::read_to_string(&outside_destination).map_err(|e| e.to_string())?,
                "outside-destination"
            );
            destination_guard.unlink()?;
            Ok(())
        })();
        cleanup_temp_dir(&src);
        cleanup_temp_dir(&dst);
        let source_contents = fs::read_to_string(outside.join("source.json"));
        let destination_contents = fs::read_to_string(outside.join("destination.json"));
        cleanup_temp_dir(&outside);
        result.unwrap();
        assert_eq!(source_contents.unwrap(), "outside-source");
        assert_eq!(destination_contents.unwrap(), "outside-destination");
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
            assert!(list_markdown_files(&dir, &dir)?.is_empty());
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
            let trusted_root = resolve_trusted_library_root(&dir)
                .map_err(|error| error.display("validate_library_root"))?;
            let snapshot = require_index_snapshot(&trusted_root)?;
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

            let write_result = write_index_from_snapshot_after_temp_hook(
                &trusted_root,
                &snapshot,
                &planned_index,
                || {
                    fs::write(&index_path, &concurrent_bytes).unwrap();
                },
            );

            match write_result {
                Err(IndexWriteFailure::Issue(issue)) => {
                    assert_eq!(issue.operation, "verify_index_unchanged");
                    assert!(test_paths_equal(Path::new(&issue.path), &index_path));
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

    #[test]
    fn scanner_detects_repeated_canonical_directory_without_recursing_forever() {
        let dir = make_temp_dir("scanner-detects-cycle");
        let result = (|| -> Result<(), String> {
            let child = dir.join("child");
            fs::create_dir_all(&child).map_err(|e| e.to_string())?;

            let file_system = FaultInjectingFileSystem::default()
                .with_entry_type_override(&child, LibraryEntryType::Directory)
                .with_canonical_dir_override(&dir, dir.clone())
                .with_canonical_dir_override(&child, dir.clone());

            let load = load_markdown_library_with_fs(&dir, &file_system);
            assert_eq!(load.load_state, NoteLoadState::Incomplete);
            assert!(load.issues.iter().any(|issue| {
                issue.kind == NoteLoadIssueKind::Scan
                    && issue.operation == "detect_cycle"
                    && issue.reason.contains("same canonical directory twice")
            }));
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[test]
    fn production_scan_and_auto_save_reject_real_directory_links_to_outside_root() {
        let dir = make_temp_dir("real-symlink-library");
        let outside = make_temp_dir("real-symlink-outside");
        let result = (|| -> Result<(), String> {
            fs::write(outside.join("outside.md"), "# Outside").map_err(|e| e.to_string())?;
            let link = dir.join("linked");
            if !create_directory_link(&link, &outside)? {
                return Ok(());
            }
            let link_guard = TestLinkGuard::directory(&link);

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
            assert_eq!(
                fs::read_to_string(outside.join("outside.md")).map_err(|e| e.to_string())?,
                "# Outside"
            );
            link_guard.unlink()?;
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        cleanup_temp_dir(&outside);
        result.unwrap();
    }

    #[test]
    fn autosave_rejects_existing_file_link_without_overwriting_external_target() {
        let dir = make_temp_dir("autosave-rejects-file-link");
        let outside = make_temp_dir("autosave-rejects-file-link-outside");
        let result = (|| -> Result<(), String> {
            let outside_file = outside.join("victim.md");
            fs::write(&outside_file, "outside-original").map_err(|e| e.to_string())?;

            let linked_file = dir.join("linked.md");
            if !create_file_link(&linked_file, &outside_file)? {
                return Ok(());
            }
            let link_guard = TestLinkGuard::file(&linked_file);

            let index = NoteIndex {
                entries: HashMap::from([(
                    "linked-note".to_string(),
                    NoteIndexEntry {
                        relative_path: "linked.md".to_string(),
                        created_at: 1,
                        manual_title: Some("Linked".to_string()),
                        is_pinned: Some(false),
                    },
                )]),
            };
            write_index(&dir, &index)?;

            let error = auto_save_markdown_note(
                &dir,
                &AutoSavePayload {
                    note_id: "linked-note".to_string(),
                    title: "Blocked".to_string(),
                    content: "# Blocked".to_string(),
                    folder_path: None,
                    is_title_manual: Some(true),
                    is_pinned: Some(false),
                },
            )
            .unwrap_err();
            assert!(error.contains("symbolic links and reparse points"));
            assert_eq!(
                fs::read_to_string(&outside_file).map_err(|e| e.to_string())?,
                "outside-original"
            );
            link_guard.unlink()?;
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        cleanup_temp_dir(&outside);
        result.unwrap();
    }

    #[test]
    fn real_directory_cycle_links_are_rejected_without_descending_forever() {
        let dir = make_temp_dir("real-directory-cycle");
        let result = (|| -> Result<(), String> {
            let loop_link = dir.join("loop");
            if !create_directory_link(&loop_link, &dir)? {
                return Ok(());
            }
            let link_guard = TestLinkGuard::directory(&loop_link);

            let load = load_markdown_library(&dir);
            assert_eq!(load.load_state, NoteLoadState::Incomplete);
            assert_issue(
                &load,
                NoteLoadIssueKind::Scan,
                "reject_symlink",
                &loop_link,
                "symbolic links and reparse points",
            );
            link_guard.unlink()?;
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        result.unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_note_write_rejects_destination_symlink_swap_after_temp_sync() {
        let dir = make_temp_dir("atomic-note-symlink-swap");
        let outside = make_temp_dir("atomic-note-symlink-swap-outside");
        let destination = dir.join("target.md");
        let outside_file = outside.join("victim.md");
        let result = (|| -> Result<(), String> {
            fs::write(&outside_file, "outside-original").map_err(|e| e.to_string())?;

            let trusted_root = resolve_trusted_library_root(&dir)
                .map_err(|error| error.display("validate_library_root"))?;

            let write_result = write_note_file_atomically_after_temp_hook(
                &trusted_root,
                &destination,
                "must-not-escape",
                || {
                    std::os::unix::fs::symlink(&outside_file, &destination).unwrap();
                },
            );
            let link_guard = TestLinkGuard::file(&destination);

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
            link_guard.unlink()?;
            Ok(())
        })();
        cleanup_temp_dir(&dir);
        cleanup_temp_dir(&outside);
        result.unwrap();
    }

    #[test]
    fn library_root_directory_link_is_rejected_before_load_or_save() {
        let parent = make_temp_dir("root-symlink-parent");
        let outside = make_temp_dir("root-symlink-outside");
        let root_link = parent.join("notes-link");
        let result = (|| -> Result<(), String> {
            fs::write(outside.join("outside.md"), "# Outside").map_err(|e| e.to_string())?;
            if !create_directory_link(&root_link, &outside)? {
                return Ok(());
            }
            let link_guard = TestLinkGuard::directory(&root_link);

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
            assert_eq!(
                fs::read_to_string(outside.join("outside.md")).map_err(|e| e.to_string())?,
                "# Outside"
            );
            link_guard.unlink()?;
            Ok(())
        })();
        cleanup_temp_dir(&parent);
        cleanup_temp_dir(&outside);
        result.unwrap();
    }
}
