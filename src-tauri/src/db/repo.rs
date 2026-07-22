//! Every SQL statement Artix runs.
//!
//! Kept in one module so the query surface is auditable at a glance and so no
//! command handler can quietly invent its own schema assumptions.

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row, Transaction};

use crate::error::{ArtixError, Result};
use crate::models::*;

/* ------------------------------------------------------------ row mapping */

fn map_session(row: &Row<'_>) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get("id")?,
        title: row.get("title")?,
        project: row.get("project")?,
        folder: row.get("folder")?,
        summary: row.get("summary")?,
        notes: row.get("notes")?,
        language: row.get("language")?,
        status: row.get("status")?,
        kind: row.get("kind")?,
        complexity: row.get("complexity")?,
        importance: row.get("importance")?,
        pinned: row.get::<_, i64>("pinned")? != 0,
        source: row.get("source")?,
        source_ref: row.get("source_ref")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        updated_at: row.get("updated_at")?,
        imported_at: row.get("imported_at")?,
        message_count: row.get("message_count")?,
        file_count: row.get("file_count")?,
        artifact_count: row.get("artifact_count")?,
        token_estimate: row.get("token_estimate")?,
        content_hash: row.get("content_hash")?,
        tags: Vec::new(),
        technologies: Vec::new(),
    })
}

const SESSION_COLUMNS: &str =
    "id, title, project, folder, summary, notes, language, status, kind, \
     complexity, importance, pinned, source, source_ref, started_at, ended_at, \
     updated_at, imported_at, message_count, file_count, artifact_count, \
     token_estimate, content_hash";

/* ------------------------------------------------------------------ writes */

/// Insert a complete session aggregate.
///
/// Returns `Duplicate` when `content_hash` already exists — the caller decides
/// whether that is an error (single import) or an expected skip (bulk import).
pub fn insert_session(
    tx: &Transaction<'_>,
    detail: &SessionDetail,
    doc: &SearchDocument,
) -> Result<String> {
    let s = &detail.session;

    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM sessions WHERE content_hash = ?1",
            params![s.content_hash],
            |row| row.get(0),
        )
        .optional()?;

    if let Some(id) = existing {
        return Err(ArtixError::Duplicate(id));
    }

    tx.execute(
        "INSERT INTO sessions (
            id, title, project, folder, summary, notes, language, status, kind,
            complexity, importance, pinned, source, source_ref, started_at, ended_at,
            updated_at, imported_at, message_count, file_count, artifact_count,
            token_estimate, content_hash
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)",
        params![
            s.id, s.title, s.project, s.folder, s.summary, s.notes, s.language, s.status, s.kind,
            s.complexity, s.importance, s.pinned as i64, s.source, s.source_ref, s.started_at,
            s.ended_at, s.updated_at, s.imported_at, s.message_count, s.file_count,
            s.artifact_count, s.token_estimate, s.content_hash
        ],
    )?;

    write_children(tx, detail)?;
    set_tags(tx, &s.id, &s.tags)?;
    set_technologies(tx, &s.id, &s.technologies)?;
    upsert_fts(tx, doc)?;

    Ok(s.id.clone())
}

/// What `upsert_session` did, so the UI can report honestly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpsertOutcome {
    Inserted,
    /// Same session id, new content — the record was refreshed in place.
    Updated,
    /// Byte-identical to what is already stored; nothing was written.
    Unchanged,
}

