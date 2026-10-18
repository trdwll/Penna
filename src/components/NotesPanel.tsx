import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import { errorMessage, type DirNode, type TreeNode } from "../services/tauri";
import { basename, folderOf, notePaths, noteTitle } from "../lib/format";
import { dailyDateOf, displayTitle } from "../lib/daily";
import Menu, { type MenuAnchor, type MenuItem } from "./Menu";
import type { PausedNote } from "./SyncPaused";
import { CheckIcon, ChevronDown, ChevronRight, PlusIcon, SearchIcon } from "./icons";

/** A note, or a folder (`folder: true`), by its vault path. */
export interface PanelItem {
  path: string;
  folder: boolean;
}

interface NotesPanelProps {
  tree: TreeNode[];
  selectedPath: string | null;
  /** Notes with changes since the last saved version (shown with a dot). */
  changedPaths: ReadonlySet<string>;
  onSelect: (path: string) => void;
  /** Create from a typed name. Reject to show the error inline. */
  onCreateNote: (name: string) => Promise<void>;
  creating: boolean;
  onCreatingChange: (creating: boolean) => void;
  /** "New note here": the new-note field starts with this folder. */
  newNoteFolder?: string;
  /** The note or folder being renamed in place, if any. */
  renaming: PanelItem | null;
  onStartRename: (item: PanelItem) => void;
  onCancelRename: () => void;
  /** Rename to a typed name. Reject to show the error inline. */
  onRename: (item: PanelItem, name: string) => Promise<void>;
  onDelete: (item: PanelItem) => void;
  /** The right-click menu for a note or folder. */
  menuFor: (item: PanelItem) => MenuItem[];
  /** A note or folder dragged onto a folder (`""` is the top of the vault). */
  onDrop: (item: PanelItem, into: string) => void;
  /** A paused sync's notes, listed on top until it finishes. */
  paused?: PausedNote[];
  findRef?: Ref<HTMLInputElement>;
  /** The note open beside the main one, marked in the list. */
  besidePath?: string | null;
  /** Ctrl+click: open a note beside the one you're writing. */
  onOpenBeside?: (path: string) => void;
}

/** What every row needs, passed down the folder tree in one piece. */
interface RowContext {
  selectedPath: string | null;
  changedPaths: ReadonlySet<string>;
  renaming: PanelItem | null;
  /** The folder a drag would drop into, highlighted. */
  dropTarget: string | null;
  onSelect: (path: string) => void;
  besidePath: string | null;
  onOpenBeside?: (path: string) => void;
  onStartRename: (item: PanelItem) => void;
  onCancelRename: () => void;
  onRename: (item: PanelItem, name: string) => Promise<void>;
  onDelete: (item: PanelItem) => void;
  onMenu: (item: PanelItem, anchor: MenuAnchor) => void;
  onDragStart: (item: PanelItem, e: ReactPointerEvent) => void;
  /** True (once) right after a drag, so its click doesn't also open or fold. */
  consumeDragClick: () => boolean;
}

