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

use tauri::{Emitter, Manager, Theme, WebviewUrl, WebviewWindowBuilder};

use commands::AppState;
use db::Database;

/// The argv flag that means "import newly-changed sessions, then get out of the
/// way". Passed by the Claude Code SessionEnd hook.
const SYNC_FLAG: &str = "--sync";

/// Event the frontend listens for to run an immediate incremental sync.
const SYNC_EVENT: &str = "artix://sync-requested";

fn has_sync_flag<T: AsRef<str>>(args: impl IntoIterator<Item = T>) -> bool {
    args.into_iter().any(|a| a.as_ref() == SYNC_FLAG)
}

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
    // Was *this* process launched by the hook (`artix --sync`)? Only meaningful
    // when we turn out to be the primary instance — see the setup hook.
    let launched_for_sync = has_sync_flag(std::env::args());

    tauri::Builder::default()
        // Must be registered first. When a second `artix --sync` launches while
        // Artix is already running, this fires in the *existing* instance and
        // the new process exits — so the hook never opens a second window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if has_sync_flag(&argv) {
                let _ = app.emit(SYNC_EVENT, ());
            } else if let Some(window) = app.get_webview_window("main") {
                // A plain second launch just focuses the existing window.
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // If we reached setup with the sync flag, no instance was already
            // running (otherwise single-instance would have forwarded and
            // exited us). There is no live galaxy to update, so quit without
            // ever showing a window — the next normal launch auto-syncs.
            if launched_for_sync {
                app.handle().exit(0);
                return Ok(());
            }

            let data_dir = resolve_data_dir(app);
            std::fs::create_dir_all(&data_dir)?;

            let db = Database::open(&data_dir.join("artix.db")).map_err(|e| {
                // Surface the real reason rather than a blank window.
                std::io::Error::other(format!("failed to open Artix library: {e}"))
            })?;

            app.manage(AppState { db, data_dir });

            // Create the window here rather than in tauri.conf.json so the
            // `--sync` path above returns before any window or webview exists —
            // no flash, no wasted webview. Starts hidden; the frontend calls
            // `show_main_window` once it has painted.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Artix")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 640.0)
                .resizable(true)
                .center()
                .decorations(true)
                .theme(Some(Theme::Dark))
                .visible(false)
                .build()?;

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
            commands::current_exe_path,
            commands::show_main_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Artix");
}
