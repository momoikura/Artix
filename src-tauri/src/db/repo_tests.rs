//! Storage-layer tests.
//!
//! These exercise the real SQL against an in-memory database: FTS5 ranking and
//! operators, cascade behaviour, dedupe, parameterisation, and the exact error
//! shape the TypeScript layer branches on.
//!
//! NOTE for `x86_64-pc-windows-gnu`: the test binary links the whole Tauri
//! stack and needs `WebView2Loader.dll` plus the MinGW runtime beside it. On
//! the MSVC target (what Artix ships) `cargo test` just works. See
//! `docs/INSTALL.md`.

use super::{repo, Database, SCHEMA_VERSION};
use crate::error::ArtixError;
use crate::models::*;

/* ----------------------------------------------------------- fixtures */

fn doc(id: &str, title: &str, body: &str) -> SearchDocument {
    SearchDocument {
        id: id.into(),
        title: title.into(),
        project: "artix".into(),
        summary: "a summary".into(),
        notes: String::new(),
        tags: "graphics perf".into(),
        technologies: "Three.js React".into(),
        body: body.into(),
    }
}

fn detail(id: &str, title: &str, hash: &str, started: i64) -> SessionDetail {
    SessionDetail {
        session: Session {
            id: id.into(),
            title: title.into(),
            project: "artix".into(),
            folder: Some("/home/dev/artix".into()),
            summary: "a summary".into(),
            notes: String::new(),
            language: Some("typescript".into()),
            status: "completed".into(),
            kind: "star".into(),
            complexity: 0.5,
            importance: 0.6,
            pinned: false,
            source: "test".into(),
            source_ref: Some("test://x".into()),
            started_at: started,
            ended_at: Some(started + 3_600_000),
            updated_at: started,
            imported_at: started,
            message_count: 2,
            file_count: 1,
            artifact_count: 2,
            token_estimate: 400,
            content_hash: hash.into(),
            tags: vec!["graphics".into(), "perf".into()],
            technologies: vec!["Three.js".into(), "React".into()],
        },
        messages: vec![
            Message {
                id: format!("{id}-m0"),
                session_id: id.into(),
                seq: 0,
                role: "user".into(),
                content: "the galaxy stutters".into(),
                created_at: Some(started),
                token_estimate: 10,
                tool_name: None,
            },
            Message {
                id: format!("{id}-m1"),
                session_id: id.into(),
                seq: 1,
                role: "assistant".into(),
                content: "clamping dt fixes it".into(),
                created_at: Some(started + 1000),
                token_estimate: 10,
                tool_name: None,
            },
        ],
        artifacts: vec![
            Artifact {
                id: format!("{id}-a0"),
                session_id: id.into(),
                kind: "decision".into(),
                title: "Clamp dt".into(),
                language: None,
                content: "Clamp dt because a stalled tab yields a huge delta.".into(),
                path: None,
                message_seq: Some(1),
                done: false,
            },
            Artifact {
                id: format!("{id}-a1"),
                session_id: id.into(),
                kind: "todo".into(),
                title: "Verify on 144Hz".into(),
                language: None,
                content: "Verify on 144Hz".into(),
                path: None,
                message_seq: None,
                done: false,
            },
        ],
        files: vec![FileRef {
            id: format!("{id}-f0"),
            session_id: id.into(),
            path: "src/renderer/loop.ts".into(),
            action: "modified".into(),
            language: Some("typescript".into()),
            bytes: 120,
            snippet: None,
        }],
        links: vec![],
    }
}

fn db() -> Database {
    Database::open_in_memory().expect("open in-memory db")
}

/* -------------------------------------------------------------- schema */

#[test]
fn migrates_to_current_schema_version() {
    let db = db();
    db.with(|c| {
        let v: i32 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        assert_eq!(v, SCHEMA_VERSION);
        Ok(())
    })
    .unwrap();
}