/// Insert, or refresh an existing session identified by `(source, source_ref)`.
///
/// This is what makes automatic sync possible. A live transcript grows while
/// you work, so its content hash changes on every scan — plain hash dedupe
/// would create a fresh star each time. Matching on the tool's own session id
/// instead means a session is one record for its whole life.
///
/// User-authored fields (`notes`, `pinned`) survive the refresh. Re-importing
/// must never destroy something only the human could have written.
pub fn upsert_session(
    tx: &Transaction<'_>,
    detail: &SessionDetail,
    doc: &SearchDocument,
) -> Result<(String, UpsertOutcome)> {
    let s = &detail.session;

    let Some(source_ref) = s.source_ref.as_deref().filter(|r| !r.is_empty()) else {
        // No stable identity to match on; fall back to hash dedupe.
        let id = insert_session(tx, detail, doc)?;
        return Ok((id, UpsertOutcome::Inserted));
    };

    let existing: Option<(String, String, String, i64)> = tx
        .query_row(
            "SELECT id, content_hash, notes, pinned FROM sessions
             WHERE source = ?1 AND source_ref = ?2",
            params![s.source, source_ref],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;

    let Some((existing_id, existing_hash, existing_notes, existing_pinned)) = existing else {
        let id = insert_session(tx, detail, doc)?;
        return Ok((id, UpsertOutcome::Inserted));
    };

    if existing_hash == s.content_hash {
        return Ok((existing_id, UpsertOutcome::Unchanged));
    }

    // Replace the derived content, keep the identity and anything hand-written.
    tx.execute(
        "DELETE FROM messages WHERE session_id = ?1",
        params![existing_id],
    )?;
    tx.execute(
        "DELETE FROM artifacts WHERE session_id = ?1",
        params![existing_id],
    )?;
    tx.execute(
        "DELETE FROM files WHERE session_id = ?1",
        params![existing_id],
    )?;

    tx.execute(
        "UPDATE sessions SET
            title = ?2, project = ?3, folder = ?4, summary = ?5, language = ?6,
            status = ?7, kind = ?8, complexity = ?9, importance = ?10,
            started_at = ?11, ended_at = ?12, updated_at = ?13,
            message_count = ?14, file_count = ?15, artifact_count = ?16,
            token_estimate = ?17, content_hash = ?18
         WHERE id = ?1",
        params![
            existing_id,
            s.title,
            s.project,
            s.folder,
            s.summary,
            s.language,
            s.status,
            s.kind,
            s.complexity,
            s.importance,
            s.started_at,
            s.ended_at,
            s.updated_at,
            s.message_count,
            s.file_count,
            s.artifact_count,
            s.token_estimate,
            s.content_hash
        ],
    )?;

    // Notes and pinned are user data; restore whatever was there.
    tx.execute(
        "UPDATE sessions SET notes = ?2, pinned = ?3 WHERE id = ?1",
        params![existing_id, existing_notes, existing_pinned],
    )?;

    // Children carry the *old* session id from the caller's aggregate, so they
    // are re-pointed at the record being refreshed.
    let mut rebased = detail.clone();
    rebased.session.id = existing_id.clone();
    for m in &mut rebased.messages {
        m.session_id = existing_id.clone();
    }
    for a in &mut rebased.artifacts {
        a.session_id = existing_id.clone();
    }
    for f in &mut rebased.files {
        f.session_id = existing_id.clone();
    }

    write_children(tx, &rebased)?;
    set_tags(tx, &existing_id, &s.tags)?;
    set_technologies(tx, &existing_id, &s.technologies)?;

    let mut fresh_doc = doc.clone();
    fresh_doc.id = existing_id.clone();
    upsert_fts(tx, &fresh_doc)?;

    Ok((existing_id, UpsertOutcome::Updated))
}

fn write_children(tx: &Transaction<'_>, detail: &SessionDetail) -> Result<()> {
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO messages (id, session_id, seq, role, content, created_at, token_estimate, tool_name)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        )?;
        for m in &detail.messages {
            stmt.execute(params![
                m.id,
                m.session_id,
                m.seq,
                m.role,
                m.content,
                m.created_at,
                m.token_estimate,
                m.tool_name
            ])?;
        }
    }
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO artifacts (id, session_id, kind, title, language, content, path, message_seq, done)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        )?;
        for a in &detail.artifacts {
            stmt.execute(params![
                a.id,
                a.session_id,
                a.kind,
                a.title,
                a.language,
                a.content,
                a.path,
                a.message_seq,
                a.done as i64
            ])?;
        }
    }
    {
        // A transcript can mention the same path twice; last write wins.
        let mut stmt = tx.prepare_cached(
            "INSERT INTO files (id, session_id, path, action, language, bytes, snippet)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(session_id, path) DO UPDATE SET
                action = excluded.action,
                language = excluded.language,
                bytes = max(files.bytes, excluded.bytes),
                snippet = coalesce(excluded.snippet, files.snippet)",
        )?;
        for f in &detail.files {
            stmt.execute(params![
                f.id,
                f.session_id,
                f.path,
                f.action,
                f.language,
                f.bytes,
                f.snippet
            ])?;
        }
    }
    Ok(())
}

