use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha1::Digest;

const INDEX_FILENAME: &str = ".hwan-note-index.json";

static TOGGLE_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^:::toggle\[(open|closed)\](?:\s+(.*))?$").unwrap());
static CHECKLIST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\s*)-\s+\[([ xX])\]\s*(.*)$").unwrap());
static HEADING_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#{1,3}\s+").unwrap());
static TASK_PREFIX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^- \[[ xX]\]\s*").unwrap());
static TOGGLE_END_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^:::\s*$").unwrap());
static UNSAFE_FILENAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[<>:"/\\|?*\x00-\x1F]"#).unwrap());
static WHITESPACE_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
static TRAILING_DOTS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.+$").unwrap());
static PLAIN_TASK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\s*)- \[[ xX]\]\s*").unwrap());

const TOGGLE_BLOCK_END: &str = ":::";
const MANUAL_TITLE_META_PREFIX: &str = "<!-- hwan-note:manual-title:";
const MANUAL_TITLE_META_SUFFIX: &str = " -->";

// ── Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndexEntry {
    pub relative_path: String,
    pub created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteIndex {
    pub entries: HashMap<String, NoteIndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSavePayload {
    pub note_id: String,
    pub title: String,
    pub content: String,
    pub folder_path: Option<String>,
    pub is_title_manual: Option<bool>,
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
    pub content: String,
    pub folder_path: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub file_path: String,
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

pub fn to_windows_crlf(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n");
    normalized.replace('\n', "\r\n")
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
        .map_or(false, |segment| segment.eq_ignore_ascii_case("inbox"))
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
        .map_or(false, |segment| segment.eq_ignore_ascii_case("inbox"))
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
    if value.len() % 2 != 0 {
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

pub fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

// ── Markdown to HTML (complex parser) ──

struct TaskInfo {
    checked: bool,
    text: String,
    child_indices: Vec<usize>,
}

fn build_task_tree(flat_tasks: &[(usize, bool, String)]) -> (Vec<TaskInfo>, Vec<usize>) {
    let mut all_tasks: Vec<TaskInfo> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut root_indices: Vec<usize> = Vec::new();

    for (depth, checked, text) in flat_tasks {
        let safe_depth = (*depth).min(stack.len());
        stack.truncate(safe_depth);

        let idx = all_tasks.len();
        all_tasks.push(TaskInfo {
            checked: *checked,
            text: text.clone(),
            child_indices: Vec::new(),
        });

        if stack.is_empty() {
            root_indices.push(idx);
        } else {
            let parent_idx = *stack.last().unwrap();
            all_tasks[parent_idx].child_indices.push(idx);
        }

        stack.push(idx);
    }

    (all_tasks, root_indices)
}

fn render_task_tree(all_tasks: &[TaskInfo], indices: &[usize]) -> String {
    let items: String = indices
        .iter()
        .map(|&idx| {
            let task = &all_tasks[idx];
            let checked_attr = if task.checked {
                r#" checked="checked""#
            } else {
                ""
            };
            let text = escape_html(&task.text);
            let text_content = if text.is_empty() {
                "<br>".to_string()
            } else {
                text
            };
            let nested = if task.child_indices.is_empty() {
                String::new()
            } else {
                render_task_tree(all_tasks, &task.child_indices)
            };
            format!(
                r#"<li data-type="taskItem" data-checked="{}"><label><input type="checkbox"{}><span></span></label><div><p>{}</p>{}</div></li>"#,
                if task.checked { "true" } else { "false" },
                checked_attr,
                text_content,
                nested,
            )
        })
        .collect();
    format!(r#"<ul data-type="taskList">{}</ul>"#, items)
}

fn find_toggle_block_end(lines: &[&str], start_index: usize) -> Option<usize> {
    let mut depth: i32 = 0;

    for (i, line) in lines.iter().enumerate().skip(start_index) {
        let trimmed = line.trim();

        if TOGGLE_BLOCK_RE.is_match(trimmed) {
            depth += 1;
            continue;
        }

        if trimmed == TOGGLE_BLOCK_END {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }

    None
}

fn render_lines(lines: &[&str]) -> String {
    let mut html: Vec<String> = Vec::new();
    let mut in_code_fence = false;
    let mut line_index = 0;

    while line_index < lines.len() {
        let line = lines[line_index];
        let trimmed = line.trim();

        // Code fence toggle
        if trimmed.starts_with("```") {
            in_code_fence = !in_code_fence;
            html.push(format!("<p>{}</p>", escape_html(line)));
            line_index += 1;
            continue;
        }

        if !in_code_fence {
            // Toggle block
            if let Some(caps) = TOGGLE_BLOCK_RE.captures(trimmed) {
                if let Some(end_index) = find_toggle_block_end(lines, line_index) {
                    let open = caps
                        .get(1)
                        .map_or("", |m| m.as_str())
                        .eq_ignore_ascii_case("open");
                    let raw_summary = caps.get(2).map_or("", |m| m.as_str()).trim();
                    let summary = {
                        let escaped = escape_html(raw_summary);
                        if escaped.is_empty() {
                            "Toggle".to_string()
                        } else {
                            escaped
                        }
                    };
                    let inner_lines: Vec<&str> = lines[line_index + 1..end_index].to_vec();
                    let inner_html = {
                        let result = render_lines(&inner_lines);
                        if result.is_empty() {
                            "<p><br></p>".to_string()
                        } else {
                            result
                        }
                    };
                    let open_attr = if open { r#" open="open""# } else { "" };
                    html.push(format!(
                        r#"<details data-type="toggleBlock"{}><summary>{}</summary><div data-type="toggleContent">{}</div></details>"#,
                        open_attr, summary, inner_html
                    ));
                    line_index = end_index + 1;
                    continue;
                }
            }

            // Task list
            if CHECKLIST_RE.is_match(line) {
                let mut flat_tasks: Vec<(usize, bool, String)> = Vec::new();

                while line_index < lines.len() {
                    let task_line = lines[line_index];
                    if task_line.trim().is_empty() || !CHECKLIST_RE.is_match(task_line) {
                        break;
                    }
                    if let Some(m) = CHECKLIST_RE.captures(task_line) {
                        let indent_str = m.get(1).map_or("", |m| m.as_str()).replace('\t', "  ");
                        let depth = indent_str.len() / 2;
                        let checked = m
                            .get(2)
                            .map_or("", |m| m.as_str())
                            .eq_ignore_ascii_case("x");
                        let text = m.get(3).map_or("", |m| m.as_str()).to_string();
                        flat_tasks.push((depth, checked, text));
                    } else {
                        break;
                    }
                    line_index += 1;
                }

                let (all_tasks, root_indices) = build_task_tree(&flat_tasks);
                html.push(render_task_tree(&all_tasks, &root_indices));
                continue;
            }
        }

        // Regular content
        if trimmed.is_empty() {
            html.push("<p><br></p>".to_string());
        } else {
            html.push(format!("<p>{}</p>", escape_html(line)));
        }
        line_index += 1;
    }

    html.join("")
}

pub fn markdown_to_html(markdown: &str) -> String {
    let (_, normalized) = extract_manual_title_metadata(markdown);
    if normalized.trim().is_empty() {
        return "<p></p>".to_string();
    }
    let lines: Vec<&str> = normalized.split('\n').collect();
    render_lines(&lines)
}

// ── Index I/O ──

fn get_index_path(auto_save_dir: &Path) -> PathBuf {
    auto_save_dir.join(INDEX_FILENAME)
}

pub fn read_index(auto_save_dir: &Path) -> NoteIndex {
    let index_path = get_index_path(auto_save_dir);
    match fs::read_to_string(&index_path) {
        Ok(raw) => serde_json::from_str::<NoteIndex>(&raw).unwrap_or(NoteIndex {
            entries: HashMap::new(),
        }),
        Err(_) => NoteIndex {
            entries: HashMap::new(),
        },
    }
}

pub fn write_index(auto_save_dir: &Path, index: &NoteIndex) -> Result<(), String> {
    let index_path = get_index_path(auto_save_dir);
    let json = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    fs::write(&index_path, json).map_err(|e| e.to_string())
}

// ── File system helpers ──

fn walk_markdown_files(root_dir: &Path, current_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();

    let entries = match fs::read_dir(current_dir) {
        Ok(entries) => entries,
        Err(_) => return files,
    };

    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();

        if file_name == INDEX_FILENAME {
            continue;
        }

        let path = entry.path();

        if path.is_dir() {
            let nested = walk_markdown_files(root_dir, &path);
            files.extend(nested);
        } else if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext.to_string_lossy().to_lowercase() == "md" {
                    files.push(path);
                }
            }
        }
    }

    files
}

fn collect_markdown_file_map(root_dir: &Path) -> HashMap<String, PathBuf> {
    let mut by_relative_path = HashMap::new();
    for file_path in walk_markdown_files(root_dir, root_dir) {
        let rel = relative_path(root_dir, &file_path);
        by_relative_path.insert(rel, file_path);
    }
    by_relative_path
}

fn ensure_unique_file_path(
    target_dir: &Path,
    base_name: &str,
    except_path: Option<&Path>,
) -> PathBuf {
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
                return candidate;
            }
        }

        if !candidate.exists() {
            return candidate;
        }

        counter += 1;
    }
}

fn walk_folder_paths(root_dir: &Path, current_dir: &Path, folders: &mut Vec<String>) {
    let entries = match fs::read_dir(current_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let relative = strip_inbox_root_alias(&relative_path(root_dir, &path));
        if !relative.is_empty() {
            folders.push(relative);
        }
        walk_folder_paths(root_dir, &path, folders);
    }
}

fn relative_path(from: &Path, to: &Path) -> String {
    match to.strip_prefix(from) {
        Ok(rel) => to_posix(&rel.to_string_lossy()),
        Err(_) => to_posix(&to.to_string_lossy()),
    }
}

fn reconcile_index_with_files(
    auto_save_dir: &Path,
    index: &mut NoteIndex,
    by_relative_path: &HashMap<String, PathBuf>,
) -> Result<bool, String> {
    let mut used_paths: HashSet<String> = HashSet::new();
    let mut index_changed = false;

    let missing_ids: Vec<String> = index
        .entries
        .iter()
        .filter(|(_, entry)| !by_relative_path.contains_key(&entry.relative_path))
        .map(|(id, _)| id.clone())
        .collect();

    for id in &missing_ids {
        index.entries.remove(id);
        index_changed = true;
    }

    for entry in index.entries.values() {
        used_paths.insert(entry.relative_path.clone());
    }

    for (rel_path, full_path) in by_relative_path {
        if used_paths.contains(rel_path) {
            continue;
        }

        let generated_id = generate_note_id(rel_path);
        if !index.entries.contains_key(&generated_id) {
            let metadata = fs::metadata(full_path).map_err(|e| e.to_string())?;
            let created_at = metadata
                .created()
                .map(system_time_to_millis)
                .unwrap_or_else(|_| {
                    metadata
                        .modified()
                        .map(system_time_to_millis)
                        .unwrap_or_else(|_| now_millis())
                });

            let manual_title = fs::read_to_string(full_path)
                .ok()
                .and_then(|markdown| extract_manual_title_metadata(&markdown).0);

            index.entries.insert(
                generated_id,
                NoteIndexEntry {
                    relative_path: rel_path.clone(),
                    created_at,
                    manual_title,
                },
            );
            used_paths.insert(rel_path.clone());
            index_changed = true;
        }
    }

    if index_changed {
        write_index(auto_save_dir, index)?;
    }

    Ok(index_changed)
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
    let entries = fs::read_dir(dir_path).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if let Some(ext) = path.extension() {
                if ext.to_string_lossy().to_lowercase() == "md" {
                    files.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
    Ok(files)
}

pub fn list_folders(auto_save_dir: &Path) -> Result<Vec<String>, String> {
    fs::create_dir_all(auto_save_dir).map_err(|e| e.to_string())?;

    let mut folders = Vec::new();
    walk_folder_paths(auto_save_dir, auto_save_dir, &mut folders);
    folders.sort();
    folders.dedup();
    Ok(folders)
}

pub fn create_folder(auto_save_dir: &Path, folder_path: &str) -> Result<Vec<String>, String> {
    fs::create_dir_all(auto_save_dir).map_err(|e| e.to_string())?;

    let normalized = sanitize_folder_path(Some(folder_path))?;
    if normalized.is_empty() {
        return Err("Folder path is required.".to_string());
    }

    fs::create_dir_all(auto_save_dir.join(&normalized)).map_err(|e| e.to_string())?;
    list_folders(auto_save_dir)
}

pub fn rename_folder(auto_save_dir: &Path, from: &str, to: &str) -> Result<Vec<String>, String> {
    fs::create_dir_all(auto_save_dir).map_err(|e| e.to_string())?;

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

    let source_dir = auto_save_dir.join(&from_path);
    if !source_dir.exists() {
        return Err("Folder not found.".to_string());
    }

    let target_dir = auto_save_dir.join(&to_path);
    if target_dir.exists() {
        return Err("Target folder already exists.".to_string());
    }

    if let Some(parent) = target_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    fs::rename(&source_dir, &target_dir).map_err(|e| e.to_string())?;

    let mut index = read_index(auto_save_dir);
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
        write_index(auto_save_dir, &index)?;
    }

    list_folders(auto_save_dir)
}

pub fn delete_folder(
    auto_save_dir: &Path,
    folder_path: &str,
) -> Result<FolderDeleteResult, String> {
    fs::create_dir_all(auto_save_dir).map_err(|e| e.to_string())?;

    let normalized = sanitize_folder_path(Some(folder_path))?;
    if normalized.is_empty() {
        return Err("Folder path is required.".to_string());
    }

    let source_dir = auto_save_dir.join(&normalized);
    let prefix = format!("{}/", normalized);
    let mut index = read_index(auto_save_dir);
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
        let old_path = auto_save_dir.join(&old_relative_path);
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
        let new_path = ensure_unique_file_path(auto_save_dir, base_name, None);
        fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;

        if let Some(entry) = index.entries.get_mut(&note_id) {
            entry.relative_path = relative_path(auto_save_dir, &new_path);
        }
        moved_note_ids.push(note_id);
    }

    write_index(auto_save_dir, &index)?;

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
    let target_dir = if safe_folder.is_empty() {
        auto_save_dir.to_path_buf()
    } else {
        auto_save_dir.join(&safe_folder)
    };

    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let mut index = read_index(auto_save_dir);
    let existing_entry = index.entries.get(&safe_id).cloned();
    let existing_path = existing_entry
        .as_ref()
        .map(|e| auto_save_dir.join(&e.relative_path));

    let title_for_slug = if payload.title.is_empty() {
        derive_title(&payload.content)
    } else {
        payload.title.clone()
    };
    let base_name = slugify_title(&title_for_slug);
    let next_file_path = ensure_unique_file_path(&target_dir, &base_name, existing_path.as_deref());
    let manual_title = if payload.is_title_manual.unwrap_or(false) {
        normalize_manual_title(&payload.title)
    } else {
        None
    };
    let stored_markdown = embed_manual_title_metadata(&payload.content, manual_title.as_deref());

    fs::write(&next_file_path, to_windows_crlf(&stored_markdown)).map_err(|e| e.to_string())?;

    // Remove old file if path changed
    if let Some(ref old_path) = existing_path {
        if to_posix(&old_path.to_string_lossy()) != to_posix(&next_file_path.to_string_lossy()) {
            let _ = fs::remove_file(old_path);
        }
    }

    let metadata = fs::metadata(&next_file_path).map_err(|e| e.to_string())?;
    let created_at = existing_entry
        .map(|e| e.created_at)
        .unwrap_or_else(now_millis);
    let updated_at = system_time_to_millis(metadata.modified().unwrap_or(SystemTime::now()));

    let rel = relative_path(auto_save_dir, &next_file_path);

    index.entries.insert(
        safe_id.clone(),
        NoteIndexEntry {
            relative_path: rel,
            created_at,
            manual_title,
        },
    );

    write_index(auto_save_dir, &index)?;

    Ok(AutoSaveResult {
        file_path: next_file_path.to_string_lossy().to_string(),
        note_id: safe_id,
        created_at,
        updated_at,
    })
}

pub fn load_markdown_notes(auto_save_dir: &Path) -> Result<Vec<LoadedNote>, String> {
    fs::create_dir_all(auto_save_dir).map_err(|e| e.to_string())?;

    let mut index = read_index(auto_save_dir);
    let by_relative_path = collect_markdown_file_map(auto_save_dir);
    reconcile_index_with_files(auto_save_dir, &mut index, &by_relative_path)?;

    // Build notes
    let mut notes: Vec<LoadedNote> = Vec::new();
    let mut index_changed = false;
    let indexed_entries: Vec<(String, NoteIndexEntry)> = index
        .entries
        .iter()
        .map(|(note_id, entry)| (note_id.clone(), entry.clone()))
        .collect();

    for (note_id, entry) in indexed_entries {
        let file_path = match by_relative_path.get(&entry.relative_path) {
            Some(p) => p,
            None => continue,
        };

        let raw_markdown = match fs::read_to_string(file_path) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let (embedded_manual_title, markdown) = extract_manual_title_metadata(&raw_markdown);
        let indexed_manual_title = entry
            .manual_title
            .as_deref()
            .and_then(normalize_manual_title);

        let plain_text = markdown_to_plain_text(&markdown);
        let derived_title = derive_title(&markdown);
        let effective_manual_title = indexed_manual_title
            .clone()
            .or_else(|| embedded_manual_title.clone());
        let title = effective_manual_title.clone().unwrap_or(derived_title);

        if indexed_manual_title.is_none() {
            if let Some(recovered_title) = embedded_manual_title {
                if let Some(index_entry) = index.entries.get_mut(&note_id) {
                    index_entry.manual_title = Some(recovered_title);
                    index_changed = true;
                }
            }
        }

        // Extract folder path from relative path (using POSIX separators)
        let rel_dir = match entry.relative_path.rfind('/') {
            Some(idx) => entry.relative_path[..idx].to_string(),
            None => ".".to_string(),
        };
        let folder_path = if rel_dir == "." {
            String::new()
        } else {
            strip_inbox_root_alias(&rel_dir)
        };

        let metadata = match fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let updated_at = system_time_to_millis(metadata.modified().unwrap_or(SystemTime::now()));

        notes.push(LoadedNote {
            note_id,
            title,
            is_title_manual: effective_manual_title.is_some(),
            plain_text,
            content: markdown_to_html(&markdown),
            folder_path,
            created_at: entry.created_at,
            updated_at,
            file_path: file_path.to_string_lossy().to_string(),
        });
    }

    if index_changed {
        write_index(auto_save_dir, &index)?;
    }

    notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(notes)
}

pub fn remove_note_from_index(
    auto_save_dir: &Path,
    note_id: &str,
) -> Result<Option<PathBuf>, String> {
    let safe_id = sanitize_note_id(note_id);
    if safe_id.is_empty() {
        return Ok(None);
    }

    let mut index = read_index(auto_save_dir);
    let entry = match index.entries.remove(&safe_id) {
        Some(e) => e,
        None => return Ok(None),
    };

    let file_path = auto_save_dir.join(&entry.relative_path);
    write_index(auto_save_dir, &index)?;
    Ok(Some(file_path))
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
    fs::write(file_path, to_windows_crlf(content)).map_err(|e| e.to_string())
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
    fs::create_dir_all(dst_dir).map_err(|e| format!("Failed to create destination: {}", e))?;

    for folder in list_folders(src_dir)? {
        fs::create_dir_all(dst_dir.join(folder))
            .map_err(|e| format!("Failed to create destination folder: {}", e))?;
    }

    let mut src_index = read_index(src_dir);
    let src_files = collect_markdown_file_map(src_dir);
    reconcile_index_with_files(src_dir, &mut src_index, &src_files)?;

    let mut dst_index = read_index(dst_dir);
    let dst_files = collect_markdown_file_map(dst_dir);
    reconcile_index_with_files(dst_dir, &mut dst_index, &dst_files)?;

    let mut existing_dst_paths: HashSet<String> =
        collect_markdown_file_map(dst_dir).into_keys().collect();
    let mut existing_dst_ids: HashSet<String> = dst_index.entries.keys().cloned().collect();
    let mut files_copied: u32 = 0;
    let mut index_changed = false;

    let mut source_entries: Vec<_> = src_index.entries.iter().collect();
    source_entries.sort_by(|(left_id, _), (right_id, _)| left_id.cmp(right_id));

    for (src_note_id, src_entry) in source_entries {
        let Some(src_file) = src_files.get(&src_entry.relative_path) else {
            continue;
        };

        if let Some(existing_entry) = dst_index.entries.get(src_note_id) {
            let existing_path = dst_dir.join(&existing_entry.relative_path);
            if existing_path.exists() {
                continue;
            }
        }

        let desired_path = dst_dir.join(&src_entry.relative_path);
        let parent_dir = desired_path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| dst_dir.to_path_buf());
        let base_name = src_file
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("untitled");

        let final_path =
            if existing_dst_paths.contains(&src_entry.relative_path) || desired_path.exists() {
                ensure_unique_file_path(&parent_dir, base_name, None)
            } else {
                desired_path
            };

        if let Some(parent) = final_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory {:?}: {}", parent, e))?;
        }

        fs::copy(src_file, &final_path)
            .map_err(|e| format!("Failed to copy {:?}: {}", src_file, e))?;
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
            },
        );
        existing_dst_paths.insert(final_rel);
        existing_dst_ids.insert(final_note_id);
        index_changed = true;
    }

    if index_changed {
        write_index(dst_dir, &dst_index)?;
    }

    Ok(MigrationResult {
        files_copied,
        index_copied: index_changed,
    })
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
                },
            )?;

            let folders = rename_folder(&dir, "alpha", "beta")?;
            assert!(folders.contains(&"beta".to_string()));
            assert!(!folders.contains(&"alpha".to_string()));

            let notes = load_markdown_notes(&dir)?;
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].folder_path, "beta");

            let index = read_index(&dir);
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
                },
            )?;

            let files = list_markdown_files(&dir)?;
            assert_eq!(files.len(), 1);

            let raw_markdown = fs::read_to_string(&files[0]).unwrap();
            assert!(raw_markdown.starts_with(MANUAL_TITLE_META_PREFIX));
            assert!(raw_markdown.contains("Body first line"));

            let notes = load_markdown_notes(&dir)?;
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].title, "Project Launch");
            assert!(notes[0].is_title_manual);
            assert_eq!(notes[0].plain_text, "Body first line\nSecond line");
            assert!(!notes[0].content.contains("hwan-note:manual-title"));
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
                to_windows_crlf(&format!(
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
                        },
                    )]),
                },
            )?;

            let notes = load_markdown_notes(&dir)?;
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0].title, manual_title);
            assert!(notes[0].is_title_manual);

            let index = read_index(&dir);
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
                },
            )?;
            create_folder(&src, "empty")?;

            let migration = migrate_notes(&src, &dst)?;
            assert_eq!(migration.files_copied, 1);
            assert!(migration.index_copied);
            assert!(dst.join("empty").exists());

            let index = read_index(&dst);
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
}
