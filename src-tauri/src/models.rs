//! Wire types.
//!
//! These mirror `src/core/types.ts` exactly. `#[serde(rename_all = "camelCase")]`
//! is what bridges Rust's snake_case to the TypeScript domain model, so the
//! frontend never performs key translation.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub project: String,
    pub folder: Option<String>,
    pub summary: String,
    pub notes: String,
    pub language: Option<String>,
    pub status: String,
    pub kind: String,
    pub complexity: f64,
    pub importance: f64,
    pub pinned: bool,
    pub source: String,
    pub source_ref: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub updated_at: i64,
    pub imported_at: i64,
    pub message_count: i64,
    pub file_count: i64,
    pub artifact_count: i64,
    pub token_estimate: i64,
    pub content_hash: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub technologies: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub role: String,
    pub content: String,
    pub created_at: Option<i64>,
    pub token_estimate: i64,
    pub tool_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub session_id: String,
    pub kind: String,
    pub title: String,
    pub language: Option<String>,
    pub content: String,
    pub path: Option<String>,
    pub message_seq: Option<i64>,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub id: String,
    pub session_id: String,
    pub path: String,
    pub action: String,
    pub language: Option<String>,
    pub bytes: i64,
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLink {
    pub from_id: String,
    pub to_id: String,
    pub kind: String,
    pub weight: f64,
}

/// The full aggregate written by `save_session` and read by `get_session`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session: Session,
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
    #[serde(default)]
    pub files: Vec<FileRef>,
    #[serde(default)]
    pub links: Vec<SessionLink>,
}

/// The pre-built search document handed down from TypeScript. Keeping document
/// construction in TS means the FTS index and the in-memory index can never
/// disagree about what "body" contains.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDocument {
    pub id: String,
    pub title: String,
    pub project: String,
    pub summary: String,
    pub notes: String,
    pub tags: String,
    pub technologies: String,
    pub body: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFilters {
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub technologies: Vec<String>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub statuses: Vec<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub pinned_only: bool,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// One FTS hit: the session id plus SQLite's raw (negative) BM25 score.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FtsHit {
    pub id: String,
    pub bm25: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetBucket {
    pub value: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facets {
    pub languages: Vec<FacetBucket>,
    pub projects: Vec<FacetBucket>,
    pub tags: Vec<FacetBucket>,
    pub technologies: Vec<FacetBucket>,
    pub statuses: Vec<FacetBucket>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStats {
    pub session_count: i64,
    pub message_count: i64,
    pub artifact_count: i64,
    pub file_count: i64,
    pub project_count: i64,
    pub token_estimate: i64,
    pub earliest: Option<i64>,
    pub latest: Option<i64>,
    pub database_bytes: i64,
}

/// Result of a bulk import — the UI reports both halves.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub imported: Vec<String>,
    pub duplicates: Vec<String>,
    pub failed: Vec<ImportFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub reference: String,
    pub message: String,
}

/// A file discovered on disk, handed to TypeScript for parsing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredFile {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub modified_at: i64,
}