/// Replace a session's tag set, creating tag rows as needed.
pub fn set_tags(tx: &Transaction<'_>, session_id: &str, tags: &[String]) -> Result<()> {
    tx.execute(
        "DELETE FROM session_tags WHERE session_id = ?1",
        params![session_id],
    )?;

    let mut find = tx.prepare_cached("SELECT id FROM tags WHERE name = ?1")?;
    let mut create =
        tx.prepare_cached("INSERT INTO tags (id, name, color) VALUES (?1, ?2, NULL)")?;
    let mut link = tx.prepare_cached(
        "INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?1, ?2)",
    )?;

    for name in tags {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let id: String = match find.query_row(params![name], |r| r.get(0)).optional()? {
            Some(id) => id,
            None => {
                let id = format!("t_{}", stable_key(name));
                create.execute(params![id, name])?;
                id
            }
        };
        link.execute(params![session_id, id])?;
    }
    Ok(())
}

pub fn set_technologies(tx: &Transaction<'_>, session_id: &str, techs: &[String]) -> Result<()> {
    tx.execute(
        "DELETE FROM session_technologies WHERE session_id = ?1",
        params![session_id],
    )?;

    let mut find = tx.prepare_cached("SELECT id FROM technologies WHERE name = ?1")?;
    let mut create = tx.prepare_cached("INSERT INTO technologies (id, name) VALUES (?1, ?2)")?;
    let mut link = tx.prepare_cached(
        "INSERT OR IGNORE INTO session_technologies (session_id, technology_id) VALUES (?1, ?2)",
    )?;

    for name in techs {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let id: String = match find.query_row(params![name], |r| r.get(0)).optional()? {
            Some(id) => id,
            None => {
                let id = format!("k_{}", stable_key(name));
                create.execute(params![id, name])?;
                id
            }
        };
        link.execute(params![session_id, id])?;
    }
    Ok(())
}

