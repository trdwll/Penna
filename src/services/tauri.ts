/**
 * Typed bridge to the Rust backend.
 *
 * Each backend command is declared once in `Commands` with its argument and
 * result types, so a misspelled command or argument fails `tsc` instead of
 * failing at runtime. The types mirror the serde structs in
 * `src-tauri/src/{vault,git}.rs`. Change both sides together.
 */
import { convertFileSrc, invoke, type InvokeArgs } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface DirNode {
  kind: "dir";
  name: string;
  /** Vault-relative, `/`-separated, e.g. `Projects/2026`. */
  path: string;
  children: TreeNode[];
}

export interface FileNode {
  kind: "file";
  name: string;
  /** Vault-relative, `/`-separated, e.g. `Projects/2026/Q4 plan.md`. */
  path: string;
}

export type TreeNode = DirNode | FileNode;

export interface NoteFile {
  content: string;
  /** Milliseconds since the Unix epoch. */
  modified: number;
}

export interface Backlink {
  path: string;
  /** The line holding the link. */
  context: string;
}

export interface CommitInfo {
  id: string;
  shortId: string;
  summary: string;
  author: string;
  /** The device that saved it (from a "Device: …" line Penna adds to the message). */
  device: string | null;
  /** Seconds since the Unix epoch. */
  timestamp: number;
}

export interface GitStatus {
  isRepo: boolean;
  /** `null` when HEAD is detached. */
  branch: string | null;
  changedFiles: number;
  /** Repo-relative paths that differ from the last commit. */
  changedPaths: string[];
  conflictedFiles: number;
  /** A sync stopped to ask which version to keep (see `gitMergeState`). */
  merging: boolean;
  hasRemote: boolean;
  /** Remote-tracking branch exists, so `ahead`/`behind` are meaningful. */
  hasUpstream: boolean;
  ahead: number;
  behind: number;
  lastCommit: CommitInfo | null;
}

export type PullOutcome =
  | { kind: "upToDate" }
  | { kind: "fastForwarded"; commit: string }
  | { kind: "merged"; commit: string }
  /** Pull only: both devices changed the same lines; nothing was changed. */
  | { kind: "wouldConflict"; paths: string[] }
  /** Sync only: the merge is in the folder, with both versions in these notes. */
  | { kind: "conflicts"; paths: string[] };

/** A sync that stopped to ask which version to keep. */
export interface MergeState {
  /** This device's last version. */
  ours: CommitInfo | null;
  /** The other device's version being merged in. */
  theirs: CommitInfo | null;
  notes: ConflictNote[];
}

export interface ConflictNote {
  path: string;
  /** Places that still have both versions; 0 once each has a choice. */
  places: number;
}

export interface SyncOutcome {
  committed: CommitInfo | null;
  /** `null` when the vault has no remote (commit-only backup). */
  pull: PullOutcome | null;
  pushed: boolean;
}

/** What the Changes view compares a note against. */
export interface NoteBase {
  kind: "lastSync" | "lastVersion" | "none";
  /** The note's text in that version; `null` if it didn't exist yet. */
  content: string | null;
  commit: CommitInfo | null;
}

export interface SearchHit {
  path: string;
  /** ms since the Unix epoch. */
  modified: number;
  /** Every word appears in the note's name. */
  titleMatch: boolean;
  /** Occurrences in the text. */
  count: number;
  snippets: { text: string; line: number }[];
  /** Lowercase, without "#". */
  tags: string[];
}

export interface HistoryHit {
  path: string;
  /** The last version that still had the text. */
  version: CommitInfo;
  /** The version that removed it. */
  removedIn: CommitInfo;
  deleted: boolean;
  snippet: string;
}

export interface Identity {
  name: string | null;
  email: string | null;
  /** Set for this vault only, rather than inherited from the global Git config. */
  vaultOnly: boolean;
}

/** The result of renaming or moving a note or a folder. */
export interface RenameOutcome {
  /** The note's or folder's new path. */
  path: string;
  /** Notes that moved: one for a note, every note inside for a folder. */
  moved: { from: string; to: string }[];
  /** Notes whose links were rewritten (at their current paths). */
  updated: string[];
  /** How many links changed in all. */
  links: number;
  /** The note's own `# Heading` took the new name. */
  retitled: boolean;
}

