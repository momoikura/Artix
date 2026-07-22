//! Filesystem operations.
//!
//! All of these are reachable only from a Tauri command, which is itself
//! reachable only after the user picked a path in a native dialog. Nothing here
//! touches the network, and nothing writes outside a path the user supplied.

use std::io::{Read, Write};
use std::path::Path;

use walkdir::WalkDir;
use zip::write::SimpleFileOptions;

use crate::error::{ArtixError, Result};
use crate::models::DiscoveredFile;

/// Directories never worth walking when the user points Artix at a project.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    ".gradle",
    "vendor",
    "Pods",
    ".idea",
    ".vscode",
    "coverage",
    ".turbo",
];

fn is_skipped(entry: &walkdir::DirEntry) -> bool {
    entry.file_type().is_dir()
        && entry
            .file_name()
            .to_str()
            .is_some_and(|name| SKIP_DIRS.contains(&name))
}

/// Recursively collect files whose extension is in `extensions` (case
/// insensitive, no leading dot). An empty list matches every file.
pub fn discover(
    root: &Path,
    extensions: &[String],
    max_depth: usize,
    max_files: usize,
) -> Result<Vec<DiscoveredFile>> {
    if !root.exists() {
        return Err(ArtixError::NotFound(format!(
            "{} does not exist",
            root.display()
        )));
    }

    let wanted: Vec<String> = extensions
        .iter()
        .map(|e| e.trim_start_matches('.').to_lowercase())
        .collect();

    let mut out = Vec::new();

    for entry in WalkDir::new(root)
        .max_depth(max_depth)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_skipped(e))
    {
        // A single unreadable directory must not abort the whole scan.
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }

        if !wanted.is_empty() {
            let matches = entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| wanted.contains(&e.to_lowercase()))
                .unwrap_or(false);
            if !matches {
                continue;
            }
        }

        let Ok(meta) = entry.metadata() else { continue };
        out.push(DiscoveredFile {
            path: entry.path().to_string_lossy().to_string(),
            name: entry.file_name().to_string_lossy().to_string(),
            bytes: meta.len(),
            modified_at: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        });

        if out.len() >= max_files {
            break;
        }
    }

    // Newest first — `Reverse` rather than a hand-rolled comparator so the
    // intent is obvious and clippy is satisfied.
    out.sort_by_key(|f| std::cmp::Reverse(f.modified_at));
    Ok(out)
}

/// Read a UTF-8 text file, refusing anything above `max_bytes` so a stray
/// pick of a 4 GB log cannot take the app down.
pub fn read_text(path: &Path, max_bytes: u64) -> Result<String> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > max_bytes {
        return Err(ArtixError::InvalidInput(format!(
            "{} is {:.1} MB, above the {:.0} MB import limit",
            path.display(),
            meta.len() as f64 / 1_048_576.0,
            max_bytes as f64 / 1_048_576.0
        )));
    }

    let bytes = std::fs::read(path)?;
    // Lossy decode: a single bad byte in a transcript should not lose the file.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn write_text(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, contents)?;
    Ok(())
}

/// Write `entries` as `(relative_path, contents)` into a deflate ZIP.
pub fn write_zip(path: &Path, entries: &[(String, String)]) -> Result<u64> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let file = std::fs::File::create(path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    for (name, contents) in entries {
        // Reject absolute paths and traversal so an archive can never be built
        // that writes outside its own root on extraction.
        let safe = name.replace('\\', "/");
        if safe.starts_with('/') || safe.split('/').any(|part| part == "..") {
            return Err(ArtixError::InvalidInput(format!(
                "unsafe archive path: {name}"
            )));
        }
        zip.start_file(safe, options)?;
        zip.write_all(contents.as_bytes())?;
    }

    zip.finish()?;
    Ok(std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))
}

/// Read every text-looking entry from a ZIP. Binary entries are skipped.
pub fn read_zip(path: &Path, max_entries: usize) -> Result<Vec<(String, String)>> {
    let file = std::fs::File::open(path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut out = Vec::new();

    for i in 0..archive.len().min(max_entries) {
        let mut entry = archive.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        // 32 MB per entry keeps a zip bomb from exhausting memory.
        if entry.size() > 32 * 1024 * 1024 {
            continue;
        }

        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut buf)?;

        // NUL bytes are the cheapest reliable "this is binary" signal.
        if buf.contains(&0) {
            continue;
        }

        out.push((
            entry.name().to_string(),
            String::from_utf8_lossy(&buf).into_owned(),
        ));
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zip_roundtrip() {
        let dir = std::env::temp_dir().join(format!("artix-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.zip");

        let entries = vec![
            ("a.md".to_string(), "# hello".to_string()),
            ("nested/b.json".to_string(), "{\"k\":1}".to_string()),
        ];
        write_zip(&path, &entries).unwrap();

        let read = read_zip(&path, 100).unwrap();
        assert_eq!(read.len(), 2);
        assert_eq!(read[0].1, "# hello");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_traversal_paths() {
        let path = std::env::temp_dir().join("artix-traversal.zip");
        let entries = vec![("../escape.txt".to_string(), "no".to_string())];
        assert!(write_zip(&path, &entries).is_err());
        std::fs::remove_file(&path).ok();
    }
}
