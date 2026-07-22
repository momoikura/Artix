//! Error type shared by every Tauri command.
//!
//! Serialises to the same `{ code, message, hint }` shape that
//! `src/core/result.ts` expects, so the frontend never has to guess what an
//! IPC rejection means.

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum ArtixError {
    #[error("{0}")]
    Storage(String),

    #[error("{0}")]
    NotFound(String),

    #[error("{0}")]
    Duplicate(String),

    #[error("{0}")]
    InvalidInput(String),

    #[error("{0}")]
    Parse(String),

    #[error("{0}")]
    Io(String),

    #[error("{0}")]
    Unsupported(String),
}

impl ArtixError {
    fn code(&self) -> &'static str {
        match self {
            Self::Storage(_) => "storage",
            Self::NotFound(_) => "not-found",
            Self::Duplicate(_) => "duplicate",
            Self::InvalidInput(_) => "invalid-input",
            Self::Parse(_) => "parse",
            Self::Io(_) => "io",
            Self::Unsupported(_) => "unsupported",
        }
    }

    /// A concrete next step the UI can show verbatim.
    fn hint(&self) -> Option<&'static str> {
        match self {
            Self::Duplicate(_) => Some("This session is already in your library."),
            Self::NotFound(_) => Some("It may have been deleted since the view was loaded."),
            Self::Parse(_) => Some("Check that the file is a supported export format."),
            _ => None,
        }
    }
}

#[derive(Serialize)]
struct SerializedError<'a> {
    code: &'a str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<&'a str>,
}

impl Serialize for ArtixError {
    // `std::result::Result` spelled out: the `Result<T>` alias below shadows the
    // std type in this module and would silently take only one parameter here.
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        SerializedError {
            code: self.code(),
            message: self.to_string(),
            hint: self.hint(),
        }
        .serialize(serializer)
    }
}

impl From<rusqlite::Error> for ArtixError {
    fn from(e: rusqlite::Error) -> Self {
        // A UNIQUE violation on `content_hash` is the dedupe path, not a bug.
        if let rusqlite::Error::SqliteFailure(err, _) = &e {
            if err.code == rusqlite::ErrorCode::ConstraintViolation {
                return Self::Duplicate(e.to_string());
            }
        }
        Self::Storage(e.to_string())
    }
}

impl From<std::io::Error> for ArtixError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

impl From<serde_json::Error> for ArtixError {
    fn from(e: serde_json::Error) -> Self {
        Self::Parse(e.to_string())
    }
}

impl From<zip::result::ZipError> for ArtixError {
    fn from(e: zip::result::ZipError) -> Self {
        Self::Io(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, ArtixError>;
