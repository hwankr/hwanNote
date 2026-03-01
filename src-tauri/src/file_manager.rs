use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha1::Digest;

const INDEX_FILENAME: &str = ".hwan-note-index.json";

static TOGGLE_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^:::toggle\[(open|closed)\](?:\s+(.*))?$").unwrap()
});
static CHECKLIST_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\s*)-\s+\[([ xX])\]\s*(.*)$").unwrap());
static HEADING_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#{1,3}\s+").unwrap());
static TASK_PREFIX_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^- \[[ xX]\]\s*").unwrap());
static TOGGLE_END_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^:::\s*$").unwrap());
static UNSAFE_FILENAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[<>:"/\\|?*\x00-\x1F]"#).unwrap());
static WHITESPACE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\s+").unwrap());
static TRAILING_DOTS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.+$").unwrap());
static PLAIN_TASK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\s*)- \[[ xX]\]\s*").unwrap());

const TOGGLE_BLOCK_END: &str = ":::";

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

pub fn sanitize_folder_path(folder_path: Option<&str>) -> String {
    let folder_path = match folder_path {
        Some(p) if !p.is_empty() => p,
        _ => return String::new(),
    };

    let normalized: String = folder_path
        .replace('\\', "/")
        .split('/')
        .map(|segment| {
            segment
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("/");

    if normalized.is_empty() || normalized == "inbox" {
        return String::new();
    }

    normalized
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

pub fn derive_title(markdown: &str) -> String {
    let normalized = markdown.replace("\r\n", "\n");
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
    let normalized = markdown.replace("\r\n", "\n");
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
                    let inner_lines: Vec<&str> =
                        lines[line_index + 1..end_index].to_vec();
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
                        let indent_str =
                            m.get(1).map_or("", |m| m.as_str()).replace('\t', "  ");
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
    let normalized = markdown.replace("\r\n", "\n");
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
        Ok(raw) => serde_json::from_str::<NoteIndex>(&raw)
            .unwrap_or(NoteIndex {
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

fn relative_path(from: &Path, to: &Path) -> String {
    match to.strip_prefix(from) {
        Ok(rel) => to_posix(&rel.to_string_lossy()),
        Err(_) => to_posix(&to.to_string_lossy()),
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
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    if ext.to_lowercase() != "md" {
        return Err("Only .md files are supported.".to_string());
    }
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(file_path, content).map_err(|e| e.to_string())
}

pub fn read_markdown_file(file_path: &Path) -> Result<String, String> {
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
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
    let safe_folder = sanitize_folder_path(payload.folder_path.as_deref());
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
    let next_file_path =
        ensure_unique_file_path(&target_dir, &base_name, existing_path.as_deref());

    fs::write(&next_file_path, to_windows_crlf(&payload.content))
        .map_err(|e| e.to_string())?;

    // Remove old file if path changed
    if let Some(ref old_path) = existing_path {
        if to_posix(&old_path.to_string_lossy())
            != to_posix(&next_file_path.to_string_lossy())
        {
            let _ = fs::remove_file(old_path);
        }
    }

    let metadata = fs::metadata(&next_file_path).map_err(|e| e.to_string())?;
    let created_at = existing_entry
        .map(|e| e.created_at)
        .unwrap_or_else(now_millis);
    let updated_at = system_time_to_millis(
        metadata.modified().unwrap_or(SystemTime::now()),
    );

    let rel = relative_path(auto_save_dir, &next_file_path);

    let manual_title = {
        let trimmed = payload.title.trim();
        let sliced: String = trimmed.chars().take(50).collect();
        if payload.is_title_manual.unwrap_or(false) && !sliced.is_empty() {
            Some(sliced)
        } else {
            None
        }
    };

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
    let files = walk_markdown_files(auto_save_dir, auto_save_dir);

    let mut by_relative_path: HashMap<String, PathBuf> = HashMap::new();
    for file_path in &files {
        let rel = relative_path(auto_save_dir, file_path);
        by_relative_path.insert(rel, file_path.clone());
    }

    let mut used_paths: HashSet<String> = HashSet::new();
    let mut index_changed = false;

    // Remove entries for missing files
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

    // Track used paths
    for entry in index.entries.values() {
        used_paths.insert(entry.relative_path.clone());
    }

    // Add entries for orphan files
    for (rel_path, full_path) in &by_relative_path {
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

            index.entries.insert(
                generated_id,
                NoteIndexEntry {
                    relative_path: rel_path.clone(),
                    created_at,
                    manual_title: None,
                },
            );
            index_changed = true;
        }
    }

    // Build notes
    let mut notes: Vec<LoadedNote> = Vec::new();

    for (note_id, entry) in &index.entries {
        let file_path = match by_relative_path.get(&entry.relative_path) {
            Some(p) => p,
            None => continue,
        };

        let markdown = match fs::read_to_string(file_path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        let plain_text = markdown_to_plain_text(&markdown);
        let derived_title = derive_title(&markdown);
        let title = match &entry.manual_title {
            Some(mt) if !mt.trim().is_empty() => mt.trim().to_string(),
            _ => derived_title,
        };

        // Extract folder path from relative path (using POSIX separators)
        let rel_dir = match entry.relative_path.rfind('/') {
            Some(idx) => entry.relative_path[..idx].to_string(),
            None => ".".to_string(),
        };
        let folder_path = if rel_dir == "." {
            String::new()
        } else {
            rel_dir
        };

        let metadata = match fs::metadata(file_path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let updated_at =
            system_time_to_millis(metadata.modified().unwrap_or(SystemTime::now()));

        notes.push(LoadedNote {
            note_id: note_id.clone(),
            title,
            is_title_manual: entry
                .manual_title
                .as_ref()
                .map_or(false, |mt| !mt.trim().is_empty()),
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

pub fn read_text_file(file_path: &Path) -> Result<String, String> {
    fs::read_to_string(file_path).map_err(|e| e.to_string())
}

pub fn save_text_file(file_path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(file_path, to_windows_crlf(content)).map_err(|e| e.to_string())
}

pub fn title_from_filename(file_path: &Path) -> String {
    let stem = file_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let title: String = stem.trim().chars().take(50).collect();
    if title.is_empty() {
        "\u{c81c}\u{baa9} \u{c5c6}\u{c74c}".to_string() // 제목 없음
    } else {
        title
    }
}
