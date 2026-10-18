//! Application-wide error type.
//!
//! Internal modules return [`AppResult<T>`] so errors keep their structure
//! (and `?` works across io, git2, and notify). The Tauri command layer turns
//! them into `String` via the `From` impl below, so the frontend always gets a
//! readable message.

use std::path::{Path, PathBuf};

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("“{0}” can't be a tag. Use letters, numbers, - _ and /, and start with a letter")]
    InvalidTag(String),

    #[error("“{0}” changed since, so nothing was linked. Look again")]
    MentionsMoved(String),

    #[error("no vault is open")]
    NoVault,

    #[error("vault folder does not exist: {}", .0.display())]
    VaultNotFound(PathBuf),

    #[error("invalid note path '{path}': {reason}")]
    InvalidPath { path: String, reason: &'static str },

    #[error("'{0}' already exists")]
    AlreadyExists(String),

    #[error("'{0}' doesn't exist")]
    NotFound(String),

    #[error("couldn't move '{0}' to the Recycle Bin: {1}")]
    Trash(String, String),

    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },

    #[error("git: {}", .0.message())]
    Git(#[from] git2::Error),

    #[error("no remote named '{0}' is configured")]
    NoRemote(String),

    #[error("HEAD is detached; check out a branch before syncing")]
    DetachedHead,

    #[error("repository is in the middle of a {0}; finish or abort it first")]
    RepoBusy(String),

    #[error("pull would conflict in: {}. Resolve manually, then sync again", .0.join(", "))]
    MergeConflict(Vec<String>),

    #[error("there's no paused sync to finish")]
    NotMerging,

    #[error("{} still {} both versions. Pick what to keep first", .0.join(", "), if .0.len() == 1 { "has" } else { "have" })]
    ChoicesLeft(Vec<String>),

    #[error("push rejected for {refname}: {reason}")]
    PushRejected { refname: String, reason: String },

    #[error("file watcher: {0}")]
    Watch(#[from] notify_debouncer_mini::notify::Error),
}

/// Lets Tauri commands declared as `Result<T, String>` use `?` on `AppResult`.
impl From<AppError> for String {
    fn from(err: AppError) -> Self {
        err.to_string()
    }
}

/// Attach the action and path to an `io::Error`, e.g. "reading 'notes/a.md': access denied".
pub trait IoContext<T> {
    fn ctx(self, action: &str, path: &Path) -> AppResult<T>;
}

impl<T> IoContext<T> for std::io::Result<T> {
    fn ctx(self, action: &str, path: &Path) -> AppResult<T> {
        self.map_err(|source| AppError::Io {
            context: format!("{action} '{}'", path.display()),
            source,
        })
    }
}
