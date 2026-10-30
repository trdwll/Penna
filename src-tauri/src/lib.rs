//! Penna backend: Tauri setup and the IPC command layer.
//!
//! Commands stay thin. Each one validates input, takes what it needs from
//! [`AppState`], and runs the actual work on tokio's blocking pool via
//! [`blocking`], so file crawls and git network calls never stall the
//! async runtime or the UI. Errors reach the frontend as plain strings.

mod attachments;
mod error;
mod export;
mod git;
mod links;
mod mentions;
mod order;
mod search;
mod tags;
mod vault;
mod watcher;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};
use crate::git::{
    CommitInfo, GitStatus, HistoryPage, MergeState, NoteBase, NoteHistory, PullOutcome,
    SyncOutcome, VersionDetail,
};
use crate::vault::{
    AttachmentUse, Backlink, FolderContents, HeadingRef, NoteFile, NoteStamp, RenameOutcome,
    TreeNode,
};

/// Every command returns this; `String` is the error message shown in the UI.
type CmdResult<T> = Result<T, String>;

const DEFAULT_COMMIT_MESSAGE: &str = "Update notes";

#[derive(Default)]
struct AppState {
    /// Absolute path of the open vault; `None` until the user picks one.
    vault_root: Mutex<Option<PathBuf>>,
    /// Keeps the filesystem watcher alive. Replacing it stops the old one.
    watcher: Mutex<Option<watcher::VaultWatcher>>,
    /// Serializes git operations that write, so two commands never race on
    /// `.git/index.lock` (e.g. an auto-commit firing during a manual sync).
    /// This is a tokio mutex because it is held across `.await`.
    git_lock: tokio::sync::Mutex<()>,
}

impl AppState {
    fn root(&self) -> AppResult<PathBuf> {
        lock(&self.vault_root).clone().ok_or(AppError::NoVault)
    }
}

/// Lock a std mutex, recovering from poisoning. The guarded values (a path, a
/// watcher handle) are always written in one step, so a panic elsewhere
/// can't leave them half-updated.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Run blocking work (disk, libgit2, network) on tokio's blocking thread pool.
async fn blocking<T, F>(task: F) -> CmdResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(task)
        .await
        .map_err(|err| format!("background task failed: {err}"))?
        .map_err(String::from)
}

fn commit_message(message: String) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        DEFAULT_COMMIT_MESSAGE.to_owned()
    } else {
        trimmed.to_owned()
    }
}

// ---------------------------------------------------------------------------
// Vault commands
// ---------------------------------------------------------------------------

/// Open a folder as the vault: scan it, start watching it, and make it the
/// target of every later command. Returns the initial file tree.
#[tauri::command]
async fn open_vault(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<Vec<TreeNode>> {
    let root = std::path::absolute(path.trim()).map_err(|e| format!("invalid vault path: {e}"))?;

    let (tree, watcher) = blocking({
        let root = root.clone();
        move || {
            let tree = vault::scan_tree(&root)?;
            let watcher = watcher::watch(app, &root)?;
            Ok((tree, watcher))
        }
    })
    .await?;

    // Dropping the previous watcher (if any) stops watching the old vault.
    *lock(&state.watcher) = Some(watcher);
    *lock(&state.vault_root) = Some(root);
    Ok(tree)
}

/// Re-scan the open vault (after the watcher reports changes).
#[tauri::command]
async fn list_tree(state: State<'_, AppState>) -> CmdResult<Vec<TreeNode>> {
    let root = state.root()?;
    blocking(move || vault::scan_tree(&root)).await
}

#[tauri::command]
async fn read_note(path: String, state: State<'_, AppState>) -> CmdResult<NoteFile> {
    let root = state.root()?;
    blocking(move || vault::read_note(&root, &path)).await
}

/// Returns the note's new modified time (ms since the Unix epoch).
#[tauri::command]
async fn write_note(path: String, content: String, state: State<'_, AppState>) -> CmdResult<i64> {
    let root = state.root()?;
    blocking(move || vault::write_note(&root, &path, &content)).await
}

/// Notes that wiki-link to this one ("Linked from" in the margin).
#[tauri::command]
async fn note_backlinks(path: String, state: State<'_, AppState>) -> CmdResult<Vec<Backlink>> {
    let root = state.root()?;
    blocking(move || vault::backlinks(&root, &path)).await
}

#[tauri::command]
/// Create a note, optionally with starting text. Never overwrites an existing file.
async fn create_note(
    path: String,
    content: Option<String>,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let root = state.root()?;
    blocking(move || vault::create_note(&root, &path, content.as_deref().unwrap_or_default())).await
}

/// Rename or move a note and update the links that point at it.
/// Holds `git_lock` so a sync never stages the vault halfway through.
#[tauri::command]
async fn rename_note(
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> CmdResult<RenameOutcome> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || vault::rename_note(&root, &from, &to)).await
}

