//! Vault (notes folder) filesystem operations.
//!
//! All paths that cross the IPC boundary are *vault-relative* and use `/` as
//! the separator (e.g. `projects/ideas.md`). This keeps the frontend
//! platform-agnostic and matches how git names paths. [`resolve`] is the only
//! way to turn one back into an absolute path, and it refuses anything that
//! could escape the vault.
//!
//! Every function here does blocking I/O. Call them via `spawn_blocking`.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use walkdir::{DirEntry, WalkDir};

use crate::error::{AppError, AppResult, IoContext};
use crate::links;

/// File extensions treated as notes.
pub const NOTE_EXTENSIONS: &[&str] = &["md", "markdown"];

/// A node in the vault tree. Serialises as a tagged union so TypeScript can
/// narrow on `kind`:
/// `{ kind: "dir", name, path, children }` | `{ kind: "file", name, path }`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TreeNode {
    Dir {
        name: String,
        path: String,
        children: Vec<TreeNode>,
    },
    File {
        name: String,
        path: String,
    },
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/// Dotfiles and dot-folders (`.git`, `.obsidian`, temp files) are hidden from
/// the tree and blocked from IPC reads and writes.
pub fn is_hidden(name: &OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

pub fn is_note(path: &Path) -> bool {
    path.extension()
        .and_then(OsStr::to_str)
        .is_some_and(|ext| NOTE_EXTENSIONS.iter().any(|n| ext.eq_ignore_ascii_case(n)))
}

/// Convert an absolute path inside `root` to a vault-relative `/` path.
/// Returns `None` for paths outside the vault.
pub fn to_relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<_> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect();
    Some(parts.join("/"))
}

/// Resolve a vault-relative path to an absolute one, rejecting anything that
/// could escape the vault: absolute paths, drive prefixes, `..`, and hidden
/// segments (which also protects `.git/`).
///
/// Symlinks inside the vault are not resolved here; `scan_tree` doesn't follow
/// them, so the UI never offers a path through one.
pub fn resolve(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let invalid = |reason| AppError::InvalidPath {
        path: rel.to_owned(),
        reason,
    };

    let rel = rel.trim();
    if rel.is_empty() {
        return Err(invalid("path is empty"));
    }

    let mut out = root.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(seg) if is_hidden(seg) => {
                return Err(invalid("hidden files and folders are not accessible"));
            }
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            Component::ParentDir => return Err(invalid("'..' is not allowed")),
            Component::RootDir | Component::Prefix(_) => {
                return Err(invalid("path must be relative to the vault"));
            }
        }
    }

    if out == root {
        return Err(invalid("path points at the vault root"));
    }
    Ok(out)
}

/// Like [`resolve`], but also requires a note extension (`.md` / `.markdown`).
pub(crate) fn resolve_note(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let path = resolve(root, rel)?;
    if !is_note(&path) {
        return Err(AppError::InvalidPath {
            path: rel.to_owned(),
            reason: "only .md and .markdown files can be edited",
        });
    }
    Ok(path)
}

pub fn ensure_vault(root: &Path) -> AppResult<()> {
    if root.is_dir() {
        Ok(())
    } else {
        Err(AppError::VaultNotFound(root.to_path_buf()))
    }
}

// ---------------------------------------------------------------------------
// Tree scanning
// ---------------------------------------------------------------------------

/// A directory being built while walking. Directories stay on a stack until
/// the walk leaves them, then get attached to their parent.
struct DirBuilder {
    name: String,
    path: String,
    children: Vec<TreeNode>,
}

impl DirBuilder {
    fn finish(self) -> TreeNode {
        TreeNode::Dir {
            name: self.name,
            path: self.path,
            children: self.children,
        }
    }
}

/// Folders first, then case-insensitive by name. This is the order the
/// sidebar shows.
fn sort_entries(a: &DirEntry, b: &DirEntry) -> Ordering {
    let a_dir = a.file_type().is_dir();
    let b_dir = b.file_type().is_dir();
    b_dir.cmp(&a_dir).then_with(|| {
        let a_name = a.file_name().to_string_lossy().to_lowercase();
        let b_name = b.file_name().to_string_lossy().to_lowercase();
        a_name.cmp(&b_name)
    })
}