/// Deterministic, filesystem-safe key for tag/technology ids.
fn stable_key(name: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(name.to_lowercase().as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Insert or replace the FTS row for a session.
pub fn upsert_fts(tx: &Transaction<'_>, doc: &SearchDocument) -> Result<()> {
    // FTS5 has no UPSERT; delete-then-insert via the rowid map.
    let existing: Option<i64> = tx
        .query_row(
            "SELECT rowid_ref FROM fts_map WHERE session_id = ?1",
            params![doc.id],
            |r| r.get(0),
        )
        .optional()?;

    if let Some(rowid) = existing {
        tx.execute("DELETE FROM session_fts WHERE rowid = ?1", params![rowid])?;
    }

    tx.execute(
        "INSERT INTO session_fts (title, project, summary, notes, tags, technologies, body, session_id)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![doc.title, doc.project, doc.summary, doc.notes, doc.tags, doc.technologies, doc.body, doc.id],
    )?;

    let rowid = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO fts_map (session_id, rowid_ref) VALUES (?1, ?2)
         ON CONFLICT(session_id) DO UPDATE SET rowid_ref = excluded.rowid_ref",
        params![doc.id, rowid],
    )?;

    Ok(())
}

/// Patch mutable session fields. `patch` is the JSON object sent by the UI;
/// unknown keys are ignored rather than rejected, so an older backend stays
/// compatible with a newer frontend.
pub fn update_session(
    tx: &Transaction<'_>,
    id: &str,
    patch: &serde_json::Value,
    now: i64,
) -> Result<()> {
    let obj = patch
        .as_object()
        .ok_or_else(|| ArtixError::InvalidInput("patch must be an object".into()))?;

    // Only these columns are user-editable; everything else is derived.
    const EDITABLE: &[(&str, &str)] = &[
        ("title", "title"),
        ("project", "project"),
        ("folder", "folder"),
        ("summary", "summary"),
        ("notes", "notes"),
        ("language", "language"),
        ("status", "status"),
        ("kind", "kind"),
        ("complexity", "complexity"),
        ("importance", "importance"),
    ];

    let mut assignments: Vec<String> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();

    for (json_key, column) in EDITABLE {
        let Some(value) = obj.get(*json_key) else {
            continue;
        };
        assignments.push(format!("{column} = ?{}", values.len() + 1));
        values.push(json_to_sql(value));
    }

    if let Some(pinned) = obj.get("pinned").and_then(|v| v.as_bool()) {
        assignments.push(format!("pinned = ?{}", values.len() + 1));
        values.push(rusqlite::types::Value::Integer(pinned as i64));
    }

    if !assignments.is_empty() {
        assignments.push(format!("updated_at = ?{}", values.len() + 1));
        values.push(rusqlite::types::Value::Integer(now));

        let sql = format!(
            "UPDATE sessions SET {} WHERE id = ?{}",
            assignments.join(", "),
            values.len() + 1
        );
        values.push(rusqlite::types::Value::Text(id.to_string()));

        let changed = tx.execute(&sql, params_from_iter(values.iter()))?;
        if changed == 0 {
            return Err(ArtixError::NotFound(format!("session {id}")));
        }
    }

    if let Some(tags) = obj.get("tags").and_then(|v| v.as_array()) {
        let tags: Vec<String> = tags
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        set_tags(tx, id, &tags)?;
    }
    if let Some(techs) = obj.get("technologies").and_then(|v| v.as_array()) {
        let techs: Vec<String> = techs
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        set_technologies(tx, id, &techs)?;
    }

    Ok(())
}

fn json_to_sql(value: &serde_json::Value) -> rusqlite::types::Value {
    use rusqlite::types::Value;
    match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Integer(*b as i64),
        serde_json::Value::Number(n) => n
            .as_i64()
            .map(Value::Integer)
            .or_else(|| n.as_f64().map(Value::Real))
            .unwrap_or(Value::Null),
        serde_json::Value::String(s) => Value::Text(s.clone()),
        other => Value::Text(other.to_string()),
    }
}

pub fn delete_session(tx: &Transaction<'_>, id: &str) -> Result<()> {
    // Cascades clear messages/artifacts/files/tags/links; FTS needs a hand.
    if let Some(rowid) = tx
        .query_row(
            "SELECT rowid_ref FROM fts_map WHERE session_id = ?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
    {
        tx.execute("DELETE FROM session_fts WHERE rowid = ?1", params![rowid])?;
    }

    let changed = tx.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(ArtixError::NotFound(format!("session {id}")));
    }
    Ok(())
}

pub fn replace_links(tx: &Transaction<'_>, links: &[SessionLink]) -> Result<()> {
    // Manual edges are user data; derived edges are disposable.
    tx.execute("DELETE FROM links WHERE kind != 'manual'", [])?;

    let mut stmt = tx.prepare_cached(
        "INSERT OR REPLACE INTO links (from_id, to_id, kind, weight) VALUES (?1,?2,?3,?4)",
    )?;
    for link in links {
        if link.kind == "manual" {
            continue;
        }
        stmt.execute(params![link.from_id, link.to_id, link.kind, link.weight])?;
    }
    Ok(())
}

/* ------------------------------------------------------------------- reads */