/** The folders that hold a path: `A/B/c.md` → `A`, `A/B`. */
function ancestorsOf(path: string): string[] {
  const parts = folderOf(path).split("/").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

const placeName = (folder: string) => (folder ? folder.split("/").join(" · ") : "the top of the vault");

/** Can `item` be dropped into `into`? Not where it already is, and a folder never into itself. */
function canDrop(item: PanelItem, into: string): boolean {
  if (into === folderOf(item.path)) return false;
  return !item.folder || (into !== item.path && !into.startsWith(`${item.path}/`));
}

/**
 * The vault as a table of contents: top-level folders are section headings,
 * deeper folders are indented sub-headings, notes are the entries. Notes and
 * folders can be renamed in place, right-clicked, and dragged onto folders.
 */
export default function NotesPanel({
  tree,
  selectedPath,
  changedPaths,
  onSelect,
  onCreateNote,
  creating,
  onCreatingChange,
  newNoteFolder,
  renaming,
  onStartRename,
  onCancelRename,
  onRename,
  onDelete,
  menuFor,
  onDrop,
  paused,
  findRef,
  besidePath = null,
  onOpenBeside,
}: NotesPanelProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<{ item: PanelItem; anchor: MenuAnchor } | null>(null);
  const [drag, setDrag] = useState<{ label: string; x: number; y: number; target: string | null } | null>(null);
  const dragClick = useRef(false);

  // Reveal the open note (or what's being renamed) by expanding its folders.
  const revealed = renaming?.path ?? selectedPath;
  useEffect(() => {
    if (!revealed) return;
    const ancestors = ancestorsOf(revealed);
    setCollapsed((prev) => (ancestors.some((a) => prev.has(a)) ? new Set([...prev].filter((p) => !ancestors.includes(p))) : prev));
  }, [revealed]);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return notePaths(tree)
      .filter((p) => displayTitle(p).toLowerCase().includes(q) || p.toLowerCase().includes(q))
      .sort((a, b) => {
        const aStarts = displayTitle(a).toLowerCase().startsWith(q) ? 0 : 1;
        const bStarts = displayTitle(b).toLowerCase().startsWith(q) ? 0 : 1;
        return aStarts - bStarts || displayTitle(a).localeCompare(displayTitle(b));
      });
  }, [query, tree]);

  // Renaming something the filter hides: clear the filter so its row shows.
  useEffect(() => {
    if (renaming && matches && (renaming.folder || !matches.includes(renaming.path))) setQuery("");
  }, [renaming, matches]);

  /** Drag a row: past a few pixels it follows the pointer, and dropping on a folder (or a note in it) moves it there. */
  function startDrag(item: PanelItem, e: ReactPointerEvent) {
    if (e.button !== 0 || renaming) return;
    const start = { x: e.clientX, y: e.clientY };
    const label = item.folder ? basename(item.path) : displayTitle(item.path);
    let active = false;
    let target: string | null = null;
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        active = true;
        document.body.classList.add("cursor-grabbing");
      }
      const into = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>("[data-drop-folder]")?.dataset.dropFolder;
      target = into !== undefined && canDrop(item, into) ? into : null;
      setDrag({ label, x: ev.clientX, y: ev.clientY, target });
    };
    const finish = (drop: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key, true);
      document.body.classList.remove("cursor-grabbing");
      setDrag(null);
      if (!active) return;
      dragClick.current = true;
      setTimeout(() => (dragClick.current = false));
      if (drop && target !== null) onDrop(item, target);
    };
    const up = () => finish(true);
    const key = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
  }

  const rootNotes = tree.filter((n) => n.kind === "file");
  const sections = tree.filter((n): n is DirNode => n.kind === "dir");

  const ctx: RowContext = {
    selectedPath,
    changedPaths,
    renaming,
    dropTarget: drag?.target ?? null,
    onSelect,
    besidePath,
    onOpenBeside,
    onStartRename,
    onCancelRename,
    onRename,
    onDelete,
    onMenu: (item, anchor) => setMenu({ item, anchor }),
    onDragStart: startDrag,
    consumeDragClick: () => {
      if (!dragClick.current) return false;
      dragClick.current = false;
      return true;
    },
  };

  function onFindKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && matches?.length) {
      onSelect(matches[0]);
      setQuery("");
    }
    if (e.key === "Escape") setQuery("");
  }

  return (
    <aside aria-label="Notes" className="flex w-64 shrink-0 flex-col gap-5 overflow-y-auto py-2.5 pr-5 pl-2 select-none">
      <label className="flex h-[34px] shrink-0 items-center gap-2 rounded-lg bg-hover px-2.5 text-ink-3">
        <SearchIcon className="size-3.5 shrink-0" />
        <input
          ref={findRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFindKey}
          placeholder="Find a note"
          aria-label="Find a note"
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-3"
        />
        <span className="font-mono text-[11px]">Ctrl K</span>
      </label>

      {creating && (
        <NewNoteInput
          key={newNoteFolder ?? ""}
          initial={newNoteFolder ? `${newNoteFolder}/` : ""}
          onCancel={() => onCreatingChange(false)}
          onSubmit={onCreateNote}
        />
      )}

      {!matches && paused && paused.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-del uppercase">Changed on both devices</div>
          {paused.map((n) => (
            <button
              key={n.path}
              type="button"
              aria-current={n.path === selectedPath ? "page" : undefined}
              onClick={() => onSelect(n.path)}
              title={n.path}
              className={`flex min-h-[30px] items-center justify-between gap-2 rounded-md px-2.5 text-left ${
                n.path === selectedPath ? "bg-hover font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
              }`}
            >
              <span className="truncate">{displayTitle(n.path)}</span>
              {n.places ? (
                <span
                  aria-label={`${n.places} to choose`}
                  className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-del-soft px-1.5 text-[11px] font-semibold text-del"
                >
                  {n.places}
                </span>
              ) : (
                <CheckIcon className="size-3.5 shrink-0 text-ok" aria-hidden={false} role="img" aria-label="Every place has a choice" />
              )}
            </button>
          ))}
        </div>
      )}

      {matches ? (
        <div className="flex flex-col gap-0.5">
          <SectionLabel>{matches.length ? `${matches.length} ${matches.length === 1 ? "note" : "notes"}` : "No matches"}</SectionLabel>
          {matches.map((path) => (
            <NoteRow
              key={path}
              path={path}
              hint={folderOf(path)}
              ctx={{
                ...ctx,
                onSelect: (p) => {
                  onSelect(p);
                  setQuery("");
                },
              }}
            />
          ))}
        </div>
      ) : (
        <>
          {rootNotes.length > 0 && (
            <div className="flex flex-col gap-0.5" data-drop-folder="">
              {rootNotes.map((node) => (
                <NoteRow key={node.path} path={node.path} ctx={ctx} />
              ))}
            </div>
          )}
          {sections.map((dir) => (
            <div key={dir.path} className="flex flex-col gap-0.5">
              <FolderHeading dir={dir} depth={0} open={!collapsed.has(dir.path)} onToggle={toggle} ctx={ctx} />
              {!collapsed.has(dir.path) && <Folder dir={dir} depth={0} collapsed={collapsed} onToggle={toggle} ctx={ctx} />}
            </div>
          ))}
          {tree.length === 0 && <p className="px-2.5 text-[13px] text-ink-3">No Markdown files here yet.</p>}
        </>
      )}

      {/* Below the list, so showing it never shifts what you are dragging over. */}
      {drag && (
        <div
          data-drop-folder=""
          className={`shrink-0 rounded-md border border-dashed px-2.5 py-2 text-[12px] ${
            drag.target === "" ? "border-accent bg-accent-soft text-accent" : "border-rule text-ink-3"
          }`}
        >
          Drop here for the top of the vault
        </div>
      )}
      <div className="flex-1" />
      <button
        type="button"
        onClick={() => onCreatingChange(true)}
        className="flex h-[34px] shrink-0 items-center justify-between rounded-md px-2.5 text-ink-2 hover:bg-hover hover:text-ink"
      >
        <span className="flex items-center gap-2">
          <PlusIcon className="size-3.5" />
          New note
        </span>
        <span className="font-mono text-[11px] text-ink-3">Ctrl N</span>
      </button>

      {menu && (
        <Menu
          anchor={menu.anchor}
          label={`${menu.item.folder ? basename(menu.item.path) : displayTitle(menu.item.path)} actions`}
          items={menuFor(menu.item)}
          onClose={() => setMenu(null)}
        />
      )}

      {drag && (
        <div
          className="pointer-events-none fixed z-50 max-w-72 truncate rounded-md bg-tooltip px-2.5 py-1 text-[12px] text-on-tooltip shadow-lg"
          style={{ left: drag.x + 14, top: drag.y + 10 }}
        >
          {drag.target === null ? `Move “${drag.label}”` : `Move “${drag.label}” to ${placeName(drag.target)}`}
        </div>
      )}
    </aside>
  );
}

