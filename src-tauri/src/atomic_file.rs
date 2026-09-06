use std::fs;
use std::io;
use std::path::Path;

/// Move an entry without ever replacing a destination created by another writer.
/// This also supports filesystems without hard links, such as removable FAT media.
pub(crate) fn move_file_without_replace(source: &Path, destination: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // SAFETY: both paths are valid, live NUL-terminated UTF-16 buffers.
        // Omitting MOVEFILE_REPLACE_EXISTING is essential: std::fs::rename sets it.
        let result = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        };
        if result == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let source = CString::new(source.as_os_str().as_bytes())
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        let destination = CString::new(destination.as_os_str().as_bytes())
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        // SAFETY: both NUL-terminated path buffers remain alive for the call.
        // No pointer is retained, and each platform flag forbids replacement.
        let result = unsafe {
            #[cfg(target_os = "linux")]
            {
                libc::renameat2(
                    libc::AT_FDCWD,
                    source.as_ptr(),
                    libc::AT_FDCWD,
                    destination.as_ptr(),
                    libc::RENAME_NOREPLACE,
                )
            }
            #[cfg(target_os = "macos")]
            {
                libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL)
            }
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
    #[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
    {
        let _ = (source, destination);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "This platform does not provide a supported no-replace rename",
        ))
    }
}

pub(crate) fn publish_temp_file(
    temp_path: &Path,
    destination: &Path,
    operation: &str,
) -> Result<(), String> {
    ensure_same_parent_directory(temp_path, destination, operation)?;
    validate_existing_destination(destination, operation)?;
    replace_file_atomically(temp_path, destination).map_err(|error| {
        format!(
            "{operation} failed to publish {} from {}: {error}",
            destination.display(),
            temp_path.display()
        )
    })?;
    sync_parent_directory(destination, operation)
}

fn ensure_same_parent_directory(
    temp_path: &Path,
    destination: &Path,
    operation: &str,
) -> Result<(), String> {
    let temp_parent = parent_directory(temp_path, operation, "temp path")?;
    let destination_parent = parent_directory(destination, operation, "destination path")?;
    if temp_parent != destination_parent {
        return Err(format!(
            "{operation} rejected publication from {} to {}: both paths must share the same parent directory",
            temp_path.display(),
            destination.display()
        ));
    }
    Ok(())
}

fn parent_directory<'a>(path: &'a Path, operation: &str, label: &str) -> Result<&'a Path, String> {
    path.parent().ok_or_else(|| {
        format!(
            "{operation} failed for {}: {label} has no parent directory",
            path.display()
        )
    })
}

fn validate_existing_destination(destination: &Path, operation: &str) -> Result<(), String> {
    let metadata = match fs::symlink_metadata(destination) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "{operation} failed to inspect existing destination {}: {error}",
                destination.display()
            ));
        }
    };

    if metadata_is_symlink_or_reparse_point(&metadata) {
        return Err(format!(
            "{operation} rejected existing destination {}: symbolic links and reparse points are not allowed",
            destination.display()
        ));
    }

    if !metadata.is_file() {
        return Err(format!(
            "{operation} rejected existing destination {}: expected a regular file",
            destination.display()
        ));
    }

    Ok(())
}

#[cfg(windows)]
fn metadata_is_symlink_or_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_symlink_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn replace_existing_file_windows(replaced_path: &Path, replacement_path: &Path) -> io::Result<()> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    fn to_wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(iter::once(0))
            .collect()
    }

    let replaced_wide = to_wide(replaced_path);
    let replacement_wide = to_wide(replacement_path);
    let result = unsafe {
        ReplaceFileW(
            replaced_wide.as_ptr(),
            replacement_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if result == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn replace_file_atomically(temp_path: &Path, destination: &Path) -> io::Result<()> {
    let destination_exists = match fs::symlink_metadata(destination) {
        Ok(_) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };

    if !destination_exists {
        return fs::rename(temp_path, destination);
    }

    #[cfg(windows)]
    {
        replace_existing_file_windows(destination, temp_path)
    }

    #[cfg(not(windows))]
    {
        fs::rename(temp_path, destination)
    }
}

#[cfg(unix)]
pub(crate) fn sync_parent_directory(path: &Path, operation: &str) -> Result<(), String> {
    let parent = parent_directory(path, operation, "path")?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            format!(
                "{operation} failed to sync parent {}: {error}",
                parent.display()
            )
        })
}

