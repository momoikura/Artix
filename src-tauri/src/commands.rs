//! Tauri command surface — the entire IPC contract between Rust and the UI.
//!
//! Every command is thin: validate, delegate to `db::repo` or `fsops`, return a
//! serialisable value. Business logic lives in TypeScript (`src/core`) or in
//! `repo`, never here.

use std::path::{Path, PathBuf};

use serde_json::Value as Json;
use tauri::State;

use crate::db::{repo, Database};
use crate::error::{ArtixError, Result};
use crate::fsops;
use crate::models::*;

pub struct AppState {
    pub db: Database,
    pub data_dir: PathBuf,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/* ----------------------------------------------------------------- library */

#[tauri::command]
pub fn list_sessions(
    state: State<'_, AppState>,
    filters: Option<SessionFilters>,
) -> Result<Vec<Session>> {
    let filters = filters.unwrap_or_default();
    state.db.with(|conn| repo::list_sessions(conn, &filters))
}

#[tauri::command]
pub fn get_session(state: State<'_, AppState>, id: String) -> Result<SessionDetail> {
    state.db.with(|conn| repo::get_session(conn, &id))
}

/// Insert one session. Returns the id; a duplicate `content_hash` is an error
/// so single-file imports can tell the user plainly.
#[tauri::command]
pub fn save_session(
    state: State<'_, AppState>,
    detail: SessionDetail,
    document: SearchDocument,
) -> Result<String> {
    state
        .db
        .transaction(|tx| repo::insert_session(tx, &detail, &document))
}

/// Bulk insert. Duplicates are reported, not fatal — importing a folder of
/// exports twice should be a no-op with a clear summary, not a wall of errors.
#[tauri::command]
pub fn save_sessions(
    state: State<'_, AppState>,
    items: Vec<(SessionDetail, SearchDocument)>,
) -> Result<ImportOutcome> {
    let mut outcome = ImportOutcome::default();

    state.db.transaction(|tx| {
        for (detail, document) in &items {
            let reference = detail
                .session
                .source_ref
                .clone()
                .unwrap_or_else(|| detail.session.title.clone());

            // Upsert, not insert: a session that has grown since the last sync
            // must refresh in place rather than become a second star.
            match repo::upsert_session(tx, detail, document) {
                Ok((id, repo::UpsertOutcome::Inserted)) => outcome.imported.push(id),
                Ok((id, repo::UpsertOutcome::Updated)) => outcome.updated.push(id),
                Ok((id, repo::UpsertOutcome::Unchanged)) => outcome.duplicates.push(id),
                Err(ArtixError::Duplicate(existing)) => outcome.duplicates.push(existing),
                Err(e) => outcome.failed.push(ImportFailure {
                    reference,
                    message: e.to_string(),
                }),
            }
        }
        Ok(())
    })?;

    Ok(outcome)
}

#[tauri::command]
pub fn update_session(state: State<'_, AppState>, id: String, patch: Json) -> Result<()> {
    state
        .db
        .transaction(|tx| repo::update_session(tx, &id, &patch, now_ms()))
}

#[tauri::command]
pub fn delete_sessions(state: State<'_, AppState>, ids: Vec<String>) -> Result<usize> {
    state.db.transaction(|tx| {
        let mut deleted = 0;
        for id in &ids {
            match repo::delete_session(tx, id) {
                Ok(()) => deleted += 1,
                // Already gone is the desired end state.
                Err(ArtixError::NotFound(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(deleted)
    })
}

#[tauri::command]
pub fn replace_links(state: State<'_, AppState>, links: Vec<SessionLink>) -> Result<usize> {
    let count = links.len();
    state.db.transaction(|tx| repo::replace_links(tx, &links))?;
    Ok(count)
}

/* ------------------------------------------------------------------ search */

#[tauri::command]
pub fn search_fts(
    state: State<'_, AppState>,
    expression: String,
    limit: Option<i64>,
) -> Result<Vec<FtsHit>> {
    let limit = limit.unwrap_or(2000).clamp(1, 100_000);
    state
        .db
        .with(|conn| repo::fts_search(conn, &expression, limit))
}

#[tauri::command]
pub fn reindex(state: State<'_, AppState>, documents: Vec<SearchDocument>) -> Result<usize> {
    state.db.transaction(|tx| repo::rebuild_fts(tx, &documents))
}

#[tauri::command]
pub fn upsert_documents(
    state: State<'_, AppState>,
    documents: Vec<SearchDocument>,
) -> Result<usize> {
    let count = documents.len();
    state.db.transaction(|tx| {
        for doc in &documents {
            repo::upsert_fts(tx, doc)?;
        }
        Ok(())
    })?;
    Ok(count)
}

/* -------------------------------------------------------------- aggregates */

#[tauri::command]
pub fn facets(state: State<'_, AppState>) -> Result<Facets> {
    state.db.with(repo::facets)
}

#[tauri::command]
pub fn stats(state: State<'_, AppState>) -> Result<LibraryStats> {
    let bytes = state.db.size_bytes();
    state.db.with(|conn| repo::stats(conn, bytes))
}

#[tauri::command]
pub fn content_hashes(state: State<'_, AppState>) -> Result<Vec<String>> {
    state.db.with(repo::all_content_hashes)
}

#[tauri::command]
pub fn sessions_for_path(
    state: State<'_, AppState>,
    path: String,
    limit: Option<i64>,
) -> Result<Vec<String>> {
    let limit = limit.unwrap_or(50).clamp(1, 1000);
    state
        .db
        .with(|conn| repo::sessions_for_path(conn, &path, limit))
}

#[tauri::command]
pub fn vacuum(state: State<'_, AppState>) -> Result<()> {
    state.db.maintenance()
}

/* --------------------------------------------------------------- settings */

#[tauri::command]
pub fn kv_get(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    state.db.with(|conn| repo::kv_get(conn, &key))
}

#[tauri::command]
pub fn kv_set(state: State<'_, AppState>, key: String, value: String) -> Result<()> {
    state
        .db
        .with(|conn| repo::kv_set(conn, &key, &value, now_ms()))
}

#[tauri::command]
pub fn kv_delete(state: State<'_, AppState>, key: String) -> Result<()> {
    state.db.with(|conn| repo::kv_delete(conn, &key))
}

/* ------------------------------------------------------------- filesystem */

/// Where Artix keeps its database, settings and plugins.
#[tauri::command]
pub fn data_dir(state: State<'_, AppState>) -> Result<String> {
    Ok(state.data_dir.to_string_lossy().to_string())
}

/// Recursively list importable files under `root`.
///
/// The extension allow-list keeps a "import my projects folder" action from
/// walking a `node_modules` tree and handing the UI 400k paths.
#[tauri::command]
pub fn discover_files(
    root: String,
    extensions: Vec<String>,
    max_depth: Option<usize>,
    max_files: Option<usize>,
) -> Result<Vec<DiscoveredFile>> {
    fsops::discover(
        Path::new(&root),
        &extensions,
        max_depth.unwrap_or(8),
        max_files.unwrap_or(20_000),
    )
}

#[tauri::command]
pub fn read_text_file(path: String, max_bytes: Option<u64>) -> Result<String> {
    fsops::read_text(Path::new(&path), max_bytes.unwrap_or(64 * 1024 * 1024))
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<()> {
    fsops::write_text(Path::new(&path), &contents)
}

/// Write a set of in-memory files as a ZIP archive. Used by the ZIP exporter.
#[tauri::command]
pub fn write_zip(path: String, entries: Vec<(String, String)>) -> Result<u64> {
    fsops::write_zip(Path::new(&path), &entries)
}

/// Read every text entry from a ZIP archive, for the archive importer.
#[tauri::command]
pub fn read_zip(path: String, max_entries: Option<usize>) -> Result<Vec<(String, String)>> {
    fsops::read_zip(Path::new(&path), max_entries.unwrap_or(5000))
}

/// Copy the live database to `path` — a consistent backup even mid-write.
#[tauri::command]
pub fn backup_database(state: State<'_, AppState>, path: String) -> Result<u64> {
    state.db.with(|conn| {
        conn.backup(rusqlite::DatabaseName::Main, Path::new(&path), None)
            .map_err(|e| ArtixError::Storage(e.to_string()))?;
        Ok(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0))
    })
}

/// Absolute path to the running Artix executable.
///
/// The frontend needs this to write the Claude Code SessionEnd hook, which must
/// invoke *this* binary rather than assume an install location.
#[tauri::command]
pub fn current_exe_path() -> Result<String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| ArtixError::Io(e.to_string()))
}

/// Reveal the main window once the frontend has painted.
///
/// The window starts hidden (see `tauri.conf.json`) so the cold `--sync` path
/// can exit without a flash, and so a normal launch never shows an unpainted
/// white frame. The UI calls this after its first render.
#[tauri::command]
pub fn show_main_window(window: tauri::Window) -> Result<()> {
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}

/// Reveal a path in the OS file manager.
#[tauri::command]
pub fn reveal_path(app: tauri::AppHandle, path: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| ArtixError::Io(e.to_string()))
}

/* ---------------------------------------------------------------- startup */

/// Everything the frontend needs on boot, in one round trip.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub data_dir: String,
    pub database_path: String,
    pub schema_version: i32,
    pub app_version: String,
    pub stats: LibraryStats,
}

#[tauri::command]
pub fn bootstrap(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Bootstrap> {
    let bytes = state.db.size_bytes();
    let stats = state.db.with(|conn| repo::stats(conn, bytes))?;

    Ok(Bootstrap {
        data_dir: state.data_dir.to_string_lossy().to_string(),
        database_path: state.db.path().to_string_lossy().to_string(),
        schema_version: crate::db::SCHEMA_VERSION,
        app_version: app.package_info().version.to_string(),
        stats,
    })
}