/* ------------------------------------------------------------ round trip */

#[test]
fn insert_read_roundtrip() {
    let db = db();
    let d = detail("S1", "Fix the render loop", "hash-1", 1_700_000_000_000);

    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &d,
            &doc("S1", "Fix the render loop", "instanced points"),
        )
    })
    .expect("insert");

    let loaded = db.with(|c| repo::get_session(c, "S1")).expect("get");
    assert_eq!(loaded.session.title, "Fix the render loop");
    assert_eq!(loaded.messages.len(), 2);
    assert_eq!(loaded.artifacts.len(), 2);
    assert_eq!(loaded.files.len(), 1);
    // Labels come back through the join tables, sorted.
    assert_eq!(loaded.session.tags, vec!["graphics", "perf"]);
    assert_eq!(loaded.session.technologies, vec!["React", "Three.js"]);
}

#[test]
fn duplicate_content_hash_is_rejected() {
    let db = db();
    let a = detail("S1", "One", "same-hash", 1_700_000_000_000);
    let b = detail("S2", "Two", "same-hash", 1_700_000_100_000);

    db.transaction(|tx| repo::insert_session(tx, &a, &doc("S1", "One", "x")))
        .unwrap();
    let err = db.transaction(|tx| repo::insert_session(tx, &b, &doc("S2", "Two", "y")));

    assert!(
        matches!(err, Err(ArtixError::Duplicate(_))),
        "expected Duplicate, got {err:?}"
    );
}

/* --------------------------------------------------------------- search */

#[test]
fn fts_search_matches_ranks_and_supports_operators() {
    let db = db();
    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &detail("S1", "Galaxy renderer instancing", "h1", 1_700_000_000_000),
            &doc(
                "S1",
                "Galaxy renderer instancing",
                "instanced points shader",
            ),
        )?;
        repo::insert_session(
            tx,
            &detail("S2", "Database migrations", "h2", 1_700_000_100_000),
            &doc("S2", "Database migrations", "sql tables schema"),
        )?;
        Ok(())
    })
    .unwrap();

    let hits = db.with(|c| repo::fts_search(c, "\"galaxy\"", 10)).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "S1");
    // bm25 is negative; more negative is a better match.
    assert!(
        hits[0].bm25 < 0.0,
        "bm25 should be negative, got {}",
        hits[0].bm25
    );

    // The prefix form the query builder emits.
    assert_eq!(
        db.with(|c| repo::fts_search(c, "\"instanc\" *", 10))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        db.with(|c| repo::fts_search(c, "\"galaxy\" AND \"shader\"", 10))
            .unwrap()
            .len(),
        1
    );

    let negated = db
        .with(|c| repo::fts_search(c, "\"artix\" NOT \"galaxy\"", 10))
        .unwrap();
    assert_eq!(negated.len(), 1);
    assert_eq!(negated[0].id, "S2");
}

/// Regression: FTS5 reports a bad MATCH at *prepare* time, so classifying the
/// error on `query_map` alone silently mislabelled user typos as storage faults.
#[test]
fn malformed_fts_expression_is_a_parse_error() {
    let db = db();
    let result = db.with(|c| repo::fts_search(c, "AND AND (", 10));
    assert!(
        matches!(result, Err(ArtixError::Parse(_))),
        "got {result:?}"
    );
}

