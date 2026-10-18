//! Git integration built on `git2` (libgit2).
//!
//! Every function here is synchronous and may block on disk or network I/O.
//! Callers must run them on a blocking thread (`tokio::task::spawn_blocking`).
//!
//! `git2::Repository` is `Send` but not `Sync`. Each operation opens its own
//! handle instead of sharing one behind a lock. Opening is cheap compared with
//! the work done, and a handle is never held while the repo changes on disk.
//!
//! Safety rules this module follows:
//! - **Pull never overwrites uncommitted work.** Checkouts use libgit2's *safe*
//!   strategy, and the working tree is updated *before* the branch ref moves,
//!   so a refused checkout leaves the branch untouched.
//! - **Merges are computed in memory first.** If a merge would conflict,
//!   `pull` changes nothing and reports the paths. Only `sync`, after it has
//!   saved every local edit as a version, goes on to write the merge into the
//!   folder with conflict markers, so the person can choose (see
//!   [`merge_state`], [`finish_merge`], [`abort_merge`]).
//! - **Push rejections are errors**, not silent no-ops.

use std::cell::RefCell;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use git2::build::CheckoutBuilder;
use git2::{
    Commit, Config, Cred, CredentialType, ErrorCode, FetchOptions, Index, IndexAddOption,
    IndexMatchedPath, Oid, PushOptions, RemoteCallbacks, Repository, RepositoryInitOptions,
    RepositoryState, Signature, Sort, StatusOptions,
};
use serde::Serialize;

use crate::error::{AppError, AppResult};

pub const DEFAULT_REMOTE: &str = "origin";
const DEFAULT_BRANCH: &str = "main";
/// Commit identity used only when git has no `user.name` / `user.email`.
const FALLBACK_NAME: &str = "Penna";
const FALLBACK_EMAIL: &str = "penna@localhost";
/// Suffix of the temp files `vault::write_note` renames into place.
const TEMP_SUFFIX: &str = ".penna-tmp";

// ---------------------------------------------------------------------------
// Types shared with the frontend (mirrored in src/services/tauri.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub author: String,
    /// The device that saved it, from a `Device: …` line in the message (Penna adds one).
    pub device: Option<String>,
    /// Seconds since the Unix epoch.
    pub timestamp: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    /// Current branch; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Paths that differ from HEAD: staged, unstaged, or untracked.
    pub changed_files: usize,
    /// Those paths, repo-relative with `/` separators, sorted.
    pub changed_paths: Vec<String>,
    pub conflicted_files: usize,
    /// A sync stopped to ask which version to keep (the repository is merging).
    pub merging: bool,
    /// An `origin` remote is configured.
    pub has_remote: bool,
    /// The remote-tracking branch exists locally, so `ahead`/`behind` are meaningful.
    pub has_upstream: bool,
    pub ahead: usize,
    pub behind: usize,
    pub last_commit: Option<CommitInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PullOutcome {
    /// Nothing new, or the remote branch doesn't exist yet.
    UpToDate,
    FastForwarded {
        commit: String,
    },
    Merged {
        commit: String,
    },
    /// Both sides changed the same lines; nothing was changed (`pull` only).
    WouldConflict {
        paths: Vec<String>,
    },
    /// The merge is in the folder with conflict markers in these notes, and
    /// waits for the person's choices (`sync` only).
    Conflicts {
        paths: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    /// The commit created for local changes, if there were any.
    pub committed: Option<CommitInfo>,
    /// `None` when the vault has no remote (commit-only backup).
    pub pull: Option<PullOutcome>,
    pub pushed: bool,
}

// ---------------------------------------------------------------------------
// Repository access and inspection
// ---------------------------------------------------------------------------

/// Open the repository rooted exactly at `path` (the vault root). Parent
/// folders are not searched, because vault-relative paths must equal
/// repo-relative paths for staging to work.
pub fn open(path: &Path) -> AppResult<Repository> {
    Ok(Repository::open(path)?)
}

/// `git init` with `main` as the initial branch. Fails if `path` is already
/// a repository.
///
/// Deliberately writes no files (not even a `.gitignore`). An empty vault on a
/// second machine stays "unborn", so its first Sync just adopts the remote
/// history instead of merging two unrelated histories. Temp files are kept out
/// of commits by `stage_all` instead.
pub fn init(path: &Path) -> AppResult<()> {
    let mut opts = RepositoryInitOptions::new();
    opts.initial_head(DEFAULT_BRANCH).no_reinit(true);
    Repository::init_opts(path, &opts)?;
    Ok(())
}

/// Snapshot for the status bar. A folder that isn't a repository returns
/// `is_repo: false` rather than an error, so the UI can offer "Init repo".
pub fn status(path: &Path) -> AppResult<GitStatus> {
    let repo = match Repository::open(path) {
        Ok(repo) => repo,
        Err(e) if e.code() == ErrorCode::NotFound => return Ok(GitStatus::default()),
        Err(e) => return Err(e.into()),
    };

    let mut status = GitStatus {
        is_repo: true,
        merging: repo.state() == RepositoryState::Merge,
        branch: current_branch(&repo)?,
        has_remote: repo.find_remote(DEFAULT_REMOTE).is_ok(),
        ..GitStatus::default()
    };

    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .exclude_submodules(true);
    for entry in repo.statuses(Some(&mut opts))?.iter() {
        let s = entry.status();
        if s.is_conflicted() {
            status.conflicted_files += 1;
        }
        if !s.is_empty() && !s.is_ignored() {
            status.changed_files += 1;
            if let Ok(path) = entry.path() {
                status.changed_paths.push(path.to_owned());
            }
        }
    }
    status.changed_paths.sort_unstable();

    let head = head_commit(&repo)?;
    if let (Some(branch), Some(head)) = (&status.branch, &head) {
        let upstream = upstream_ref(&repo, DEFAULT_REMOTE, branch);
        if let Ok(upstream_oid) = repo.refname_to_id(&upstream) {
            let (ahead, behind) = repo.graph_ahead_behind(head.id(), upstream_oid)?;
            status.has_upstream = true;
            status.ahead = ahead;
            status.behind = behind;
        }
    }
    status.last_commit = head.as_ref().map(commit_info);

    Ok(status)
}

/// Branch HEAD points at, including an "unborn" branch on a repo with no
/// commits yet. `None` when HEAD is detached.
fn current_branch(repo: &Repository) -> AppResult<Option<String>> {
    if repo.head_detached()? {
        return Ok(None);
    }
    let head = repo.find_reference("HEAD")?;
    let target = head.symbolic_target()?;
    Ok(target
        .and_then(|t| t.strip_prefix("refs/heads/"))
        .map(str::to_owned))
}

/// The commit HEAD points at, or `None` on an unborn branch.
fn head_commit(repo: &Repository) -> AppResult<Option<Commit<'_>>> {
    match repo.head() {
        Ok(head) => Ok(Some(head.peel_to_commit()?)),
        Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// The remote-tracking ref for `branch`: the configured upstream
/// (`branch.<name>.merge`) if any, else `refs/remotes/<remote>/<branch>`.
fn upstream_ref(repo: &Repository, remote: &str, branch: &str) -> String {
    repo.branch_upstream_name(&format!("refs/heads/{branch}"))
        .ok()
        .and_then(|buf| buf.as_str().ok().map(str::to_owned))
        .unwrap_or_else(|| format!("refs/remotes/{remote}/{branch}"))
}

fn commit_info(commit: &Commit<'_>) -> CommitInfo {
    let id = commit.id().to_string();
    CommitInfo {
        short_id: id.chars().take(7).collect(),
        summary: commit
            .summary()
            .ok()
            .flatten()
            .unwrap_or_default()
            .to_owned(),
        author: commit.author().name().unwrap_or_default().to_owned(),
        device: commit.message().ok().and_then(device_trailer),
        timestamp: commit.time().seconds(),
        id,
    }
}

/// The last `Device: …` trailer in a commit message.
fn device_trailer(message: &str) -> Option<String> {
    message
        .lines()
        .filter_map(|line| line.strip_prefix("Device:"))
        .map(|name| name.trim().to_owned())
        .rfind(|name| !name.is_empty())
}

/// Refuse to act while a merge, rebase, etc. is half-finished (e.g. started
/// from the command line). Committing on top of that state corrupts history.
fn ensure_clean_state(repo: &Repository) -> AppResult<()> {
    let busy = match repo.state() {
        RepositoryState::Clean => return Ok(()),
        RepositoryState::Merge => "merge",
        RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherry-pick",
        RepositoryState::Bisect => "bisect",
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => "rebase",
        RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => "patch apply",
    };
    Err(AppError::RepoBusy(busy.to_owned()))
}

fn conflict_paths(index: &Index) -> AppResult<Vec<String>> {
    let mut paths = Vec::new();
    for conflict in index.conflicts()? {
        let conflict = conflict?;
        if let Some(entry) = conflict.our.or(conflict.their).or(conflict.ancestor) {
            paths.push(String::from_utf8_lossy(&entry.path).into_owned());
        }
    }
    paths.sort_unstable();
    paths.dedup();
    Ok(paths)
}

// ---------------------------------------------------------------------------
// Stage and commit
// ---------------------------------------------------------------------------

/// `git add <path>` for one vault-relative path. Stages a deletion if the
/// file no longer exists. Callers must validate `rel` with `vault::resolve`.
pub fn stage_path(repo: &Repository, rel: &str) -> AppResult<()> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("repository has no working directory"))?;
    let path = Path::new(rel);
    let mut index = repo.index()?;
    if workdir.join(path).exists() {
        index.add_path(path)?;
    } else {
        index.remove_path(path)?;
    }
    index.write()?;
    Ok(())
}