/** An attachment and the notes that use it. */
export interface AttachmentUse {
  path: string;
  /** Bytes. */
  size: number;
  notes: string[];
}

/** A line of a note's text with inline tags on it. */
export interface Mention {
  /** 1-based line. */
  line: number;
  text: string;
  /** The tags written on it, lowercase, once per time they're written. */
  tags: string[];
}

/** A note that has tags (lowercase, without #). */
export interface TaggedNote {
  path: string;
  modified: number;
  tags: string[];
  /** The ones set in front matter. */
  properties: string[];
  mentions: Mention[];
}

export interface TagRenameOutcome {
  /** The new name as written (no #). */
  name: string;
  /** Notes that changed. */
  notes: string[];
  /** Tags rewritten. */
  changed: number;
}

/** Where a note mentions another by name: 1-based line and byte range in it. */
export interface MentionPlace {
  line: number;
  start: number;
  end: number;
}

/** An unlinked mention, with the text around it. */
export interface UnlinkedMention extends MentionPlace {
  before: string;
  text: string;
  after: string;
}

/** A note that mentions the open one without linking it; `more` counts mentions past the first few. */
export interface Mentioning {
  path: string;
  mentions: UnlinkedMention[];
  more: number;
}

/** A heading in a note, for the quick switcher. */
export interface HeadingRef {
  path: string;
  level: number;
  text: string;
  /** 1-based line. */
  line: number;
}

export interface FolderContents {
  notes: number;
  /** Files that aren't notes (images, PDFs, …). */
  files: number;
}