#[test]
fn reindexed_session_is_findable_under_its_new_title() {
    let db = db();
    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &detail("S1", "Before", "h1", 1_700_000_000_000),
            &doc("S1", "Before", "x"),
        )
    })
    .unwrap();

    db.transaction(|tx| repo::upsert_fts(tx, &doc("S1", "Zephyr protocol", "x")))
        .unwrap();

    assert_eq!(
        db.with(|c| repo::fts_search(c, "\"zephyr\"", 10))
            .unwrap()
            .len(),
        1
    );
    // The stale row must be deleted, not merely shadowed.
    assert_eq!(
        db.with(|c| repo::fts_search(c, "\"before\"", 10))
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn rebuild_fts_replaces_the_whole_index() {
    let db = db();
    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &detail("S1", "A", "h1", 1_700_000_100_000),
            &doc("S1", "A", "galaxy"),
        )
    })
    .unwrap();

    assert_eq!(
        db.transaction(|tx| repo::rebuild_fts(tx, &[doc("S1", "Rebuilt", "nebula")]))
            .unwrap(),
        1
    );
    assert_eq!(
        db.with(|c| repo::fts_search(c, "\"nebula\"", 10))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        db.with(|c| repo::fts_search(c, "\"galaxy\"", 10))
            .unwrap()
            .len(),
        0
    );
}

/* --------------------------------------------------------------- updates */

#[test]
fn update_patches_only_editable_columns() {
    let db = db();
    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &detail("S1", "Before", "h1", 1_700_000_000_000),
            &doc("S1", "Before", "x"),
        )
    })
    .unwrap();

    let patch = serde_json::json!({
        "title": "After",
        "status": "archived",
        "pinned": true,
        "tags": ["renamed"],
        "contentHash": "attempt-to-overwrite"
    });
    db.transaction(|tx| repo::update_session(tx, "S1", &patch, 1_700_000_500_000))
        .unwrap();

    let loaded = db.with(|c| repo::get_session(c, "S1")).unwrap();
    assert_eq!(loaded.session.title, "After");
    assert_eq!(loaded.session.status, "archived");
    assert!(loaded.session.pinned);
    assert_eq!(loaded.session.tags, vec!["renamed"]);
    // Derived / identity columns are not user-editable.
    assert_eq!(loaded.session.content_hash, "h1");
}

#[test]
fn update_missing_session_reports_not_found() {
    let db = db();
    let patch = serde_json::json!({ "title": "nope" });
    let r = db.transaction(|tx| repo::update_session(tx, "ghost", &patch, 0));
    assert!(matches!(r, Err(ArtixError::NotFound(_))), "got {r:?}");
}

#[test]
fn delete_cascades_and_clears_fts() {
    let db = db();
    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &detail("S1", "Doomed", "h1", 1_700_000_000_000),
            &doc("S1", "Doomed", "galaxy"),
        )
    })
    .unwrap();

    db.transaction(|tx| repo::delete_session(tx, "S1")).unwrap();

    db.with(|c| {
        for table in [
            "messages",
            "artifacts",
            "files",
            "session_tags",
            "session_technologies",
        ] {
            let n: i64 = c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))?;
            assert_eq!(n, 0, "{table} was not cascaded");
        }
        let fts: i64 = c.query_row("SELECT count(*) FROM session_fts", [], |r| r.get(0))?;
        assert_eq!(fts, 0, "FTS row leaked after delete");
        Ok(())
    })
    .unwrap();

    assert!(matches!(
        db.transaction(|tx| repo::delete_session(tx, "S1")),
        Err(ArtixError::NotFound(_))
    ));
}

/* --------------------------------------------------------------- listing */