/// `git add -A`: stage new, modified, and deleted files. Respects
/// `.gitignore` and always skips in-flight temp files.
pub fn stage_all(repo: &Repository) -> AppResult<()> {
    let mut index = repo.index()?;
    // Returning > 0 skips the path, 0 stages it.
    let skip_temp: &mut IndexMatchedPath<'_> =
        &mut |path: &Path, _spec: &[u8]| i32::from(path.to_string_lossy().ends_with(TEMP_SUFFIX));
    index.add_all(["*"], IndexAddOption::DEFAULT, Some(skip_temp))?;
    index.update_all(["*"], None)?;
    index.write()?;
    Ok(())
}

/// Commit what is staged. Returns `Ok(None)` without creating a commit when
/// the index matches HEAD, so callers can commit without making empty commits.
pub fn commit(repo: &Repository, message: &str) -> AppResult<Option<CommitInfo>> {
    ensure_clean_state(repo)?;

    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Err(AppError::MergeConflict(conflict_paths(&index)?));
    }

    let tree_id = index.write_tree()?;
    let parent = head_commit(repo)?;
    let unchanged = match &parent {
        Some(parent) => parent.tree_id() == tree_id,
        None => index.is_empty(),
    };
    if unchanged {
        return Ok(None);
    }

    let tree = repo.find_tree(tree_id)?;
    let sig = signature(repo)?;
    let parents: Vec<&Commit<'_>> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;
    Ok(Some(commit_info(&repo.find_commit(oid)?)))
}

/// Author and committer from git config (`user.name` / `user.email`). Falls
/// back to a placeholder so a machine without git identity can still back up.
fn signature(repo: &Repository) -> AppResult<Signature<'static>> {
    match repo.signature() {
        Ok(sig) => Ok(sig),
        Err(e) if e.code() == ErrorCode::NotFound => {
            Ok(Signature::now(FALLBACK_NAME, FALLBACK_EMAIL)?)
        }
        Err(e) => Err(e.into()),
    }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/// Tracks which credential sources have been tried. libgit2 calls the
/// credentials callback again after every failed attempt, so without this a
/// bad credential would retry forever.
#[derive(Default)]
struct CredentialAttempts {
    username: bool,
    ssh_agent: bool,
    ssh_keys_tried: usize,
    helper: bool,
    default: bool,
}

impl CredentialAttempts {
    fn next(
        &mut self,
        config: &Config,
        url: &str,
        username_from_url: Option<&str>,
        allowed: CredentialType,
    ) -> Result<Cred, git2::Error> {
        let user = username_from_url.unwrap_or("git");

        // SSH URL without a user: libgit2 asks for the username first.
        if allowed.contains(CredentialType::USERNAME) && !self.username {
            self.username = true;
            return Cred::username(user);
        }

        if allowed.contains(CredentialType::SSH_KEY) {
            // 1. ssh-agent: the Windows OpenSSH agent service or Pageant.
            if !self.ssh_agent {
                self.ssh_agent = true;
                return Cred::ssh_key_from_agent(user);
            }
            // 2. Default key files in ~/.ssh that have no passphrase.
            if let Some(key) = default_ssh_keys().get(self.ssh_keys_tried) {
                self.ssh_keys_tried += 1;
                return Cred::ssh_key(user, None, key, None);
            }
        }

        // 3. HTTPS: git's configured credential helper (Git Credential Manager on Windows).
        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) && !self.helper {
            self.helper = true;
            if let Ok(cred) = Cred::credential_helper(config, url, username_from_url) {
                return Ok(cred);
            }
        }

        // 4. Integrated Windows auth (NTLM/Negotiate), for corporate servers.
        if allowed.contains(CredentialType::DEFAULT) && !self.default {
            self.default = true;
            return Cred::default();
        }

        Err(git2::Error::from_str(
            "authentication failed: for SSH remotes, load a key into ssh-agent; \
             for HTTPS remotes, sign in once with `git fetch` so Git Credential Manager stores a token",
        ))
    }
}

fn default_ssh_keys() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return Vec::new();
    };
    let ssh_dir = PathBuf::from(home).join(".ssh");
    ["id_ed25519", "id_ecdsa", "id_rsa"]
        .iter()
        .map(|name| ssh_dir.join(name))
        .filter(|path| path.is_file())
        .collect()
}

fn remote_callbacks<'a>(repo: &Repository) -> AppResult<RemoteCallbacks<'a>> {
    let config = repo.config()?;
    let mut attempts = CredentialAttempts::default();
    let mut callbacks = RemoteCallbacks::new();
    callbacks
        .credentials(move |url, username, allowed| attempts.next(&config, url, username, allowed));
    Ok(callbacks)
}

// ---------------------------------------------------------------------------
// Fetch, pull, push
// ---------------------------------------------------------------------------

fn fetch(repo: &Repository, remote_name: &str) -> AppResult<()> {
    let mut remote = repo
        .find_remote(remote_name)
        .map_err(|_| AppError::NoRemote(remote_name.to_owned()))?;
    let mut opts = FetchOptions::new();
    opts.remote_callbacks(remote_callbacks(repo)?);
    // No explicit refspecs, so the remote's configured ones are used, which
    // updates every `refs/remotes/<remote>/*` tracking branch.
    remote.fetch(&[] as &[&str], Some(&mut opts), None)?;
    Ok(())
}

/// Update the working tree and index to match `commit` without losing
/// uncommitted work. The safe strategy refuses to overwrite modified or
/// untracked files and fails with a conflict instead.
///
/// Call this before moving the branch ref, so a refusal leaves HEAD unchanged.
fn checkout_safely(repo: &Repository, commit: &Commit<'_>) -> AppResult<()> {
    let mut opts = CheckoutBuilder::new();
    opts.safe();
    repo.checkout_tree(commit.as_object(), Some(&mut opts))?;
    Ok(())
}

/// `git pull` for the current branch: fetch, then fast-forward or merge.
///
/// A merge that would conflict changes nothing and returns
/// [`PullOutcome::WouldConflict`] with the affected paths.
pub fn pull(repo: &Repository, remote_name: &str) -> AppResult<PullOutcome> {
    ensure_clean_state(repo)?;
    let branch = current_branch(repo)?.ok_or(AppError::DetachedHead)?;
    fetch(repo, remote_name)?;

    let upstream = upstream_ref(repo, remote_name, &branch);
    let their_oid = match repo.refname_to_id(&upstream) {
        Ok(oid) => oid,
        // The remote branch doesn't exist yet (e.g. an empty remote before the first push).
        Err(e) if e.code() == ErrorCode::NotFound => return Ok(PullOutcome::UpToDate),
        Err(e) => return Err(e.into()),
    };
    let theirs = repo.find_commit(their_oid)?;
    let branch_ref = format!("refs/heads/{branch}");

    // Unborn local branch (fresh repo + remote added): adopt the remote history.
    let Some(ours) = head_commit(repo)? else {
        checkout_safely(repo, &theirs)?;
        repo.reference(&branch_ref, their_oid, false, "penna: initial pull")?;
        return Ok(PullOutcome::FastForwarded {
            commit: their_oid.to_string(),
        });
    };

    let annotated = repo.find_annotated_commit(their_oid)?;
    let (analysis, _preference) = repo.merge_analysis(&[&annotated])?;

    if analysis.is_up_to_date() {
        return Ok(PullOutcome::UpToDate);
    }

    if analysis.is_fast_forward() {
        checkout_safely(repo, &theirs)?;
        repo.find_reference(&branch_ref)?
            .set_target(their_oid, "penna: fast-forward pull")?;
        return Ok(PullOutcome::FastForwarded {
            commit: their_oid.to_string(),
        });
    }

    // Diverged. Merge in memory first so a conflict never touches the working tree.
    let mut merged = repo.merge_commits(&ours, &theirs, None)?;
    if merged.has_conflicts() {
        return Ok(PullOutcome::WouldConflict {
            paths: conflict_paths(&merged)?,
        });
    }

    let tree = repo.find_tree(merged.write_tree_to(repo)?)?;
    let sig = signature(repo)?;
    let upstream_short = upstream.strip_prefix("refs/remotes/").unwrap_or(&upstream);
    let message = format!("Merge {upstream_short} into {branch}");
    // `None` = create the commit object without moving any ref yet.
    let merge_oid = repo.commit(None, &sig, &sig, &message, &tree, &[&ours, &theirs])?;

    checkout_safely(repo, &repo.find_commit(merge_oid)?)?;
    repo.find_reference(&branch_ref)?
        .set_target(merge_oid, "penna: merge pull")?;
    Ok(PullOutcome::Merged {
        commit: merge_oid.to_string(),
    })
}