/// Walk the vault and return its folders and Markdown files as a nested tree.
///
/// `walkdir` yields entries depth-first, parents before children, which lets
/// us build the tree in one pass with a stack: `stack[d]` is the directory
/// that owns entries at depth `d + 1`.
///
/// Unreadable entries (permissions, broken links) are skipped, not treated as
/// errors, so one bad folder doesn't hide the whole vault.
pub fn scan_tree(root: &Path) -> AppResult<Vec<TreeNode>> {
    ensure_vault(root)?;

    let walker = WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .sort_by(sort_entries)
        .into_iter()
        .filter_entry(|e| !is_hidden(e.file_name()));

    let mut stack = vec![DirBuilder {
        name: String::new(),
        path: String::new(),
        children: Vec::new(),
    }];

    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                eprintln!("[vault] skipping unreadable entry: {err}");
                continue;
            }
        };

        // Close any directories we've walked out of (depth >= 1, so the root survives).
        close_dirs(&mut stack, entry.depth());

        let Some(rel) = to_relative(root, entry.path()) else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();

        if entry.file_type().is_dir() {
            stack.push(DirBuilder {
                name,
                path: rel,
                children: Vec::new(),
            });
        } else if entry.file_type().is_file()
            && is_note(entry.path())
            && let Some(parent) = stack.last_mut()
        {
            parent.children.push(TreeNode::File { name, path: rel });
        }
    }

    close_dirs(&mut stack, 1);
    Ok(stack.pop().map(|root| root.children).unwrap_or_default())
}

/// Pop directories until `stack.len() == depth`, attaching each to its parent.
/// Folders without any notes (an attachments folder, say) are left out.
fn close_dirs(stack: &mut Vec<DirBuilder>, depth: usize) {
    while stack.len() > depth.max(1) {
        if let Some(done) = stack.pop()
            && !done.children.is_empty()
            && let Some(parent) = stack.last_mut()
        {
            parent.children.push(done.finish());
        }
    }
}

// ---------------------------------------------------------------------------
// Note I/O
// ---------------------------------------------------------------------------

/// A note's text plus when it last changed on disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    pub content: String,
    /// Milliseconds since the Unix epoch.
    pub modified: i64,
}

pub(crate) fn modified_ms(path: &Path) -> AppResult<i64> {
    let modified = fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ctx("reading the modified time of", path)?;
    let millis = modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(i64::try_from(millis).unwrap_or(i64::MAX))
}

pub fn read_note(root: &Path, rel: &str) -> AppResult<NoteFile> {
    let path = resolve_note(root, rel)?;
    let content = fs::read_to_string(&path).ctx("reading", &path)?;
    Ok(NoteFile {
        content,
        modified: modified_ms(&path)?,
    })
}

/// Write a note atomically: write a hidden temp file next to the target,
/// flush it to disk, then rename it over the original. A crash mid-save
/// leaves either the old or the new content, never a truncated file.
///
/// Returns the file's new modified time (ms since the Unix epoch).
pub fn write_note(root: &Path, rel: &str, content: &str) -> AppResult<i64> {
    let path = resolve_note(root, rel)?;
    write_atomic(&path, content)?;
    modified_ms(&path)
}

