//! Artix desktop backend.
//!
//! Responsibilities are deliberately narrow: own the SQLite library, expose it
//! over IPC, and touch the filesystem on the user's behalf. No networking is
//! linked in, and none is possible — Artix is offline by construction.

mod commands;
mod db;
mod error;
mod fsops;
mod models;

use std::path::PathBuf;

use tauri::Manager;

use commands::AppState;
use db::Database;

/// Resolve the library location, honouring `ARTIX_DATA_DIR` for portable
/// installs (a USB stick, or a second library for testing).
fn resolve_data_dir(app: &tauri::App) -> PathBuf {
    if let Ok(custom) = std::env::var("ARTIX_DATA_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = resolve_data_dir(app);
            std::fs::create_dir_all(&data_dir)?;

            let db = Database::open(&data_dir.join("artix.db")).map_err(|e| {
                // Surface the real reason rather than a blank window.
                std::io::Error::other(format!("failed to open Artix library: {e}"))
            })?;

            app.manage(AppState { db, data_dir });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::list_sessions,
            commands::get_session,
            commands::save_session,
            commands::save_sessions,
            commands::update_session,
            commands::delete_sessions,
            commands::replace_links,
            commands::search_fts,
            commands::reindex,
            commands::upsert_documents,
            commands::facets,
            commands::stats,
            commands::content_hashes,
            commands::sessions_for_path,
            commands::vacuum,
            commands::kv_get,
            commands::kv_set,
            commands::kv_delete,
            commands::data_dir,
            commands::discover_files,
            commands::read_text_file,
            commands::write_text_file,
            commands::write_zip,
            commands::read_zip,
            commands::backup_database,
            commands::reveal_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Artix");
}