/// `git push <remote> <branch>`. Returns `Ok(false)` when there is nothing
/// to push. Sets the branch's upstream after the first push so status can
/// report ahead/behind.
pub fn push(repo: &Repository, remote_name: &str) -> AppResult<bool> {
    let branch = current_branch(repo)?.ok_or(AppError::DetachedHead)?;
    let Some(head) = head_commit(repo)? else {
        return Ok(false); // no commits yet
    };
    if let Ok(upstream_oid) = repo.refname_to_id(&upstream_ref(repo, remote_name, &branch))
        && upstream_oid == head.id()
    {
        return Ok(false); // remote already has this commit
    }

    let mut remote = repo
        .find_remote(remote_name)
        .map_err(|_| AppError::NoRemote(remote_name.to_owned()))?;
    let refname = format!("refs/heads/{branch}");

    // `push()` returns Ok even when the server rejects a ref (e.g. non-fast-forward),
    // so record rejections from the callback and check them afterwards.
    let rejection: RefCell<Option<(String, String)>> = RefCell::new(None);
    {
        let mut callbacks = remote_callbacks(repo)?;
        callbacks.push_update_reference(|refname, status| {
            if let Some(reason) = status {
                *rejection.borrow_mut() = Some((refname.to_owned(), reason.to_owned()));
            }
            Ok(())
        });
        let mut opts = PushOptions::new();
        opts.remote_callbacks(callbacks);
        remote.push(&[format!("{refname}:{refname}")], Some(&mut opts))?;
    }
    if let Some((refname, reason)) = rejection.take() {
        return Err(AppError::PushRejected { refname, reason });
    }

    // First push: record the upstream like `git push -u` does.
    let mut config = repo.config()?;
    let remote_key = format!("branch.{branch}.remote");
    if config.get_string(&remote_key).is_err() {
        config.set_str(&remote_key, remote_name)?;
        config.set_str(&format!("branch.{branch}.merge"), &refname)?;
    }
    Ok(true)
}

/// What the Sync button does: stage everything, commit, pull, then push.
/// Without a remote it only commits, so local-only vaults still get history.
pub fn sync(path: &Path, message: &str) -> AppResult<SyncOutcome> {
    let repo = open(path)?;
    stage_all(&repo)?;
    let committed = commit(&repo, message)?;

    if repo.find_remote(DEFAULT_REMOTE).is_err() {
        return Ok(SyncOutcome {
            committed,
            pull: None,
            pushed: false,
        });
    }

    let pull = match pull(&repo, DEFAULT_REMOTE)? {
        // Every local edit is in a version now, so the merge can go into the folder.
        PullOutcome::WouldConflict { .. } => {
            let branch = current_branch(&repo)?.ok_or(AppError::DetachedHead)?;
            let theirs = repo
                .find_reference(&upstream_ref(&repo, DEFAULT_REMOTE, &branch))?
                .peel_to_commit()?;
            let paths = start_merge(&repo, &theirs)?;
            return Ok(SyncOutcome {
                committed,
                pull: Some(PullOutcome::Conflicts { paths }),
                pushed: false,
            });
        }
        outcome => outcome,
    };
    let pushed = push(&repo, DEFAULT_REMOTE)?;
    Ok(SyncOutcome {
        committed,
        pull: Some(pull),
        pushed,
    })
}

// ---------------------------------------------------------------------------
// Conflicts that need a choice
// ---------------------------------------------------------------------------

/// A sync that stopped to ask: both versions and the notes that need a choice.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeState {
    /// This device's last version.
    pub ours: Option<CommitInfo>,
    /// The other device's version being merged in.
    pub theirs: Option<CommitInfo>,
    pub notes: Vec<ConflictNote>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictNote {
    pub path: String,
    /// Conflict blocks still in the file; 0 once every place has a choice.
    pub places: usize,
}

/// How many complete `<<<<<<<` … `>>>>>>>` blocks a note still holds.
pub fn count_conflicts(text: &str) -> usize {
    let mut open = false;
    let mut count = 0;
    for line in text.lines() {
        if line.starts_with("<<<<<<<") {
            open = true;
        } else if open && line.starts_with(">>>>>>>") {
            open = false;
            count += 1;
        }
    }
    count
}

fn is_hidden_path(rel: &str) -> bool {
    rel.split('/').any(|seg| seg.starts_with('.'))
}

/// `photo.png` → `photo (from Laptop).png`, for keeping the other device's copy.
fn sibling_name(rel: &str, label: &str) -> String {
    let (folder, name) = rel.rsplit_once('/').map_or(("", rel), |(f, n)| (f, n));
    let (stem, ext) = name.rsplit_once('.').map_or((name, ""), |(s, e)| (s, e));
    let label: String = label
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
        .collect();
    let file = if ext.is_empty() {
        format!("{stem} (from {label})")
    } else {
        format!("{stem} (from {label}).{ext}")
    };
    if folder.is_empty() {
        file
    } else {
        format!("{folder}/{file}")
    }
}

fn write_blob(repo: &Repository, workdir: &Path, rel: &str, id: Oid) -> AppResult<()> {
    let path = workdir.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| AppError::Io {
            context: format!("creating folder '{}'", parent.display()),
            source,
        })?;
    }
    fs::write(&path, repo.find_blob(id)?.content()).map_err(|source| AppError::Io {
        context: format!("writing '{}'", path.display()),
        source,
    })
}

/// Write a merge that has conflicts into the folder and leave the repository
/// merging. Notes get Git's conflict markers, labelled with each device's
/// name. Conflicts markers can't express are settled here without losing a
/// version: a file both devices changed keeps this device's copy and gets the
/// other one beside it, and a note deleted on one side but edited on the other
/// keeps the edit. Returns the notes that need a choice.
fn start_merge(repo: &Repository, theirs: &Commit<'_>) -> AppResult<Vec<String>> {
    let ours =
        head_commit(repo)?.ok_or_else(|| git2::Error::from_str("nothing to merge into yet"))?;
    let our_label = ours
        .message()
        .ok()
        .and_then(device_trailer)
        .unwrap_or_else(|| "This PC".to_owned());
    let mut their_label = theirs
        .message()
        .ok()
        .and_then(device_trailer)
        .unwrap_or_else(|| "Other device".to_owned());
    if their_label == our_label {
        their_label = format!("{their_label} (other copy)");
    }

    let annotated = repo.find_annotated_commit(theirs.id())?;
    let mut checkout = CheckoutBuilder::new();
    checkout
        .safe()
        .allow_conflicts(true)
        .conflict_style_merge(true)
        .our_label(&our_label)
        .their_label(&their_label);
    repo.merge(&[&annotated], None, Some(&mut checkout))?;

    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("repository has no working directory"))?
        .to_path_buf();
    let mut index = repo.index()?;
    let conflicts: Vec<git2::IndexConflict> = index.conflicts()?.collect::<Result<_, _>>()?;
    let mut notes = Vec::new();
    for conflict in conflicts {
        let Some(entry) = conflict
            .our
            .as_ref()
            .or(conflict.their.as_ref())
            .or(conflict.ancestor.as_ref())
        else {
            continue;
        };
        let rel = String::from_utf8_lossy(&entry.path).into_owned();
        let note = crate::vault::is_note(Path::new(&rel)) && !is_hidden_path(&rel);
        match (&conflict.our, &conflict.their) {
            (Some(_), Some(_)) if note => {
                notes.push(rel); // markers in the file: the person chooses
                continue;
            }
            (Some(our), Some(their)) => {
                write_blob(repo, &workdir, &rel, our.id)?;
                if !is_hidden_path(&rel) {
                    let side = sibling_name(&rel, &their_label);
                    write_blob(repo, &workdir, &side, their.id)?;
                    index.add_path(Path::new(&side))?;
                }
                index.add_path(Path::new(&rel))?;
            }
            (Some(only), None) | (None, Some(only)) => {
                write_blob(repo, &workdir, &rel, only.id)?;
                index.add_path(Path::new(&rel))?;
            }
            (None, None) => index.remove_path(Path::new(&rel))?,
        }
    }
    index.write()?;
    notes.sort_unstable();
    Ok(notes)
}

/// The other device's commit being merged in (`MERGE_HEAD`).
fn merge_head(repo: &mut Repository) -> Option<Oid> {
    let mut id = None;
    repo.mergehead_foreach(|oid| {
        id = Some(*oid);
        false // the first one is enough
    })
    .ok();
    id
}

/// The paused sync, or `None` when the vault isn't in the middle of one.
pub fn merge_state(repo_path: &Path) -> AppResult<Option<MergeState>> {
    let Some(mut repo) = open_existing(repo_path)? else {
        return Ok(None);
    };
    if repo.state() != RepositoryState::Merge {
        return Ok(None);
    }
    let their_id = merge_head(&mut repo);
    let ours = head_commit(&repo)?.as_ref().map(commit_info);
    let theirs = their_id
        .and_then(|id| repo.find_commit(id).ok())
        .as_ref()
        .map(commit_info);
    let workdir = repo.workdir().map(Path::to_path_buf).unwrap_or_default();
    let notes = conflict_paths(&repo.index()?)?
        .into_iter()
        .filter(|p| crate::vault::is_note(Path::new(p)) && !is_hidden_path(p))
        .map(|path| ConflictNote {
            places: fs::read_to_string(workdir.join(&path))
                .map(|t| count_conflicts(&t))
                .unwrap_or(0),
            path,
        })
        .collect();
    Ok(Some(MergeState {
        ours,
        theirs,
        notes,
    }))
}