/// Temp file + flush + rename, so readers see the old or the new content,
/// never a half-written file.
fn write_atomic(path: &Path, content: &str) -> AppResult<()> {
    let parent = path.parent().ok_or_else(|| AppError::InvalidPath {
        path: path.display().to_string(),
        reason: "path has no parent folder",
    })?;
    fs::create_dir_all(parent).ctx("creating folder", parent)?;

    let file_name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = parent.join(format!(".{file_name}.penna-tmp"));

    let result = (|| {
        let mut file = File::create(&tmp).ctx("creating temp file", &tmp)?;
        file.write_all(content.as_bytes()).ctx("writing", &tmp)?;
        file.sync_all().ctx("flushing", &tmp)?;
        drop(file);
        // On Windows, std::fs::rename replaces an existing file
        // (MoveFileExW + MOVEFILE_REPLACE_EXISTING).
        fs::rename(&tmp, path).ctx("saving", path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

// ---------------------------------------------------------------------------
// Vault settings (`.penna/settings.json`, synced with the notes)
// ---------------------------------------------------------------------------

fn vault_settings_path(root: &Path) -> PathBuf {
    root.join(".penna").join("settings.json")
}

/// The vault's settings JSON, or `None` before anything was saved.
pub fn read_vault_settings(root: &Path) -> AppResult<Option<String>> {
    ensure_vault(root)?;
    let path = vault_settings_path(root);
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(AppError::Io {
            context: format!("reading '{}'", path.display()),
            source: err,
        }),
    }
}

/// Save the vault's settings. Rejects text that isn't valid JSON.
pub fn write_vault_settings(root: &Path, json: &str) -> AppResult<()> {
    ensure_vault(root)?;
    serde_json::from_str::<serde_json::Value>(json).map_err(|_| AppError::InvalidPath {
        path: ".penna/settings.json".into(),
        reason: "settings must be valid JSON",
    })?;
    write_atomic(&vault_settings_path(root), json)
}

/// Create a new, empty note. Fails if the file already exists, so it never
/// overwrites a note.
pub fn create_note(root: &Path, rel: &str, content: &str) -> AppResult<()> {
    let path = resolve_note(root, rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ctx("creating folder", parent)?;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::AlreadyExists => AppError::AlreadyExists(rel.to_owned()),
            _ => AppError::Io {
                context: format!("creating '{}'", path.display()),
                source: err,
            },
        })?;
    if !content.is_empty() {
        file.write_all(content.as_bytes()).ctx("writing", &path)?;
        file.sync_all().ctx("flushing", &path)?;
    }
    Ok(())
}

/// A note path and when it last changed on disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteStamp {
    pub path: String,
    /// Milliseconds since the Unix epoch.
    pub modified: i64,
}

/// The most recently modified notes, newest first.
pub fn recent_notes(root: &Path, limit: usize) -> AppResult<Vec<NoteStamp>> {
    ensure_vault(root)?;
    let walker = WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_hidden(e.file_name()));
    let mut notes: Vec<NoteStamp> = walker
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && is_note(e.path()))
        .filter_map(|e| {
            Some(NoteStamp {
                path: to_relative(root, e.path())?,
                modified: modified_ms(e.path()).ok()?,
            })
        })
        .collect();
    notes.sort_by_key(|n| std::cmp::Reverse(n.modified));
    notes.truncate(limit);
    Ok(notes)
}

// ---------------------------------------------------------------------------
// Rename, move, delete
// ---------------------------------------------------------------------------

/// Every note path in sidebar order (the order the editor resolves names in).
pub fn note_paths(root: &Path) -> AppResult<Vec<String>> {
    fn walk(nodes: Vec<TreeNode>, out: &mut Vec<String>) {
        for node in nodes {
            match node {
                TreeNode::File { path, .. } => out.push(path),
                TreeNode::Dir { children, .. } => walk(children, out),
            }
        }
    }
    let mut out = Vec::new();
    walk(scan_tree(root)?, &mut out);
    Ok(out)
}

/// The result of renaming or moving a note or a folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    /// The note's or folder's new path.
    pub path: String,
    /// Notes that moved, old path → new path (one for a note, all of a folder's).
    pub moved: Vec<Moved>,
    /// Notes whose links were rewritten (at their current paths).
    pub updated: Vec<String>,
    /// How many links changed in all.
    pub links: usize,
    /// The note's own `# Heading` took the new name (notes only).
    pub retitled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    pub from: String,
    pub to: String,
}

