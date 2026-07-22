-- Artix schema, migration 001.
--
-- Design notes:
--  * Every timestamp is INTEGER epoch milliseconds, UTC. No TEXT dates.
--  * `sessions` carries denormalised counters so the galaxy can be rendered
--    from a single indexed scan with zero joins — this is what makes 100k
--    sessions load in one query.
--  * Full-text lives in a standalone (contentless-style) FTS5 table maintained
--    by the application rather than by triggers, because the indexed `body`
--    aggregates messages, artifacts and file paths and is size-capped.
--  * Foreign keys cascade so deleting a session cannot orphan rows.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
    id              TEXT    PRIMARY KEY,
    title           TEXT    NOT NULL,
    project         TEXT    NOT NULL DEFAULT 'Unsorted',
    folder          TEXT,
    summary         TEXT    NOT NULL DEFAULT '',
    notes           TEXT    NOT NULL DEFAULT '',
    language        TEXT,
    status          TEXT    NOT NULL DEFAULT 'completed'
                            CHECK (status IN ('active','completed','paused','archived')),
    kind            TEXT    NOT NULL DEFAULT 'planet'
                            CHECK (kind IN ('star','planet','asteroid')),
    complexity      REAL    NOT NULL DEFAULT 0 CHECK (complexity BETWEEN 0 AND 1),
    importance      REAL    NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 1),
    pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
    source          TEXT    NOT NULL DEFAULT 'unknown',
    source_ref      TEXT,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    updated_at      INTEGER NOT NULL,
    imported_at     INTEGER NOT NULL,
    message_count   INTEGER NOT NULL DEFAULT 0,
    file_count      INTEGER NOT NULL DEFAULT 0,
    artifact_count  INTEGER NOT NULL DEFAULT 0,
    token_estimate  INTEGER NOT NULL DEFAULT 0,
    content_hash    TEXT    NOT NULL UNIQUE
);

-- The galaxy sorts by time and filters by project/language constantly.
CREATE INDEX IF NOT EXISTS idx_sessions_started   ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project   ON sessions(project, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_language  ON sessions(language) WHERE language IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_status    ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_pinned    ON sessions(pinned) WHERE pinned = 1;
CREATE INDEX IF NOT EXISTS idx_sessions_updated   ON sessions(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT    PRIMARY KEY,
    session_id      TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    role            TEXT    NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content         TEXT    NOT NULL,
    created_at      INTEGER,
    token_estimate  INTEGER NOT NULL DEFAULT 0,
    tool_name       TEXT,
    UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS artifacts (
    id           TEXT    PRIMARY KEY,
    session_id   TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind         TEXT    NOT NULL
                         CHECK (kind IN ('code','architecture','decision','todo','command','note')),
    title        TEXT    NOT NULL,
    language     TEXT,
    content      TEXT    NOT NULL,
    path         TEXT,
    message_seq  INTEGER,
    done         INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, kind);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind    ON artifacts(kind);

CREATE TABLE IF NOT EXISTS files (
    id          TEXT    PRIMARY KEY,
    session_id  TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    path        TEXT    NOT NULL,
    action      TEXT    NOT NULL
                        CHECK (action IN ('created','modified','deleted','read','referenced')),
    language    TEXT,
    bytes       INTEGER NOT NULL DEFAULT -1,
    snippet     TEXT,
    UNIQUE (session_id, path)
);

CREATE INDEX IF NOT EXISTS idx_files_session ON files(session_id);
-- "which sessions touched this file?" is a first-class question.
CREATE INDEX IF NOT EXISTS idx_files_path    ON files(path);

CREATE TABLE IF NOT EXISTS tags (
    id     TEXT PRIMARY KEY,
    name   TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color  TEXT
);

CREATE TABLE IF NOT EXISTS session_tags (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag_id);

CREATE TABLE IF NOT EXISTS technologies (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS session_technologies (
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    technology_id TEXT NOT NULL REFERENCES technologies(id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, technology_id)
);

CREATE INDEX IF NOT EXISTS idx_session_tech_tech ON session_technologies(technology_id);

-- Knowledge-graph edges. Recomputed in bulk; never hand-edited except for
-- kind = 'manual', which `rebuild_links` preserves.
CREATE TABLE IF NOT EXISTS links (
    from_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    to_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL
                 CHECK (kind IN ('same-project','shared-files','shared-tech','continuation','manual')),
    weight  REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (from_id, to_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);

-- JSON blob store for settings, plugin config and saved views.
CREATE TABLE IF NOT EXISTS kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Full-text index. Column order MUST match SEARCH_FIELDS in
-- src/search/document.ts, because bm25() weights are positional.
CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
    title,
    project,
    summary,
    notes,
    tags,
    technologies,
    body,
    session_id UNINDEXED,
    tokenize = 'unicode61 remove_diacritics 2'
);

-- Maps FTS rowids back to sessions without scanning the virtual table.
CREATE TABLE IF NOT EXISTS fts_map (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    rowid_ref  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fts_map_rowid ON fts_map(rowid_ref);
