//! Database lifecycle: opening, pragmas, migrations, maintenance.
//!
//! Artix keeps a single write connection behind a mutex. SQLite in WAL mode
//! serialises writers anyway, and every Artix write is a short transaction, so
//! a pool would add complexity without adding throughput.

pub mod repo;

#[cfg(test)]
mod repo_tests;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::{ArtixError, Result};

/// Bumped whenever `migrations()` gains an entry.
pub const SCHEMA_VERSION: i32 = 1;

pub struct Database {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl Database {
    /// Open (creating if needed) the library at `path` and bring it up to date.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(path)?;
        configure(&conn)?;
        assert_fts5(&conn)?;
        migrate(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
            path: path.to_path_buf(),
        })
    }

    /// In-memory database, used by the Rust unit tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        configure(&conn)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: PathBuf::from(":memory:"),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Run `f` with the write connection held.
    ///
    /// A poisoned mutex means another thread panicked mid-write; the WAL is
    /// still consistent, so we recover rather than propagate the panic.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        f(&guard)
    }

    /// Run `f` inside a transaction, rolling back on any error.
    pub fn transaction<T>(&self, f: impl FnOnce(&rusqlite::Transaction) -> Result<T>) -> Result<T> {
        let mut guard = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        let tx = guard.transaction()?;
        let value = f(&tx)?;
        tx.commit()?;
        Ok(value)
    }

    /// Reclaim space and refresh planner statistics. Cheap enough to run on a
    /// user action, far too expensive to run on every write.
    pub fn maintenance(&self) -> Result<()> {
        self.with(|conn| {
            conn.execute_batch(
                "PRAGMA wal_checkpoint(TRUNCATE);
                 PRAGMA optimize;
                 INSERT INTO session_fts(session_fts) VALUES('optimize');",
            )?;
            Ok(())
        })?;
        // VACUUM cannot run inside a transaction or with statements pending.
        self.with(|conn| {
            conn.execute_batch("VACUUM;")?;
            Ok(())
        })
    }

    pub fn size_bytes(&self) -> i64 {
        std::fs::metadata(&self.path)
            .map(|m| m.len() as i64)
            .unwrap_or(0)
    }
}

/// Connection pragmas. Chosen for a single-user desktop app that values
/// responsiveness and crash-safety over the last few percent of throughput.
fn configure(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;        -- readers never block the writer
         PRAGMA synchronous = NORMAL;      -- WAL makes this crash-safe
         PRAGMA foreign_keys = ON;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -65536;       -- 64 MiB page cache
         PRAGMA mmap_size = 268435456;     -- 256 MiB memory map
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

/// Fail loudly at startup rather than mysteriously at first search if the
/// linked SQLite was built without FTS5.
fn assert_fts5(conn: &Connection) -> Result<()> {
    let ok: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5')",
            [],
            |row| row.get(0),
        )
        .unwrap_or(false);

    if ok {
        return Ok(());
    }

    // pragma_compile_options is not always populated; probe directly.
    match conn.execute_batch("CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x);") {
        Ok(()) => {
            let _ = conn.execute_batch("DROP TABLE temp.__fts5_probe;");
            Ok(())
        }
        Err(_) => Err(ArtixError::Unsupported(
            "This build of SQLite lacks FTS5. Rebuild Artix with the bundled SQLite \
             (the default) rather than a system library."
                .into(),
        )),
    }
}

/// Ordered migrations. Each entry runs exactly once, tracked by `user_version`.
fn migrations() -> Vec<(i32, &'static str)> {
    vec![(1, include_str!("schema.sql"))]
}

fn migrate(conn: &Connection) -> Result<()> {
    let current: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

    if current > SCHEMA_VERSION {
        return Err(ArtixError::Unsupported(format!(
            "This library was written by a newer version of Artix (schema {current}, \
             this build supports {SCHEMA_VERSION}). Upgrade Artix to open it."
        )));
    }

    for (version, sql) in migrations() {
        if version <= current {
            continue;
        }
        conn.execute_batch("BEGIN;")?;
        match conn.execute_batch(sql) {
            Ok(()) => {
                conn.execute_batch(&format!("PRAGMA user_version = {version};"))?;
                conn.execute_batch("COMMIT;")?;
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(ArtixError::Storage(format!(
                    "migration {version} failed: {e}"
                )));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_to_current_version() {
        let db = Database::open_in_memory().expect("open");
        let version: i32 = db
            .with(|c| Ok(c.query_row("PRAGMA user_version", [], |r| r.get(0))?))
            .expect("query");
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn fts5_is_available() {
        let db = Database::open_in_memory().expect("open");
        db.with(|c| {
            c.execute(
                "INSERT INTO session_fts(title, project, summary, notes, tags, technologies, body, session_id)
                 VALUES ('galaxy renderer', 'artix', '', '', '', '', 'instanced points', 'S1')",
                [],
            )?;
            let count: i64 = c.query_row(
                "SELECT count(*) FROM session_fts WHERE session_fts MATCH 'galaxy'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(count, 1);
            Ok(())
        })
        .expect("fts roundtrip");
    }
}