/// Remove `dir` and its parents while they're empty, stopping at the vault
/// root. A folder that still holds anything (even hidden files) stays.
fn remove_empty_dirs(root: &Path, dir: Option<&Path>) {
    let mut dir = dir;
    while let Some(d) = dir {
        if d == root || !d.starts_with(root) || fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

/// Canonical vault paths for both ends of a move, refusing to replace
/// anything. A change of case only (`idea` → `Idea`) is allowed.
fn move_ends(
    root: &Path,
    from_abs: &Path,
    to_abs: &Path,
    to_input: &str,
) -> AppResult<(String, String)> {
    let (Some(from), Some(to)) = (to_relative(root, from_abs), to_relative(root, to_abs)) else {
        return Err(AppError::InvalidPath {
            path: to_input.to_owned(),
            reason: "path must be inside the vault",
        });
    };
    let case_only = from.to_lowercase() == to.to_lowercase();
    if from != to && !case_only && fs::symlink_metadata(to_abs).is_ok() {
        return Err(AppError::AlreadyExists(to));
    }
    Ok((from, to))
}

/// Move a file or folder from `from_abs` to `to_abs` and rewrite the links
/// that `moves` (every note and file that changes path) breaks, across the
/// vault. Every rewrite is worked out before anything on disk changes.
/// With `retitle`, the moved note's `# Old name` heading takes the new name.
fn move_and_relink(
    root: &Path,
    from_abs: &Path,
    to_abs: &Path,
    path: String,
    moves: HashMap<String, String>,
    retitle: Option<(&str, &str)>,
) -> AppResult<RenameOutcome> {
    let before = note_paths(root)?;
    let after: Vec<String> = before
        .iter()
        .map(|p| moves.get(p).cloned().unwrap_or_else(|| p.clone()))
        .collect();
    let files = crate::attachments::list(root)?;
    let rename = links::Rename {
        moves: &moves,
        before: &before,
        after: &after,
        files: &files,
    };
    let mut writes = Vec::new();
    let mut updated = Vec::new();
    let mut total = 0;
    let mut retitled = false;
    for (old, new) in before.iter().zip(&after) {
        let Ok(text) = fs::read_to_string(resolve(root, old)?) else {
            continue; // unreadable or not UTF-8: leave it alone
        };
        let (mut rewritten, n) = links::rewrite(&text, old, new, &rename);
        if n > 0 {
            total += n;
            updated.push(new.clone());
        }
        if old != new
            && let Some((old_name, new_name)) = retitle
            && old_name != new_name
            && let Some(text) = links::retitle(&rewritten, old_name, new_name)
        {
            rewritten = text;
            retitled = true;
        }
        if rewritten != text {
            writes.push((new.clone(), rewritten));
        }
    }

    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent).ctx("creating folder", parent)?;
    }
    fs::rename(from_abs, to_abs).ctx("renaming", from_abs)?;
    for (rel, text) in &writes {
        write_atomic(&resolve(root, rel)?, text)?;
    }
    remove_empty_dirs(root, from_abs.parent());

    let mut moved: Vec<Moved> = before
        .iter()
        .zip(&after)
        .filter(|(old, new)| old != new)
        .map(|(old, new)| Moved {
            from: old.clone(),
            to: new.clone(),
        })
        .collect();
    moved.sort_by(|a, b| a.from.cmp(&b.from));
    Ok(RenameOutcome {
        path,
        moved,
        updated,
        links: total,
        retitled,
    })
}

/// Rename or move a note, then rewrite the links that pointed at it across
/// the vault (wiki links and relative Markdown links), plus the note's own
/// relative links when it changes folder. Never overwrites another note; a
/// change of case only (`idea.md` → `Idea.md`) is allowed.
pub fn rename_note(root: &Path, from: &str, to: &str) -> AppResult<RenameOutcome> {
    let from_abs = resolve_note(root, from)?;
    let to_abs = resolve_note(root, to)?;
    if !from_abs.is_file() {
        return Err(AppError::NotFound(from.to_owned()));
    }
    let (from, to) = move_ends(root, &from_abs, &to_abs, to)?;
    if from == to {
        return Ok(RenameOutcome {
            path: to,
            moved: Vec::new(),
            updated: Vec::new(),
            links: 0,
            retitled: false,
        });
    }
    let moves = HashMap::from([(from.clone(), to.clone())]);
    let names = (links::stem(&from).to_owned(), links::stem(&to).to_owned());
    move_and_relink(
        root,
        &from_abs,
        &to_abs,
        to.clone(),
        moves,
        Some((&names.0, &names.1)),
    )
}

/// Rename or move a folder with everything in it, rewriting links to the
/// notes and files inside it (and their own links out of it) across the
/// vault. Refuses to move a folder into itself or onto something that exists.
pub fn rename_folder(root: &Path, from: &str, to: &str) -> AppResult<RenameOutcome> {
    let from_abs = resolve(root, from)?;
    let to_abs = resolve(root, to)?;
    if !from_abs.is_dir() {
        return Err(AppError::NotFound(from.to_owned()));
    }
    let (from, to) = move_ends(root, &from_abs, &to_abs, to)?;
    if from == to {
        return Ok(RenameOutcome {
            path: to,
            moved: Vec::new(),
            updated: Vec::new(),
            links: 0,
            retitled: false,
        });
    }
    if to
        .to_lowercase()
        .starts_with(&format!("{}/", from.to_lowercase()))
    {
        return Err(AppError::InvalidPath {
            path: to,
            reason: "a folder can't go inside itself",
        });
    }
    // Everything inside moves with it: notes, images, other files (not hidden ones).
    let prefix = format!("{from}/");
    let moves: HashMap<String, String> = note_paths(root)?
        .into_iter()
        .chain(crate::attachments::list(root)?)
        .filter_map(|p| {
            p.strip_prefix(&prefix)
                .map(|rest| (p.clone(), format!("{to}/{rest}")))
        })
        .collect();
    move_and_relink(root, &from_abs, &to_abs, to.clone(), moves, None)
}