/// Rename or move a folder with everything in it and update links to what's inside.
#[tauri::command]
async fn rename_folder(
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> CmdResult<RenameOutcome> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || vault::rename_folder(&root, &from, &to)).await
}

/// Move a folder and everything in it to the Recycle Bin.
#[tauri::command]
async fn delete_folder(path: String, state: State<'_, AppState>) -> CmdResult<()> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || vault::delete_folder(&root, &path)).await
}

/// Arrange a folder's notes and subfolders by hand (`""` is the top of the
/// vault). No names puts it back to A to Z.
#[tauri::command]
async fn set_order(
    folder: String,
    names: Vec<String>,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || order::set(&root, &folder, names)).await
}

/// How many notes and other files a folder holds (for the delete confirmation).
#[tauri::command]
async fn folder_contents(path: String, state: State<'_, AppState>) -> CmdResult<FolderContents> {
    let root = state.root()?;
    blocking(move || vault::folder_contents(&root, &path)).await
}

/// Move a note to the Recycle Bin.
#[tauri::command]
async fn delete_note(path: String, state: State<'_, AppState>) -> CmdResult<()> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || vault::delete_note(&root, &path)).await
}

/// Every file in the vault that isn't a note (images, PDFs, …).
#[tauri::command]
async fn list_attachments(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let root = state.root()?;
    blocking(move || attachments::list(&root)).await
}

/// Save pasted file data (the raw request body) as an attachment for a note.
/// Headers carry the percent-encoded `x-name`, `x-note` and `x-folder`
/// (the attachments folder; empty = next to the note). Returns its vault path.
#[tauri::command]
async fn save_attachment(
    request: tauri::ipc::Request<'_>,
    state: State<'_, AppState>,
) -> CmdResult<String> {
    let root = state.root()?;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("expected the file's data".into());
    };
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(links::percent_decode)
            .unwrap_or_default()
    };
    let (name, note, folder) = (header("x-name"), header("x-note"), header("x-folder"));
    let data = data.clone();
    blocking(move || attachments::save(&root, &folder, &note, &name, &data)).await
}

/// Copy files from elsewhere on the computer into the vault for a note
/// (files already in the vault stay where they are). Returns their vault paths.
#[tauri::command]
async fn import_attachments(
    paths: Vec<String>,
    note: String,
    folder: String,
    state: State<'_, AppState>,
) -> CmdResult<Vec<String>> {
    let root = state.root()?;
    blocking(move || attachments::import(&root, &folder, &note, &paths)).await
}

/// Rename or move an attachment and update the links and embeds that use it.
#[tauri::command]
async fn rename_attachment(
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> CmdResult<RenameOutcome> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || vault::rename_attachment(&root, &from, &to)).await
}

/// Move attachments to the Recycle Bin. Returns how many.
#[tauri::command]
async fn delete_attachments(paths: Vec<String>, state: State<'_, AppState>) -> CmdResult<usize> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || vault::delete_attachments(&root, &paths)).await
}

/// Every attachment with the notes that use it.
#[tauri::command]
async fn attachment_usage(state: State<'_, AppState>) -> CmdResult<Vec<AttachmentUse>> {
    let root = state.root()?;
    blocking(move || vault::attachment_usage(&root)).await
}

/// Show an attachment in Explorer.
#[tauri::command]
async fn reveal_attachment(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let root = state.root()?;
    let target = blocking(move || vault::resolve(&root, &path)).await?;
    app.opener()
        .reveal_item_in_dir(target)
        .map_err(|err| err.to_string())
}

/// Open an attachment with its default app. Programs and scripts are shown in Explorer instead.
#[tauri::command]
async fn open_attachment(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let root = state.root()?;
    let target = blocking(move || attachments::open_target(&root, &path)).await?;
    match target {
        attachments::Open::App(path) => app
            .opener()
            .open_path(path.display().to_string(), None::<&str>),
        attachments::Open::Reveal(path) => app.opener().reveal_item_in_dir(path),
    }
    .map_err(|err| err.to_string())
}