/// Finish a paused sync once every note has a choice: save the merge as a
/// version with both devices' versions as parents, then send it.
pub fn finish_merge(repo_path: &Path, message: &str) -> AppResult<SyncOutcome> {
    let Some(state) = merge_state(repo_path)? else {
        return Err(AppError::NotMerging);
    };
    let left: Vec<String> = state
        .notes
        .iter()
        .filter(|n| n.places > 0)
        .map(|n| n.path.clone())
        .collect();
    if !left.is_empty() {
        return Err(AppError::ChoicesLeft(left));
    }
    let mut repo = open(repo_path)?;
    let their_id = merge_head(&mut repo).ok_or(AppError::NotMerging)?;
    stage_all(&repo)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("repository has no working directory"))?
        .to_path_buf();
    let mut index = repo.index()?;
    // Anything still marked as conflicting is taken as it is in the folder.
    for path in conflict_paths(&index)? {
        if workdir.join(&path).exists() {
            index.add_path(Path::new(&path))?;
        } else {
            index.remove_path(Path::new(&path))?;
        }
    }
    index.write()?;
    let tree = repo.find_tree(index.write_tree()?)?;
    let ours = head_commit(&repo)?.ok_or_else(|| git2::Error::from_str("nothing to merge into"))?;
    let theirs = repo.find_commit(their_id)?;
    let sig = signature(&repo)?;
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &[&ours, &theirs])?;
    repo.cleanup_state()?;
    let committed = commit_info(&repo.find_commit(oid)?);
    let pushed = repo.find_remote(DEFAULT_REMOTE).is_ok() && push(&repo, DEFAULT_REMOTE)?;
    Ok(SyncOutcome {
        committed: Some(committed),
        pull: Some(PullOutcome::Merged {
            commit: oid.to_string(),
        }),
        pushed,
    })
}