#[test]
fn list_sessions_filters_and_orders() {
    let db = db();
    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &detail("S1", "Newest", "h1", 1_700_000_300_000),
            &doc("S1", "Newest", "x"),
        )?;
        repo::insert_session(
            tx,
            &detail("S2", "Oldest", "h2", 1_700_000_100_000),
            &doc("S2", "Oldest", "x"),
        )?;
        let mut archived = detail("S3", "Archived", "h3", 1_700_000_200_000);
        archived.session.status = "archived".into();
        repo::insert_session(tx, &archived, &doc("S3", "Archived", "x"))?;
        Ok(())
    })
    .unwrap();

    let list = db
        .with(|c| repo::list_sessions(c, &SessionFilters::default()))
        .unwrap();
    assert_eq!(
        list.iter().map(|s| s.title.as_str()).collect::<Vec<_>>(),
        vec!["Newest", "Oldest"]
    );
    // Labels are attached by the bulk join, not a per-row subquery.
    assert_eq!(list[0].tags, vec!["graphics", "perf"]);

    let all = db
        .with(|c| {
            repo::list_sessions(
                c,
                &SessionFilters {
                    include_archived: true,
                    ..Default::default()
                },
            )
        })
        .unwrap();
    assert_eq!(all.len(), 3);

    let by_tag = db
        .with(|c| {
            repo::list_sessions(
                c,
                &SessionFilters {
                    tags: vec!["graphics".into()],
                    ..Default::default()
                },
            )
        })
        .unwrap();
    assert_eq!(by_tag.len(), 2);

    let by_tech = db
        .with(|c| {
            repo::list_sessions(
                c,
                &SessionFilters {
                    technologies: vec!["React".into()],
                    ..Default::default()
                },
            )
        })
        .unwrap();
    assert_eq!(by_tech.len(), 2);

    let ranged = db
        .with(|c| {
            repo::list_sessions(
                c,
                &SessionFilters {
                    from: Some(1_700_000_250_000),
                    ..Default::default()
                },
            )
        })
        .unwrap();
    assert_eq!(ranged.len(), 1);
    assert_eq!(ranged[0].title, "Newest");
}

/// `list_sessions` builds SQL by string concatenation for its IN clauses, so
/// this pins that every user value still goes through a bound parameter.
#[test]
fn filters_are_parameterised_against_injection() {
    let db = db();
    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &detail("S1", "Safe", "h1", 1_700_000_000_000),
            &doc("S1", "Safe", "x"),
        )
    })
    .unwrap();

    let hostile = SessionFilters {
        projects: vec!["artix'; DROP TABLE sessions; --".into()],
        ..Default::default()
    };
    assert_eq!(
        db.with(|c| repo::list_sessions(c, &hostile)).unwrap().len(),
        0
    );

    let n = db
        .with(|c| Ok(c.query_row::<i64, _, _>("SELECT count(*) FROM sessions", [], |r| r.get(0))?))
        .unwrap();
    assert_eq!(n, 1, "sessions table was dropped");
}

/* ---------------------------------------------------------- aggregation */

#[test]
fn facets_and_stats_aggregate() {
    let db = db();
    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &detail("S1", "A", "h1", 1_700_000_100_000),
            &doc("S1", "A", "x"),
        )?;
        let mut other = detail("S2", "B", "h2", 1_700_000_200_000);
        other.session.project = "orbital".into();
        other.session.language = Some("rust".into());
        repo::insert_session(tx, &other, &doc("S2", "B", "x"))?;
        Ok(())
    })
    .unwrap();

    let f = db.with(repo::facets).unwrap();
    assert_eq!(f.languages.len(), 2);
    assert_eq!(f.projects.len(), 2);
    assert!(f.tags.iter().any(|b| b.value == "graphics" && b.count == 2));

    let s = db.with(|c| repo::stats(c, 0)).unwrap();
    assert_eq!(s.session_count, 2);
    assert_eq!(s.project_count, 2);
    assert_eq!(s.message_count, 4);
    assert_eq!(s.earliest, Some(1_700_000_100_000));
    assert_eq!(s.latest, Some(1_700_000_200_000));
}

#[test]
fn stats_on_an_empty_library_does_not_fail() {
    let db = db();
    let s = db.with(|c| repo::stats(c, 0)).unwrap();
    assert_eq!(s.session_count, 0);
    assert_eq!(s.earliest, None);
}