/// Save a note exported as a web page (its vault images put inside) where the user chose.
#[tauri::command]
async fn export_html(html: String, target: String, state: State<'_, AppState>) -> CmdResult<()> {
    let root = state.root()?;
    blocking(move || export::save_html(&root, &html, std::path::Path::new(&target))).await
}

/// Print the page, while it shows a note in print layout, to a PDF where the user chose.
/// `width` and `height` are the paper size in inches.
#[tauri::command]
async fn export_pdf(
    webview: tauri::Webview,
    target: String,
    width: f64,
    height: f64,
) -> CmdResult<()> {
    #[cfg(windows)]
    {
        use std::sync::{Arc, Mutex};
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let tx = Arc::new(Mutex::new(Some(tx)));
        let send = move |result: Result<(), String>| {
            if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                let _ = tx.send(result);
            }
        };
        let fail = send.clone();
        webview
            .with_webview(move |platform| {
                if let Err(err) =
                    export::print_to_pdf(&platform, &target, width, height, Box::new(send))
                {
                    fail(Err(err.message()));
                }
            })
            .map_err(|e| e.to_string())?;
        rx.await.map_err(|_| "the PDF export stopped".to_owned())?
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, target, width, height);
        Err("PDF export works on Windows only for now".into())
    }
}

/// Notes that mention this one by name (or alias) without linking it ("Mentioned in").
#[tauri::command]
async fn unlinked_mentions(
    path: String,
    state: State<'_, AppState>,
) -> CmdResult<Vec<mentions::Mentioning>> {
    let root = state.root()?;
    blocking(move || mentions::unlinked(&root, &path)).await
}

/// Turn mentions in `path` into links to `target`; returns how many were linked.
#[tauri::command]
async fn link_mentions(
    path: String,
    target: String,
    places: Vec<mentions::Place>,
    state: State<'_, AppState>,
) -> CmdResult<usize> {
    let root = state.root()?;
    blocking(move || mentions::link(&root, &path, &target, &places)).await
}

/// Every note with tags, for the Tags view.
#[tauri::command]
async fn list_tags(state: State<'_, AppState>) -> CmdResult<Vec<tags::TaggedNote>> {
    let root = state.root()?;
    blocking(move || tags::index(&root)).await
}

/// Rename a tag, and the tags nested under it, in every note.
#[tauri::command]
async fn rename_tag(
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> CmdResult<tags::TagRenameOutcome> {
    let root = state.root()?;
    blocking(move || tags::rename(&root, &from, &to)).await
}

/// Every heading in every note (the quick switcher's "Headings").
#[tauri::command]
async fn list_headings(state: State<'_, AppState>) -> CmdResult<Vec<HeadingRef>> {
    let root = state.root()?;
    blocking(move || vault::all_headings(&root)).await
}

/// Notes by last modified time, newest first ("Also edited today").
#[tauri::command]
async fn recent_notes(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> CmdResult<Vec<NoteStamp>> {
    let root = state.root()?;
    blocking(move || vault::recent_notes(&root, limit.unwrap_or(200))).await
}

// ---------------------------------------------------------------------------
// Git commands
// ---------------------------------------------------------------------------

/// Read-only, so it doesn't take `git_lock`. A long push won't freeze the
/// status bar, and libgit2 writes the index atomically anyway.
#[tauri::command]
async fn git_status(state: State<'_, AppState>) -> CmdResult<GitStatus> {
    let root = state.root()?;
    blocking(move || git::status(&root)).await
}

#[tauri::command]
async fn git_init(state: State<'_, AppState>) -> CmdResult<GitStatus> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || {
        git::init(&root)?;
        git::status(&root)
    })
    .await
}

/// Stage one vault-relative path (`git add <path>`).
#[tauri::command]
async fn git_stage(path: String, state: State<'_, AppState>) -> CmdResult<()> {
    let root = state.root()?;
    vault::resolve(&root, &path)?; // reject paths outside the vault before touching the index
    let _guard = state.git_lock.lock().await;
    blocking(move || git::stage_path(&git::open(&root)?, &path)).await
}