export interface NoteStamp {
  path: string;
  /** ms since the Unix epoch. */
  modified: number;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface FileChange {
  path: string;
  /** Previous path, for renames. */
  oldPath: string | null;
  status: FileStatus;
}

export interface VersionSummary {
  commit: CommitInfo;
  files: FileChange[];
}

export interface HistoryPage {
  versions: VersionSummary[];
  more: boolean;
}

export interface FileDiff extends FileChange {
  /** Note text before/after; null when absent on that side or not a note. */
  oldText: string | null;
  newText: string | null;
}

export interface VersionDetail {
  /** null for changes not synced yet. */
  commit: CommitInfo | null;
  /** What it is compared with: the previous version, or the last sync. */
  base: CommitInfo | null;
  files: FileDiff[];
}

export interface NoteHistory {
  /** Newest first. */
  versions: CommitInfo[];
  more: boolean;
}

// ---------------------------------------------------------------------------
// Command map: the single source of truth for the IPC surface
// ---------------------------------------------------------------------------

type NoArgs = Record<string, never>;

interface Commands {
  open_vault: { args: { path: string }; result: TreeNode[] };
  list_tree: { args: NoArgs; result: TreeNode[] };
  read_note: { args: { path: string }; result: NoteFile };
  write_note: { args: { path: string; content: string }; result: number };
  create_note: { args: { path: string; content?: string }; result: void };
  rename_note: { args: { from: string; to: string }; result: RenameOutcome };
  delete_note: { args: { path: string }; result: void };
  rename_folder: { args: { from: string; to: string }; result: RenameOutcome };
  delete_folder: { args: { path: string }; result: void };
  folder_contents: { args: { path: string }; result: FolderContents };
  list_attachments: { args: NoArgs; result: string[] };
  /** Sent with a raw body; see `saveAttachment`. */
  save_attachment: { args: NoArgs; result: string };
  import_attachments: { args: { paths: string[]; note: string; folder: string }; result: string[] };
  open_attachment: { args: { path: string }; result: void };
  rename_attachment: { args: { from: string; to: string }; result: RenameOutcome };
  delete_attachments: { args: { paths: string[] }; result: number };
  attachment_usage: { args: NoArgs; result: AttachmentUse[] };
  reveal_attachment: { args: { path: string }; result: void };
  recent_notes: { args: { limit?: number }; result: NoteStamp[] };
  list_headings: { args: NoArgs; result: HeadingRef[] };
  list_tags: { args: NoArgs; result: TaggedNote[] };
  export_html: { args: { html: string; target: string }; result: null };
  export_pdf: { args: { target: string; width: number; height: number }; result: null };
  rename_tag: { args: { from: string; to: string }; result: TagRenameOutcome };
  search_notes: { args: { query: string; titlesOnly: boolean }; result: SearchHit[] };
  search_history: { args: { query: string }; result: HistoryHit[] };
  vault_settings_read: { args: NoArgs; result: string | null };
  vault_settings_write: { args: { json: string }; result: void };
  device_name: { args: NoArgs; result: string };
  git_remote_url: { args: NoArgs; result: string | null };
  git_set_remote: { args: { url: string }; result: void };
  git_test_connection: { args: NoArgs; result: void };
  git_identity: { args: NoArgs; result: Identity };
  git_set_identity: { args: { name: string; email: string }; result: void };
  note_backlinks: { args: { path: string }; result: Backlink[] };
  unlinked_mentions: { args: { path: string }; result: Mentioning[] };
  link_mentions: { args: { path: string; target: string; places: MentionPlace[] }; result: number };
  git_status: { args: NoArgs; result: GitStatus };
  git_note_base: { args: { path: string }; result: NoteBase };
  git_note_history: { args: { path: string }; result: NoteHistory };
  git_log: { args: { skip: number; limit: number }; result: HistoryPage };
  git_version: { args: { id: string }; result: VersionDetail };
  git_pending: { args: NoArgs; result: VersionDetail };
  git_note_at: { args: { path: string; id: string }; result: string | null };
  git_current_path: { args: { path: string; id: string }; result: string | null };
  git_restore: { args: { id: string; paths: string[] }; result: number };
  git_init: { args: NoArgs; result: GitStatus };
  git_stage: { args: { path: string }; result: void };
  git_commit: { args: { message: string; all: boolean }; result: CommitInfo | null };
  git_pull: { args: NoArgs; result: PullOutcome };
  git_push: { args: NoArgs; result: boolean };
  git_sync: { args: { message: string }; result: SyncOutcome };
  git_merge_state: { args: NoArgs; result: MergeState | null };
  git_finish_merge: { args: { message: string }; result: SyncOutcome };
  git_abort_merge: { args: NoArgs; result: void };
}

type CommandName = keyof Commands;
type ArgsOf<C extends CommandName> = Commands[C]["args"] extends NoArgs ? [] : [Commands[C]["args"]];

/** Thrown by every wrapper. `message` is the human-readable error from Rust. */
export class BackendError extends Error {
  readonly command: CommandName;