/// An image or other file (not a note), checked: it must exist.
fn resolve_attachment(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let path = resolve(root, rel)?;
    if is_note(&path) {
        return Err(AppError::InvalidPath {
            path: rel.to_owned(),
            reason: "that's a note, not an attachment",
        });
    }
    if !path.is_file() {
        return Err(AppError::NotFound(rel.to_owned()));
    }
    Ok(path)
}

/// Rename or move an attachment and rewrite the links and embeds that use it.
pub fn rename_attachment(root: &Path, from: &str, to: &str) -> AppResult<RenameOutcome> {
    let from_abs = resolve_attachment(root, from)?;
    let to_abs = resolve(root, to)?;
    if is_note(&to_abs) {
        return Err(AppError::InvalidPath {
            path: to.to_owned(),
            reason: "an attachment can't be renamed into a note",
        });
    }
    let (from, to) = move_ends(root, &from_abs, &to_abs, to)?;
    if from == to {
        return Ok(RenameOutcome {
            path: to,
            moved: Vec::new(),
            updated: Vec::new(),
            links: 0,
            retitled: false,
        });
    }
    let moves = HashMap::from([(from, to.clone())]);
    move_and_relink(root, &from_abs, &to_abs, to, moves, None)
}

/// Move attachments to the Recycle Bin. Links to them stay (and show as missing).
pub fn delete_attachments(root: &Path, rels: &[String]) -> AppResult<usize> {
    let paths = rels
        .iter()
        .map(|rel| resolve_attachment(root, rel))
        .collect::<AppResult<Vec<_>>>()?;
    if paths.is_empty() {
        return Ok(0);
    }
    trash::delete_all(&paths).map_err(|err| AppError::Trash(rels.join(", "), err.to_string()))?;
    for path in &paths {
        remove_empty_dirs(root, path.parent());
    }
    Ok(paths.len())
}

/// An attachment and the notes that use it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUse {
    pub path: String,
    /// Bytes.
    pub size: u64,
    /// Notes that link to it or embed it.
    pub notes: Vec<String>,
}

/// Every attachment with the notes that use it ("Files no note links to").
pub fn attachment_usage(root: &Path) -> AppResult<Vec<AttachmentUse>> {
    let files = crate::attachments::list(root)?;
    let mut uses: HashMap<String, Vec<String>> = HashMap::new();
    for note in note_paths(root)? {
        let Ok(text) = fs::read_to_string(resolve(root, &note)?) else {
            continue;
        };
        for file in links::files_linked(&text, &note, &files) {
            uses.entry(file.to_owned()).or_default().push(note.clone());
        }
    }
    Ok(files
        .iter()
        .map(|path| AttachmentUse {
            size: resolve(root, path)
                .ok()
                .and_then(|p| fs::metadata(p).ok())
                .map_or(0, |m| m.len()),
            notes: uses.remove(path).unwrap_or_default(),
            path: path.clone(),
        })
        .collect())
}

/// Move a note to the Recycle Bin. Links to it are left as they are.
pub fn delete_note(root: &Path, rel: &str) -> AppResult<()> {
    let path = resolve_note(root, rel)?;
    if !path.is_file() {
        return Err(AppError::NotFound(rel.to_owned()));
    }
    trash::delete(&path).map_err(|err| AppError::Trash(rel.to_owned(), err.to_string()))?;
    remove_empty_dirs(root, path.parent());
    Ok(())
}

/// Move a folder and everything in it to the Recycle Bin.
pub fn delete_folder(root: &Path, rel: &str) -> AppResult<()> {
    let path = resolve(root, rel)?;
    if !path.is_dir() {
        return Err(AppError::NotFound(rel.to_owned()));
    }
    trash::delete(&path).map_err(|err| AppError::Trash(rel.to_owned(), err.to_string()))?;
    remove_empty_dirs(root, path.parent());
    Ok(())
}

/// What's in a folder, for the delete confirmation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderContents {
    pub notes: usize,
    /// Files that aren't notes (images, PDFs, …).
    pub files: usize,
}

pub fn folder_contents(root: &Path, rel: &str) -> AppResult<FolderContents> {
    let path = resolve(root, rel)?;
    if !path.is_dir() {
        return Err(AppError::NotFound(rel.to_owned()));
    }
    let (mut notes, mut files) = (0, 0);
    for entry in WalkDir::new(&path)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_hidden(e.file_name()))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        if is_note(entry.path()) {
            notes += 1;
        } else {
            files += 1;
        }
    }
    Ok(FolderContents { notes, files })
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