/// Commit staged changes. With `all`, stages every change first (`git add -A`).
/// Returns `null` when there was nothing to commit.
#[tauri::command]
async fn git_commit(
    message: String,
    all: bool,
    state: State<'_, AppState>,
) -> CmdResult<Option<CommitInfo>> {
    let root = state.root()?;
    let message = commit_message(message);
    let _guard = state.git_lock.lock().await;
    blocking(move || {
        let repo = git::open(&root)?;
        if all {
            git::stage_all(&repo)?;
        }
        git::commit(&repo, &message)
    })
    .await
}

#[tauri::command]
async fn git_pull(state: State<'_, AppState>) -> CmdResult<PullOutcome> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || git::pull(&git::open(&root)?, git::DEFAULT_REMOTE)).await
}

/// Returns `false` when there was nothing to push.
#[tauri::command]
async fn git_push(state: State<'_, AppState>) -> CmdResult<bool> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || git::push(&git::open(&root)?, git::DEFAULT_REMOTE)).await
}

/// The version a note's Changes view compares against (last sync, else last commit).
#[tauri::command]
async fn git_note_base(path: String, state: State<'_, AppState>) -> CmdResult<NoteBase> {
    let root = state.root()?;
    vault::resolve(&root, &path)?;
    blocking(move || git::note_base(&root, &path)).await
}

/// Commits that changed one note, newest first.
#[tauri::command]
async fn git_note_history(path: String, state: State<'_, AppState>) -> CmdResult<NoteHistory> {
    const LIMIT: usize = 500;
    let root = state.root()?;
    vault::resolve(&root, &path)?;
    blocking(move || git::note_history(&root, &path, LIMIT)).await
}

/// Full-text search. With `titles_only`, only note names count.
#[tauri::command]
async fn search_notes(
    query: String,
    titles_only: bool,
    state: State<'_, AppState>,
) -> CmdResult<Vec<search::SearchHit>> {
    let root = state.root()?;
    blocking(move || search::search(&root, &query, titles_only)).await
}

/// Text that matched in an older version but has been removed since.
#[tauri::command]
async fn search_history(
    query: String,
    state: State<'_, AppState>,
) -> CmdResult<Vec<git::HistoryHit>> {
    let root = state.root()?;
    blocking(move || git::search_history(&root, &query, 400, 20)).await
}

/// The vault's own settings (`.penna/settings.json`), or null before any were saved.
#[tauri::command]
async fn vault_settings_read(state: State<'_, AppState>) -> CmdResult<Option<String>> {
    let root = state.root()?;
    blocking(move || vault::read_vault_settings(&root)).await
}

#[tauri::command]
async fn vault_settings_write(json: String, state: State<'_, AppState>) -> CmdResult<()> {
    let root = state.root()?;
    blocking(move || vault::write_vault_settings(&root, &json)).await
}

#[tauri::command]
async fn git_remote_url(state: State<'_, AppState>) -> CmdResult<Option<String>> {
    let root = state.root()?;
    blocking(move || git::remote_url(&root)).await
}

/// Connect the vault to a remote (or disconnect with an empty URL).
#[tauri::command]
async fn git_set_remote(url: String, state: State<'_, AppState>) -> CmdResult<()> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || git::set_remote(&root, &url)).await
}

/// This computer's name, the default device name shown in History.
#[tauri::command]
fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "This PC".to_owned())
}

/// Fetch without touching notes, to check the remote and sign-in.
#[tauri::command]
async fn git_test_connection(state: State<'_, AppState>) -> CmdResult<()> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || git::test_connection(&root)).await
}

#[tauri::command]
async fn git_identity(state: State<'_, AppState>) -> CmdResult<git::Identity> {
    let root = state.root()?;
    blocking(move || git::identity(&root)).await
}

/// Name and email for this vault's versions; empty values fall back to your global Git identity.
#[tauri::command]
async fn git_set_identity(
    name: String,
    email: String,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || git::set_identity(&root, &name, &email)).await
}

/// Saved versions for the History view, newest first.
#[tauri::command]
async fn git_log(skip: usize, limit: usize, state: State<'_, AppState>) -> CmdResult<HistoryPage> {
    let root = state.root()?;
    blocking(move || git::log(&root, skip, limit.min(500))).await
}

/// One version with each changed note's text before and after.
#[tauri::command]
async fn git_version(id: String, state: State<'_, AppState>) -> CmdResult<VersionDetail> {
    let root = state.root()?;
    blocking(move || git::version(&root, &id)).await
}

/// Changes in the folder that the last sync doesn't have yet.
#[tauri::command]
async fn git_pending(state: State<'_, AppState>) -> CmdResult<VersionDetail> {
    let root = state.root()?;
    blocking(move || git::pending(&root)).await
}

