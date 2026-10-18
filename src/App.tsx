/**
 * Penna's app shell (the "Margin" design). Owns vault, note, Git and view
 * state, and connects the title bar, rail, side panels, page and margin to
 * the Rust backend.
 *
 * Views: Notes (table of contents), Today (daily notes) and History (saved
 * versions). Notes and Today share the note page; History has its own.
 *
 * Data flow:
 *   user action → typed IPC call → Rust (blocking pool) → result → React state
 *   disk change → Rust watcher → "vault:changed" → refresh tree/status/open note
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import HistoryPanel, { PENDING } from "./components/HistoryPanel";
import MarginPanel from "./components/MarginPanel";
import NotePage, { type DayLink, type OpenNote } from "./components/NotePage";
import type { MenuItem } from "./components/Menu";
import Menu, { type MenuAnchor } from "./components/Menu";
import { ConfirmDialog, DeleteDialog, MoveDialog, RenameFileDialog, TagRenameDialog } from "./components/NoteDialogs";
import type { PausedNote, PausedSync } from "./components/SyncPaused";
import type { ConflictLabels, ConflictsInfo } from "./editor/conflicts";
import NotesPanel, { type PanelItem } from "./components/NotesPanel";
import QuickSwitcher, { type SwitcherCommand } from "./components/QuickSwitcher";
import Rail, { type View } from "./components/Rail";
import SearchView from "./components/SearchView";
import TagsView from "./components/TagsView";
import BesidePane, { type BesideNote } from "./components/BesidePane";
import TemplateDialog from "./components/TemplateDialog";
import { STARTER_TEMPLATE, forInsert, fromTemplate, takeCursor, templatePaths } from "./lib/templates";
import { tagCounts } from "./lib/tags";
import { embedTargets, embeddedFonts, htmlDocument, paperSize, printDialog, renderNote, withPrintLayout } from "./lib/exportNote";
import SettingsView from "./components/SettingsView";
import TitleBar from "./components/TitleBar";
import Toast, { type ToastMessage } from "./components/Toast";
import TodayPanel from "./components/TodayPanel";
import VersionPage, { VersionMargin, type CompareTarget } from "./components/VersionPage";
import Welcome from "./components/Welcome";
import type { ChangesInfo, EditorHandle, SaveStatus, ViewMode } from "./editor/Editor";
import type { FileHandlers } from "./editor/fileDrop";
import type { LinkHandlers } from "./editor/livePreview";
import { IMAGE_FILE, attachmentMarkdown, fileIndex, pastedName, resolveAttachment, resolveEmbed } from "./lib/attachments";
import { buildDailyNote, dailyDateOf, dailyNotes, dailyPath, displayTitle, longTitle, sameDay, shortTitle, startOfDay } from "./lib/daily";
import {
  basename,
  folderOf,
  folderPaths,
  folderRenameTarget,
  joinPath,
  moveTarget,
  notePathFromInput,
  notePaths,
  noteTitle,
  renameTarget,
  resolveWikiLink,
  shortDate,
  shortTime,
} from "./lib/format";
import { useDebouncedCallback, useLatest } from "./lib/hooks";
import { extractHeadings } from "./lib/outline";
import {
  DEFAULT_VAULT,
  applyAppSettings,
  formatDate,
  loadAppSettings,
  parseVaultSettings,
  saveAppSettings,
  syncMessage,
  type AppSettings,
  type VaultPatch,
  type VaultSettings,
} from "./lib/settings";
import * as api from "./services/tauri";
import type {
  Backlink,
  GitStatus,
  FolderContents,
  HistoryHit,
  MergeState,
  NoteBase,
  NoteHistory,
  NoteStamp,
  RenameOutcome,
  SyncOutcome,
  TreeNode,
  VersionDetail,
  VersionSummary,
} from "./services/tauri";

const KEY_LAST_VAULT = "penna.lastVault";
/** Recently opened notes, per vault, for the quick switcher. */
const recentKey = (vault: string) => `penna.recent:${vault}`;
/** The note open beside the main one, per vault, so it's there next time. */
const besideKey = (vault: string) => `penna.beside:${vault}`;
const HISTORY_PAGE = 100;
/** "Sync after I stop typing": wait this long after the last save. */
const TYPING_SYNC_DELAY = 2 * 60_000;
/** Closing never waits longer than this for the closing sync. */
const CLOSE_SYNC_TIMEOUT = 10_000;

// localStorage can be unavailable (locked-down profile); the app works without it.
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

/** Did a sync bring in anything from other devices? */
const pulledSomething = (outcome: SyncOutcome) => outcome.pull !== null && outcome.pull.kind !== "upToDate";

function describeSync({ committed, pull, pushed }: SyncOutcome): string {
  if (!pull) return committed ? "Saved a version (no remote to send it to)" : "Nothing new to save";
  const steps = [
    committed && "saved a version",
    pull.kind === "fastForwarded" && "got new changes",
    pull.kind === "merged" && "merged in changes from your other devices",
    pushed && "sent yours",
  ].filter(Boolean);
  return steps.length ? `Synced: ${steps.join(", ")}` : "Already up to date";
}

/** "Renamed to “Plan”. Updated 3 links in 2 notes." */
function describeRename(from: string, { path, updated, links }: RenameOutcome): string {
  const moved = folderOf(from) !== folderOf(path);
  const renamed = basename(from) !== basename(path);
  const where = folderOf(path) ? folderOf(path).split("/").join(" · ") : "the top of the vault";
  const what =
    moved && renamed
      ? `Moved to ${where} as “${noteTitle(path)}”`
      : moved
        ? `Moved “${noteTitle(path)}” to ${where}`
        : `Renamed to “${noteTitle(path)}”`;
  if (!links) return what;
  return `${what}. Updated ${links} ${links === 1 ? "link" : "links"} in ${updated.length} ${updated.length === 1 ? "note" : "notes"}.`;
}

/** "Renamed the folder to “Archive”. Updated 4 links in 3 notes." */
function describeFolderMove(from: string, { path, updated, links }: RenameOutcome): string {
  const moved = folderOf(from) !== folderOf(path);
  const renamed = basename(from) !== basename(path);
  const where = folderOf(path) ? folderOf(path).split("/").join(" · ") : "the top of the vault";
  const name = basename(path);
  const what =
    moved && renamed
      ? `Moved the folder to ${where} as “${name}”`
      : moved
        ? `Moved “${name}” to ${where}`
        : `Renamed the folder to “${name}”`;
  if (!links) return what;
  return `${what}. Updated ${links} ${links === 1 ? "link" : "links"} in ${updated.length} ${updated.length === 1 ? "note" : "notes"}.`;
}

/** A folder setting (`Journal`, `Attachments`, `Templates/Daily`) after `from` became `to`, or null when it isn't affected. */
function retarget(setting: string, from: string, to: string): string | null {
  const value = setting.trim().replace(/^[\\/]+|[\\/]+$/g, "");
  const lower = value.toLowerCase();
  const prefix = from.toLowerCase();
  if (!value) return null;
  if (lower === prefix) return to;
  if (lower.startsWith(`${prefix}/`)) return to + value.slice(from.length);
  return null;
}

function baseLabel(base: NoteBase | null): string {
  if (!base?.commit) return "your last saved version";
  const when = shortTime(base.commit.timestamp * 1000);
  return base.kind === "lastSync" ? `your last sync · ${when}` : `your last saved version · ${when}`;
}

const versionLabel = (c: { timestamp: number; summary: string }) => `${shortDate(c.timestamp * 1000)} · ${c.summary}`;

/** Compare the open note against an older version instead of the last sync. */
interface Compare extends CompareTarget {
  path: string;
}