  constructor(command: CommandName, message: string) {
    super(message);
    this.name = "BackendError";
    this.command = command;
  }
}

export function errorMessage(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function call<C extends CommandName>(command: C, ...[args]: ArgsOf<C>): Promise<Commands[C]["result"]> {
  try {
    return await invoke<Commands[C]["result"]>(command, args as InvokeArgs | undefined);
  } catch (err) {
    // Rust commands return `Result<T, String>`, so `err` is normally the message itself.
    throw new BackendError(command, errorMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

/** Open a folder as the vault, start watching it, and return its tree. */
export const openVault = (path: string) => call("open_vault", { path });
export const listTree = () => call("list_tree");
export const readNote = (path: string) => call("read_note", { path });
/** Atomic write; creates parent folders. Resolves to the new modified time (ms). */
export const writeNote = (path: string, content: string) => call("write_note", { path, content });
/** Create a note (empty, or with starting text). Rejects if the file already exists. */
export const createNote = (path: string, content?: string) => call("create_note", { path, content });
/** Rename or move a note and rewrite the links that point at it. Rejects if the target exists. */
export const renameNote = (from: string, to: string) => call("rename_note", { from, to });
/** Move a note to the Recycle Bin. */
export const deleteNote = (path: string) => call("delete_note", { path });
/** Rename or move a folder with everything in it, rewriting links to what's inside. */
export const renameFolder = (from: string, to: string) => call("rename_folder", { from, to });
/** Move a folder and everything in it to the Recycle Bin. */
export const deleteFolder = (path: string) => call("delete_folder", { path });
export const folderContents = (path: string) => call("folder_contents", { path });
/** Every file in the vault that isn't a note (images, PDFs, …). */
export const listAttachments = () => call("list_attachments");
/** Copy files from elsewhere into the vault for a note (files already in the vault stay put). Resolves to vault paths. */
export const importAttachments = (paths: string[], note: string, folder: string) => call("import_attachments", { paths, note, folder });
/** Open with the default app (programs and scripts are only shown in Explorer). */
export const openAttachment = (path: string) => call("open_attachment", { path });
/** Rename or move an attachment; links and embeds that use it follow. */
export const renameAttachment = (from: string, to: string) => call("rename_attachment", { from, to });
/** Move attachments to the Recycle Bin. Resolves to how many. */
export const deleteAttachments = (paths: string[]) => call("delete_attachments", { paths });
/** Every attachment with the notes that use it. */
export const attachmentUsage = () => call("attachment_usage");
export const revealAttachment = (path: string) => call("reveal_attachment", { path });

/** Save pasted file data as an attachment for `note`. Sent as raw bytes, not JSON. Resolves to its vault path. */
export async function saveAttachment(data: Uint8Array, name: string, note: string, folder: string): Promise<string> {
  try {
    return await invoke<string>("save_attachment", data, {
      headers: { "x-name": encodeURIComponent(name), "x-note": encodeURIComponent(note), "x-folder": encodeURIComponent(folder) },
    });
  } catch (err) {
    throw new BackendError("save_attachment", errorMessage(err));
  }
}

/** The URL an `<img>` uses for a vault file (served by the backend's `penna:` scheme). */
export const attachmentUrl = (path: string) => convertFileSrc(path, "penna");

/** Every heading in every note, in sidebar order. */
export const listHeadings = () => call("list_headings");
/** Every note with tags, for the Tags view. */
export const listTags = () => call("list_tags");
/** Rename a tag, and the tags nested under it, in every note. */
export const renameTag = (from: string, to: string) => call("rename_tag", { from, to });
/** Notes by last modified time, newest first. */
export const recentNotes = (limit = 200) => call("recent_notes", { limit });
export const noteBacklinks = (path: string) => call("note_backlinks", { path });
/** Notes that mention `path` by name (or alias) without linking it. */
export const unlinkedMentions = (path: string) => call("unlinked_mentions", { path });
/** Turn mentions in `path` into links to `target`; resolves to how many were linked. */
export const linkMentions = (path: string, target: string, places: MentionPlace[]) =>
  call("link_mentions", { path, target, places: places.map(({ line, start, end }) => ({ line, start, end })) });

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export const gitStatus = () => call("git_status");
export const gitNoteBase = (path: string) => call("git_note_base", { path });
export const gitNoteHistory = (path: string) => call("git_note_history", { path });
export const gitLog = (skip: number, limit: number) => call("git_log", { skip, limit });
export const gitVersion = (id: string) => call("git_version", { id });
/** Changes in the folder that the last sync does not have yet. */
export const gitPending = () => call("git_pending");
export const gitNoteAt = (path: string, id: string) => call("git_note_at", { path, id });
/** Where a note from version `id` is now, following renames; null if it was deleted. */
export const gitCurrentPath = (path: string, id: string) => call("git_current_path", { path, id });
/** Write notes back as they were in a version. Resolves to how many were restored. */
export const gitRestore = (id: string, paths: string[]) => call("git_restore", { id, paths });
export const gitInit = () => call("git_init");
export const gitRemoteUrl = () => call("git_remote_url");
/** Connect to a remote; an empty URL disconnects. */
export const gitSetRemote = (url: string) => call("git_set_remote", { url });
/** Fetch without touching notes: checks the remote and sign-in. */
export const gitTestConnection = () => call("git_test_connection");
export const gitIdentity = () => call("git_identity");
export const gitSetIdentity = (name: string, email: string) => call("git_set_identity", { name, email });

// ---------------------------------------------------------------------------
// Search and settings
// ---------------------------------------------------------------------------

export const searchNotes = (query: string, titlesOnly = false) => call("search_notes", { query, titlesOnly });
/** Text found in older versions that has been removed since. */
export const searchHistory = (query: string) => call("search_history", { query });
/** The vault's `.penna/settings.json`, or null before any were saved. */
export const readVaultSettings = () => call("vault_settings_read");
export const writeVaultSettings = (json: string) => call("vault_settings_write", { json });
export const deviceName = () => call("device_name");
export const gitStage = (path: string) => call("git_stage", { path });
/** Commit; with `all` (default) stage every change first. Resolves `null` if nothing changed. */
export const gitCommit = (message: string, { all = true }: { all?: boolean } = {}) => call("git_commit", { message, all });
export const gitPull = () => call("git_pull");
export const gitPush = () => call("git_push");
/** Stage all, commit, pull, push (commit only when no remote is configured). May stop with `conflicts` to ask. */
export const gitSync = (message: string) => call("git_sync", { message });
/** The paused sync, or null. */
export const gitMergeState = () => call("git_merge_state");
/** Save the merge once every note has a choice, then send it. */
export const gitFinishMerge = (message: string) => call("git_finish_merge", { message });
/** Stop the paused sync: notes go back to this device's last version. */
export const gitAbortMerge = () => call("git_abort_merge");

// ---------------------------------------------------------------------------
// Events, dialogs, window, links
// ---------------------------------------------------------------------------

/** Must match `watcher::VAULT_CHANGED` in Rust. */
const VAULT_CHANGED_EVENT = "vault:changed";

/** Subscribe to on-disk changes in the vault. Resolves to an unsubscribe function. */
export function onVaultChanged(handler: (paths: string[]) => void): Promise<UnlistenFn> {
  return listen<{ paths: string[] }>(VAULT_CHANGED_EVENT, (event) => handler(event.payload.paths));
}

/** Native file picker for images and files to add. Resolves to [] if the user cancels. */
export async function pickAttachmentFiles(): Promise<string[]> {
  const selected = await open({ multiple: true, directory: false, title: "Add images or files" });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export type FileDrop = { type: "over"; x: number; y: number } | { type: "drop"; x: number; y: number; paths: string[] } | { type: "leave" };

/** Files dragged in from Explorer. Positions are CSS pixels in the window. Resolves to an unsubscribe function. */
export function onFileDrop(handler: (event: FileDrop) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "leave") return handler({ type: "leave" });
    const scale = window.devicePixelRatio || 1;
    const x = payload.position.x / scale;
    const y = payload.position.y / scale;
    if (payload.type === "drop") handler({ type: "drop", x, y, paths: payload.paths });
    else handler({ type: "over", x, y });
  });
}

/** Where to save an export (native dialog). Resolves `null` if the user cancels. */
export async function pickExportTarget(name: string, kind: "html" | "pdf"): Promise<string | null> {
  const filters = kind === "html" ? [{ name: "Web page", extensions: ["html"] }] : [{ name: "PDF", extensions: ["pdf"] }];
  return (await save({ defaultPath: name, filters, title: kind === "html" ? "Export as a web page" : "Export as PDF" })) ?? null;
}

/** Save an exported web page; vault images marked `penna-vault:<path>` go inside it. */
export const exportHtml = (html: string, target: string) => call("export_html", { html, target });
/** Save the page, while it's in print layout, as a PDF (paper size in inches). */
export const exportPdf = (target: string, width: number, height: number) => call("export_pdf", { target, width, height });

/** Native folder picker. Resolves `null` if the user cancels. */
export async function pickVaultFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title: "Choose a vault folder" });
  return typeof selected === "string" ? selected : null;
}

/** The app draws its own title bar, so it drives the window controls itself. */
export const appWindow = {
  /** Runs `handler` before the window closes (awaited), e.g. to sync. */
  onCloseRequested: (handler: () => Promise<void>) => getCurrentWindow().onCloseRequested(handler),
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
  isMaximized: () => getCurrentWindow().isMaximized(),
  onResized: (handler: () => void) => getCurrentWindow().onResized(handler),
};

/** Open a web link in the default browser. */
export const openExternal = (url: string) => openUrl(url);