function Chevron({ open }: { open: boolean }) {
  const Icon = open ? ChevronDown : ChevronRight;
  return <Icon className="size-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">{children}</div>;
}

/** F2 renames, Delete deletes, the menu key (or Shift+F10) opens the menu: for a focused note or folder. */
function rowKeys(item: PanelItem, ctx: RowContext) {
  return (e: KeyboardEvent<HTMLButtonElement>) => {
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (e.key === "F2" && plain && !e.shiftKey) ctx.onStartRename(item);
    else if (e.key === "Delete" && plain && !e.shiftKey) ctx.onDelete(item);
    else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      const r = e.currentTarget.getBoundingClientRect();
      ctx.onMenu(item, { x: r.left + 12, y: r.bottom + 2 });
    } else return;
    e.preventDefault();
    e.stopPropagation(); // F2 here renames this row, not the open note
  };
}

/** A folder's name: an uppercase section heading at the top level, a quiet sub-heading below. */
function FolderHeading({
  dir,
  depth,
  indent = 10,
  open,
  onToggle,
  ctx,
}: {
  dir: DirNode;
  /** 0 for top-level sections. */
  depth: number;
  indent?: number;
  open: boolean;
  onToggle: (path: string) => void;
  ctx: RowContext;
}) {
  const item: PanelItem = { path: dir.path, folder: true };
  if (ctx.renaming?.folder && ctx.renaming.path === dir.path) {
    return (
      <RenameInput
        original={dir.name}
        label={`New name for the ${dir.name} folder`}
        indent={depth === 0 ? 10 : indent + 12}
        onSubmit={(name) => ctx.onRename(item, name)}
        onCancel={ctx.onCancelRename}
      />
    );
  }
  const target = ctx.dropTarget === dir.path;
  return (
    <button
      type="button"
      aria-expanded={open}
      data-drop-folder={dir.path}
      title={dir.path}
      onClick={() => !ctx.consumeDragClick() && onToggle(dir.path)}
      onKeyDown={rowKeys(item, ctx)}
      onPointerDown={(e) => ctx.onDragStart(item, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        ctx.onMenu(item, { x: e.clientX, y: e.clientY });
      }}
      style={depth === 0 ? undefined : { paddingLeft: indent + 12 }}
      className={`group flex items-center justify-between rounded-md text-left ${
        depth === 0 ? "px-2.5 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.12em] uppercase" : "pt-2.5 pr-2.5 pb-1 text-xs"
      } ${target ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink"}`}
    >
      <span className="truncate">{dir.name}</span>
      <Chevron open={open} />
    </button>
  );
}