export default function App() {
  // Settings
  const [appSettings, setAppSettings] = useState<AppSettings>(loadAppSettings);
  const [vaultSettings, setVaultSettings] = useState<VaultSettings>(DEFAULT_VAULT);
  const [defaultDevice, setDefaultDevice] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Vault and view
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [view, setView] = useState<View>("notes");
  const [day, setDay] = useState<Date>(() => startOfDay(new Date()));

  // Open note
  const [note, setNote] = useState<OpenNote | null>(null);
  const [text, setText] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus | null>(null);
  const [mode, setMode] = useState<ViewMode>(() => loadAppSettings().defaultView);
  const [changesOn, setChangesOn] = useState(false);
  const [base, setBase] = useState<NoteBase | null>(null);
  const [compare, setCompare] = useState<Compare | null>(null);
  const [compareBase, setCompareBase] = useState<string | undefined>(undefined);
  const [changesInfo, setChangesInfo] = useState<ChangesInfo | null>(null);
  const [backlinks, setBacklinks] = useState<Backlink[] | null>(null);
  /** Notes that mention the open one without linking it ("Mentioned in"). */
  const [mentions, setMentions] = useState<api.Mentioning[] | null>(null);
  /** The note open beside the one you're writing (Ctrl+\\), and its save status. */
  const [beside, setBeside] = useState<BesideNote | null>(null);
  const [besideStatus, setBesideStatus] = useState<SaveStatus>("saved");
  const besideRef = useLatest(beside);
  const besideStatusRef = useLatest(besideStatus);
  /** "Open beside" mode for the quick switcher. */
  const [switcherBeside, setSwitcherBeside] = useState(false);
  const [history, setHistory] = useState<NoteHistory | null>(null);
  const [recent, setRecent] = useState<NoteStamp[] | null>(null);
  /** Every file in the vault that isn't a note (images, PDFs, …), for showing and opening attachments. */
  const [attachments, setAttachments] = useState<string[]>([]);

  // History view
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [moreVersions, setMoreVersions] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [pending, setPending] = useState<VersionDetail | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [versionDetail, setVersionDetail] = useState<VersionDetail | null>(null);

  // Git and UI
  const [git, setGit] = useState<GitStatus | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [creating, setCreating] = useState(false);
  /** Note actions: renaming in place in the Notes panel, the Move and Delete dialogs. */
  const [renaming, setRenaming] = useState<PanelItem | null>(null);
  const [moving, setMoving] = useState<PanelItem | null>(null);
  /** "New note here": the folder the new-note field starts in. */
  const [newNoteFolder, setNewNoteFolder] = useState("");
  const [deletingFolder, setDeletingFolder] = useState<{ path: string; contents: FolderContents | null } | null>(null);
  /** An image or file right-clicked in a note, its rename dialog, and its delete confirmation. */
  const [fileMenu, setFileMenu] = useState<{ path: string; anchor: MenuAnchor } | null>(null);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [deletingFile, setDeletingFile] = useState<{ path: string; notes: number | null } | null>(null);
  const [deleting, setDeleting] = useState<{ path: string; links: number | null } | null>(null);
  /** A sync that stopped to ask which version to keep. */
  const [merge, setMerge] = useState<MergeState | null>(null);
  /** The open note's places with both versions, as its editor last reported them. */
  const [conflictsSeen, setConflictsSeen] = useState<{ path: string; info: ConflictsInfo | null } | null>(null);
  const [stoppingSync, setStoppingSync] = useState(false);
  /** The quick switcher (Ctrl+P), with the text it opened with ("" or ">" for commands). */
  const [switcher, setSwitcher] = useState<string | null>(null);
  /** Notes opened in this vault, newest first. */
  const [recentOpened, setRecentOpened] = useState<string[]>([]);
  /** The Tags view: every note with tags (null until loaded), the chosen tag, and a rename in progress. */
  const [tagIndex, setTagIndex] = useState<api.TaggedNote[] | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  /** Clicking a #tag in a note (set once changeView exists). */
  const openTagRef = useRef<(tag: string) => void>(() => {});
  const besideEditorRef = useRef<EditorHandle>(null);
  /** The beside note's text as last read or written, to tell our own saves from changes made elsewhere. */
  const besideDisk = useRef("");
  const openBesideRef = useRef<(path: string, quiet?: boolean) => Promise<void>>(() => Promise.resolve());
  /** Save both editors' latest keystrokes before a file operation. */
  const flushEditors = async () => {
    await editorRef.current?.flush();
    await besideEditorRef.current?.flush();
  };
  /** The template dialog: starting a note in a folder, or inserting into the open note. */
  const [templating, setTemplating] = useState<{ mode: "new"; folder: string } | { mode: "insert" } | null>(null);
  /** Who's waiting for the inserted template's text (the + menu, or a command). */
  const templateResolve = useRef<((t: { text: string; cursor: number | null } | null) => void) | null>(null);
  const pickTemplateRef = useRef<() => Promise<{ text: string; cursor: number | null } | null>>(() => Promise.resolve(null));

  const editorRef = useRef<EditorHandle>(null);
  const findRef = useRef<HTMLInputElement>(null);
  /** The open note's content as last read from or written to disk. */
  const diskContentRef = useRef("");
  const noteRef = useLatest(note);
  const treeRef = useLatest(tree);
  const viewRef = useLatest(view);
  const versionsRef = useLatest(versions);
  const saveStatusRef = useLatest(saveStatus);
  const syncBusyRef = useLatest(syncBusy);
  const appSettingsRef = useLatest(appSettings);
  const vaultSettingsRef = useLatest(vaultSettings);
  const gitRef = useLatest(git);
  const filesRef = useLatest(useMemo(() => fileIndex(attachments), [attachments]));
  /** Bumped when files change, so images are fetched again instead of shown from cache. */
  const filesVersion = useRef(0);
  /** Bumped when other notes change on disk, so `![[Note]]` embeds load again. */
  const notesVersion = useRef(0);
  const device = appSettings.deviceName.trim() || defaultDevice;
  const deviceRef = useLatest(device);

  /** Bumped on every navigation, so a slow note load can't switch views after the user moved on. */
  const navSeq = useRef(0);
  /** Gives each opened note an id, so renaming it doesn't remount the editor. */
  const noteIds = useRef(0);
  /** A rename, move or delete is running: the watcher leaves the open note alone until it finishes. */
  const fileOpRef = useRef(false);
  /** Called after each successful save (drives "sync after I stop typing"). */
  const afterSaveRef = useRef<() => void>(() => {});

  const toastId = useRef(0);
  const notify = useCallback((message: string, tone: "info" | "error" = "info") => {
    setToast({ id: ++toastId.current, text: message, tone });
  }, []);
  const showError = useCallback((err: unknown, prefix: string) => notify(`${prefix}: ${api.errorMessage(err)}`, "error"), [notify]);

  // ---- Settings ------------------------------------------------------------

  useEffect(() => {
    if (vaultPath) writeStorage(recentKey(vaultPath), JSON.stringify(recentOpened));
  }, [vaultPath, recentOpened]);

  useEffect(() => {
    applyAppSettings(appSettings);
    saveAppSettings(appSettings);
  }, [appSettings]);

  useEffect(() => {
    api
      .deviceName()
      .then(setDefaultDevice)
      .catch(() => setDefaultDevice("This PC"));
  }, []);

  const updateApp = useCallback((patch: Partial<AppSettings>) => setAppSettings((s) => ({ ...s, ...patch })), []);

  const persistVaultSettings = useDebouncedCallback((settings: VaultSettings) => {
    api.writeVaultSettings(JSON.stringify(settings, null, 2) + "\n").catch((err) => showError(err, "Couldn't save vault settings"));
  }, 400);

  const updateVault = useCallback(
    (patch: VaultPatch) => {
      setVaultSettings((s) => {
        const next = {
          sync: { ...s.sync, ...patch.sync },
          daily: { ...s.daily, ...patch.daily },
          attachments: { ...s.attachments, ...patch.attachments },
          templates: { ...s.templates, ...patch.templates },
        };
        persistVaultSettings(next);
        return next;
      });
    },
    [persistVaultSettings],
  );

  /** Vault settings change when another device syncs them in, so re-read after pulls too. */
  const loadVaultSettings = useCallback(async () => {
    try {
      const settings = parseVaultSettings(await api.readVaultSettings());
      setVaultSettings(settings);
      return settings;
    } catch {
      setVaultSettings(DEFAULT_VAULT);
      return DEFAULT_VAULT;
    }
  }, []);

  // ---- Loading -------------------------------------------------------------

  /** Base version + history for the open note (both change when versions are saved or synced). */
  const loadVersions = useCallback(
    async (path: string) => {
      const isCurrent = () => noteRef.current?.path === path;
      const [b, h] = await Promise.allSettled([api.gitNoteBase(path), api.gitNoteHistory(path)]);
      if (!isCurrent()) return;
      if (b.status === "fulfilled") setBase(b.value);
      if (h.status === "fulfilled") setHistory(h.value);
    },
    [noteRef],
  );

  const refreshGit = useCallback(async () => {
    try {
      const status = await api.gitStatus();
      setGit(status);
      setMerge(status.merging ? await api.gitMergeState().catch(() => null) : null);
    } catch (err) {
      setGit(null);
      setMerge(null);
      showError(err, "Couldn't read Git status");
    }
    const path = noteRef.current?.path;
    if (path) void loadVersions(path);
  }, [showError, noteRef, loadVersions]);

  const refreshTree = useCallback(async () => {
    try {
      setTree(await api.listTree());
    } catch (err) {
      showError(err, "Couldn't refresh notes");
    }
  }, [showError]);

  const refreshBacklinks = useCallback(
    async (forPath?: string) => {
      const path = forPath ?? noteRef.current?.path;
      if (!path) return;
      try {
        const [links, mentioned] = await Promise.all([api.noteBacklinks(path), api.unlinkedMentions(path).catch(() => [])]);
        if (noteRef.current?.path === path) {
          setBacklinks(links);
          setMentions(mentioned);
        }
      } catch {
        if (noteRef.current?.path === path) {
          setBacklinks([]);
          setMentions([]);
        }
      }
    },
    [noteRef],
  );

  const refreshAttachments = useCallback(async () => {
    try {
      setAttachments(await api.listAttachments());
    } catch {
      setAttachments([]);
    }
    filesVersion.current++;
  }, []);

  /** "Also edited today", shown on today's daily note. */
  const refreshRecent = useCallback(async () => {
    try {
      setRecent(await api.recentNotes(100));
    } catch {
      setRecent([]);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const [page, pend] = await Promise.all([api.gitLog(0, HISTORY_PAGE), api.gitPending()]);
      setVersions(page.versions);
      setMoreVersions(page.more);
      setPending(pend);
      setSelectedVersion((current) => {
        const stillThere = current === PENDING ? pend.files.length > 0 : page.versions.some((v) => v.commit.id === current);
        if (current && stillThere) return current;
        return pend.files.length ? PENDING : (page.versions[0]?.commit.id ?? null);
      });
    } catch (err) {
      showError(err, "Couldn't load history");
    } finally {
      setHistoryLoading(false);
    }
  }, [showError]);

  const loadMoreHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const page = await api.gitLog(versionsRef.current.length, HISTORY_PAGE);
      setVersions((prev) => [...prev, ...page.versions]);
      setMoreVersions(page.more);
    } catch (err) {
      showError(err, "Couldn't load older versions");
    } finally {
      setHistoryLoading(false);
    }
  }, [versionsRef, showError]);

  const refreshGitSoon = useDebouncedCallback(() => void refreshGit(), 1000);
  const refreshTreeSoon = useDebouncedCallback(() => void refreshTree(), 250);
  const refreshBacklinksSoon = useDebouncedCallback(() => void refreshBacklinks(), 1500);
  const refreshRecentSoon = useDebouncedCallback(() => void refreshRecent(), 1500);
  const refreshAttachmentsSoon = useDebouncedCallback(() => void refreshAttachments(), 600);
  const loadTags = useCallback(async () => {
    try {
      setTagIndex(await api.listTags());
      setTagsError(null);
    } catch (err) {
      setTagsError(api.errorMessage(err));
    }
  }, []);
  const refreshTagsSoon = useDebouncedCallback(() => {
    if (viewRef.current === "tags") void loadTags();
  }, 500);
  const redrawEmbedsSoon = useDebouncedCallback(() => editorRef.current?.refresh(), 300);
  const refreshHistorySoon = useDebouncedCallback(() => {
    if (viewRef.current === "history") void loadHistory();
  }, 1200);

  const closeNote = useCallback(() => {
    setNote(null);
    setText("");
    setSaveStatus(null);
    setBase(null);
    setHistory(null);
    setBacklinks(null);
    setMentions(null);
    setChangesInfo(null);
    setCompare(null);
  }, []);

  /** "Get changes when Penna opens": pull quietly, and only speak up if something came in. */
  const pullOnOpen = useCallback(async () => {
    try {
      const status = await api.gitStatus();
      if (!status.isRepo || !status.hasRemote || status.merging) return;
      const outcome = await api.gitPull();
      if (outcome.kind === "wouldConflict") {
        notify("Your other devices changed some of the same lines as you. Sync when you’re ready, and Penna will ask what to keep.");
      } else if (outcome.kind !== "upToDate") {
        notify("Got the latest changes from your other devices");
        void refreshTree();
        void loadVaultSettings();
      }
      void refreshGit();
    } catch (err) {
      // Unsaved-as-a-version edits that touch the same notes: Sync saves them first, then asks.
      if (/conflict/i.test(api.errorMessage(err))) {
        notify("Your other devices changed notes you’ve edited here too. Sync when you’re ready, and Penna will bring both together.");
      } else {
        showError(err, "Couldn't get changes on open");
      }
    }
  }, [notify, showError, refreshTree, refreshGit, loadVaultSettings]);

  const openVault = useCallback(
    async (path: string) => {
      const initialTree = await api.openVault(path);
      setVaultPath(path);
      setTree(initialTree);
      closeNote();
      setGit(null);
      setView("notes");
      setRenaming(null);
      setMoving(null);
      setDeleting(null);
      setVersions([]);
      setPending(null);
      setSelectedVersion(null);
      writeStorage(KEY_LAST_VAULT, path);
      try {
        setRecentOpened(JSON.parse(readStorage(recentKey(path)) ?? "[]") as string[]);
      } catch {
        setRecentOpened([]);
      }
      setBeside(null);
      const wasBeside = readStorage(besideKey(path));
      if (wasBeside) setTimeout(() => void openBesideRef.current(wasBeside, true), 400);
      void refreshAttachments();
      const settings = await loadVaultSettings();
      void refreshGit();
      if (settings.sync.pullOnOpen) void pullOnOpen();
    },
    [closeNote, refreshGit, loadVaultSettings, pullOnOpen, refreshAttachments],
  );

  // Reopen the last vault on startup (ref guard: StrictMode runs effects twice in dev).
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    const last = readStorage(KEY_LAST_VAULT);
    if (!last || !appSettingsRef.current.reopenLastVault) {
      setBooting(false);
      return;
    }
    openVault(last)
      .catch((err) => {
        writeStorage(KEY_LAST_VAULT, null);
        showError(err, "Couldn't reopen your last vault");
      })
      .finally(() => setBooting(false));
  }, [openVault, showError]);

  // ---- Notes ---------------------------------------------------------------

  const chooseVault = useCallback(async () => {
    try {
      await flushEditors();
      const path = await api.pickVaultFolder();
      if (path) await openVault(path);
    } catch (err) {
      showError(err, "Couldn't open that folder");
    }
  }, [openVault, showError]);

  /**
   * Open a note. Daily notes opened from Today stay in Today; everything
   * else shows in Notes. `compare` turns on Changes against an older version.
   */
  const selectNote = useCallback(
    async (path: string, opts: { view?: View; compare?: CompareTarget } = {}) => {
      const nav = ++navSeq.current;
      const date = dailyDateOf(path);
      const nextView: View = opts.view ?? (date && viewRef.current === "today" ? "today" : "notes");
      if (nextView === "today" && date) setDay(startOfDay(date));
      if (opts.compare) {
        const known = versionsRef.current.find((v) => v.commit.id === opts.compare!.id);
        setCompare({
          path,
          id: opts.compare.id,
          label: opts.compare.label || (known ? versionLabel(known.commit) : "an older version"),
        });
        setChangesOn(true);
      }
      if (noteRef.current?.path === path) {
        setView(nextView);
        return;
      }
      try {
        const file = await api.readNote(path);
        diskContentRef.current = file.content;
        setNote({
          id: ++noteIds.current,
          path,
          content: file.content,
          revision: 0,
          modified: file.modified,
        });
        setText(file.content);
        setSaveStatus("saved");
        setMode(appSettingsRef.current.defaultView); // each note opens in the default view
        setChangesInfo(null);
        setBase(null);
        setHistory(null);
        setBacklinks(null);
        setMentions(null);
        if (!opts.compare) setCompare(null);
        if (nav === navSeq.current) setView(nextView); // not if the user went elsewhere meanwhile
        void loadVersions(path);
        void refreshBacklinks(path);
        setRecentOpened((prev) => [path, ...prev.filter((p) => p !== path)].slice(0, 50));
        if (date && sameDay(date, new Date())) void refreshRecent();
      } catch (err) {
        showError(err, "Couldn't open that note");
      }
    },
    [noteRef, viewRef, versionsRef, loadVersions, refreshBacklinks, refreshRecent, showError],
  );

  /** Re-read the open note when coming back from History (its editor was unmounted). */
  const revisitNote = useCallback(async () => {
    const open = noteRef.current;
    if (!open || saveStatusRef.current === "dirty" || saveStatusRef.current === "saving") return;
    try {
      const file = await api.readNote(open.path);
      if (file.content === open.content) return;
      diskContentRef.current = file.content;
      setNote((prev) =>
        prev?.path === open.path
          ? {
              ...prev,
              content: file.content,
              revision: prev.revision + 1,
              modified: file.modified,
            }
          : prev,
      );
      setText(file.content);
    } catch {
      closeNote();
    }
  }, [noteRef, closeNote]);

  const saveNote = useCallback(
    async (path: string, content: string) => {
      let modified: number;
      try {
        modified = await api.writeNote(path, content);
      } catch (err) {
        showError(err, `Couldn't save ${noteTitle(path)}`);
        throw err; // the editor shows "Not saved" and retries on the next edit
      }
      if (noteRef.current?.path === path) {
        diskContentRef.current = content;
        setNote((prev) => (prev?.path === path ? { ...prev, content, modified } : prev));
      }
      refreshGitSoon();
      afterSaveRef.current();
    },
    [noteRef, showError, refreshGitSoon],
  );

  const createNote = useCallback(
    async (input: string) => {
      // "New notes go in" applies when the name has no folder of its own.
      const where = appSettingsRef.current.newNotesIn;
      const folder = /[\\/]/.test(input) || where === "root" ? "" : where === "inbox" ? "Inbox" : folderOf(noteRef.current?.path ?? "");
      const path = notePathFromInput(folder ? `${folder}/${input}` : input);
      await api.createNote(path); // rejects if it exists; the panel shows the error inline
      setCreating(false);
      setNewNoteFolder("");
      await refreshTree();
      await selectNote(path, { view: "notes" });
    },
    [refreshTree, selectNote, appSettingsRef, noteRef],
  );

  // ---- Today ---------------------------------------------------------------

  /**
   * Show a day in Today. Opens its note if there is one; for today (or when
   * asked) creates it from the template, carrying over yesterday's open tasks.
   */
  const openDay = useCallback(
    async (date: Date, create: boolean) => {
      const target = startOfDay(date);
      setDay(target);
      setView("today");
      const existing = dailyNotes(treeRef.current).find((n) => sameDay(n.date, target));
      if (existing) {
        await selectNote(existing.path, { view: "today" });
        return;
      }
      if (!create) {
        await flushEditors();
        closeNote();
        return;
      }
      const daily = vaultSettingsRef.current.daily;
      const path = dailyPath(target, daily.folder);
      let cursor: number | null = null;
      try {
        const paths = notePaths(treeRef.current);
        const templatePath = daily.template.trim() ? notePathFromInput(daily.template) : null;
        const template = templatePath && paths.includes(templatePath) ? (await api.readNote(templatePath)).content : null;
        const before = dailyNotes(treeRef.current).find((n) => n.date < target);
        const previous = before
          ? {
              date: before.date,
              content: (await api.readNote(before.path)).content,
            }
          : null;
        const title = daily.titleFormat.trim() ? formatDate(target, daily.titleFormat) : undefined;
        const start = takeCursor(buildDailyNote(target, template, previous, new Date(), { title, carryOver: daily.carryOver }));
        cursor = start.cursor;
        await api.createNote(path, start.text);
      } catch (err) {
        if (!/already exists/i.test(api.errorMessage(err))) {
          showError(err, "Couldn't start the day's note");
          return;
        }
      }
      await refreshTree();
      await selectNote(path, { view: "today" });
      if (cursor !== null) setTimeout(() => editorRef.current?.setCursor(cursor), 200);
    },
    [treeRef, vaultSettingsRef, selectNote, closeNote, refreshTree, showError],
  );

  // ---- History -------------------------------------------------------------

  useEffect(() => {
    if (view !== "history" || !selectedVersion) return;
    if (selectedVersion === PENDING) {
      setVersionDetail(pending);
      return;
    }
    let stale = false;
    setVersionDetail(null);
    api
      .gitVersion(selectedVersion)
      .then((detail) => !stale && setVersionDetail(detail))
      .catch((err) => !stale && showError(err, "Couldn't load that version"));
    return () => {
      stale = true;
    };
  }, [view, selectedVersion, pending, showError]);

  const stepVersion = useCallback(
    (dir: -1 | 1) => {
      const i = versions.findIndex((v) => v.commit.id === selectedVersion);
      const next = versions[i + dir];
      if (next) setSelectedVersion(next.commit.id);
      else if (dir === -1 && pending?.files.length) setSelectedVersion(PENDING);
    },
    [versions, selectedVersion, pending],
  );

  const restoreVersion = useCallback(
    async (paths: string[]) => {
      if (!selectedVersion || selectedVersion === PENDING) return;
      try {
        await flushEditors();
        const n = await api.gitRestore(selectedVersion, paths);
        notify(`Restored ${n} ${n === 1 ? "note" : "notes"}. Sync to save it as a new version.`);
        void refreshGit();
        void loadHistory();
      } catch (err) {
        showError(err, "Couldn't restore");
      }
    },
    [selectedVersion, notify, refreshGit, loadHistory, showError],
  );

  // ---- Git -----------------------------------------------------------------

  /** Save a version, get changes, send yours. `quiet` (automatic syncs) only speaks up when something came in or failed. */
  // ---- A paused sync -------------------------------------------------------

  const pausedNotesRef = useRef<PausedNote[]>([]);
  const mergeRef = useLatest(merge);

  /** The next place that still has both versions: in this note, else the next note that has one. */
  const goToNextPlace = useCallback(() => {
    const notes = pausedNotesRef.current;
    const open = noteRef.current?.path;
    if (notes.some((n) => n.path === open && n.places > 0)) {
      editorRef.current?.nextConflict();
      return;
    }
    const next = notes.find((n) => n.places > 0);
    if (next) void selectNote(next.path, { view: "notes" }).then(() => setTimeout(() => editorRef.current?.nextConflict(), 250));
  }, [noteRef, selectNote]);

  /** Every place has a choice: save the merge as a version and send it. */
  const finishSync = useCallback(async () => {
    if (syncBusyRef.current) return;
    setSyncBusy(true);
    fileOpRef.current = true;
    const theirs = mergeRef.current?.theirs?.device ?? "your other device";
    try {
      await flushEditors();
      const device = deviceRef.current;
      const outcome = await api.gitFinishMerge(`Merge changes from ${theirs}${device ? `\n\nDevice: ${device}` : ""}`);
      notify(
        outcome.pushed ? `Synced: your choices are saved, with ${theirs}’s changes, and sent` : "Saved the merged notes as a new version",
      );
      await revisitNote();
    } catch (err) {
      showError(err, "Couldn’t finish the sync");
    } finally {
      fileOpRef.current = false;
      setSyncBusy(false);
      void refreshGit();
      if (viewRef.current === "history") void loadHistory();
    }
  }, [syncBusyRef, mergeRef, deviceRef, notify, showError, revisitNote, refreshGit, loadHistory, viewRef]);

  /** Stop the paused sync: notes go back to this device's last version. */
  const stopSync = useCallback(async () => {
    setSyncBusy(true);
    fileOpRef.current = true;
    const theirs = mergeRef.current?.theirs?.device ?? "your other device";
    try {
      await flushEditors();
      await api.gitAbortMerge();
      await revisitNote();
      notify(`Stopped the sync. Your notes are as they were; ${theirs}’s changes wait for the next one.`);
    } catch (err) {
      showError(err, "Couldn’t stop the sync");
    } finally {
      fileOpRef.current = false;
      setSyncBusy(false);
      setStoppingSync(false);
      void refreshGit();
    }
  }, [mergeRef, notify, showError, revisitNote, refreshGit]);

  const sync = useCallback(
    async ({ quiet = false }: { quiet?: boolean } = {}) => {
      if (syncBusyRef.current) return;
      // Paused: automatic syncs wait; the Sync button finishes, or goes to the next place to choose.
      if (gitRef.current?.merging) {
        if (quiet) return;
        if (pausedNotesRef.current.every((n) => n.places === 0)) void finishSync();
        else goToNextPlace();
        return;
      }
      setSyncBusy(true);
      fileOpRef.current = true; // the open note is reloaded below, quietly
      try {
        await flushEditors(); // get the latest keystrokes onto disk first
        const outcome = await api.gitSync(syncMessage(vaultSettingsRef.current.sync.message, deviceRef.current));
        if (outcome.pull?.kind === "conflicts") {
          const paths = outcome.pull.paths;
          notify(`Sync paused: ${paths.length === 1 ? "a note" : `${paths.length} notes`} changed on both devices. Pick what to keep.`);
          await refreshGit();
          await revisitNote();
          const open = noteRef.current?.path;
          if (paths.length && (!open || !paths.includes(open))) await selectNote(paths[0], { view: "notes" });
          return;
        }
        if (!quiet || pulledSomething(outcome)) notify(describeSync(outcome));
        if (pulledSomething(outcome)) {
          void loadVaultSettings();
          await revisitNote();
        }
      } catch (err) {
        showError(err, quiet ? "Automatic sync stopped" : "Sync stopped");
      } finally {
        fileOpRef.current = false;
        setSyncBusy(false);
        void refreshGit();
        if (viewRef.current === "history") void loadHistory();
      }
    },
    [
      syncBusyRef,
      gitRef,
      viewRef,
      noteRef,
      vaultSettingsRef,
      deviceRef,
      notify,
      showError,
      refreshGit,
      loadHistory,
      loadVaultSettings,
      revisitNote,
      selectNote,
      finishSync,
      goToNextPlace,
    ],
  );

  // Automatic sync: on a timer, or a couple of minutes after the last save ("after I stop typing").
  const syncAfterTyping = useDebouncedCallback(() => void sync({ quiet: true }), TYPING_SYNC_DELAY);
  useEffect(() => {
    afterSaveRef.current = () => {
      const { auto, interval } = vaultSettingsRef.current.sync;
      if (auto && interval === "typing" && gitRef.current?.isRepo) syncAfterTyping();
    };
  }, [vaultSettingsRef, gitRef, syncAfterTyping]);

  // The timer calls sync through a ref, so it isn't restarted (and postponed) every time sync is re-created.
  const syncRef = useLatest(sync);
  const autoSync = vaultSettings.sync.auto && vaultSettings.sync.interval !== "typing" && !!vaultPath && !!git?.isRepo;
  const autoMinutes = Number(vaultSettings.sync.interval) || 15;
  useEffect(() => {
    if (!autoSync) return;
    const id = setInterval(() => {
      const status = gitRef.current;
      if (status?.isRepo && !status.merging && (status.changedFiles > 0 || status.hasRemote)) void syncRef.current({ quiet: true });
    }, autoMinutes * 60_000);
    return () => clearInterval(id);
  }, [autoSync, autoMinutes, gitRef, syncRef]);

  // "Sync when Penna closes": the window waits (up to a limit) for one last sync.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    api.appWindow
      .onCloseRequested(async () => {
        const work = (async () => {
          await flushEditors();
          const settings = vaultSettingsRef.current.sync;
          if (settings.syncOnClose && gitRef.current?.isRepo && !gitRef.current.merging && !syncBusyRef.current) {
            await api.gitSync(syncMessage(settings.message, deviceRef.current));
          }
        })().catch(() => {}); // closing must never get stuck on an error
        await Promise.race([work, new Promise((resolve) => setTimeout(resolve, CLOSE_SYNC_TIMEOUT))]);
      })
      .then((fn) => (disposed ? fn() : (unlisten = fn)))
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [vaultSettingsRef, gitRef, syncBusyRef, deviceRef]);

  const initRepo = useCallback(async () => {
    setSyncBusy(true);
    try {
      setGit(await api.gitInit());
      notify("History is on. Each sync now saves a version of your notes.");
      const path = noteRef.current?.path;
      if (path) void loadVersions(path);
    } catch (err) {
      showError(err, "Couldn't set up history");
    } finally {
      setSyncBusy(false);
    }
  }, [notify, showError, noteRef, loadVersions]);

  /**
   * Link handlers for a pane: the main note, or the one beside it. A plain
   * click opens a note in the same pane; Ctrl+click opens it in the other.
   */
  const makeLinks = useCallback(
    (pane: "main" | "beside"): LinkHandlers => {
      const here = () => (pane === "main" ? noteRef.current?.path : besideRef.current?.path) ?? "";
      const open = (path: string, other = false) => {
        if ((pane === "main") !== other) void selectNote(path);
        else void openBesideRef.current(path);
      };
      return {
        openWikiLink: (target, other) => {
          const found = resolveWikiLink(target, notePaths(treeRef.current));
          if (found) {
            open(found, other);
            return;
          }
          // `[[report.pdf]]`: a file in the vault, not a note.
          const file = resolveEmbed(target, filesRef.current);
          if (file) {
            api.openAttachment(file).catch((err) => showError(err, `Couldn't open “${basename(file)}”`));
            return;
          }
          // Following a link to a note that doesn't exist yet creates it, like a wiki.
          void (async () => {
            try {
              const path = notePathFromInput(target);
              await api.createNote(path);
              await refreshTree();
              open(path, other);
              notify(`Created “${noteTitle(path)}”`);
            } catch (err) {
              showError(err, `Couldn't open “${target}”`);
            }
          })();
        },
        openUrl: (url, other) => {
          if (/^(https?:|mailto:)/i.test(url)) {
            api.openExternal(url).catch((err) => showError(err, "Couldn't open the link"));
            return;
          }
          // A relative link to another note: [text](Other%20note.md)
          const current = here();
          let decoded: string;
          try {
            decoded = decodeURIComponent(url.split("#")[0]);
          } catch {
            return; // malformed %-escape
          }
          const paths = notePaths(treeRef.current);
          const relative = joinPath(folderOf(current), decoded);
          const found = (relative && resolveWikiLink(relative, paths)) || resolveWikiLink(decoded, paths);
          if (found) {
            open(found, other);
            return;
          }
          // An attachment: [report](Attachments/report.pdf) opens in its own app.
          const file = resolveAttachment(decoded, current, filesRef.current);
          if (file) api.openAttachment(file).catch((err) => showError(err, `Couldn't open “${basename(file)}”`));
        },
        imageUrl: (src, embed, from) => {
          if (/^(https:|data:image\/)/i.test(src)) return src;
          if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null; // other schemes (http:, file:) aren't shown
          const current = from ?? here();
          if (embed) {
            const file = resolveEmbed(src, filesRef.current);
            return file && IMAGE_FILE.test(file) ? `${api.attachmentUrl(file)}?v=${filesVersion.current}` : null;
          }
          let decoded: string;
          try {
            decoded = decodeURIComponent(src.split("#")[0]);
          } catch {
            return null;
          }
          if (!IMAGE_FILE.test(decoded)) return null;
          // Not in the list yet (just pasted)? Try the path relative to the note anyway.
          const file = resolveAttachment(decoded, current, filesRef.current) ?? joinPath(folderOf(current), decoded);
          return file ? `${api.attachmentUrl(file)}?v=${filesVersion.current}` : null;
        },
        embedNote: (target) => {
          const path = resolveWikiLink(target, notePaths(treeRef.current));
          if (!path || path === here()) return null; // a note never embeds itself
          return { path, title: displayTitle(path), version: notesVersion.current };
        },
        readNote: (path) => api.readNote(path).then((file) => file.content),
        openTag: (tag) => openTagRef.current(tag),
        fileMenu: (src, embed, at) => {
          if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false; // web links and other schemes
          let file: string | null = null;
          if (embed) file = resolveEmbed(src, filesRef.current);
          else {
            try {
              file = resolveAttachment(decodeURIComponent(src.split("#")[0]), here(), filesRef.current);
            } catch {
              file = null;
            }
          }
          if (!file) return false;
          setFileMenu({ path: file, anchor: at });
          return true;
        },
      };
    },
    [treeRef, noteRef, besideRef, filesRef, selectNote, refreshTree, notify, showError],
  );
  const links = useMemo(() => makeLinks("main"), [makeLinks]);
  const besideLinks = useMemo(() => makeLinks("beside"), [makeLinks]);

  /** Pasted images and picked files are copied into the vault's attachments folder. */
  const makeFiles = useCallback(
    (pane: "main" | "beside"): FileHandlers => {
      const here = () => (pane === "main" ? noteRef.current?.path : besideRef.current?.path);
      return {
        savePasted: async (file) => {
          const note = here();
          if (!note) return "";
          try {
            const name = file.name && !/^image\.\w+$/i.test(file.name) ? file.name : pastedName(file.type);
            const data = new Uint8Array(await file.arrayBuffer());
            const path = await api.saveAttachment(data, name, note, vaultSettingsRef.current.attachments.folder);
            void refreshAttachments();
            return attachmentMarkdown(note, path);
          } catch (err) {
            showError(err, "Couldn't add the pasted file");
            throw err;
          }
        },
        ...(pane === "main" ? { pickTemplate: () => pickTemplateRef.current() } : {}),
        pickFiles: async () => {
          const note = here();
          if (!note) return "";
          try {
            const picked = await api.pickAttachmentFiles();
            if (!picked.length) return "";
            const paths = await api.importAttachments(picked, note, vaultSettingsRef.current.attachments.folder);
            void refreshAttachments();
            return paths.map((p) => attachmentMarkdown(note, p)).join("\n");
          } catch (err) {
            showError(err, "Couldn't add those files");
            return "";
          }
        },
      };
    },
    [noteRef, besideRef, vaultSettingsRef, refreshAttachments, showError],
  );
  const fileHandlers = useMemo(() => makeFiles("main"), [makeFiles]);
  const besideFiles = useMemo(() => makeFiles("beside"), [makeFiles]);

  // Files dragged in from Explorer go into the open note, where they're dropped.
  useEffect(() => {
    if (!vaultPath) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    api
      .onFileDrop((event) => {
        if (event.type === "leave") {
          editorRef.current?.dropHint(null);
          besideEditorRef.current?.dropHint(null);
          return;
        }
        const pane = document.querySelector("[data-pane=beside]")?.getBoundingClientRect();
        const onBeside = !!pane && event.x >= pane.left && event.x <= pane.right && event.y >= pane.top && event.y <= pane.bottom;
        const editor = onBeside ? besideEditorRef.current : editorRef.current;
        (onBeside ? editorRef.current : besideEditorRef.current)?.dropHint(null);
        if (event.type === "over") return editor?.dropHint({ x: event.x, y: event.y });
        const note = onBeside ? besideRef.current?.path : noteRef.current?.path;
        if (!editor || !note) {
          notify("Open a note, then drop files onto it to add them.");
          return;
        }
        void (async () => {
          try {
            const paths = await api.importAttachments(event.paths, note, vaultSettingsRef.current.attachments.folder);
            void refreshAttachments();
            editor.insertFiles({ x: event.x, y: event.y }, paths.map((p) => attachmentMarkdown(note, p)).join("\n"));
            if (paths.length) notify(`Added ${paths.length} ${paths.length === 1 ? "file" : "files"} to the note`);
          } catch (err) {
            editor.dropHint(null);
            showError(err, "Couldn't add those files");
          }
        })();
      })
      .then(
        (fn) => (disposed ? fn() : (unlisten = fn)),
        () => {},
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [vaultPath, noteRef, besideRef, vaultSettingsRef, notify, showError, refreshAttachments]);

  /** The open note changed on disk (another editor, a pull, a restore, a cloud client). */
  const reloadIfChangedOnDisk = useCallback(
    async (path: string) => {
      // Unsaved local edits win; the next save overwrites the disk version.
      if (saveStatusRef.current !== "saved") return;
      let file: api.NoteFile;
      try {
        file = await api.readNote(path);
      } catch {
        if (noteRef.current?.path === path) {
          closeNote();
          notify(`“${noteTitle(path)}” was moved or deleted outside Penna`);
        }
        return;
      }
      if (noteRef.current?.path !== path || file.content === diskContentRef.current) return; // our own save
      diskContentRef.current = file.content;
      setNote((prev) =>
        prev?.path === path
          ? {
              ...prev,
              content: file.content,
              revision: prev.revision + 1,
              modified: file.modified,
            }
          : prev,
      );
      setText(file.content);
      notify(`Reloaded “${noteTitle(path)}”: it changed on disk`);
    },
    [saveStatusRef, noteRef, closeNote, notify],
  );

  // ---- Subscriptions -------------------------------------------------------

  useEffect(() => {
    if (!vaultPath) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    api
      .onVaultChanged((paths) => {
        refreshTreeSoon();
        refreshGitSoon();
        refreshBacklinksSoon();
        refreshRecentSoon();
        refreshHistorySoon();
        refreshAttachmentsSoon();
        refreshTagsSoon();
        const side = besideRef.current;
        if (side && paths.includes(side.path) && !fileOpRef.current) void reloadBesideRef.current(side.path);
        const open = noteRef.current;
        if (open && paths.includes(open.path) && !fileOpRef.current) void reloadIfChangedOnDisk(open.path);
        // Another note changed: embeds of it load again.
        if (paths.some((p) => p !== open?.path && /\.(md|markdown)$/i.test(p))) {
          notesVersion.current++;
          redrawEmbedsSoon();
        }
      })
      .then(
        (fn) => (disposed ? fn() : (unlisten = fn)),
        (err) => showError(err, "Couldn't watch the vault for changes"),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    vaultPath,
    noteRef,
    refreshTreeSoon,
    refreshGitSoon,
    refreshBacklinksSoon,
    refreshRecentSoon,
    refreshHistorySoon,
    refreshAttachmentsSoon,
    redrawEmbedsSoon,
    reloadIfChangedOnDisk,
    showError,
  ]);

  // The watcher ignores `.git/`, so also refresh when the window regains focus
  // (picks up commits made from a terminal).
  useEffect(() => {
    if (!vaultPath) return;
    const onFocus = () => {
      refreshGitSoon();
      refreshHistorySoon();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [vaultPath, refreshGitSoon, refreshHistorySoon]);

  // Load the older version's text when comparing against one.
  const activeCompare = compare && note && compare.path === note.path ? compare : null;
  useEffect(() => {
    setCompareBase(undefined);
    if (!activeCompare) return;
    let stale = false;
    api
      .gitNoteAt(activeCompare.path, activeCompare.id)
      .then((text) => !stale && setCompareBase(text ?? ""))
      .catch((err) => !stale && showError(err, "Couldn't load that version"));
    return () => {
      stale = true;
    };
  }, [activeCompare?.path, activeCompare?.id, showError]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Derived state -------------------------------------------------------

  const changesUnavailable = !git
    ? "Loading history…"
    : !git.isRepo
      ? "Set up history to see changes"
      : base?.kind === "none"
        ? "Save a first version to see changes"
        : null;
  const showChanges = changesOn && !changesUnavailable && base !== null;
  const changesBase = !showChanges ? undefined : activeCompare ? compareBase : (base?.content ?? "");
  const changesLabel = activeCompare ? activeCompare.label : baseLabel(base);
  const compareOptions = useMemo(
    () =>
      (history?.versions ?? []).map((v) => ({
        id: v.id,
        label: versionLabel(v),
      })),
    [history],
  );
  const headings = useMemo(() => extractHeadings(text), [text]);
  const changedPaths = useMemo(() => new Set(git?.changedPaths ?? []), [git]);

  // A paused sync: the open note's count comes live from its editor, the rest from the folder.
  const openConflicts = note && conflictsSeen?.path === note.path ? conflictsSeen.info : null;
  const pausedNotes: PausedNote[] | null = merge
    ? merge.notes.map((n) =>
        note && n.path === note.path && conflictsSeen?.path === note.path ? { path: n.path, places: openConflicts?.open.length ?? 0 } : n,
      )
    : null;
  pausedNotesRef.current = pausedNotes ?? [];
  const pausedLeft = pausedNotes?.reduce((sum, n) => sum + n.places, 0) ?? 0;
  const theirsName = merge?.theirs?.device ?? "Other device";
  const conflictLabels: ConflictLabels | null = merge
    ? {
        ours: merge.ours ? `This PC · ${shortTime(merge.ours.timestamp * 1000)}` : "This PC",
        theirs: merge.theirs ? `${theirsName} · ${shortTime(merge.theirs.timestamp * 1000)}` : theirsName,
        theirsName,
      }
    : null;
  const pausedSync: PausedSync | null =
    merge && pausedNotes
      ? {
          theirsName,
          notes: pausedNotes,
          ready: pausedLeft === 0,
          busy: syncBusy,
          onFinish: () => void finishSync(),
          onStop: () => setStoppingSync(true),
          onOpenNote: (path) => void selectNote(path, { view: "notes" }),
        }
      : null;

  const noteDate = note ? dailyDateOf(note.path) : null;
  const dayNav = useMemo(() => {
    if (!noteDate) return undefined;
    const all = dailyNotes(tree); // newest first
    const link = (n: { path: string; date: Date } | undefined): DayLink | null => (n ? { path: n.path, label: shortTitle(n.date) } : null);
    return {
      previous: link(all.find((n) => n.date < noteDate)),
      next: link([...all].reverse().find((n) => n.date > noteDate)),
    };
  }, [noteDate?.getTime(), tree]); // eslint-disable-line react-hooks/exhaustive-deps
  const editedToday = useMemo(() => {
    if (!note || !noteDate || !sameDay(noteDate, new Date()) || !recent) return undefined;
    const start = startOfDay(new Date()).getTime();
    return recent.filter((n) => n.modified >= start && n.path !== note.path);
  }, [note, noteDate?.getTime(), recent]); // eslint-disable-line react-hooks/exhaustive-deps

  const setModeAndRemember = useCallback((next: ViewMode) => setMode(next), []);

  /** Views without the note editor; coming back from them re-reads the open note. */
  const editorless = (v: View) => v === "history" || v === "search" || v === "settings" || v === "tags";

  const changeView = useCallback(
    (next: View) => {
      navSeq.current++;
      setRenaming(null);
      if (next === "today") {
        void openDay(new Date(), true);
        return;
      }
      if (next === "history") {
        setView("history");
        void loadHistory();
        return;
      }
      if (next === "tags") void loadTags();
      if (editorless(viewRef.current) && !editorless(next)) void revisitNote();
      setView(next);
    },
    [openDay, loadHistory, revisitNote, viewRef, loadTags],
  );

  useEffect(() => {
    openTagRef.current = (tag: string) => {
      setSelectedTag(tag);
      changeView("tags");
    };
  }, [changeView]);

  /** Open a note from the Tags view, at the line where the tag is written. */
  const openTagged = useCallback(
    async (path: string, line: number | null) => {
      navSeq.current++;
      if (noteRef.current?.path === path) {
        await revisitNote();
        setView("notes");
      } else {
        await selectNote(path, { view: "notes" });
      }
      if (line) setTimeout(() => editorRef.current?.scrollToLine(line), 200);
    },
    [noteRef, revisitNote, selectNote],
  );

  /** Open a note that mentions the open one, at the mention. */
  const openMention = useCallback(
    async (path: string, line: number) => {
      navSeq.current++;
      await selectNote(path, { view: "notes" });
      setTimeout(() => editorRef.current?.scrollToLine(line), 200);
    },
    [selectNote],
  );

  /** Open a note beside the one you're writing (quietly when restoring it). */
  const openBeside = useCallback(
    async (path: string, quiet = false) => {
      if (noteRef.current?.path === path) {
        if (!quiet) notify("That's the note you're writing. Pick another one to open beside it.");
        return;
      }
      await besideEditorRef.current?.flush();
      try {
        const file = await api.readNote(path);
        besideDisk.current = file.content;
        setBesideStatus("saved");
        setBeside((b) => ({ path, content: file.content, modified: file.modified, revision: (b?.revision ?? 0) + 1 }));
        if (!quiet && editorless(viewRef.current)) changeView("notes");
      } catch (err) {
        if (!quiet) showError(err, `Couldn't open “${displayTitle(path)}” beside`);
      }
    },
    [noteRef, viewRef, notify, showError, changeView], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    openBesideRef.current = openBeside;
  }, [openBeside]);

  const closeBeside = useCallback(async () => {
    await besideEditorRef.current?.flush();
    setBeside(null);
  }, []);

  /** The Beside button and Ctrl+\\: close the note beside, or choose one to open. */
  const toggleBeside = useCallback(() => {
    if (besideRef.current) return void closeBeside();
    if (!noteRef.current) return notify("Open a note first, then another one beside it.");
    setSwitcherBeside(true);
    setSwitcher("");
  }, [besideRef, noteRef, closeBeside, notify]);

  /** Swap: the note beside becomes the main one (the effect below puts the old main one beside). */
  const swapBeside = useCallback(async () => {
    const side = besideRef.current;
    if (side) await selectNote(side.path, { view: "notes" });
  }, [besideRef, selectNote]);

  // When the main note becomes the one beside (Swap, or opening it), the old main note goes beside.
  const previousMain = useRef<string | null>(null);
  useEffect(() => {
    const path = note?.path ?? null;
    const previous = previousMain.current;
    previousMain.current = path;
    if (path && besideRef.current?.path === path) {
      if (previous && previous !== path) void openBeside(previous, true);
      else setBeside(null);
    }
  }, [note?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveBeside = useCallback(
    async (content: string) => {
      const side = besideRef.current;
      if (!side) return;
      besideDisk.current = content;
      await api.writeNote(side.path, content);
    },
    [besideRef],
  );

  /** The note beside changed on disk: reload it, unless it has edits of its own waiting. */
  const reloadBeside = useCallback(
    async (path: string) => {
      const file = await api.readNote(path).catch(() => null);
      if (besideRef.current?.path !== path) return;
      if (!file) {
        setBeside(null);
        notify(`“${displayTitle(path)}” is gone, so it's no longer beside.`);
        return;
      }
      if (file.content === besideDisk.current || besideStatusRef.current !== "saved") return;
      besideDisk.current = file.content;
      setBeside((b) => (b && b.path === path ? { ...b, content: file.content, modified: file.modified, revision: b.revision + 1 } : b));
    },
    [besideRef, besideStatusRef, notify],
  );
  const reloadBesideRef = useLatest(reloadBeside);

  useEffect(() => {
    if (vaultPath) writeStorage(besideKey(vaultPath), beside?.path ?? "");
  }, [vaultPath, beside?.path]);

  /** "Link": turn a note's mentions of the open note into links. */
  const linkMentions = useCallback(
    async (mentioning: api.Mentioning) => {
      const target = noteRef.current?.path;
      if (!target) return;
      try {
        const n = await api.linkMentions(mentioning.path, target, mentioning.mentions);
        notify(`Linked ${n === 1 ? "a mention" : `${n} mentions`} in “${displayTitle(mentioning.path)}” to “${displayTitle(target)}”.`);
      } catch (err) {
        showError(err, "Couldn't link it");
      }
      void refreshBacklinks(target);
    },
    [noteRef, notify, showError, refreshBacklinks],
  );

  /** Rename a tag in every note; the dialog shows any error. */
  const renameTag = async (from: string, to: string) => {
    fileOpRef.current = true;
    try {
      await flushEditors();
      const outcome = await api.renameTag(from, to);
      setRenamingTag(null);
      const n = outcome.notes.length;
      notify(`Renamed #${from} to #${outcome.name} in ${n} ${n === 1 ? "note" : "notes"}.`);
      setSelectedTag(outcome.name.toLowerCase());
      await loadTags();
      const open = noteRef.current;
      if (open && outcome.notes.includes(open.path) && !editorless(viewRef.current)) await revisitNote();
    } finally {
      fileOpRef.current = false;
      void refreshGit();
    }
  };

  /** Open a search result and jump to the first match. */
  const openSearchResult = useCallback(
    async (path: string, term: string) => {
      navSeq.current++;
      if (noteRef.current?.path === path) {
        await revisitNote();
        setView("notes");
      } else {
        await selectNote(path, { view: "notes" });
      }
      if (term) setTimeout(() => editorRef.current?.reveal(term), 200);
    },
    [noteRef, revisitNote, selectNote],
  );

  /** Text found in an older version: compare the note with it, or show where a deleted note went. */
  /**
   * Open a note named by an older version, comparing with that version. If it
   * was renamed or moved since, follow it to where it is now.
   */
  const openFromHistory = useCallback(
    async (path: string, compare: CompareTarget): Promise<boolean> => {
      if (notePaths(treeRef.current).includes(path)) {
        await selectNote(path, { view: "notes", compare });
        return true;
      }
      try {
        const now = await api.gitCurrentPath(path, compare.id);
        if (!now) return false;
        const where =
          folderOf(now) !== folderOf(path) ? ` in ${folderOf(now) ? folderOf(now).split("/").join(" · ") : "the top of the vault"}` : "";
        notify(
          noteTitle(now) === noteTitle(path)
            ? `“${noteTitle(path)}” is${where} now`
            : `“${noteTitle(path)}” is now “${noteTitle(now)}”${where}`,
        );
        await selectNote(now, { view: "notes", compare });
        return true;
      } catch (err) {
        showError(err, "Couldn't open that note");
        return true;
      }
    },
    [treeRef, selectNote, notify, showError],
  );

  const openHistoryHit = useCallback(
    (hit: HistoryHit) => {
      void (async () => {
        const compare = { id: hit.version.id, label: versionLabel(hit.version) };
        if (await openFromHistory(hit.path, compare)) return;
        // Really deleted: show the version that removed it.
        setSelectedVersion(hit.removedIn.id);
        changeView("history");
      })();
    },
    [changeView, openFromHistory],
  );

  // ---- Rename, move, delete ------------------------------------------------

  /** Rename in place in the Notes panel (switching to it from Today and other views). */
  const startRename = useCallback(
    (item: PanelItem) => {
      if (viewRef.current !== "notes") changeView("notes");
      setCreating(false);
      setRenaming(item);
    },
    [viewRef, changeView],
  );

  /**
   * After a rename or move (of a note, or a folder with notes in it): follow
   * the open note to its new path, reload it if its text changed, and keep
   * settings that name a moved note or folder pointing at it.
   */
  const followMoves = useCallback(
    async (outcome: RenameOutcome, folder?: { from: string; to: string }) => {
      const moves = new Map(outcome.moved.map((m) => [m.from, m.to]));
      if (moves.size) setRecentOpened((prev) => prev.map((p) => moves.get(p) ?? p));
      // The note beside follows too, and reloads if its links were rewritten.
      const side = besideRef.current;
      if (side) {
        const to = moves.get(side.path) ?? side.path;
        if (to !== side.path || outcome.updated.includes(to)) {
          const file = await api.readNote(to).catch(() => null);
          if (file) besideDisk.current = file.content;
          setBeside((b) =>
            b && b.path === side.path
              ? { ...b, path: to, ...(file ? { content: file.content, modified: file.modified, revision: b.revision + 1 } : {}) }
              : b,
          );
        }
      }
      const open = noteRef.current;
      if (open) {
        const path = moves.get(open.path) ?? open.path;
        const from = open.path;
        // Its text changed on disk (links rewritten, or its heading renamed): load it again.
        const changed = outcome.updated.includes(path) || (outcome.retitled && path !== from);
        const file = changed ? await api.readNote(path).catch(() => null) : null;
        if (file) {
          diskContentRef.current = file.content;
          setText(file.content);
        }
        setNote((prev) =>
          prev?.path === open.path
            ? { ...prev, path, ...(file ? { content: file.content, revision: prev.revision + 1, modified: file.modified } : {}) }
            : prev,
        );
        if (path !== from) {
          setCompare((c) => (c?.path === from ? { ...c, path } : c));
          void loadVersions(path);
          void refreshBacklinks(path);
        }
      }
      // Settings → Daily notes (folder, template) and Attachments name notes and folders by path.
      const { daily, attachments, templates } = vaultSettingsRef.current;
      let templatePath: string | null = null;
      try {
        templatePath = daily.template.trim() ? notePathFromInput(daily.template) : null;
      } catch {
        // not a usable path; leave the setting alone
      }
      const movedTemplate = templatePath ? moves.get(templatePath) : undefined;
      const patch = {
        daily: {
          ...(movedTemplate ? { template: movedTemplate.replace(/\.(md|markdown)$/i, "") } : {}),
          ...(folder && retarget(daily.folder, folder.from, folder.to) ? { folder: retarget(daily.folder, folder.from, folder.to)! } : {}),
        },
        attachments:
          folder && retarget(attachments.folder, folder.from, folder.to)
            ? { folder: retarget(attachments.folder, folder.from, folder.to)! }
            : {},
      };
      const templatesTo = folder ? retarget(templates.folder, folder.from, folder.to) : null;
      if (templatesTo) Object.assign(patch, { templates: { folder: templatesTo } });
      if (Object.keys(patch.daily).length || Object.keys(patch.attachments).length || templatesTo) updateVault(patch);
      await refreshTree();
      void refreshGit();
    },
    [noteRef, vaultSettingsRef, loadVersions, refreshBacklinks, updateVault, refreshTree, refreshGit],
  );

  /** Rename or move a note; the backend rewrites links to it. Rejects so the caller can show the error. */
  const moveNote = useCallback(
    async (from: string, to: string) => {
      if (from === to) return;
      fileOpRef.current = true;
      try {
        await flushEditors();
        const outcome = await api.renameNote(from, to);
        await followMoves(outcome);
        notify(describeRename(from, outcome));
      } finally {
        fileOpRef.current = false;
      }
    },
    [followMoves, notify],
  );

  /** Rename or move a folder with everything in it; links to what's inside follow. */
  const moveFolder = useCallback(
    async (from: string, to: string) => {
      if (from === to) return;
      fileOpRef.current = true;
      try {
        await flushEditors();
        const outcome = await api.renameFolder(from, to);
        await followMoves(outcome, { from, to: outcome.path });
        notify(describeFolderMove(from, outcome));
      } finally {
        fileOpRef.current = false;
      }
    },
    [followMoves, notify],
  );

  const renameInPlace = useCallback(
    async (item: PanelItem, name: string) => {
      if (item.folder) await moveFolder(item.path, folderRenameTarget(item.path, name));
      else await moveNote(item.path, renameTarget(item.path, name));
      setRenaming(null);
    },
    [moveNote, moveFolder],
  );

  const moveToFolder = useCallback(
    async (folder: string) => {
      if (!moving) return;
      const to = moveTarget(moving.path, folder);
      if (moving.folder) await moveFolder(moving.path, to);
      else await moveNote(moving.path, to);
      setMoving(null);
    },
    [moving, moveNote, moveFolder],
  );

  /** Dragged onto a folder in the Notes panel. */
  const dropInto = useCallback(
    (item: PanelItem, into: string) => {
      const to = moveTarget(item.path, into);
      const run = item.folder ? moveFolder(item.path, to) : moveNote(item.path, to);
      run.catch((err) => showError(err, `Couldn't move “${basename(item.path)}”`));
    },
    [moveNote, moveFolder, showError],
  );

  /** Ask first; the dialog says how many notes link to it. */
  const requestDelete = useCallback((path: string) => {
    setDeleting({ path, links: null });
    api.noteBacklinks(path).then(
      (links) => setDeleting((d) => (d?.path === path ? { ...d, links: links.length } : d)),
      () => {},
    );
  }, []);

  const deleteNote = useCallback(
    async (path: string) => {
      fileOpRef.current = true;
      try {
        await flushEditors();
        await api.deleteNote(path);
        if (noteRef.current?.path === path) closeNote();
        if (besideRef.current?.path === path) setBeside(null);
        notify(`Deleted “${displayTitle(path)}”. It's in the Recycle Bin.`);
        await refreshTree();
        void refreshGit();
      } catch (err) {
        showError(err, "Couldn't delete it");
      } finally {
        fileOpRef.current = false;
        setDeleting(null);
      }
    },
    [noteRef, closeNote, notify, showError, refreshTree, refreshGit],
  );

  const loadHeadings = useCallback(() => api.listHeadings(), []);
  const loadTagList = useCallback(
    async () => [...tagCounts(await api.listTags())].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count),
    [],
  );

  /** Everything the switcher's ">" can do, for what's open right now. */
  const switcherCommands = (): SwitcherCommand[] => {
    const theme = appSettings.theme;
    const editing = !!note && !editorless(view);
    const list: (SwitcherCommand | false)[] = [
      {
        id: "new",
        label: "New note",
        hint: "Ctrl N",
        run: () => {
          changeView("notes");
          setCreating(true);
        },
      },
      { id: "template-new", label: "New note from a template…", hint: "Ctrl Shift N", run: () => startFromTemplate() },
      { id: "today", label: "Open today's note", hint: "Ctrl D", run: () => changeView("today") },
      { id: "search", label: "Search everything", hint: "Ctrl Shift F", run: () => changeView("search") },
      { id: "tags", label: "Browse tags", hint: "Ctrl Shift T", run: () => changeView("tags") },
      { id: "history", label: "Show history", run: () => changeView("history") },
      { id: "settings", label: "Open settings", hint: "Ctrl ,", run: () => changeView("settings") },
      !!git?.isRepo && {
        id: "sync",
        label: git.merging
          ? pausedLeft
            ? "Go to the next place to choose"
            : "Finish sync"
          : git.hasRemote
            ? "Sync now"
            : "Save a version",
        hint: "Ctrl Shift S",
        run: () => void sync(),
      },
      editing && {
        id: "mode",
        label: mode === "preview" ? "Switch to Source" : "Switch to Preview",
        hint: "Ctrl E",
        run: () => setModeAndRemember(mode === "preview" ? "source" : "preview"),
      },
      editing &&
        !changesUnavailable && {
          id: "changes",
          label: showChanges ? "Hide changes" : "Show changes",
          hint: "Ctrl Shift E",
          run: () => setChangesOn((on) => !on),
        },
      editing && {
        id: "beside",
        label: beside ? "Close the note beside" : "Open a note beside this one…",
        hint: "Ctrl \\",
        run: toggleBeside,
      },
      editing && !!beside && { id: "swap", label: "Swap the two notes", run: () => void swapBeside() },
      editing && { id: "rename", label: "Rename this note", hint: "F2", run: () => startRename({ path: note.path, folder: false }) },
      editing && { id: "move", label: "Move this note…", run: () => setMoving({ path: note.path, folder: false }) },
      editing && {
        id: "attach",
        label: "Add an image or file…",
        run: () => void fileHandlers.pickFiles().then((markdown) => markdown && editorRef.current?.insertFiles(null, markdown)),
      },
      editing && {
        id: "template-insert",
        label: "Insert a template…",
        run: () => void pickTemplate().then((t) => t && editorRef.current?.insertSnippet(t.text, t.cursor)),
      },
      editing && { id: "export-html", label: "Export as HTML…", run: () => void exportNote(note.path, "html") },
      editing && { id: "export-pdf", label: "Export as PDF…", run: () => void exportNote(note.path, "pdf") },
      editing && { id: "print", label: "Print…", run: () => void exportNote(note.path, "print") },
      editing && { id: "delete", label: "Delete this note…", run: () => requestDelete(note.path) },
      { id: "vault", label: "Open another vault…", run: () => void chooseVault() },
      theme !== "dark" && { id: "dark", label: "Use the dark theme", run: () => updateApp({ theme: "dark" }) },
      theme !== "light" && { id: "light", label: "Use the light theme", run: () => updateApp({ theme: "light" }) },
      theme !== "system" && { id: "system", label: "Match the Windows theme", run: () => updateApp({ theme: "system" }) },
    ];
    return list.filter((c): c is SwitcherCommand => !!c);
  };

  /** Ask first; the dialog says what's inside. */
  const requestDeleteFolder = useCallback((path: string) => {
    setDeletingFolder({ path, contents: null });
    api.folderContents(path).then(
      (contents) => setDeletingFolder((d) => (d?.path === path ? { ...d, contents } : d)),
      () => {},
    );
  }, []);

  const deleteFolder = useCallback(
    async (path: string) => {
      fileOpRef.current = true;
      try {
        await flushEditors();
        await api.deleteFolder(path);
        const open = noteRef.current?.path;
        if (open && open.startsWith(`${path}/`)) closeNote();
        if (besideRef.current?.path.startsWith(`${path}/`)) setBeside(null);
        notify(`Deleted the folder “${basename(path)}”. It's in the Recycle Bin.`);
        await refreshTree();
        void refreshGit();
      } catch (err) {
        showError(err, "Couldn't delete the folder");
      } finally {
        fileOpRef.current = false;
        setDeletingFolder(null);
      }
    },
    [noteRef, closeNote, notify, showError, refreshTree, refreshGit],
  );

  // ---- Images and files in notes -------------------------------------------

  /** Rename an attachment (the extension stays unless a new one is typed); links and embeds follow. */
  const renameFile = useCallback(
    async (from: string, input: string) => {
      const name = input
        .trim()
        .replace(/[<>:"|?*\\/\u0000-\u001f]/g, "")
        .replace(/[. ]+$/, "");
      if (!name) throw new Error("Enter a name");
      const ext = /\.[^./]+$/.exec(from)?.[0] ?? "";
      const file = /\.[^.]+$/.test(name) ? name : name + ext;
      const folder = folderOf(from);
      fileOpRef.current = true;
      try {
        await flushEditors();
        const outcome = await api.renameAttachment(from, folder ? `${folder}/${file}` : file);
        await followMoves(outcome);
        await refreshAttachments();
        editorRef.current?.refresh();
        const links = outcome.links ? ` Updated ${outcome.links} ${outcome.links === 1 ? "link" : "links"}.` : "";
        notify(`Renamed to “${file}”.${links}`);
        setRenamingFile(null);
      } finally {
        fileOpRef.current = false;
      }
    },
    [followMoves, refreshAttachments, notify],
  );

  const requestDeleteFile = useCallback((path: string) => {
    setDeletingFile({ path, notes: null });
    api.attachmentUsage().then(
      (all) => setDeletingFile((d) => (d?.path === path ? { ...d, notes: all.find((u) => u.path === path)?.notes.length ?? 0 } : d)),
      () => {},
    );
  }, []);

  const deleteFiles = useCallback(
    async (paths: string[]) => {
      try {
        const n = await api.deleteAttachments(paths);
        await refreshAttachments();
        editorRef.current?.refresh();
        void refreshGit();
        notify(n === 1 ? `Deleted “${basename(paths[0])}”. It's in the Recycle Bin.` : `Moved ${n} files to the Recycle Bin.`);
      } catch (err) {
        showError(err, "Couldn't delete it");
      }
    },
    [refreshAttachments, refreshGit, notify, showError],
  );

  const fileMenuItems = (path: string): MenuItem[] => [
    { label: "Open", onSelect: () => api.openAttachment(path).catch((err) => showError(err, "Couldn't open it")) },
    { label: "Show in Explorer", onSelect: () => api.revealAttachment(path).catch((err) => showError(err, "Couldn't show it")) },
    { label: "Rename…", onSelect: () => setRenamingFile(path) },
    { label: "Delete…", danger: true, onSelect: () => requestDeleteFile(path) },
  ];

  const requestDeleteItem = useCallback(
    (item: PanelItem) => (item.folder ? requestDeleteFolder(item.path) : requestDelete(item.path)),
    [requestDelete, requestDeleteFolder],
  );

  /** Export a note as a web page or a PDF, or print it. */
  const exportNote = useCallback(
    async (path: string, kind: "html" | "pdf" | "print") => {
      const title = displayTitle(path);
      try {
        await flushEditors();
        const { content } = await api.readNote(path);
        // Notes embedded with ![[…]], loaded first (one level deep).
        const embedded = new Map<string, { title: string; text: string }>();
        const all = notePaths(treeRef.current);
        for (const target of new Set(embedTargets(content))) {
          const found = resolveWikiLink(target, all);
          if (found && found !== path) embedded.set(target, { title: displayTitle(found), text: (await api.readNote(found)).content });
        }
        const body = renderNote(content, {
          image: (src, embed) => {
            if (/^(https?:\/\/|data:image\/)/i.test(src)) return src;
            if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
            let file: string | null = null;
            if (embed) file = resolveEmbed(src, filesRef.current);
            else {
              try {
                file = resolveAttachment(decodeURIComponent(src.split("#")[0]), path, filesRef.current);
              } catch {
                file = null;
              }
            }
            if (!file || !IMAGE_FILE.test(file)) return null;
            return kind === "html" ? `penna-vault:${encodeURIComponent(file)}` : api.attachmentUrl(file);
          },
          note: (target) => embedded.get(target) ?? null,
        });
        if (kind === "html") {
          const target = await api.pickExportTarget(`${title}.html`, "html");
          if (!target) return;
          await api.exportHtml(htmlDocument(title, body, await embeddedFonts()), target);
          notify(`Saved “${title}” as a web page: ${target}`);
        } else if (kind === "pdf") {
          const target = await api.pickExportTarget(`${title}.pdf`, "pdf");
          if (!target) return;
          const [width, height] = paperSize();
          await withPrintLayout(title, body, () => api.exportPdf(target, width, height));
          notify(`Saved “${title}” as a PDF: ${target}`);
        } else {
          await withPrintLayout(title, body, printDialog);
        }
      } catch (err) {
        showError(err, `Couldn't export “${title}”`);
      }
    },
    [noteRef, treeRef, filesRef, notify, showError],
  );

  /** Start a note from a template, in `folder` (or where new notes go). */
  const startFromTemplate = useCallback(
    (folder?: string) => {
      const where = appSettingsRef.current.newNotesIn;
      const fallback = where === "root" ? "" : where === "inbox" ? "Inbox" : folderOf(noteRef.current?.path ?? "");
      setTemplating({ mode: "new", folder: folder ?? fallback });
    },
    [appSettingsRef, noteRef],
  );

  /** Choose a template to insert into the open note; resolves to its text, or null. */
  const pickTemplate = useCallback(
    () =>
      new Promise<{ text: string; cursor: number | null } | null>((resolve) => {
        if (!noteRef.current) return resolve(null);
        templateResolve.current?.(null);
        templateResolve.current = resolve;
        setTemplating({ mode: "insert" });
      }),
    [noteRef],
  );
  useEffect(() => {
    pickTemplateRef.current = pickTemplate;
  }, [pickTemplate]);

  const closeTemplating = useCallback((result: { text: string; cursor: number | null } | null = null) => {
    templateResolve.current?.(result);
    templateResolve.current = null;
    setTemplating(null);
  }, []);

  const loadTemplateText = useCallback((path: string) => api.readNote(path).then((f) => f.content), []);
  const templateList = useMemo(
    () => templatePaths(notePaths(tree), vaultSettings.templates.folder),
    [tree, vaultSettings.templates.folder],
  );

  const createFromTemplate = async (name: string, template: string, folder: string) => {
    const path = notePathFromInput(folder ? `${folder}/${name}` : name);
    const { text, cursor } = fromTemplate(await loadTemplateText(template), noteTitle(path));
    await api.createNote(path, text); // rejects if it exists; the dialog shows why
    closeTemplating();
    await refreshTree();
    await selectNote(path, { view: "notes" });
    if (cursor !== null) setTimeout(() => editorRef.current?.setCursor(cursor), 200);
  };

  const insertTemplate = async (template: string) => {
    const open = noteRef.current;
    if (!open) return closeTemplating();
    closeTemplating(forInsert(await loadTemplateText(template), displayTitle(open.path)));
  };

  /** "Make a template": a starter note in the templates folder, opened to edit. */
  const makeTemplate = async () => {
    const folder = vaultSettingsRef.current.templates.folder.trim().replace(/^[\\/]+|[\\/]+$/g, "");
    const taken = new Set(notePaths(treeRef.current).map((p) => p.toLowerCase()));
    let path = notePathFromInput(`${folder}/Template`);
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = notePathFromInput(`${folder}/Template ${n}`);
    await api.createNote(path, STARTER_TEMPLATE);
    closeTemplating();
    await refreshTree();
    await selectNote(path, { view: "notes" });
    notify(`Made “${noteTitle(path)}” in ${folder}. Change it as you like, then start notes from it with Ctrl+Shift+N.`);
  };

  const menuFor = useCallback(
    (item: PanelItem): MenuItem[] =>
      item.folder
        ? [
            {
              label: "New note here",
              onSelect: () => {
                setNewNoteFolder(item.path);
                setCreating(true);
              },
            },
            { label: "New from template here…", onSelect: () => startFromTemplate(item.path) },
            { label: "Rename", hint: "F2", onSelect: () => startRename(item) },
            { label: "Move to…", onSelect: () => setMoving(item) },
            { label: "Delete…", danger: true, onSelect: () => requestDeleteFolder(item.path) },
          ]
        : [
            { label: "Open beside", hint: "Ctrl click", onSelect: () => void openBeside(item.path) },
            { label: "Rename", hint: "F2", onSelect: () => startRename(item) },
            { label: "Move to…", onSelect: () => setMoving(item) },
            { label: "Export as HTML…", onSelect: () => void exportNote(item.path, "html") },
            { label: "Export as PDF…", onSelect: () => void exportNote(item.path, "pdf") },
            { label: "Print…", onSelect: () => void exportNote(item.path, "print") },
            { label: "Delete…", danger: true, onSelect: () => requestDelete(item.path) },
          ],
    [startRename, requestDelete, requestDeleteFolder, exportNote, startFromTemplate, openBeside],
  );

  // ---- Keyboard ------------------------------------------------------------

  const keyState = useLatest({
    note,
    mode,
    view,
    changesUnavailable,
    busy: !!(
      moving ||
      deleting ||
      deletingFolder ||
      renaming ||
      renamingFile ||
      deletingFile ||
      switcher !== null ||
      renamingTag !== null ||
      templating !== null
    ),
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // F2 renames the open note (a focused row in the Notes panel handles its own F2).
      if (e.key === "F2" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        const { note: open, view: current, busy } = keyState.current;
        if (open && (current === "notes" || current === "today") && !busy) {
          e.preventDefault();
          startRename({ path: open.path, folder: false });
        }
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const { note: open, mode: current, view: currentView, changesUnavailable: unavailable } = keyState.current;
      const editing = open && currentView !== "history";
      if (key === "e" && !e.shiftKey && editing) {
        e.preventDefault();
        setModeAndRemember(current === "preview" ? "source" : "preview");
      } else if (key === "e" && e.shiftKey && editing && !unavailable) {
        e.preventDefault();
        setChangesOn((on) => !on);
      } else if (key === "s" && e.shiftKey) {
        e.preventDefault();
        void sync();
      } else if (key === "s") {
        e.preventDefault(); // also stops WebView2's "Save page as"
        void editorRef.current?.flush();
      } else if (e.key === "\\" && !e.shiftKey) {
        e.preventDefault();
        toggleBeside();
      } else if (key === "t" && e.shiftKey) {
        e.preventDefault();
        changeView("tags");
      } else if (key === "p") {
        e.preventDefault(); // also stops WebView2's print dialog
        setSwitcherBeside(false);
        setSwitcher(e.shiftKey ? ">" : "");
      } else if (key === "k" && !e.shiftKey) {
        e.preventDefault();
        changeView("notes");
        setTimeout(() => {
          findRef.current?.focus();
          findRef.current?.select();
        });
      } else if (key === "n" && e.shiftKey) {
        e.preventDefault(); // also stops WebView2 from opening a private window
        startFromTemplate();
      } else if (key === "n" && !e.shiftKey) {
        e.preventDefault(); // also stops WebView2 from opening a new window
        changeView("notes");
        setCreating(true);
      } else if (key === "d" && !e.shiftKey) {
        e.preventDefault();
        changeView("today");
      } else if (key === "f" && e.shiftKey) {
        e.preventDefault();
        changeView("search");
      } else if (key === "," && !e.shiftKey) {
        e.preventDefault();
        changeView("settings");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keyState, setModeAndRemember, sync, changeView, startRename, startFromTemplate, toggleBeside]);

  // ---- Layout --------------------------------------------------------------

  const inHistory = view === "history";
  const fullView = view === "search" || view === "settings" || view === "tags";
  const splitChanges = showChanges && mode === "source" && appSettings.diffLayout === "split";
  const versionIndex = versions.findIndex((v) => v.commit.id === selectedVersion);

  return (
    <div className="flex h-screen flex-col bg-bg text-ink">
      <TitleBar
        vaultName={vaultPath ? basename(vaultPath) : null}
        onSwitchVault={() => void chooseVault()}
        hasNote={!!note && !inHistory && !fullView}
        mode={mode}
        onModeChange={setModeAndRemember}
        changesOn={showChanges}
        changesUnavailable={changesUnavailable}
        onToggleChanges={() => setChangesOn((on) => !on)}
        saveStatus={note && !inHistory && !fullView ? saveStatus : null}
        git={vaultPath ? git : null}
        syncBusy={syncBusy}
        onSync={() => void sync()}
        onInitRepo={() => void initRepo()}
        paused={merge ? { left: pausedLeft } : null}
        besideOn={!!beside}
        onToggleBeside={note && !inHistory && !fullView ? toggleBeside : undefined}
      />

      <div className="flex min-h-0 flex-1">
        {vaultPath ? (
          <>
            <Rail view={view} onChange={changeView} />

            {view === "search" ? (
              <SearchView
                query={searchQuery}
                onQueryChange={setSearchQuery}
                onOpenNote={(path, term) => void openSearchResult(path, term)}
                onOpenVersion={openHistoryHit}
              />
            ) : view === "tags" ? (
              <TagsView
                notes={tagIndex}
                error={tagsError}
                selected={selectedTag}
                onSelect={setSelectedTag}
                onOpen={(path, line) => void openTagged(path, line)}
                onRename={setRenamingTag}
                onSearch={(tag) => {
                  setSearchQuery(`#${tag}`);
                  changeView("search");
                }}
              />
            ) : view === "settings" ? (
              <SettingsView
                app={appSettings}
                onApp={updateApp}
                vault={vaultSettings}
                onVault={updateVault}
                vaultPath={vaultPath}
                onSwitchVault={() => void chooseVault()}
                git={git}
                onInitRepo={() => void initRepo()}
                onGitChanged={() => void refreshGit()}
                defaultDevice={defaultDevice}
                notify={notify}
                onDeleteFiles={deleteFiles}
              />
            ) : (
              <>
                {inHistory ? (
                  <HistoryPanel
                    pending={pending}
                    versions={versions}
                    more={moreVersions}
                    loading={historyLoading}
                    selected={selectedVersion}
                    onSelect={setSelectedVersion}
                    onLoadMore={() => void loadMoreHistory()}
                  />
                ) : view === "today" ? (
                  <TodayPanel tree={tree} selected={day} onPick={(d) => void openDay(d, sameDay(d, new Date()))} />
                ) : (
                  <NotesPanel
                    tree={tree}
                    selectedPath={note?.path ?? null}
                    changedPaths={changedPaths}
                    onSelect={(path) => void selectNote(path, { view: "notes" })}
                    besidePath={beside?.path ?? null}
                    onOpenBeside={(path) => void openBeside(path)}
                    onCreateNote={createNote}
                    creating={creating}
                    onCreatingChange={(on) => {
                      setCreating(on);
                      if (!on) setNewNoteFolder("");
                    }}
                    newNoteFolder={newNoteFolder}
                    renaming={renaming}
                    onStartRename={startRename}
                    onCancelRename={() => setRenaming(null)}
                    onRename={renameInPlace}
                    onDelete={requestDeleteItem}
                    menuFor={menuFor}
                    onDrop={dropInto}
                    paused={pausedNotes ?? undefined}
                    findRef={findRef}
                  />
                )}

                <main className="flex min-w-0 flex-1 flex-col border-l border-rule">
                  {inHistory ? (
                    git && !git.isRepo ? (
                      <EmptyState>History starts once you set it up. Use “Set up history” in the title bar.</EmptyState>
                    ) : (
                      <VersionPage
                        detail={selectedVersion ? versionDetail : null}
                        pending={selectedVersion === PENDING}
                        onOpenNote={(path, target) =>
                          void (async () => {
                            if (!target) return void selectNote(path);
                            if (!(await openFromHistory(path, target))) {
                              notify(`“${noteTitle(path)}” isn't in the vault any more. Restore it from this version to bring it back.`);
                            }
                          })()
                        }
                        onRestore={restoreVersion}
                        onSync={() => void sync()}
                        syncBusy={syncBusy}
                      />
                    )
                  ) : note ? (
                    <NotePage
                      note={note}
                      text={text}
                      mode={mode}
                      changes={{
                        on: showChanges,
                        base: changesBase,
                        label: changesLabel,
                        info: changesInfo,
                        options: compareOptions,
                        compareId: activeCompare?.id ?? null,
                        layout: appSettings.diffLayout,
                      }}
                      editorRef={editorRef}
                      onSave={(content) => saveNote(note.path, content)}
                      onStatusChange={setSaveStatus}
                      onTextChange={setText}
                      onChangesInfo={setChangesInfo}
                      onNextChange={() => editorRef.current?.nextChange()}
                      onPreviousChange={() => editorRef.current?.previousChange()}
                      onHideChanges={() => setChangesOn(false)}
                      onLayoutChange={(diffLayout) => updateApp({ diffLayout })}
                      onCompareChange={(id) => {
                        const option = compareOptions.find((o) => o.id === id);
                        setCompare(id && option ? { path: note.path, id, label: option.label } : null);
                      }}
                      links={links}
                      getNotes={() => notePaths(treeRef.current)}
                      files={fileHandlers}
                      spellcheck={appSettings.spellcheck}
                      keepCrlf={appSettings.keepCrlf}
                      dayNav={view === "today" ? dayNav : undefined}
                      onOpenNote={(path) => void selectNote(path)}
                      menuItems={menuFor({ path: note.path, folder: false })}
                      sync={pausedSync}
                      conflictLabels={conflictLabels}
                      conflictsInfo={openConflicts}
                      onConflictsInfo={(info) => setConflictsSeen({ path: note.path, info })}
                      onNextConflict={() => editorRef.current?.nextConflict()}
                      onPreviousConflict={() => editorRef.current?.previousConflict()}
                    />
                  ) : view === "today" ? (
                    <EmptyState>
                      <span className="font-serif text-[25px] text-ink">{longTitle(day)}</span>
                      <span>There's no note for this day.</span>
                      <button
                        type="button"
                        onClick={() => void openDay(day, true)}
                        className="mt-2 h-9 rounded-full bg-ink px-4 text-[13px] font-medium text-bg hover:opacity-90"
                      >
                        Start this day's note
                      </button>
                    </EmptyState>
                  ) : (
                    <EmptyState>Pick a note, or press Ctrl N to start one.</EmptyState>
                  )}
                </main>

                {inHistory ? (
                  <VersionMargin
                    detail={versionDetail}
                    onStep={stepVersion}
                    canStep={{
                      newer: selectedVersion !== PENDING && (versionIndex > 0 || !!pending?.files.length),
                      older: selectedVersion === PENDING ? versions.length > 0 : versionIndex >= 0 && versionIndex < versions.length - 1,
                    }}
                  />
                ) : beside && note ? (
                  <BesidePane
                    note={beside}
                    mode={mode}
                    editorRef={besideEditorRef}
                    links={besideLinks}
                    getNotes={() => notePaths(treeRef.current)}
                    files={besideFiles}
                    spellcheck={appSettings.spellcheck}
                    keepCrlf={appSettings.keepCrlf}
                    status={besideStatus}
                    onStatusChange={setBesideStatus}
                    onSave={saveBeside}
                    onSwap={() => void swapBeside()}
                    onClose={() => void closeBeside()}
                  />
                ) : (
                  note &&
                  !splitChanges && (
                    <MarginPanel
                      headings={headings}
                      backlinks={backlinks}
                      mentions={mentions}
                      onOpenMention={(path, line) => void openMention(path, line)}
                      onLinkMentions={(m) => void linkMentions(m)}
                      history={git && !git.isRepo ? "untracked" : history}
                      changesOn={showChanges}
                      changesInfo={changesInfo}
                      changesLabel={changesLabel}
                      onJump={(pos) => editorRef.current?.scrollTo(pos)}
                      onOpenNote={(path) => void selectNote(path)}
                      onUndoChanges={() => {
                        const target = activeCompare ? compareBase : base?.content;
                        if (target === undefined) return;
                        const eol = note.content.includes("\r\n") ? "\r\n" : "\n";
                        editorRef.current?.replaceAll((target ?? "").replace(/\r\n|\r|\n/g, eol));
                        notify(`Back to ${changesLabel}. Ctrl+Z undoes this.`);
                      }}
                      editedToday={editedToday}
                      sync={pausedSync}
                      notePath={note.path}
                      conflictsInfo={openConflicts}
                    />
                  )
                )}
              </>
            )}
          </>
        ) : (
          <Welcome booting={booting} onOpen={() => void chooseVault()} />
        )}
      </div>

      {templating && vaultPath && (
        <TemplateDialog
          mode={templating.mode}
          templates={templateList}
          folderName={vaultSettings.templates.folder}
          target={templating.mode === "new" ? templating.folder : note ? displayTitle(note.path) : ""}
          loadText={loadTemplateText}
          onCancel={() => closeTemplating(null)}
          onCreate={(name, template) => createFromTemplate(name, template, templating.mode === "new" ? templating.folder : "")}
          onInsert={insertTemplate}
          onMakeTemplate={makeTemplate}
        />
      )}
      {renamingTag && tagIndex && (
        <TagRenameDialog
          tag={renamingTag}
          notes={tagIndex}
          canUndo={!!git?.isRepo}
          onCancel={() => setRenamingTag(null)}
          onRename={(name) => renameTag(renamingTag, name)}
        />
      )}
      {switcher !== null && vaultPath && (
        <QuickSwitcher
          initial={switcher}
          notes={notePaths(tree)}
          recent={recentOpened}
          loadHeadings={loadHeadings}
          loadTags={loadTagList}
          commands={switcherCommands()}
          onOpenTag={(tag) => openTagRef.current(tag)}
          onOpen={(path) => void (switcherBeside ? openBeside(path) : selectNote(path, { view: "notes" }))}
          onOpenHeading={(path, line) =>
            switcherBeside
              ? void openBeside(path).then(() => setTimeout(() => besideEditorRef.current?.scrollToLine(line), 200))
              : void selectNote(path, { view: "notes" }).then(() => setTimeout(() => editorRef.current?.scrollToLine(line), 200))
          }
          placeholder={switcherBeside ? "Open a note beside this one" : undefined}
          onCreate={(name) => {
            changeView("notes");
            createNote(name).catch((err) => showError(err, `Couldn't create “${name}”`));
          }}
          onSearch={(query) => {
            setSearchQuery(query);
            changeView("search");
          }}
          onClose={() => setSwitcher(null)}
        />
      )}
      {fileMenu && (
        <Menu
          anchor={fileMenu.anchor}
          label={`${basename(fileMenu.path)} actions`}
          items={fileMenuItems(fileMenu.path)}
          onClose={() => setFileMenu(null)}
        />
      )}
      {renamingFile && (
        <RenameFileDialog path={renamingFile} onCancel={() => setRenamingFile(null)} onRename={(name) => renameFile(renamingFile, name)} />
      )}
      {deletingFile && (
        <ConfirmDialog
          title={`Delete “${basename(deletingFile.path)}”?`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeletingFile(null)}
          onConfirm={async () => {
            await deleteFiles([deletingFile.path]);
            setDeletingFile(null);
          }}
        >
          <p>It goes to the Recycle Bin{git?.isRepo ? ", and saved versions stay in History" : ""}.</p>
          {!!deletingFile.notes && (
            <p>
              {deletingFile.notes} {deletingFile.notes === 1 ? "note uses" : "notes use"} it. The links stay and show that the file is
              missing.
            </p>
          )}
        </ConfirmDialog>
      )}
      {stoppingSync && (
        <ConfirmDialog
          title="Stop this sync?"
          confirmLabel="Stop the sync"
          cancelLabel="Keep choosing"
          onCancel={() => setStoppingSync(false)}
          onConfirm={stopSync}
        >
          <p>Your notes go back to how they were before this sync, and choices you made in it are undone.</p>
          <p>
            {theirsName}’s changes wait for the next sync, which will ask again. Edits you made to other notes meanwhile stay as they are.
          </p>
        </ConfirmDialog>
      )}
      {moving && (
        <MoveDialog
          path={moving.path}
          folder={moving.folder}
          folders={folderPaths(tree)}
          onCancel={() => setMoving(null)}
          onMove={moveToFolder}
        />
      )}
      {deletingFolder && (
        <ConfirmDialog
          title={`Delete the folder “${basename(deletingFolder.path)}”?`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDeletingFolder(null)}
          onConfirm={() => deleteFolder(deletingFolder.path)}
        >
          <p>
            {deletingFolder.contents
              ? `Its ${deletingFolder.contents.notes} ${deletingFolder.contents.notes === 1 ? "note" : "notes"}${
                  deletingFolder.contents.files
                    ? ` and ${deletingFolder.contents.files} other ${deletingFolder.contents.files === 1 ? "file" : "files"}`
                    : ""
                } ${deletingFolder.contents.notes + deletingFolder.contents.files === 1 ? "goes" : "go"} to the Recycle Bin with it`
              : "Everything in it goes to the Recycle Bin with it"}
            {git?.isRepo ? ", and saved versions stay in History." : "."}
          </p>
        </ConfirmDialog>
      )}
      {deleting && (
        <DeleteDialog
          path={deleting.path}
          links={deleting.links}
          inHistory={!!git?.isRepo}
          onCancel={() => setDeleting(null)}
          onConfirm={() => deleteNote(deleting.path)}
        />
      )}

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-[13px] text-ink-3 select-none">
      {children}
    </div>
  );
}