#[cfg(not(unix))]
pub(crate) fn sync_parent_directory(path: &Path, operation: &str) -> Result<(), String> {
    parent_directory(path, operation, "path")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{move_file_without_replace, publish_temp_file};
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::path::{Path, PathBuf};

    fn now_millis() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    }

    fn make_temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "hwan_note_atomic_file_{}_{}_{}",
            name,
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cleanup_temp_dir(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    fn create_temp_file(path: &Path, content: &str) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .unwrap();
        file.write_all(content.as_bytes()).unwrap();
        file.sync_all().unwrap();
    }

    #[test]
    fn no_replace_move_preserves_existing_destination_and_source() {
        let root = make_temp_dir("no-replace-existing");
        let source = root.join("source.txt");
        let destination = root.join("destination.txt");
        fs::write(&source, "source").unwrap();
        fs::write(&destination, "external sentinel").unwrap();
        let error = move_file_without_replace(&source, &destination).unwrap_err();
        assert!(error.raw_os_error().is_some());
        assert_eq!(fs::read_to_string(&source).unwrap(), "source");
        assert_eq!(
            fs::read_to_string(&destination).unwrap(),
            "external sentinel"
        );
        cleanup_temp_dir(&root);
    }

    #[test]
    fn no_replace_move_supports_files_and_directories() {
        let root = make_temp_dir("no-replace-moves");
        let source = root.join("source");
        let destination = root.join("destination");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("file.txt"), "content").unwrap();
        move_file_without_replace(&source, &destination).unwrap();
        move_file_without_replace(&destination.join("file.txt"), &root.join("file.txt")).unwrap();
        assert!(!source.exists());
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "content"
        );
        cleanup_temp_dir(&root);
    }

    #[cfg(unix)]
    fn create_file_symlink(link: &Path, target: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_file_symlink(link: &Path, target: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[test]
    fn publish_temp_file_renames_when_destination_is_missing() {
        let root = make_temp_dir("publish-new");
        let temp_path = root.join(".calendar.json.tmp");
        let destination = root.join("calendar.json");
        create_temp_file(&temp_path, "fresh");

        publish_temp_file(&temp_path, &destination, "publish_test").unwrap();

        assert!(!temp_path.exists());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "fresh");
        cleanup_temp_dir(&root);
    }

    #[test]
    fn publish_temp_file_replaces_existing_destination() {
        let root = make_temp_dir("publish-replace");
        let temp_path = root.join(".calendar.json.tmp");
        let destination = root.join("calendar.json");
        fs::write(&destination, "old").unwrap();
        create_temp_file(&temp_path, "new");

        publish_temp_file(&temp_path, &destination, "publish_test").unwrap();

        assert!(!temp_path.exists());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "new");
        cleanup_temp_dir(&root);
    }

    #[test]
    fn publish_temp_file_rejects_cross_directory_publication() {
        let root = make_temp_dir("publish-cross-dir");
        let other = make_temp_dir("publish-cross-dir-other");
        let temp_path = root.join(".calendar.json.tmp");
        let destination = other.join("calendar.json");
        create_temp_file(&temp_path, "fresh");

        let error = publish_temp_file(&temp_path, &destination, "publish_test").unwrap_err();

        assert!(error.contains("share the same parent directory"));
        assert_eq!(fs::read_to_string(&temp_path).unwrap(), "fresh");
        cleanup_temp_dir(&root);
        cleanup_temp_dir(&other);
    }

    #[test]
    fn publish_temp_file_rejects_existing_symlink_destination_without_touching_target() {
        let root = make_temp_dir("publish-symlink-destination");
        let outside = make_temp_dir("publish-symlink-target");
        let temp_path = root.join(".calendar.json.tmp");
        let destination = root.join("calendar.json");
        let external_target = outside.join("real-calendar.json");
        fs::write(&external_target, "external").unwrap();
        create_temp_file(&temp_path, "fresh");

        let symlink_result = create_file_symlink(&destination, &external_target);
        if cfg!(windows) && symlink_result.is_err() {
            cleanup_temp_dir(&root);
            cleanup_temp_dir(&outside);
            return;
        }
        symlink_result.unwrap();

        let error = publish_temp_file(&temp_path, &destination, "publish_test").unwrap_err();

        assert!(error.contains("symbolic links and reparse points are not allowed"));
        assert_eq!(fs::read_to_string(&external_target).unwrap(), "external");
        assert_eq!(fs::read_to_string(&temp_path).unwrap(), "fresh");
        cleanup_temp_dir(&root);
        cleanup_temp_dir(&outside);
    }

    #[cfg(windows)]
    #[test]
    fn publish_temp_file_preserves_destination_and_temp_when_replacefilew_is_blocked() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

        let root = make_temp_dir("publish-share-delete-blocked");
        let temp_path = root.join(".calendar.json.tmp");
        let destination = root.join("calendar.json");
        fs::write(&destination, "old").unwrap();
        create_temp_file(&temp_path, "fresh");

        let destination_guard = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&destination)
            .unwrap();

        let error = publish_temp_file(&temp_path, &destination, "publish_test").unwrap_err();

        assert!(error.contains("failed to publish"));
        assert_eq!(fs::read_to_string(&destination).unwrap(), "old");
        assert_eq!(fs::read_to_string(&temp_path).unwrap(), "fresh");

        drop(destination_guard);
        cleanup_temp_dir(&root);
    }
}