/// A note's text in a given version (for comparing against older versions).
#[tauri::command]
async fn git_note_at(
    path: String,
    id: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let root = state.root()?;
    vault::resolve(&root, &path)?;
    blocking(move || git::note_at(&root, &path, &id)).await
}

/// Where a note from an older version is now (following renames), or null if it was deleted.
#[tauri::command]
async fn git_current_path(
    path: String,
    id: String,
    state: State<'_, AppState>,
) -> CmdResult<Option<String>> {
    let root = state.root()?;
    blocking(move || git::current_path(&root, &path, &id)).await
}

/// Write notes back as they were in a version. Returns how many were restored.
#[tauri::command]
async fn git_restore(
    id: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> CmdResult<usize> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await; // not while a sync is checking files out
    blocking(move || git::restore(&root, &id, &paths)).await
}

/// Stage all, commit, pull, push: the title bar's Sync button.
#[tauri::command]
async fn git_sync(message: String, state: State<'_, AppState>) -> CmdResult<SyncOutcome> {
    let root = state.root()?;
    let message = commit_message(message);
    let _guard = state.git_lock.lock().await;
    blocking(move || git::sync(&root, &message)).await
}

/// The paused sync (both versions and the notes that need a choice), or null.
#[tauri::command]
async fn git_merge_state(state: State<'_, AppState>) -> CmdResult<Option<MergeState>> {
    let root = state.root()?;
    blocking(move || git::merge_state(&root)).await
}

/// Save the merge once every note has a choice, then send it.
#[tauri::command]
async fn git_finish_merge(message: String, state: State<'_, AppState>) -> CmdResult<SyncOutcome> {
    let root = state.root()?;
    let message = commit_message(message);
    let _guard = state.git_lock.lock().await;
    blocking(move || git::finish_merge(&root, &message)).await
}

/// Stop the paused sync: notes go back to this device's last version.
#[tauri::command]
async fn git_abort_merge(state: State<'_, AppState>) -> CmdResult<()> {
    let root = state.root()?;
    let _guard = state.git_lock.lock().await;
    blocking(move || git::abort_merge(&root)).await
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// The portable Windows copy: with a file named `portable` next to the
/// program, WebView2 keeps everything (settings, the last vault, recent notes)
/// in a `data` folder beside it instead of the user profile. Notes live in the
/// vault either way.
fn use_portable_data() {
    #[cfg(windows)]
    {
        if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_some() {
            return; // already chosen (tests do this)
        }
        let Some(dir) = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
        else {
            return;
        };
        if dir.join("portable").is_file() {
            let data = dir.join("data");
            let _ = std::fs::create_dir_all(&data);
            // SAFETY: called first thing in `run`, before any other thread exists.
            unsafe { std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", data) };
        }
    }
}

pub fn run() {
    use_portable_data();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        // `penna:` (http://penna.localhost on Windows) serves vault files to the editor's images.
        .register_asynchronous_uri_scheme_protocol("penna", |ctx, request, responder| {
            let root = lock(&ctx.app_handle().state::<AppState>().vault_root).clone();
            let path = request.uri().path().to_owned();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(attachments::serve(root, &path))
            });
        })
        .invoke_handler(tauri::generate_handler![
            open_vault,
            list_tree,
            read_note,
            write_note,
            create_note,
            rename_note,
            delete_note,
            rename_folder,
            delete_folder,
            folder_contents,
            set_order,
            list_attachments,
            save_attachment,
            import_attachments,
            open_attachment,
            rename_attachment,
            delete_attachments,
            attachment_usage,
            reveal_attachment,
            note_backlinks,
            recent_notes,
            list_headings,
            list_tags,
            unlinked_mentions,
            link_mentions,
            export_html,
            export_pdf,
            rename_tag,
            search_notes,
            search_history,
            vault_settings_read,
            vault_settings_write,
            git_remote_url,
            git_set_remote,
            device_name,
            git_test_connection,
            git_identity,
            git_set_identity,
            git_status,
            git_note_base,
            git_note_history,
            git_log,
            git_version,
            git_pending,
            git_note_at,
            git_current_path,
            git_restore,
            git_init,
            git_stage,
            git_commit,
            git_pull,
            git_push,
            git_sync,
            git_merge_state,
            git_finish_merge,
            git_abort_merge,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