interface FolderProps {
  dir: DirNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  onToggle: (path: string) => void;
  ctx: RowContext;
}

/** A folder's notes first, then its sub-folders as indented sub-headings. */
function Folder({ dir, depth, collapsed, onToggle, ctx }: FolderProps) {
  const indent = 10 + depth * 12;
  // Daily notes newest first; everything else keeps the vault order.
  const files = dir.children
    .filter((n) => n.kind === "file")
    .sort((a, b) => (dailyDateOf(b.path)?.getTime() ?? 0) - (dailyDateOf(a.path)?.getTime() ?? 0));
  const subdirs = dir.children.filter((n): n is DirNode => n.kind === "dir");
  return (
    <>
      {files.map((node) => (
        <NoteRow key={node.path} path={node.path} indent={indent} ctx={ctx} />
      ))}
      {subdirs.map((sub) => (
        <div key={sub.path} className="flex flex-col gap-0.5">
          <FolderHeading dir={sub} depth={depth + 1} indent={indent} open={!collapsed.has(sub.path)} onToggle={onToggle} ctx={ctx} />
          {!collapsed.has(sub.path) && <Folder dir={sub} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} ctx={ctx} />}
        </div>
      ))}
    </>
  );
}

function NoteRow({ path, indent = 10, hint, ctx }: { path: string; indent?: number; hint?: string; ctx: RowContext }) {
  const item: PanelItem = { path, folder: false };
  if (ctx.renaming && !ctx.renaming.folder && ctx.renaming.path === path) {
    return (
      <RenameInput
        original={noteTitle(path)}
        label={`New name for ${noteTitle(path)}`}
        indent={indent}
        onSubmit={(name) => ctx.onRename(item, name)}
        onCancel={ctx.onCancelRename}
      />
    );
  }
  const selected = path === ctx.selectedPath;
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      data-drop-folder={folderOf(path)}
      onClick={(e) => {
        if (ctx.consumeDragClick()) return;
        if ((e.ctrlKey || e.metaKey) && ctx.onOpenBeside) ctx.onOpenBeside(path);
        else ctx.onSelect(path);
      }}
      onKeyDown={rowKeys(item, ctx)}
      onPointerDown={(e) => ctx.onDragStart(item, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        ctx.onMenu(item, { x: e.clientX, y: e.clientY });
      }}
      title={path}
      style={{ paddingLeft: indent }}
      className={`flex min-h-[30px] items-center justify-between gap-2 rounded-md pr-2.5 text-left ${
        selected ? "bg-hover font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
      }`}
    >
      <span className="flex min-w-0 flex-col py-1">
        <span className="truncate">{displayTitle(path)}</span>
        {hint && <span className="truncate text-xs font-normal text-ink-3">{hint}</span>}
      </span>
      {path === ctx.besidePath && <span className="shrink-0 text-xs font-normal text-ink-3">beside</span>}
      {ctx.changedPaths.has(path) && (
        <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label="Changed since last saved version" />
      )}
    </button>
  );
}