#[test]
fn sessions_for_path_finds_shared_files_newest_first() {
    let db = db();
    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &detail("S1", "A", "h1", 1_700_000_100_000),
            &doc("S1", "A", "x"),
        )?;
        repo::insert_session(
            tx,
            &detail("S2", "B", "h2", 1_700_000_200_000),
            &doc("S2", "B", "x"),
        )?;
        Ok(())
    })
    .unwrap();

    let ids = db
        .with(|c| repo::sessions_for_path(c, "src/renderer/loop.ts", 10))
        .unwrap();
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0], "S2");
}

#[test]
fn content_hashes_are_listed_for_dedupe() {
    let db = db();
    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &detail("S1", "A", "h1", 1_700_000_100_000),
            &doc("S1", "A", "x"),
        )?;
        repo::insert_session(
            tx,
            &detail("S2", "B", "h2", 1_700_000_200_000),
            &doc("S2", "B", "x"),
        )?;
        Ok(())
    })
    .unwrap();

    let mut hashes = db.with(repo::all_content_hashes).unwrap();
    hashes.sort();
    assert_eq!(hashes, vec!["h1", "h2"]);
}

/* --------------------------------------------------------------- links */

#[test]
fn replace_links_preserves_manual_edges() {
    let db = db();
    db.transaction(|tx| {
        repo::insert_session(
            tx,
            &detail("S1", "A", "h1", 1_700_000_100_000),
            &doc("S1", "A", "x"),
        )?;
        repo::insert_session(
            tx,
            &detail("S2", "B", "h2", 1_700_000_200_000),
            &doc("S2", "B", "x"),
        )?;
        tx.execute(
            "INSERT INTO links (from_id, to_id, kind, weight) VALUES ('S1','S2','manual',1.0)",
            [],
        )?;
        Ok(())
    })
    .unwrap();

    db.transaction(|tx| {
        repo::replace_links(
            tx,
            &[SessionLink {
                from_id: "S1".into(),
                to_id: "S2".into(),
                kind: "shared-files".into(),
                weight: 0.8,
            }],
        )
    })
    .unwrap();

    db.with(|c| {
        let manual: i64 =
            c.query_row("SELECT count(*) FROM links WHERE kind='manual'", [], |r| {
                r.get(0)
            })?;
        let derived: i64 = c.query_row(
            "SELECT count(*) FROM links WHERE kind='shared-files'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(manual, 1, "manual edge was destroyed by a rebuild");
        assert_eq!(derived, 1);
        Ok(())
    })
    .unwrap();
}

/* ----------------------------------------------------------- key/value */

#[test]
fn kv_roundtrip() {
    let db = db();
    db.with(|c| repo::kv_set(c, "settings", "{\"theme\":\"void\"}", 1))
        .unwrap();
    assert_eq!(
        db.with(|c| repo::kv_get(c, "settings")).unwrap(),
        Some("{\"theme\":\"void\"}".into())
    );

    db.with(|c| repo::kv_set(c, "settings", "{\"theme\":\"deep-space\"}", 2))
        .unwrap();
    assert_eq!(
        db.with(|c| repo::kv_get(c, "settings")).unwrap(),
        Some("{\"theme\":\"deep-space\"}".into())
    );

    db.with(|c| repo::kv_delete(c, "settings")).unwrap();
    assert_eq!(db.with(|c| repo::kv_get(c, "settings")).unwrap(), None);
    assert_eq!(db.with(|c| repo::kv_get(c, "never-set")).unwrap(), None);
}

/* ----------------------------------------------------------- wire shape */

/// The frontend branches on `code`, so this pins the serialised error shape.
#[test]
fn error_serialises_to_the_shape_typescript_expects() {
    let json = serde_json::to_value(ArtixError::Duplicate("S1".into())).unwrap();
    assert_eq!(json["code"], "duplicate");
    assert!(json["hint"].is_string());

    let storage = serde_json::to_value(ArtixError::Storage("boom".into())).unwrap();
    assert_eq!(storage["code"], "storage");
    assert_eq!(storage["message"], "boom");
    // `hint` is omitted, not null, when absent.
    assert!(storage.get("hint").is_none());
}
