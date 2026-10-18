//! Filesystem watcher. Tells the frontend when files in the vault change on
//! disk (another editor, a git pull, a cloud-sync client) so the tree and the
//! open note stay current.
//!
//! `notify-debouncer-mini` merges bursts of OS events (one save is often
//! several writes plus a rename) into one batch per window.

use std::path::Path;
use std::time::Duration;

use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::AppResult;
use crate::vault;

/// Event name the frontend subscribes to (see `onVaultChanged` in src/services/tauri.ts).
pub const VAULT_CHANGED: &str = "vault:changed";
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Watching stops when this handle is dropped.
pub type VaultWatcher = Debouncer<RecommendedWatcher>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultChanged {
    /// Vault-relative `/` paths that were created, modified, or deleted.
    pub paths: Vec<String>,
}

/// Start watching `root` recursively and emit [`VAULT_CHANGED`] for each batch.
pub fn watch(app: AppHandle, root: &Path) -> AppResult<VaultWatcher> {
    let vault_root = root.to_path_buf();

    let mut debouncer = new_debouncer(DEBOUNCE, move |result: DebounceEventResult| {
        let events = match result {
            Ok(events) => events,
            Err(err) => {
                eprintln!("[watcher] {err}");
                return;
            }
        };

        let mut paths: Vec<String> = events
            .into_iter()
            .filter_map(|event| vault::to_relative(&vault_root, &event.path))
            // Skip the root itself, `.git/` internals, dotfiles, and our temp files.
            .filter(|rel| !rel.is_empty() && !rel.split('/').any(|seg| seg.starts_with('.')))
            .collect();
        paths.sort_unstable();
        paths.dedup();

        if !paths.is_empty()
            && let Err(err) = app.emit(VAULT_CHANGED, VaultChanged { paths })
        {
            eprintln!("[watcher] failed to emit event: {err}");
        }
    })?;

    debouncer.watcher().watch(root, RecursiveMode::Recursive)?;
    Ok(debouncer)
}