/// A heading in a note, for the quick switcher.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadingRef {
    pub path: String,
    pub level: u8,
    pub text: String,
    /// 1-based line.
    pub line: usize,
}

/// Every heading in every note, in sidebar order.
pub fn all_headings(root: &Path) -> AppResult<Vec<HeadingRef>> {
    let mut out = Vec::new();
    for path in note_paths(root)? {
        let Ok(text) = fs::read_to_string(resolve(root, &path)?) else {
            continue;
        };
        for (level, text, line) in links::headings(&text) {
            out.push(HeadingRef {
                path: path.clone(),
                level,
                text,
                line,
            });
        }
    }
    Ok(out)
}

/// A note that links to another one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    /// Vault-relative path of the linking note.
    pub path: String,
    /// The line that holds the link, trimmed, for context.
    pub context: String,
}

/// Every note that links to `rel`, with a wiki link or a relative Markdown
/// link, sorted by path. Links resolve the way the editor follows them, and
/// links inside code don't count.
///
/// This reads the whole vault on each call, which is fine for a few thousand
/// notes. A persistent link index built from watcher events can replace it
/// later without changing the command's shape.
pub fn backlinks(root: &Path, rel: &str) -> AppResult<Vec<Backlink>> {
    let target_abs = resolve_note(root, rel)?;
    let Some(target) = to_relative(root, &target_abs) else {
        return Ok(Vec::new());
    };
    let paths = note_paths(root)?;

    let mut links = Vec::new();
    for path in &paths {
        if *path == target {
            continue;
        }
        let Ok(text) = fs::read_to_string(resolve(root, path)?) else {
            continue; // unreadable or not UTF-8: skip rather than fail the whole list
        };
        if let Some(line) = links::line_linking_to(&text, path, &target, &paths) {
            links.push(Backlink {
                path: path.clone(),
                context: line.chars().take(160).collect(),
            });
        }
    }
    links.sort_by_key(|link| link.path.to_lowercase());
    Ok(links)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("penna-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_rejects_escapes() {
        let root = Path::new("C:/vault");
        for bad in [
            "",
            "../x.md",
            "a/../../x.md",
            "/abs.md",
            "C:/x.md",
            ".git/config",
            "a/.hidden/b.md",
        ] {
            assert!(resolve(root, bad).is_err(), "should reject {bad:?}");
        }
        assert_eq!(
            resolve(root, "a/b.md").unwrap(),
            root.join("a").join("b.md")
        );
    }

    #[test]
    fn scan_builds_sorted_tree_and_skips_hidden() {
        let root = temp_vault("scan");
        fs::create_dir_all(root.join("Zeta/inner")).unwrap();
        fs::create_dir_all(root.join("alpha")).unwrap();
        fs::create_dir_all(root.join("Attachments")).unwrap();
        fs::create_dir_all(root.join("beta")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join("b.md"), "").unwrap();
        fs::write(root.join("A.md"), "").unwrap();
        fs::write(root.join("image.png"), "").unwrap();
        fs::write(root.join("Attachments/photo.png"), "").unwrap();
        fs::write(root.join("beta/c.md"), "").unwrap();
        fs::write(root.join("Zeta/inner/deep.md"), "").unwrap();
        fs::write(root.join(".git/HEAD"), "").unwrap();

        let tree = scan_tree(&root).unwrap();
        let names: Vec<_> = tree
            .iter()
            .map(|n| match n {
                TreeNode::Dir { name, .. } | TreeNode::File { name, .. } => name.as_str(),
            })
            .collect();
        // Folders without notes (empty, or only attachments) are left out.
        assert_eq!(names, ["beta", "Zeta", "A.md", "b.md"]);

        let TreeNode::Dir { children, .. } = &tree[1] else {
            panic!("expected dir")
        };
        let TreeNode::Dir { children, path, .. } = &children[0] else {
            panic!("expected dir")
        };
        assert_eq!(path, "Zeta/inner");
        assert!(
            matches!(&children[0], TreeNode::File { path, .. } if path == "Zeta/inner/deep.md")
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn backlinks_finds_linking_notes() {
        let root = temp_vault("links");
        fs::create_dir_all(root.join("Journal")).unwrap();
        fs::write(root.join("Merge UX.md"), "# Merge UX").unwrap();
        fs::write(
            root.join("Roadmap.md"),
            "1. Ship\n2. Build [[Merge UX]] next\n",
        )
        .unwrap();
        fs::write(root.join("Journal/Oct 16.md"), "nothing here").unwrap();
        let links = backlinks(&root, "Merge UX.md").unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].path, "Roadmap.md");
        assert_eq!(links[0].context, "2. Build [[Merge UX]] next");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rename_moves_the_note_and_rewrites_links() {
        let root = temp_vault("rename");
        fs::create_dir_all(root.join("Inbox")).unwrap();
        fs::write(root.join("Inbox/Idea.md"), "# Idea\n[home](../Home.md)\n").unwrap();
        fs::write(
            root.join("Home.md"),
            "See [[Idea]] and [[Inbox/Idea|this]].\r\n",
        )
        .unwrap();
        fs::write(root.join("Other.md"), "No links.\n").unwrap();

        let out = rename_note(&root, "Inbox/Idea.md", "Projects/Big idea.md").unwrap();
        assert_eq!(out.path, "Projects/Big idea.md");
        assert_eq!(out.links, 2);
        assert_eq!(out.updated, ["Home.md"]);
        assert_eq!(
            fs::read_to_string(root.join("Home.md")).unwrap(),
            "See [[Big idea]] and [[Projects/Big idea|this]].\r\n"
        );
        // Its heading follows the new name; its own link still reaches
        // Home.md from the new folder (same depth).
        assert!(out.retitled);
        assert_eq!(
            fs::read_to_string(root.join("Projects/Big idea.md")).unwrap(),
            "# Big idea\n[home](../Home.md)\n"
        );
        assert!(!root.join("Inbox").exists(), "the empty folder is removed");

        // Never overwrites; a missing note is an error; case-only renames work.
        assert!(matches!(
            rename_note(&root, "Home.md", "Other.md"),
            Err(AppError::AlreadyExists(_))
        ));
        assert!(matches!(
            rename_note(&root, "Nope.md", "New.md"),
            Err(AppError::NotFound(_))
        ));
        assert!(rename_note(&root, "Home.md", "../Home.md").is_err());
        rename_note(&root, "Other.md", "other.md").unwrap();
        assert_eq!(
            note_paths(&root).unwrap(),
            ["Projects/Big idea.md", "Home.md", "other.md"]
        );
        assert!(matches!(
            delete_note(&root, "Missing.md"),
            Err(AppError::NotFound(_))
        ));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rename_folder_moves_everything_and_relinks() {
        let root = temp_vault("rename-folder");
        fs::create_dir_all(root.join("Projects/2026")).unwrap();
        fs::write(
            root.join("Projects/Plan.md"),
            "[[Projects/2026/Q4]] [home](../Home.md) ![](diagram.png) [q4](2026/Q4.md)\n",
        )
        .unwrap();
        fs::write(
            root.join("Projects/2026/Q4.md"),
            "# Q4\n[plan](../Plan.md)\n",
        )
        .unwrap();
        fs::write(root.join("Projects/diagram.png"), "png").unwrap();
        fs::write(
            root.join("Home.md"),
            "[[Plan]] [[Projects/Plan]] [p](Projects/Plan.md) ![](Projects/diagram.png) ![[Projects/diagram.png]] ![[diagram.png]]\n",
        )
        .unwrap();

        let out = rename_folder(&root, "Projects", "Archive/Old projects").unwrap();
        assert_eq!(out.path, "Archive/Old projects");
        let moved: Vec<_> = out
            .moved
            .iter()
            .map(|m| (m.from.as_str(), m.to.as_str()))
            .collect();
        assert_eq!(
            moved,
            [
                ("Projects/2026/Q4.md", "Archive/Old projects/2026/Q4.md"),
                ("Projects/Plan.md", "Archive/Old projects/Plan.md")
            ]
        );
        assert!(!root.join("Projects").exists());
        assert_eq!(
            fs::read_to_string(root.join("Archive/Old projects/diagram.png")).unwrap(),
            "png"
        );
        assert_eq!(
            fs::read_to_string(root.join("Home.md")).unwrap(),
            "[[Plan]] [[Archive/Old projects/Plan]] [p](Archive/Old%20projects/Plan.md) ![](Archive/Old%20projects/diagram.png) ![[Archive/Old projects/diagram.png]] ![[diagram.png]]\n"
        );
        // Links between notes inside the folder still work as written; links out of it follow its depth.
        assert_eq!(
            fs::read_to_string(root.join("Archive/Old projects/Plan.md")).unwrap(),
            "[[Archive/Old projects/2026/Q4]] [home](../../Home.md) ![](diagram.png) [q4](2026/Q4.md)\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("Archive/Old projects/2026/Q4.md")).unwrap(),
            "# Q4\n[plan](../Plan.md)\n"
        );

        // Never into itself, never over something that exists.
        assert!(rename_folder(&root, "Archive", "Archive/Inner").is_err());
        fs::create_dir_all(root.join("Other")).unwrap();
        fs::write(root.join("Other/x.md"), "x").unwrap();
        assert!(matches!(
            rename_folder(&root, "Archive", "Other"),
            Err(AppError::AlreadyExists(_))
        ));
        assert!(matches!(
            rename_folder(&root, "Nope", "Elsewhere"),
            Err(AppError::NotFound(_))
        ));

        let contents = folder_contents(&root, "Archive").unwrap();
        assert_eq!((contents.notes, contents.files), (2, 1));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn attachments_rename_and_usage() {
        let root = temp_vault("attach-rename");
        fs::create_dir_all(root.join("Attachments")).unwrap();
        fs::create_dir_all(root.join("Projects")).unwrap();
        fs::write(root.join("Attachments/pic.png"), "png").unwrap();
        fs::write(root.join("Attachments/unused.pdf"), "pdf").unwrap();
        fs::write(
            root.join("Projects/Plan.md"),
            "![](../Attachments/pic.png) and ![[pic.png]]\n",
        )
        .unwrap();
        fs::write(root.join("Home.md"), "![](Attachments/pic.png)\n").unwrap();

        let usage = attachment_usage(&root).unwrap();
        let summary: Vec<_> = usage
            .iter()
            .map(|u| (u.path.as_str(), u.notes.len(), u.size))
            .collect();
        assert_eq!(
            summary,
            [
                ("Attachments/pic.png", 2, 3),
                ("Attachments/unused.pdf", 0, 3)
            ]
        );

        let out =
            rename_attachment(&root, "Attachments/pic.png", "Attachments/Diagram 1.png").unwrap();
        assert_eq!(out.links, 3);
        assert_eq!(
            fs::read_to_string(root.join("Projects/Plan.md")).unwrap(),
            "![](../Attachments/Diagram%201.png) and ![[Diagram 1.png]]\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("Home.md")).unwrap(),
            "![](Attachments/Diagram%201.png)\n"
        );
        assert!(rename_attachment(&root, "Attachments/unused.pdf", "Attachments/note.md").is_err());
        assert!(rename_attachment(&root, "Home.md", "Home2.md").is_err());
        assert!(matches!(
            rename_attachment(&root, "Attachments/unused.pdf", "Attachments/Diagram 1.png"),
            Err(AppError::AlreadyExists(_))
        ));
        assert!(matches!(
            delete_attachments(&root, &["Missing.png".to_owned()]),
            Err(AppError::NotFound(_))
        ));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn vault_settings_round_trip() {
        let root = temp_vault("settings");
        assert_eq!(read_vault_settings(&root).unwrap(), None);
        write_vault_settings(&root, r#"{"daily":{"folder":"Journal"}}"#).unwrap();
        assert_eq!(
            read_vault_settings(&root).unwrap().as_deref(),
            Some(r#"{"daily":{"folder":"Journal"}}"#)
        );
        assert!(write_vault_settings(&root, "not json").is_err());
        assert!(
            scan_tree(&root).unwrap().is_empty(),
            ".penna stays hidden from the tree"
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn write_then_read_round_trips() {
        let root = temp_vault("rw");
        let modified = write_note(&root, "sub/note.md", "# Hello\r\n").unwrap();
        let note = read_note(&root, "sub/note.md").unwrap();
        assert_eq!(note.content, "# Hello\r\n");
        assert_eq!(note.modified, modified);
        assert!(modified > 0);
        assert!(matches!(
            create_note(&root, "sub/note.md", "new"),
            Err(AppError::AlreadyExists(_))
        ));
        assert_eq!(
            read_note(&root, "sub/note.md").unwrap().content,
            "# Hello\r\n",
            "never overwritten"
        );
        assert!(write_note(&root, "script.js", "").is_err());

        create_note(&root, "Journal/2026-10-17.md", "# Saturday\n").unwrap();
        assert_eq!(
            read_note(&root, "Journal/2026-10-17.md").unwrap().content,
            "# Saturday\n"
        );
        let recent = recent_notes(&root, 10).unwrap();
        assert_eq!(recent.len(), 2);
        assert!(recent[0].modified >= recent[1].modified);
        fs::remove_dir_all(&root).unwrap();
    }
}