/** A name, editable in place. Enter or clicking away renames; Esc cancels. */
function RenameInput({
  original,
  label,
  indent,
  onSubmit,
  onCancel,
}: {
  original: string;
  label: string;
  indent: number;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(original);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function submit() {
    if (busyRef.current) return;
    const name = value.trim();
    if (!name || name === original) return onCancel();
    busyRef.current = true; // stays set after a rename, so a blur while unmounting can't send it twice
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name);
    } catch (err) {
      setError(errorMessage(err));
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-1 py-0.5" style={{ paddingLeft: Math.max(0, indent - 6) }}>
      <input
        autoFocus
        value={value}
        readOnly={busy}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation(); // keep F2 and shortcuts from reaching the app while typing
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => (error ? onCancel() : void submit())}
        aria-label={label}
        spellCheck={false}
        className="h-[30px] rounded-md border border-accent bg-bg px-1.5 text-ink outline-none"
      />
      {error ? (
        <p role="alert" className="px-1 text-xs text-danger">
          {error}
        </p>
      ) : (
        <p className="px-1 text-xs text-ink-3">Enter to rename · Esc to cancel</p>
      )}
    </div>
  );
}

function NewNoteInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const name = value.trim();
    if (!name || name === initial.trim()) return onCancel();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-1.5 px-0.5">
      <input
        autoFocus
        value={value}
        disabled={busy}
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") onCancel();
        }}
        onBlur={() => (!value.trim() || value.trim() === initial.trim()) && onCancel()}
        placeholder="Note name, or folder/name"
        aria-label="New note name"
        className="h-[34px] rounded-lg border border-rule bg-bg px-2.5 text-ink outline-none placeholder:text-ink-3 focus:border-accent"
      />
      {error ? (
        <p role="alert" className="px-1 text-xs text-danger">
          {error}
        </p>
      ) : (
        <p className="px-1 text-xs text-ink-3">Enter to create · Esc to cancel</p>
      )}
    </div>
  );
}