/// Stop a paused sync: the notes go back to this device's last version and
/// the other device's changes wait for the next sync. Files the merge changed
/// that the person edited since are left as they are, and so is everything
/// else they changed meanwhile.
pub fn abort_merge(repo_path: &Path) -> AppResult<()> {
    let repo = open(repo_path)?;
    if repo.state() != RepositoryState::Merge {
        return Ok(());
    }
    let head = head_commit(&repo)?.ok_or_else(|| git2::Error::from_str("nothing to go back to"))?;
    let head_tree = head.tree()?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("repository has no working directory"))?
        .to_path_buf();
    let index = repo.index()?;
    let conflicted: HashSet<String> = conflict_paths(&index)?.into_iter().collect();
    let in_head = |rel: &str| head_tree.get_path(Path::new(rel)).is_ok();

    let mut restore = Vec::new();
    let mut remove = Vec::new();
    for rel in &conflicted {
        if in_head(rel) {
            restore.push(rel.clone())
        } else {
            remove.push(rel.clone())
        }
    }
    let diff = repo.diff_tree_to_index(Some(&head_tree), Some(&index), None)?;
    for delta in diff.deltas() {
        let Some(rel) = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(path_string)
        else {
            continue;
        };
        if conflicted.contains(&rel) {
            continue;
        }
        // Edited since the merge started: the person's text stays.
        let edited = repo
            .status_file(Path::new(&rel))
            .map(|s| {
                s.intersects(
                    git2::Status::WT_MODIFIED | git2::Status::WT_DELETED | git2::Status::WT_RENAMED,
                )
            })
            .unwrap_or(false);
        if edited {
            continue;
        }
        if in_head(&rel) {
            restore.push(rel)
        } else {
            remove.push(rel)
        }
    }

    if !restore.is_empty() {
        let mut checkout = CheckoutBuilder::new();
        checkout.force();
        for rel in &restore {
            checkout.path(rel.as_str());
        }
        repo.checkout_tree(head_tree.as_object(), Some(&mut checkout))?;
    }
    for rel in &remove {
        let _ = fs::remove_file(workdir.join(rel));
    }
    let mut index = repo.index()?;
    index.read_tree(&head_tree)?;
    index.write()?;
    repo.cleanup_state()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Per-note history (the Changes view and the margin's "versions" line)
// ---------------------------------------------------------------------------

/// Which version the Changes view compares a note against.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BaseKind {
    /// The commit the remote-tracking branch points at: what you last synced.
    LastSync,
    /// No remote yet, so the last local commit.
    LastVersion,
    /// Not a repository, or no commits yet.
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteBase {
    pub kind: BaseKind,
    /// The note's text in that version; `None` if the note didn't exist then.
    pub content: Option<String>,
    pub commit: Option<CommitInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteHistory {
    /// Commits that changed the note, newest first.
    pub versions: Vec<CommitInfo>,
    /// The walk stopped at its limit, so older versions exist.
    pub more: bool,
}

/// Blob id of `path` in `commit`'s tree, or `None` if it isn't there.
fn entry_id(commit: &Commit<'_>, path: &Path) -> AppResult<Option<Oid>> {
    match commit.tree()?.get_path(path) {
        Ok(entry) => Ok(Some(entry.id())),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// The note's text in `commit`. Content is stored normalized (LF) when
/// `core.autocrlf` is on; callers compare line by line, so that's fine.
fn text_at(repo: &Repository, commit: &Commit<'_>, path: &Path) -> AppResult<Option<String>> {
    let Some(id) = entry_id(commit, path)? else {
        return Ok(None);
    };
    let blob = repo.find_blob(id)?;
    Ok(Some(String::from_utf8_lossy(blob.content()).into_owned()))
}

fn open_existing(path: &Path) -> AppResult<Option<Repository>> {
    match Repository::open(path) {
        Ok(repo) => Ok(Some(repo)),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// The commit that "since your last sync" means: the remote-tracking branch
/// when there is one, else the last local commit. `None` before any commit.
fn sync_base(repo: &Repository) -> AppResult<Option<(BaseKind, Commit<'_>)>> {
    let Some(head) = head_commit(repo)? else {
        return Ok(None);
    };
    let synced = current_branch(repo)?
        .and_then(|branch| {
            repo.refname_to_id(&upstream_ref(repo, DEFAULT_REMOTE, &branch))
                .ok()
        })
        .and_then(|oid| repo.find_commit(oid).ok());
    Ok(Some(match synced {
        Some(commit) => (BaseKind::LastSync, commit),
        None => (BaseKind::LastVersion, head),
    }))
}

/// The version of a note that "Changes" compares against: the last synced
/// commit when the branch has a remote-tracking ref, else the last commit.
pub fn note_base(repo_path: &Path, rel: &str) -> AppResult<NoteBase> {
    let none = NoteBase {
        kind: BaseKind::None,
        content: None,
        commit: None,
    };
    let Some(repo) = open_existing(repo_path)? else {
        return Ok(none);
    };
    let Some((kind, base)) = sync_base(&repo)? else {
        return Ok(none);
    };
    let mut content = text_at(&repo, &base, Path::new(rel))?;
    // Renamed since then: compare with the note under its old name.
    if content.is_none()
        && let Some(old) = renamed_since(&repo, Some(&base.tree()?), rel)?
    {
        content = text_at(&repo, &base, Path::new(&old))?;
    }
    Ok(NoteBase {
        kind,
        content,
        commit: Some(commit_info(&base)),
    })
}

/// How far back `note_at` looks for a note's older names.
const FOLLOW_LIMIT: usize = 500;

/// Where `rel` was before a rename between `tree` and the folder (whether or
/// not the rename was saved as a version yet).
fn renamed_since(
    repo: &Repository,
    tree: Option<&git2::Tree<'_>>,
    rel: &str,
) -> AppResult<Option<String>> {
    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let mut diff = repo.diff_tree_to_workdir_with_index(tree, Some(&mut opts))?;
    rename_source(&mut diff, true, rel)
}

/// Where `rel` was before `commit` renamed it.
fn renamed_in(repo: &Repository, commit: &Commit<'_>, rel: &str) -> AppResult<Option<String>> {
    let parent = parent_tree(commit)?;
    let mut diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&commit.tree()?), None)?;
    rename_source(&mut diff, false, rel)
}

fn rename_source(
    diff: &mut git2::Diff<'_>,
    untracked: bool,
    rel: &str,
) -> AppResult<Option<String>> {
    Ok(file_changes(diff, untracked)?
        .into_iter()
        .find(|c| c.status == FileStatus::Renamed && c.path == rel)
        .and_then(|c| c.old_path))
}

/// Commits that changed a note, newest first, compared with each commit's
/// first parent, each with the note's path in that commit. Follows the note
/// back through renames. Returns `true` too when it stopped at `limit`.
fn note_versions<'r>(
    repo: &'r Repository,
    rel: &str,
    limit: usize,
) -> AppResult<(Vec<(Commit<'r>, String)>, bool)> {
    let Some(head) = head_commit(repo)? else {
        return Ok((Vec::new(), false));
    };
    let mut path = rel.to_owned();
    if entry_id(&head, Path::new(rel))?.is_none()
        && let Some(old) = renamed_since(repo, Some(&head.tree()?), rel)?
    {
        path = old; // renamed, but not saved as a version yet
    }

    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?; // children before parents, so renames are followed in order
    let mut versions = Vec::new();
    for oid in walk {
        let commit = repo.find_commit(oid?)?;
        let here = entry_id(&commit, Path::new(&path))?;
        let before = match commit.parent(0) {
            Ok(parent) => entry_id(&parent, Path::new(&path))?,
            Err(_) => None, // root commit
        };
        if here == before {
            continue;
        }
        if versions.len() == limit {
            return Ok((versions, true));
        }
        // New at this path in this commit: it may have been renamed from another.
        let renamed = if here.is_some() && before.is_none() {
            renamed_in(repo, &commit, &path)?
        } else {
            None
        };
        versions.push((commit, path.clone()));
        if let Some(old) = renamed {
            path = old;
        }
    }
    Ok((versions, false))
}

/// Commits that changed `rel`, newest first, following renames. Stops after
/// `limit` versions.
pub fn note_history(repo_path: &Path, rel: &str, limit: usize) -> AppResult<NoteHistory> {
    let Some(repo) = open_existing(repo_path)? else {
        return Ok(NoteHistory {
            versions: Vec::new(),
            more: false,
        });
    };
    let (versions, more) = note_versions(&repo, rel, limit)?;
    Ok(NoteHistory {
        versions: versions
            .iter()
            .map(|(commit, _)| commit_info(commit))
            .collect(),
        more,
    })
}

// ---------------------------------------------------------------------------
// Vault history (the History view)
// ---------------------------------------------------------------------------

/// Note texts bigger than this aren't sent for diffing.
const MAX_DIFF_TEXT: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// The previous path, for renames.
    pub old_path: Option<String>,
    pub status: FileStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSummary {
    pub commit: CommitInfo,
    pub files: Vec<FileChange>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    /// Newest first.
    pub versions: Vec<VersionSummary>,
    pub more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    #[serde(flatten)]
    pub change: FileChange,
    /// Note text before and after. `None` when the note doesn't exist on that
    /// side, or the file isn't a note (or is too large to diff).
    pub old_text: Option<String>,
    pub new_text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDetail {
    /// The version shown; `None` for changes not synced yet.
    pub commit: Option<CommitInfo>,
    /// What it's compared with: the parent commit, or the last sync.
    pub base: Option<CommitInfo>,
    pub files: Vec<FileDiff>,
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// The files a diff touches, with renames detected.
fn file_changes(diff: &mut git2::Diff<'_>, untracked: bool) -> AppResult<Vec<FileChange>> {
    let mut find = git2::DiffFindOptions::new();
    find.renames(true).for_untracked(untracked);
    diff.find_similar(Some(&mut find))?;
    let mut out = Vec::new();
    for delta in diff.deltas() {
        let status = match delta.status() {
            git2::Delta::Added | git2::Delta::Untracked => FileStatus::Added,
            git2::Delta::Deleted => FileStatus::Deleted,
            git2::Delta::Renamed => FileStatus::Renamed,
            git2::Delta::Modified | git2::Delta::Typechange | git2::Delta::Copied => {
                FileStatus::Modified
            }
            _ => continue,
        };
        let new_path = delta.new_file().path().map(path_string);
        let old_path = delta.old_file().path().map(path_string);
        let Some(path) = new_path.or_else(|| old_path.clone()) else {
            continue;
        };
        out.push(FileChange {
            old_path: (status == FileStatus::Renamed)
                .then_some(old_path)
                .flatten(),
            path,
            status,
        });
    }
    out.sort_by_key(|a| a.path.to_lowercase());
    Ok(out)
}

fn note_text_at(repo: &Repository, commit: &Commit<'_>, rel: &str) -> AppResult<Option<String>> {
    if !crate::vault::is_note(Path::new(rel)) {
        return Ok(None);
    }
    Ok(text_at(repo, commit, Path::new(rel))?.filter(|t| t.len() <= MAX_DIFF_TEXT))
}

fn parent_tree<'r>(commit: &Commit<'r>) -> AppResult<Option<git2::Tree<'r>>> {
    match commit.parent(0) {
        Ok(parent) => Ok(Some(parent.tree()?)),
        Err(_) => Ok(None), // root commit
    }
}

/// Saved versions, newest first, each with the files it changed.
pub fn log(repo_path: &Path, skip: usize, limit: usize) -> AppResult<HistoryPage> {
    let mut page = HistoryPage {
        versions: Vec::new(),
        more: false,
    };
    let Some(repo) = open_existing(repo_path)? else {
        return Ok(page);
    };
    if head_commit(&repo)?.is_none() {
        return Ok(page);
    }
    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.set_sorting(Sort::TIME)?;
    for oid in walk.skip(skip) {
        if page.versions.len() == limit {
            page.more = true;
            break;
        }
        let commit = repo.find_commit(oid?)?;
        let mut diff =
            repo.diff_tree_to_tree(parent_tree(&commit)?.as_ref(), Some(&commit.tree()?), None)?;
        page.versions.push(VersionSummary {
            commit: commit_info(&commit),
            files: file_changes(&mut diff, false)?,
        });
    }
    Ok(page)
}

/// One saved version: what it changed, with note texts before and after.
pub fn version(repo_path: &Path, id: &str) -> AppResult<VersionDetail> {
    let repo = open(repo_path)?;
    let commit = repo.find_commit(Oid::from_str(id)?)?;
    let parent = commit.parent(0).ok();
    let mut diff =
        repo.diff_tree_to_tree(parent_tree(&commit)?.as_ref(), Some(&commit.tree()?), None)?;
    let files = file_changes(&mut diff, false)?
        .into_iter()
        .map(|change| {
            let old_rel = change
                .old_path
                .clone()
                .unwrap_or_else(|| change.path.clone());
            let old_text = match &parent {
                Some(p) => note_text_at(&repo, p, &old_rel)?,
                None => None,
            };
            let new_text = note_text_at(&repo, &commit, &change.path)?;
            Ok(FileDiff {
                change,
                old_text,
                new_text,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    Ok(VersionDetail {
        commit: Some(commit_info(&commit)),
        base: parent.as_ref().map(commit_info),
        files,
    })
}

/// Everything in the folder that differs from the last sync: saved-but-not-
/// sent versions plus edits not saved as a version yet.
pub fn pending(repo_path: &Path) -> AppResult<VersionDetail> {
    let mut detail = VersionDetail {
        commit: None,
        base: None,
        files: Vec::new(),
    };
    let Some(repo) = open_existing(repo_path)? else {
        return Ok(detail);
    };
    let base = sync_base(&repo)?.map(|(_, commit)| commit);
    let base_tree = base.as_ref().map(|c| c.tree()).transpose()?;
    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let mut diff = repo.diff_tree_to_workdir_with_index(base_tree.as_ref(), Some(&mut opts))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("repository has no working directory"))?
        .to_path_buf();

    for change in file_changes(&mut diff, true)? {
        let old_rel = change
            .old_path
            .clone()
            .unwrap_or_else(|| change.path.clone());
        let old_text = match &base {
            Some(b) => note_text_at(&repo, b, &old_rel)?,
            None => None,
        };
        let new_text = if crate::vault::is_note(Path::new(&change.path)) {
            std::fs::read_to_string(workdir.join(&change.path))
                .ok()
                .filter(|t| t.len() <= MAX_DIFF_TEXT)
        } else {
            None
        };
        detail.files.push(FileDiff {
            change,
            old_text,
            new_text,
        });
    }
    detail.base = base.as_ref().map(commit_info);
    Ok(detail)
}

/// A note's text in a given version (`None` if it didn't exist then).
/// Where a note that was at `rel` in version `id` is now: followed forward
/// through every rename since, including one not saved as a version yet.
/// `None` when it was deleted.
pub fn current_path(repo_path: &Path, rel: &str, id: &str) -> AppResult<Option<String>> {
    let repo = open(repo_path)?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("repository has no working directory"))?
        .to_path_buf();
    let start = repo.find_commit(Oid::from_str(id)?)?;
    let mut path = rel.to_owned();
    if let Some(head) = head_commit(&repo)? {
        // Every version after `id`, oldest first.
        let mut walk = repo.revwalk()?;
        walk.push(head.id())?;
        walk.hide(start.id())?;
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME | Sort::REVERSE)?;
        for oid in walk {
            let commit = repo.find_commit(oid?)?;
            let parent = parent_tree(&commit)?;
            let mut diff = repo.diff_tree_to_tree(parent.as_ref(), Some(&commit.tree()?), None)?;
            if let Some(new) = rename_target(&mut diff, false, &path)? {
                path = new;
            }
        }
        let mut opts = git2::DiffOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(true);
        let mut diff =
            repo.diff_tree_to_workdir_with_index(Some(&head.tree()?), Some(&mut opts))?;
        if let Some(new) = rename_target(&mut diff, true, &path)? {
            path = new;
        }
    }
    Ok(workdir.join(&path).is_file().then_some(path))
}

/// Where `old` went if the diff renames it.
fn rename_target(
    diff: &mut git2::Diff<'_>,
    untracked: bool,
    old: &str,
) -> AppResult<Option<String>> {
    Ok(file_changes(diff, untracked)?
        .into_iter()
        .find(|c| c.status == FileStatus::Renamed && c.old_path.as_deref() == Some(old))
        .map(|c| c.path))
}

pub fn note_at(repo_path: &Path, rel: &str, id: &str) -> AppResult<Option<String>> {
    let repo = open(repo_path)?;
    let commit = repo.find_commit(Oid::from_str(id)?)?;
    if let Some(text) = text_at(&repo, &commit, Path::new(rel))? {
        return Ok(Some(text));
    }
    // It may have had another name in that version.
    let (versions, _) = note_versions(&repo, rel, FOLLOW_LIMIT)?;
    match versions.iter().find(|(c, _)| c.id() == commit.id()) {
        Some((_, path)) => text_at(&repo, &commit, Path::new(path)),
        None => Ok(None),
    }
}

/// Put notes back the way they were in version `id`, by writing their old
/// text into the folder. History isn't rewritten: the next sync saves the
/// restore as a new version. Notes that didn't exist then are left alone.
/// Returns how many notes were restored.
pub fn restore(repo_path: &Path, id: &str, paths: &[String]) -> AppResult<usize> {
    let repo = open(repo_path)?;
    let commit = repo.find_commit(Oid::from_str(id)?)?;
    let mut restored = 0;
    for rel in paths {
        let Some(text) = text_at(&repo, &commit, Path::new(rel))? else {
            continue;
        };
        // Keep Windows line endings if the note on disk uses them.
        let crlf = crate::vault::read_note(repo_path, rel)
            .map(|note| note.content.contains("\r\n"))
            .unwrap_or(false);
        let text = if crlf {
            text.replace("\r\n", "\n").replace('\n', "\r\n")
        } else {
            text
        };
        crate::vault::write_note(repo_path, rel, &text)?; // validates the path
        restored += 1;
    }
    Ok(restored)
}

// ---------------------------------------------------------------------------
// Search in older versions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryHit {
    pub path: String,
    /// The last version that still had the text.
    pub version: CommitInfo,
    /// The version that removed it (or deleted the note).
    pub removed_in: CommitInfo,
    /// The whole note was deleted.
    pub deleted: bool,
    pub snippet: String,
}

/// Text that matched in an earlier version of a note but is gone now: for
/// each note, the most recent version where the query stopped matching.
/// Notes whose current text still matches are left to the normal search.
pub fn search_history(
    repo_path: &Path,
    query: &str,
    max_commits: usize,
    max_hits: usize,
) -> AppResult<Vec<HistoryHit>> {
    let terms = crate::search::parse_query(query);
    let mut hits: Vec<HistoryHit> = Vec::new();
    if terms.is_empty() {
        return Ok(hits);
    }
    let Some(repo) = open_existing(repo_path)? else {
        return Ok(hits);
    };
    if head_commit(&repo)?.is_none() {
        return Ok(hits);
    }
    let matches = |text: &str| crate::search::contains_all(&text.to_lowercase(), &terms);
    let mut seen = std::collections::HashSet::new();

    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.set_sorting(Sort::TIME)?;
    for oid in walk.take(max_commits) {
        let commit = repo.find_commit(oid?)?;
        let Ok(parent) = commit.parent(0) else {
            continue;
        };
        let mut diff =
            repo.diff_tree_to_tree(Some(&parent.tree()?), Some(&commit.tree()?), None)?;
        for change in file_changes(&mut diff, false)? {
            if change.status == FileStatus::Added || !seen.insert(change.path.clone()) {
                continue;
            }
            let old_rel = change
                .old_path
                .clone()
                .unwrap_or_else(|| change.path.clone());
            let Some(old_text) = note_text_at(&repo, &parent, &old_rel)? else {
                continue;
            };
            if !matches(&old_text) {
                seen.remove(&change.path); // an older removal may still count
                continue;
            }
            let new_text = note_text_at(&repo, &commit, &change.path)?;
            if new_text.as_deref().is_some_and(matches) {
                seen.remove(&change.path);
                continue;
            }
            // Skip notes whose current text has it again (normal search finds those).
            let current = std::fs::read_to_string(repo_path.join(&change.path)).ok();
            if current.as_deref().is_some_and(matches) {
                continue;
            }
            let line = old_text
                .lines()
                .find(|l| {
                    let l = l.to_lowercase();
                    terms.iter().any(|t| l.contains(t.as_str()))
                })
                .unwrap_or_default();
            hits.push(HistoryHit {
                path: change.path,
                version: commit_info(&parent),
                removed_in: commit_info(&commit),
                deleted: change.status == FileStatus::Deleted,
                snippet: crate::search::snippet_of(line, &terms),
            });
            if hits.len() == max_hits {
                return Ok(hits);
            }
        }
    }
    Ok(hits)
}

// ---------------------------------------------------------------------------
// Settings support: remote, connection test, identity
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: Option<String>,
    pub email: Option<String>,
    /// Set in this vault's own Git config (rather than inherited from your global one).
    pub vault_only: bool,
}

/// The `origin` URL, if a remote is set up.
pub fn remote_url(repo_path: &Path) -> AppResult<Option<String>> {
    let Some(repo) = open_existing(repo_path)? else {
        return Ok(None);
    };
    let Ok(remote) = repo.find_remote(DEFAULT_REMOTE) else {
        return Ok(None);
    };
    Ok(remote.url().ok().map(str::to_owned))
}

/// Point `origin` at `url` (creating it if needed). An empty URL removes the remote.
pub fn set_remote(repo_path: &Path, url: &str) -> AppResult<()> {
    let repo = open(repo_path)?;
    let url = url.trim();
    if url.is_empty() {
        let _ = repo.remote_delete(DEFAULT_REMOTE); // already gone is fine
    } else if repo.find_remote(DEFAULT_REMOTE).is_ok() {
        repo.remote_set_url(DEFAULT_REMOTE, url)?;
    } else {
        repo.remote(DEFAULT_REMOTE, url)?;
    }
    Ok(())
}

/// Fetch from `origin` without changing any notes: proves the URL and sign-in work.
pub fn test_connection(repo_path: &Path) -> AppResult<()> {
    fetch(&open(repo_path)?, DEFAULT_REMOTE)
}

pub fn identity(repo_path: &Path) -> AppResult<Identity> {
    let repo = open(repo_path)?;
    let config = repo.config()?;
    let local = repo.config()?.open_level(git2::ConfigLevel::Local).ok();
    let vault_only = local
        .as_ref()
        .is_some_and(|c| c.get_string("user.name").is_ok());
    Ok(Identity {
        name: config.get_string("user.name").ok(),
        email: config.get_string("user.email").ok(),
        vault_only,
    })
}

/// Set the name and email used for this vault's versions (repo-local config).
/// Empty values remove the override, falling back to the global Git identity.
pub fn set_identity(repo_path: &Path, name: &str, email: &str) -> AppResult<()> {
    let repo = open(repo_path)?;
    let mut config = repo.config()?.open_level(git2::ConfigLevel::Local)?;
    for (key, value) in [("user.name", name.trim()), ("user.email", email.trim())] {
        if value.is_empty() {
            let _ = config.remove(key); // already unset is fine
        } else {
            config.set_str(key, value)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests (local only, no network)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("penna-git-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn init_commit_and_status() {
        let dir = temp_dir("commit");
        assert!(!status(&dir).unwrap().is_repo);

        init(&dir).unwrap();
        fs::write(dir.join("a.md"), "hello").unwrap();
        let s = status(&dir).unwrap();
        assert!(s.is_repo);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.changed_files, 1);

        let repo = open(&dir).unwrap();
        stage_all(&repo).unwrap();
        let first = commit(&repo, "first").unwrap().expect("commit created");
        assert_eq!(first.summary, "first");
        assert!(
            commit(&repo, "empty").unwrap().is_none(),
            "no empty commits"
        );
        assert_eq!(status(&dir).unwrap().changed_files, 0);

        fs::remove_file(dir.join("a.md")).unwrap();
        stage_path(&repo, "a.md").unwrap();
        assert!(commit(&repo, "delete").unwrap().is_some());

        drop(repo);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn note_base_and_history() {
        let dir = temp_dir("history");
        assert_eq!(note_base(&dir, "a.md").unwrap().kind, BaseKind::None);

        init(&dir).unwrap();
        let repo = open(&dir).unwrap();
        let save = |text: &str, message: &str| {
            fs::write(dir.join("a.md"), text).unwrap();
            stage_all(&repo).unwrap();
            commit(&repo, message).unwrap();
        };
        save("one", "first");
        fs::write(dir.join("other.md"), "x").unwrap(); // a commit that doesn't touch a.md
        stage_all(&repo).unwrap();
        commit(&repo, "unrelated").unwrap();
        save("two", "second");
        fs::write(dir.join("a.md"), "three, not committed").unwrap();

        let history = note_history(&dir, "a.md", 10).unwrap();
        let summaries: Vec<_> = history
            .versions
            .iter()
            .map(|c| c.summary.as_str())
            .collect();
        assert_eq!(summaries, ["second", "first"]);
        assert!(!history.more);
        assert!(note_history(&dir, "a.md", 1).unwrap().more);

        // No remote, so the base is the last commit.
        let base = note_base(&dir, "a.md").unwrap();
        assert_eq!(base.kind, BaseKind::LastVersion);
        assert_eq!(base.content.as_deref(), Some("two"));
        assert_eq!(note_base(&dir, "new.md").unwrap().content, None);

        // With a pushed remote, the base becomes the last synced commit.
        let remote_dir = temp_dir("history-remote");
        Repository::init_bare(&remote_dir).unwrap();
        repo.remote(
            DEFAULT_REMOTE,
            &remote_dir.to_string_lossy().replace('\\', "/"),
        )
        .unwrap();
        push(&repo, DEFAULT_REMOTE).unwrap();
        save("four", "after sync");
        let base = note_base(&dir, "a.md").unwrap();
        assert_eq!(base.kind, BaseKind::LastSync);
        assert_eq!(base.content.as_deref(), Some("two"));

        drop(repo);
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&remote_dir).ok();
    }

    #[test]
    fn history_follows_renames() {
        let dir = temp_dir("follow");
        init(&dir).unwrap();
        let repo = open(&dir).unwrap();
        let text =
            "# Idea\n\nA long enough paragraph that git recognises the file after a rename.\n";
        fs::write(dir.join("Idea.md"), text).unwrap();
        stage_all(&repo).unwrap();
        let first = commit(&repo, "first").unwrap().unwrap();

        // Renamed, not saved as a version yet: Changes compares with the old name.
        fs::create_dir_all(dir.join("Projects")).unwrap();
        crate::vault::rename_note(&dir, "Idea.md", "Projects/Big idea.md").unwrap();
        assert_eq!(
            note_base(&dir, "Projects/Big idea.md")
                .unwrap()
                .content
                .as_deref(),
            Some(text)
        );
        assert_eq!(
            note_history(&dir, "Projects/Big idea.md", 10)
                .unwrap()
                .versions
                .len(),
            1
        );

        // Saved, then edited and renamed again.
        stage_all(&repo).unwrap();
        commit(&repo, "rename").unwrap().unwrap();
        fs::write(dir.join("Projects/Big idea.md"), format!("{text}More.\n")).unwrap();
        stage_all(&repo).unwrap();
        commit(&repo, "edit").unwrap().unwrap();
        crate::vault::rename_note(&dir, "Projects/Big idea.md", "Final.md").unwrap();
        stage_all(&repo).unwrap();
        commit(&repo, "rename again").unwrap().unwrap();

        let history = note_history(&dir, "Final.md", 10).unwrap();
        let summaries: Vec<_> = history
            .versions
            .iter()
            .map(|c| c.summary.as_str())
            .collect();
        assert_eq!(summaries, ["rename again", "edit", "rename", "first"]);
        assert_eq!(
            note_at(&dir, "Final.md", &first.id).unwrap().as_deref(),
            Some(text)
        );
        // Forward: the first version's path leads to where the note is now.
        assert_eq!(
            current_path(&dir, "Idea.md", &first.id).unwrap().as_deref(),
            Some("Final.md")
        );
        crate::vault::rename_note(&dir, "Final.md", "Later/Final.md").unwrap(); // not saved as a version
        assert_eq!(
            current_path(&dir, "Idea.md", &first.id).unwrap().as_deref(),
            Some("Later/Final.md")
        );
        fs::remove_file(dir.join("Later/Final.md")).unwrap();
        assert_eq!(current_path(&dir, "Idea.md", &first.id).unwrap(), None);

        drop(repo);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn vault_history_versions_pending_and_restore() {
        let dir = temp_dir("vault-history");
        init(&dir).unwrap();
        let repo = open(&dir).unwrap();
        let save = |message: &str| {
            stage_all(&repo).unwrap();
            commit(&repo, message).unwrap().unwrap()
        };

        fs::write(dir.join("a.md"), "one\ntwo\n").unwrap();
        fs::write(dir.join("b.md"), "bee\n").unwrap();
        save("first");
        fs::write(dir.join("a.md"), "one\nTWO\nthree\n").unwrap();
        fs::remove_file(dir.join("b.md")).unwrap();
        let second = save("second");

        let page = log(&dir, 0, 10).unwrap();
        assert_eq!(page.versions.len(), 2);
        assert!(!page.more);
        let statuses: Vec<_> = page.versions[0]
            .files
            .iter()
            .map(|f| (f.path.as_str(), f.status))
            .collect();
        assert_eq!(
            statuses,
            [
                ("a.md", FileStatus::Modified),
                ("b.md", FileStatus::Deleted)
            ]
        );
        assert!(log(&dir, 0, 1).unwrap().more);
        assert_eq!(
            log(&dir, 1, 10).unwrap().versions[0].commit.summary,
            "first"
        );

        let detail = version(&dir, &second.id).unwrap();
        let a = &detail.files[0];
        assert_eq!(a.old_text.as_deref(), Some("one\ntwo\n"));
        assert_eq!(a.new_text.as_deref(), Some("one\nTWO\nthree\n"));
        assert_eq!(detail.base.as_ref().unwrap().summary, "first");

        // Not synced yet (no remote, so compared with the last version): an edit and a new note.
        fs::write(dir.join("a.md"), "edited\n").unwrap();
        fs::write(dir.join("c.md"), "new\n").unwrap();
        let pending_files: Vec<_> = pending(&dir)
            .unwrap()
            .files
            .into_iter()
            .map(|f| (f.change.path, f.change.status))
            .collect();
        assert_eq!(
            pending_files,
            [
                ("a.md".to_owned(), FileStatus::Modified),
                ("c.md".to_owned(), FileStatus::Added)
            ]
        );

        let first_id = log(&dir, 1, 1).unwrap().versions[0].commit.id.clone();
        assert_eq!(
            note_at(&dir, "b.md", &first_id).unwrap().as_deref(),
            Some("bee\n")
        );
        let restored = restore(&dir, &first_id, &["a.md".into(), "c.md".into()]).unwrap();
        assert_eq!(
            restored, 1,
            "c.md didn't exist in that version, so it's left alone"
        );
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "one\ntwo\n");
        assert_eq!(fs::read_to_string(dir.join("c.md")).unwrap(), "new\n");

        drop(repo);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn history_search_identity_and_device() {
        let dir = temp_dir("history-search");
        init(&dir).unwrap();
        let repo = open(&dir).unwrap();
        let save = |message: &str| {
            stage_all(&repo).unwrap();
            commit(&repo, message).unwrap().unwrap()
        };
        fs::write(
            dir.join("Roadmap.md"),
            "Settle every conflict by keeping the newest edit.\nShip it.\n",
        )
        .unwrap();
        fs::write(dir.join("Old.md"), "A conflict note we later deleted.\n").unwrap();
        save("first");
        fs::write(dir.join("Roadmap.md"), "Ship it.\n").unwrap();
        let removed = save("Drop the newest-edit rule\n\nDevice: Laptop");
        assert_eq!(removed.summary, "Drop the newest-edit rule");
        assert_eq!(removed.device.as_deref(), Some("Laptop"));
        fs::remove_file(dir.join("Old.md")).unwrap();
        save("Delete old note");

        let mut hits = search_history(&dir, "conflict", 100, 10).unwrap();
        hits.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "Old.md");
        assert!(hits[0].deleted);
        assert_eq!(hits[1].path, "Roadmap.md");
        assert_eq!(hits[1].version.summary, "first");
        assert_eq!(hits[1].removed_in.summary, "Drop the newest-edit rule");
        assert_eq!(
            hits[1].snippet,
            "Settle every conflict by keeping the newest edit."
        );
        assert!(
            search_history(&dir, "Ship", 100, 10).unwrap().is_empty(),
            "still in the current text"
        );

        set_identity(&dir, "Penna Tester", "tester@example.com").unwrap();
        let who = identity(&dir).unwrap();
        assert_eq!(who.name.as_deref(), Some("Penna Tester"));
        assert!(who.vault_only);
        set_identity(&dir, "", "").unwrap();
        assert!(!identity(&dir).unwrap().vault_only);
        assert_eq!(remote_url(&dir).unwrap(), None);
        set_remote(&dir, "https://example.com/notes.git").unwrap();
        assert_eq!(
            remote_url(&dir).unwrap().as_deref(),
            Some("https://example.com/notes.git")
        );
        set_remote(&dir, "git@example.com:me/notes.git").unwrap();
        assert_eq!(
            remote_url(&dir).unwrap().as_deref(),
            Some("git@example.com:me/notes.git")
        );
        set_remote(&dir, "").unwrap();
        assert_eq!(remote_url(&dir).unwrap(), None);

        drop(repo);
        fs::remove_dir_all(&dir).ok();
    }

    /// Clone-free pull test: a bare "remote" plus two working repos that push and pull through it.
    #[test]
    fn pull_fast_forwards_and_merges() {
        let base = temp_dir("pull");
        let remote_dir = base.join("remote.git");
        Repository::init_bare(&remote_dir).unwrap();
        let remote_url = remote_dir.to_string_lossy().replace('\\', "/");

        let setup = |name: &str| {
            let dir = base.join(name);
            fs::create_dir_all(&dir).unwrap();
            init(&dir).unwrap();
            let repo = open(&dir).unwrap();
            repo.remote(DEFAULT_REMOTE, &remote_url).unwrap();
            (dir, repo)
        };
        let (dir_a, repo_a) = setup("a");
        let (dir_b, repo_b) = setup("b");

        // A creates history and pushes.
        fs::write(dir_a.join("one.md"), "1").unwrap();
        stage_all(&repo_a).unwrap();
        commit(&repo_a, "one").unwrap();
        assert!(push(&repo_a, DEFAULT_REMOTE).unwrap());

        // B (unborn) pulls it.
        assert!(matches!(
            pull(&repo_b, DEFAULT_REMOTE).unwrap(),
            PullOutcome::FastForwarded { .. }
        ));
        assert_eq!(fs::read_to_string(dir_b.join("one.md")).unwrap(), "1");

        // Both change different files, so B's pull needs a clean merge.
        fs::write(dir_a.join("two.md"), "2").unwrap();
        stage_all(&repo_a).unwrap();
        commit(&repo_a, "two").unwrap();
        push(&repo_a, DEFAULT_REMOTE).unwrap();

        fs::write(dir_b.join("three.md"), "3").unwrap();
        stage_all(&repo_b).unwrap();
        commit(&repo_b, "three").unwrap();
        assert!(matches!(
            pull(&repo_b, DEFAULT_REMOTE).unwrap(),
            PullOutcome::Merged { .. }
        ));
        assert!(dir_b.join("two.md").exists() && dir_b.join("three.md").exists());
        assert!(push(&repo_b, DEFAULT_REMOTE).unwrap());

        // Conflicting edits: pull refuses and leaves B's file alone.
        pull(&repo_a, DEFAULT_REMOTE).unwrap();
        fs::write(dir_a.join("one.md"), "A edit").unwrap();
        stage_all(&repo_a).unwrap();
        commit(&repo_a, "a edit").unwrap();
        push(&repo_a, DEFAULT_REMOTE).unwrap();

        fs::write(dir_b.join("one.md"), "B edit").unwrap();
        stage_all(&repo_b).unwrap();
        commit(&repo_b, "b edit").unwrap();
        let outcome = pull(&repo_b, DEFAULT_REMOTE).unwrap();
        assert!(
            matches!(&outcome, PullOutcome::WouldConflict { paths } if paths == &["one.md"]),
            "{outcome:?}"
        );
        assert_eq!(
            repo_b.state(),
            RepositoryState::Clean,
            "pull alone never starts a merge"
        );
        assert_eq!(fs::read_to_string(dir_b.join("one.md")).unwrap(), "B edit");

        // Uncommitted local edits block a fast-forward that would overwrite them.
        let (dir_c, repo_c) = setup("c");
        pull(&repo_c, DEFAULT_REMOTE).unwrap();
        let head_before = repo_c.head().unwrap().target();
        fs::write(dir_a.join("two.md"), "A again").unwrap();
        stage_all(&repo_a).unwrap();
        commit(&repo_a, "a again").unwrap();
        push(&repo_a, DEFAULT_REMOTE).unwrap();

        fs::write(dir_c.join("two.md"), "C unsaved work").unwrap();
        assert!(pull(&repo_c, DEFAULT_REMOTE).is_err());
        assert_eq!(
            fs::read_to_string(dir_c.join("two.md")).unwrap(),
            "C unsaved work"
        );
        assert_eq!(
            repo_c.head().unwrap().target(),
            head_before,
            "HEAD must not move"
        );

        drop((repo_a, repo_b, repo_c));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn sync_pauses_on_conflicts_then_stops_or_finishes() {
        let base = temp_dir("conflicts");
        let remote_dir = base.join("remote.git");
        Repository::init_bare(&remote_dir).unwrap();
        let remote_url = remote_dir.to_string_lossy().replace('\\', "/");
        let setup = |name: &str| {
            let dir = base.join(name);
            fs::create_dir_all(&dir).unwrap();
            init(&dir).unwrap();
            open(&dir)
                .unwrap()
                .remote(DEFAULT_REMOTE, &remote_url)
                .unwrap();
            dir
        };
        // Checkouts follow core.autocrlf, so compare text with LF line endings.
        let read = |p: PathBuf| fs::read_to_string(p).unwrap().replace("\r\n", "\n");
        let laptop = setup("laptop");
        let desk = setup("desk");

        fs::write(laptop.join("note.md"), "one\nshared line\nthree\n").unwrap();
        fs::write(laptop.join("pic.png"), "png 0").unwrap();
        sync(&laptop, "First\n\nDevice: Laptop").unwrap();
        sync(&desk, "Nothing yet\n\nDevice: Desk").unwrap();
        assert_eq!(read(desk.join("note.md")), "one\nshared line\nthree\n");

        // Both devices change the same line, and the same image.
        fs::write(
            laptop.join("note.md"),
            "one\nshared line, from the laptop\nthree\n",
        )
        .unwrap();
        fs::write(laptop.join("pic.png"), "png laptop").unwrap();
        sync(&laptop, "Edit\n\nDevice: Laptop").unwrap();
        fs::write(
            desk.join("note.md"),
            "one\nshared line, from the desk\nthree\n",
        )
        .unwrap();
        fs::write(desk.join("pic.png"), "png desk").unwrap();
        fs::write(desk.join("other.md"), "desk only").unwrap();

        let outcome = sync(&desk, "Edit\n\nDevice: Desk").unwrap();
        assert!(
            matches!(&outcome.pull, Some(PullOutcome::Conflicts { paths }) if paths == &["note.md"]),
            "{outcome:?}"
        );
        assert!(!outcome.pushed);
        assert!(status(&desk).unwrap().merging);
        let text = read(desk.join("note.md"));
        assert!(
            text.contains("<<<<<<< Desk")
                && text.contains("=======")
                && text.contains(">>>>>>> Laptop"),
            "{text}"
        );
        assert_eq!(count_conflicts(&text), 1);
        // The image: this device's copy in place, the laptop's beside it.
        assert_eq!(read(desk.join("pic.png")), "png desk");
        assert_eq!(
            fs::read_to_string(desk.join("pic (from Laptop).png")).unwrap(),
            "png laptop"
        );

        let state = merge_state(&desk).unwrap().expect("merging");
        assert_eq!(state.theirs.unwrap().device.as_deref(), Some("Laptop"));
        assert_eq!(state.notes.len(), 1);
        assert_eq!(
            (state.notes[0].path.as_str(), state.notes[0].places),
            ("note.md", 1)
        );
        assert!(matches!(
            finish_merge(&desk, "Merge"),
            Err(AppError::ChoicesLeft(_))
        ));
        // Automatic syncs can't commit in the middle of it.
        assert!(sync(&desk, "auto").is_err());

        // Stop: back to this device's version; an edit made meanwhile stays.
        fs::write(desk.join("other.md"), "desk only, edited during the pause").unwrap();
        abort_merge(&desk).unwrap();
        assert_eq!(open(&desk).unwrap().state(), RepositoryState::Clean);
        assert_eq!(
            read(desk.join("note.md")),
            "one\nshared line, from the desk\nthree\n"
        );
        assert_eq!(read(desk.join("pic.png")), "png desk");
        assert!(!desk.join("pic (from Laptop).png").exists());
        assert_eq!(
            read(desk.join("other.md")),
            "desk only, edited during the pause"
        );
        assert!(merge_state(&desk).unwrap().is_none());

        // Again, and this time choose.
        let outcome = sync(&desk, "Again\n\nDevice: Desk").unwrap();
        assert!(matches!(outcome.pull, Some(PullOutcome::Conflicts { .. })));
        fs::write(
            desk.join("note.md"),
            "one\nshared line, from the laptop\nthree\n",
        )
        .unwrap();
        assert_eq!(merge_state(&desk).unwrap().unwrap().notes[0].places, 0);
        let done = finish_merge(&desk, "Merge changes from Laptop\n\nDevice: Desk").unwrap();
        assert!(done.pushed);
        let repo = open(&desk).unwrap();
        assert_eq!(repo.state(), RepositoryState::Clean);
        assert_eq!(
            repo.head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent_count(),
            2
        );
        assert_eq!(status(&desk).unwrap().changed_files, 0);

        // The laptop gets the merged result with a plain fast-forward.
        let outcome = sync(&laptop, "Pull\n\nDevice: Laptop").unwrap();
        assert!(
            matches!(outcome.pull, Some(PullOutcome::FastForwarded { .. })),
            "{outcome:?}"
        );
        assert_eq!(
            read(laptop.join("other.md")),
            "desk only, edited during the pause"
        );
        assert!(laptop.join("pic (from Laptop).png").exists());

        drop(repo);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn counts_and_names() {
        assert_eq!(
            count_conflicts("a\n<<<<<<< X\nb\n=======\nc\n>>>>>>> Y\nd\n<<<<<<< X\nunfinished"),
            1
        );
        assert_eq!(count_conflicts("no markers"), 0);
        assert_eq!(
            sibling_name("Attachments/photo.png", "Laptop"),
            "Attachments/photo (from Laptop).png"
        );
        assert_eq!(sibling_name("notes", "A:B"), "notes (from AB)");
    }
}