pub fn get_session(conn: &Connection, id: &str) -> Result<SessionDetail> {
    let mut session = conn
        .query_row(
            &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE id = ?1"),
            params![id],
            map_session,
        )
        .optional()?
        .ok_or_else(|| ArtixError::NotFound(format!("session {id}")))?;

    session.tags = load_labels(conn, id, LabelKind::Tag)?;
    session.technologies = load_labels(conn, id, LabelKind::Technology)?;

    let messages = conn
        .prepare(
            "SELECT id, session_id, seq, role, content, created_at, token_estimate, tool_name
             FROM messages WHERE session_id = ?1 ORDER BY seq",
        )?
        .query_map(params![id], |row| {
            Ok(Message {
                id: row.get(0)?,
                session_id: row.get(1)?,
                seq: row.get(2)?,
                role: row.get(3)?,
                content: row.get(4)?,
                created_at: row.get(5)?,
                token_estimate: row.get(6)?,
                tool_name: row.get(7)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let artifacts = conn
        .prepare(
            "SELECT id, session_id, kind, title, language, content, path, message_seq, done
             FROM artifacts WHERE session_id = ?1 ORDER BY kind, rowid",
        )?
        .query_map(params![id], |row| {
            Ok(Artifact {
                id: row.get(0)?,
                session_id: row.get(1)?,
                kind: row.get(2)?,
                title: row.get(3)?,
                language: row.get(4)?,
                content: row.get(5)?,
                path: row.get(6)?,
                message_seq: row.get(7)?,
                done: row.get::<_, i64>(8)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let files = conn
        .prepare(
            "SELECT id, session_id, path, action, language, bytes, snippet
             FROM files WHERE session_id = ?1 ORDER BY path",
        )?
        .query_map(params![id], |row| {
            Ok(FileRef {
                id: row.get(0)?,
                session_id: row.get(1)?,
                path: row.get(2)?,
                action: row.get(3)?,
                language: row.get(4)?,
                bytes: row.get(5)?,
                snippet: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let links = conn
        .prepare(
            "SELECT from_id, to_id, kind, weight FROM links
             WHERE from_id = ?1 OR to_id = ?1
             ORDER BY weight DESC LIMIT 200",
        )?
        .query_map(params![id], |row| {
            Ok(SessionLink {
                from_id: row.get(0)?,
                to_id: row.get(1)?,
                kind: row.get(2)?,
                weight: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(SessionDetail {
        session,
        messages,
        artifacts,
        files,
        links,
    })
}

enum LabelKind {
    Tag,
    Technology,
}

fn load_labels(conn: &Connection, session_id: &str, kind: LabelKind) -> Result<Vec<String>> {
    let sql = match kind {
        LabelKind::Tag => {
            "SELECT t.name FROM tags t
             JOIN session_tags st ON st.tag_id = t.id
             WHERE st.session_id = ?1 ORDER BY t.name"
        }
        LabelKind::Technology => {
            "SELECT k.name FROM technologies k
             JOIN session_technologies sk ON sk.technology_id = k.id
             WHERE sk.session_id = ?1 ORDER BY k.name"
        }
    };
    Ok(conn
        .prepare(sql)?
        .query_map(params![session_id], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?)
}

/// Load sessions matching `filters`, with their tag and technology sets.
///
/// Labels are fetched in two bulk queries rather than per-row subqueries; on a
/// 100k-session library this is the difference between ~200 ms and ~30 s.
pub fn list_sessions(conn: &Connection, filters: &SessionFilters) -> Result<Vec<Session>> {
    let mut wheres: Vec<String> = Vec::new();
    let mut values: Vec<rusqlite::types::Value> = Vec::new();

    macro_rules! bind {
        ($v:expr) => {{
            values.push($v);
            format!("?{}", values.len())
        }};
    }

    if !filters.include_archived && filters.statuses.is_empty() {
        wheres.push("s.status != 'archived'".into());
    }
    if filters.pinned_only {
        wheres.push("s.pinned = 1".into());
    }
    if let Some(from) = filters.from {
        wheres.push(format!(
            "s.started_at >= {}",
            bind!(rusqlite::types::Value::Integer(from))
        ));
    }
    if let Some(to) = filters.to {
        wheres.push(format!(
            "s.started_at <= {}",
            bind!(rusqlite::types::Value::Integer(to))
        ));
    }

    push_in_clause(&mut wheres, &mut values, "s.status", &filters.statuses);
    push_in_clause(&mut wheres, &mut values, "s.language", &filters.languages);
    push_in_clause(&mut wheres, &mut values, "s.project", &filters.projects);

    if !filters.tags.is_empty() {
        let placeholders = bind_list(&mut values, &filters.tags);
        wheres.push(format!(
            "EXISTS (SELECT 1 FROM session_tags st JOIN tags t ON t.id = st.tag_id
                     WHERE st.session_id = s.id AND t.name IN ({placeholders}))"
        ));
    }
    if !filters.technologies.is_empty() {
        let placeholders = bind_list(&mut values, &filters.technologies);
        wheres.push(format!(
            "EXISTS (SELECT 1 FROM session_technologies sk JOIN technologies k ON k.id = sk.technology_id
                     WHERE sk.session_id = s.id AND k.name IN ({placeholders}))"
        ));
    }

    let where_sql = if wheres.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", wheres.join(" AND "))
    };

    let limit = filters.limit.unwrap_or(200_000).clamp(1, 1_000_000);
    let offset = filters.offset.unwrap_or(0).max(0);

    let sql = format!(
        "SELECT {} FROM sessions s {} ORDER BY s.started_at DESC LIMIT {} OFFSET {}",
        SESSION_COLUMNS
            .split(", ")
            .map(|c| format!("s.{c}"))
            .collect::<Vec<_>>()
            .join(", "),
        where_sql,
        limit,
        offset
    );

    let mut sessions = conn
        .prepare(&sql)?
        .query_map(params_from_iter(values.iter()), map_session)?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    attach_labels(conn, &mut sessions)?;
    Ok(sessions)
}

/// Two bulk joins populate every session's labels at once.
fn attach_labels(conn: &Connection, sessions: &mut [Session]) -> Result<()> {
    if sessions.is_empty() {
        return Ok(());
    }

    let mut index = std::collections::HashMap::with_capacity(sessions.len());
    for (i, s) in sessions.iter().enumerate() {
        index.insert(s.id.clone(), i);
    }

    let pairs = |sql: &str| -> Result<Vec<(String, String)>> {
        Ok(conn
            .prepare(sql)?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    };

    for (session_id, name) in
        pairs("SELECT st.session_id, t.name FROM session_tags st JOIN tags t ON t.id = st.tag_id")?
    {
        if let Some(&i) = index.get(&session_id) {
            sessions[i].tags.push(name);
        }
    }

    for (session_id, name) in pairs(
        "SELECT sk.session_id, k.name FROM session_technologies sk
         JOIN technologies k ON k.id = sk.technology_id",
    )? {
        if let Some(&i) = index.get(&session_id) {
            sessions[i].technologies.push(name);
        }
    }

    for s in sessions.iter_mut() {
        s.tags.sort();
        s.technologies.sort();
    }
    Ok(())
}

fn push_in_clause(
    wheres: &mut Vec<String>,
    values: &mut Vec<rusqlite::types::Value>,
    column: &str,
    items: &[String],
) {
    if items.is_empty() {
        return;
    }
    let placeholders = bind_list(values, items);
    wheres.push(format!("{column} IN ({placeholders})"));
}

fn bind_list(values: &mut Vec<rusqlite::types::Value>, items: &[String]) -> String {
    items
        .iter()
        .map(|item| {
            values.push(rusqlite::types::Value::Text(item.clone()));
            format!("?{}", values.len())
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/* ------------------------------------------------------------------ search */

/// Run an FTS5 MATCH and return ids with their raw BM25 scores.
///
/// The weight vector must match `BM25_WEIGHTS` in `src/search/document.ts`.
pub fn fts_search(conn: &Connection, match_expr: &str, limit: i64) -> Result<Vec<FtsHit>> {
    let sql = "SELECT session_id, bm25(session_fts, 10.0, 6.0, 4.0, 4.0, 5.0, 3.0, 1.0) AS score
               FROM session_fts
               WHERE session_fts MATCH ?1
               ORDER BY score
               LIMIT ?2";

    // A malformed MATCH expression is user input, not a storage fault, and
    // SQLite may report it at prepare time *or* at first step depending on the
    // query. Run the whole thing, then classify — attaching `.map_err` to any
    // single call silently misses the other path.
    let run = || -> rusqlite::Result<Vec<FtsHit>> {
        let mut stmt = conn.prepare_cached(sql)?;
        let rows = stmt.query_map(params![match_expr, limit], |row| {
            Ok(FtsHit {
                id: row.get(0)?,
                bm25: row.get(1)?,
            })
        })?;
        rows.collect()
    };

    run().map_err(|e| {
        let message = e.to_string();
        if message.contains("fts5") || message.contains("MATCH") || message.contains("syntax error")
        {
            ArtixError::Parse(format!("invalid search expression: {message}"))
        } else {
            ArtixError::Storage(message)
        }
    })
}

/// Rebuild the entire FTS index from supplied documents. Used after a schema
/// change or when the user asks to reindex.
pub fn rebuild_fts(tx: &Transaction<'_>, docs: &[SearchDocument]) -> Result<usize> {
    tx.execute("DELETE FROM session_fts", [])?;
    tx.execute("DELETE FROM fts_map", [])?;
    for doc in docs {
        upsert_fts(tx, doc)?;
    }
    Ok(docs.len())
}

/* ------------------------------------------------------------ aggregations */

pub fn facets(conn: &Connection) -> Result<Facets> {
    let bucket = |sql: &str| -> Result<Vec<FacetBucket>> {
        Ok(conn
            .prepare(sql)?
            .query_map([], |row| {
                Ok(FacetBucket {
                    value: row.get(0)?,
                    count: row.get(1)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    };

    Ok(Facets {
        languages: bucket(
            "SELECT language, count(*) FROM sessions WHERE language IS NOT NULL
             GROUP BY language ORDER BY count(*) DESC, language",
        )?,
        projects: bucket(
            "SELECT project, count(*) FROM sessions GROUP BY project
             ORDER BY count(*) DESC, project LIMIT 500",
        )?,
        tags: bucket(
            "SELECT t.name, count(*) FROM tags t JOIN session_tags st ON st.tag_id = t.id
             GROUP BY t.name ORDER BY count(*) DESC, t.name LIMIT 500",
        )?,
        technologies: bucket(
            "SELECT k.name, count(*) FROM technologies k
             JOIN session_technologies sk ON sk.technology_id = k.id
             GROUP BY k.name ORDER BY count(*) DESC, k.name LIMIT 500",
        )?,
        statuses: bucket("SELECT status, count(*) FROM sessions GROUP BY status ORDER BY status")?,
    })
}

pub fn stats(conn: &Connection, database_bytes: i64) -> Result<LibraryStats> {
    let scalar = |sql: &str| -> Result<i64> { Ok(conn.query_row(sql, [], |r| r.get(0))?) };

    let (earliest, latest): (Option<i64>, Option<i64>) = conn.query_row(
        "SELECT min(started_at), max(started_at) FROM sessions",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    Ok(LibraryStats {
        session_count: scalar("SELECT count(*) FROM sessions")?,
        message_count: scalar("SELECT count(*) FROM messages")?,
        artifact_count: scalar("SELECT count(*) FROM artifacts")?,
        file_count: scalar("SELECT count(*) FROM files")?,
        project_count: scalar("SELECT count(DISTINCT project) FROM sessions")?,
        token_estimate: scalar("SELECT coalesce(sum(token_estimate), 0) FROM sessions")?,
        earliest,
        latest,
        database_bytes,
    })
}

/// Every session's search document, streamed for reindexing and export.
pub fn all_content_hashes(conn: &Connection) -> Result<Vec<String>> {
    Ok(conn
        .prepare("SELECT content_hash FROM sessions")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Ids of sessions that touched a given file — powers "what else edited this?".
pub fn sessions_for_path(conn: &Connection, path: &str, limit: i64) -> Result<Vec<String>> {
    Ok(conn
        .prepare(
            "SELECT DISTINCT f.session_id FROM files f
             JOIN sessions s ON s.id = f.session_id
             WHERE f.path = ?1 ORDER BY s.started_at DESC LIMIT ?2",
        )?
        .query_map(params![path, limit], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/* --------------------------------------------------------------- key/value */

pub fn kv_get(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM kv WHERE key = ?1", params![key], |r| {
            r.get(0)
        })
        .optional()?)
}

pub fn kv_set(conn: &Connection, key: &str, value: &str, now: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now],
    )?;
    Ok(())
}

pub fn kv_delete(conn: &Connection, key: &str) -> Result<()> {
    conn.execute("DELETE FROM kv WHERE key = ?1", params![key])?;
    Ok(())
}
