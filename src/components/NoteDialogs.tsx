import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { displayTitle } from "../lib/daily";
import { folderOf } from "../lib/format";
import { cleanTag, renamePreview, tagProblem } from "../lib/tags";
import { errorMessage, type TaggedNote } from "../services/tauri";
import { FolderIcon } from "./icons";

/**
 * A small modal near the top of the window. Esc or a click outside cancels;
 * Tab stays inside; focus goes back where it was when it closes.
 */
export function Dialog({
  label,
  onCancel,
  children,
  width = 440,
}: {
  label: string;
  onCancel: () => void;
  children: ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    const el = ref.current;
    (el?.querySelector<HTMLElement>("[data-autofocus]") ?? el?.querySelector<HTMLElement>("input, button"))?.focus();
    return () => returnTo?.focus();
  }, []);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === "Tab") {
      const focusable = [...(ref.current?.querySelectorAll<HTMLElement>("input, button:not([disabled])") ?? [])];
      if (!focusable.length) return;
      const i = focusable.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? focusable.length - 1 : i - 1) : (i + 1) % focusable.length;
      e.preventDefault();
      focusable[next].focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/25 px-4 pt-[16vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={onKeyDown}
        style={{ width }}
        className="max-w-full overflow-hidden rounded-xl border border-rule bg-bg shadow-xl select-none"
      >
        {children}
      </div>
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="font-serif text-[22px] leading-tight font-medium tracking-[-0.01em] text-ink">{children}</h2>;
}

const where = (folder: string) => (folder ? folder.split("/").join(" · ") : "the top of the vault");

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

/** A yes/no question before something that's hard to take back. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog label={title} onCancel={onCancel}>
      <div className="flex flex-col gap-2 px-6 pt-5 pb-5">
        <Heading>{title}</Heading>
        <div className="flex flex-col gap-2 text-[13px] leading-relaxed text-ink-2">{children}</div>
      </div>
      <div className="flex justify-end gap-2 border-t border-rule px-5 py-3">
        <button
          type="button"
          data-autofocus
          onClick={onCancel}
          className="h-8 rounded-full px-4 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
          className={`h-8 rounded-full px-4 text-[13px] font-medium text-bg hover:opacity-90 disabled:opacity-50 ${danger ? "bg-danger" : "bg-ink"}`}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export function DeleteDialog({
  path,
  links,
  inHistory,
  onCancel,
  onConfirm,
}: {
  path: string;
  /** Notes that link to it; null while counting. */
  links: number | null;
  /** The vault keeps versions, so it can be restored from History too. */
  inHistory: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const title = displayTitle(path);
  return (
    <Dialog label={`Delete ${title}`} onCancel={onCancel}>
      <div className="flex flex-col gap-2 px-6 pt-5 pb-5">
        <Heading>Delete “{title}”?</Heading>
        <p className="text-[13px] leading-relaxed text-ink-2">
          It goes to the Recycle Bin{inHistory ? ", and its saved versions stay in History" : ""}.
        </p>
        {!!links && (
          <p className="text-[13px] leading-relaxed text-ink-2">
            {links} {links === 1 ? "note links" : "notes link"} to it. Those links stay; following one starts a new, empty note.
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-rule px-5 py-3">
        <button type="button" onClick={onCancel} className="h-8 rounded-full px-4 text-[13px] text-ink-2 hover:bg-hover hover:text-ink">
          Cancel
        </button>
        <button
          type="button"
          data-autofocus
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
          className="h-8 rounded-full bg-danger px-4 text-[13px] font-medium text-bg hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Move
// ---------------------------------------------------------------------------

interface Choice {
  folder: string;
  /** A folder that doesn't exist yet. */
  create: boolean;
}

/** Pick a folder (or type a new one) to move a note into. */
export function MoveDialog({
  path,
  folder = false,
  folders,
  onCancel,
  onMove,
}: {
  path: string;
  /** Moving a folder: it can't go inside itself. */
  folder?: boolean;
  folders: string[];
  onCancel: () => void;
  /** Reject to show the error in the dialog. */
  onMove: (folder: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const current = folderOf(path);
  const name = folder ? path.slice(path.lastIndexOf("/") + 1) : displayTitle(path);

  const choices = useMemo<Choice[]>(() => {
    const typed = query
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    const q = typed.toLowerCase();
    const inside = (f: string) => folder && (f === path || f.startsWith(`${path}/`));
    const all = ["", ...folders].filter((f) => f !== current && !inside(f));
    const shown = q ? all.filter((f) => f.toLowerCase().includes(q)) : all;
    const exists = q && ["", ...folders].some((f) => f.toLowerCase() === q);
    return [...shown.map((folder) => ({ folder, create: false })), ...(q && !exists ? [{ folder: typed, create: true }] : [])];
  }, [query, folders, current, folder, path]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  async function choose(choice: Choice | undefined) {
    if (!choice || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onMove(choice.folder);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = choices.length;
      if (n) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void choose(choices[active]);
    }
  }

  return (
    <Dialog label={`Move ${name}`} onCancel={onCancel}>
      <div className="flex flex-col gap-1 px-6 pt-5 pb-3">
        <Heading>
          Move {folder ? "the folder " : ""}“{name}”
        </Heading>
        <p className="text-[13px] text-ink-3">
          Now in {where(current)}. {folder ? "Everything in it moves too, and links to it are updated." : "Links to it are updated."}
        </p>
      </div>
      <div className="px-5 pb-2">
        <input
          value={query}
          readOnly={busy}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find a folder, or type a new one"
          aria-label="Folder"
          role="combobox"
          aria-expanded="true"
          aria-controls="move-folders"
          aria-activedescendant={choices[active] ? `move-folder-${active}` : undefined}
          className="h-[34px] w-full rounded-lg border border-rule bg-bg px-2.5 text-ink outline-none placeholder:text-ink-3 focus:border-accent"
        />
      </div>
      <ul ref={listRef} id="move-folders" role="listbox" aria-label="Folders" className="max-h-[264px] overflow-y-auto px-2 pb-2">
        {choices.map((choice, i) => (
          <li
            key={`${choice.create}:${choice.folder}`}
            id={`move-folder-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === active}
            onMouseMove={() => setActive(i)}
            onClick={() => void choose(choice)}
            className={`flex h-8 items-center gap-2.5 rounded-md px-3 text-[13px] ${i === active ? "bg-hover text-ink" : "text-ink-2"}`}
          >
            <FolderIcon className="size-3.5 shrink-0 text-ink-3" />
            {choice.create ? (
              <span className="truncate">
                New folder <span className="font-medium text-ink">{choice.folder}</span>
              </span>
            ) : choice.folder ? (
              <FolderName path={choice.folder} />
            ) : (
              <span className="truncate">
                Vault <span className="text-ink-3">· top level</span>
              </span>
            )}
          </li>
        ))}
        {!choices.length && (
          <li className="px-3 py-2 text-[13px] text-ink-3">
            {query.trim() ? "It's already in that folder." : "No other folders yet. Type a name to make one."}
          </li>
        )}
      </ul>
      {error && (
        <p role="alert" className="border-t border-rule px-6 py-2.5 text-xs text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}

/** `Projects/2026` → "Projects /" quiet, "2026" in ink. */
function FolderName({ path }: { path: string }) {
  const i = path.lastIndexOf("/");
  return (
    <span className="truncate">
      {i > 0 && <span className="text-ink-3">{path.slice(0, i).split("/").join(" / ")} / </span>}
      {path.slice(i + 1)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Attachments: rename, and files no note uses
// ---------------------------------------------------------------------------

/** "1.2 MB", "340 KB", "12 bytes". */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Rename an image or other file. The name is selected without its extension, which stays unless you type one. */
export function RenameFileDialog({
  path,
  onCancel,
  onRename,
}: {
  path: string;
  onCancel: () => void;
  /** Resolves when renamed; rejects to show the error. */
  onRename: (name: string) => Promise<void>;
}) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.setSelectionRange(0, dot > 0 ? dot : name.length);
  }, [dot, name.length]);

  async function submit() {
    const next = value.trim();
    if (!next || next === name) return onCancel();
    setBusy(true);
    setError(null);
    try {
      await onRename(next);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog label={`Rename ${name}`} onCancel={onCancel}>
      <div className="flex flex-col gap-1 px-6 pt-5 pb-3">
        <Heading>Rename “{name}”</Heading>
        <p className="text-[13px] text-ink-3">In {where(folderOf(path))}. Links and embeds that use it are updated.</p>
      </div>
      <div className="flex flex-col gap-1.5 px-5 pb-4">
        <input
          ref={input}
          data-autofocus
          value={value}
          readOnly={busy}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          aria-label="New file name"
          spellCheck={false}
          className="h-[34px] w-full rounded-lg border border-rule bg-bg px-2.5 text-ink outline-none focus:border-accent"
        />
        {error ? (
          <p role="alert" className="px-1 text-xs text-danger">
            {error}
          </p>
        ) : (
          <p className="px-1 text-xs text-ink-3">Enter to rename · Esc to cancel</p>
        )}
      </div>
    </Dialog>
  );
}

export interface UnusedFile {
  path: string;
  size: number;
}

/** Files no note links to or embeds: pick which to send to the Recycle Bin. */
export function UnusedFilesDialog({
  files,
  onCancel,
  onReveal,
  onDelete,
}: {
  files: UnusedFile[];
  onCancel: () => void;
  onReveal: (path: string) => void;
  onDelete: (paths: string[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(files.map((f) => f.path)));
  const [busy, setBusy] = useState(false);
  const total = files.filter((f) => picked.has(f.path)).reduce((sum, f) => sum + f.size, 0);
  const toggle = (path: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <Dialog label="Files no note links to" onCancel={onCancel}>
      <div className="flex flex-col gap-1 px-6 pt-5 pb-3">
        <Heading>Files no note links to</Heading>
        <p className="text-[13px] leading-relaxed text-ink-3">
          No note links to these or embeds them. Pick the ones to move to the Recycle Bin; saved versions stay in History.
        </p>
      </div>
      <ul aria-label="Files" className="max-h-[300px] overflow-y-auto border-y border-rule px-2 py-1.5">
        {files.map((f) => (
          <li key={f.path} className="flex items-center gap-2.5 rounded-md px-3 py-1.5 hover:bg-hover">
            <input
              type="checkbox"
              checked={picked.has(f.path)}
              onChange={() => toggle(f.path)}
              aria-label={f.path}
              className="size-[15px] shrink-0 accent-accent"
            />
            <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={f.path}>
              {f.path.slice(f.path.lastIndexOf("/") + 1)}
              <span className="ml-2 text-ink-3">{where(folderOf(f.path))}</span>
            </span>
            <span className="shrink-0 text-xs text-ink-3">{fileSize(f.size)}</span>
            <button type="button" onClick={() => onReveal(f.path)} className="shrink-0 text-xs text-accent hover:text-ink">
              Show
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-end gap-2 px-5 py-3">
        <span className="mr-auto text-xs text-ink-3">{picked.size ? `${picked.size} picked · ${fileSize(total)}` : "None picked"}</span>
        <button type="button" onClick={onCancel} className="h-8 rounded-full px-4 text-[13px] text-ink-2 hover:bg-hover hover:text-ink">
          Cancel
        </button>
        <button
          type="button"
          disabled={!picked.size || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onDelete([...picked]);
            } finally {
              setBusy(false);
            }
          }}
          className="h-8 rounded-full bg-danger px-4 text-[13px] font-medium text-bg hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "Moving…" : picked.size === 1 ? "Move 1 file to the Recycle Bin" : `Move ${picked.size} files to the Recycle Bin`}
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Rename a tag
// ---------------------------------------------------------------------------

/** Rename a tag everywhere, with what that will change spelled out first. */
export function TagRenameDialog({
  tag,
  notes,
  canUndo,
  onCancel,
  onRename,
}: {
  tag: string;
  /** The Tags view's index, for the summary. */
  notes: readonly TaggedNote[];
  /** Versions are kept (a Git vault), so History can undo it. */
  canUndo: boolean;
  onCancel: () => void;
  /** Resolves when renamed; rejects to show the error. */
  onRename: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(tag);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const name = cleanTag(value);
  const problem = name ? tagProblem(value) : null;
  const preview = useMemo(() => renamePreview(notes, tag, name), [notes, tag, name]);
  const unchanged = !name || name === tag;

  useEffect(() => input.current?.select(), []);

  async function submit() {
    if (unchanged) return onCancel();
    const why = tagProblem(value);
    if (why) return setError(why);
    setBusy(true);
    setError(null);
    try {
      await onRename(name);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const where = [
    preview.inText > 0 && `${preview.inText} ${preview.inText === 1 ? "tag" : "tags"} in ${preview.notes === 1 ? "its" : "their"} text`,
    preview.inProperties > 0 &&
      `${preview.inProperties} ${preview.inText > 0 ? "" : preview.inProperties === 1 ? "tag " : "tags "}in properties`,
  ]
    .filter(Boolean)
    .join(" and ");
  const notesLabel = `${preview.notes} ${preview.notes === 1 ? "note" : "notes"}`;
  const valid = !unchanged && !problem;

  return (
    <Dialog label={`Rename #${tag}`} onCancel={onCancel} width={460}>
      <div className="flex flex-col gap-1 px-6 pt-5 pb-3">
        <Heading>Rename #{tag}</Heading>
        <p className="text-[13px] text-ink-3">Every note that uses it changes, in its text and its properties.</p>
      </div>
      <div className="flex flex-col gap-1.5 px-5 pb-4">
        <label className="flex h-[34px] items-center rounded-lg border border-rule bg-bg px-2.5 focus-within:border-accent">
          <span aria-hidden="true" className="text-faint">
            #
          </span>
          <input
            ref={input}
            data-autofocus
            value={value}
            readOnly={busy}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            aria-label="New tag name"
            spellCheck={false}
            className="ml-0.5 min-w-0 flex-1 bg-transparent text-ink outline-none"
          />
        </label>
        {error || problem ? (
          <p role="alert" className="px-1 text-xs text-danger">
            {error ?? problem}
          </p>
        ) : (
          <p className="px-1 text-xs text-ink-3">Enter to rename · Esc to cancel</p>
        )}
        <ul className="m-0 mt-1.5 flex list-none flex-col gap-1.5 px-1 text-[13px] leading-snug text-ink-2">
          <li className="flex gap-2">
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
            <span>
              Changes <strong className="font-semibold text-ink">{notesLabel}</strong>
              {where ? `: ${where}.` : "."}
            </span>
          </li>
          {preview.nested.slice(0, 3).map((t) => (
            <li key={t} className="flex gap-2">
              <span aria-hidden="true" className="text-faint">
                ·
              </span>
              <span>
                <span className="text-ink">#{t}</span> becomes{" "}
                <span className="text-ink">#{valid ? name + t.slice(tag.length) : `…${t.slice(tag.length)}`}</span>.
              </span>
            </li>
          ))}
          {preview.nested.length > 3 && (
            <li className="flex gap-2">
              <span aria-hidden="true" className="text-faint">
                ·
              </span>
              <span>
                {preview.nested.length - 3} more {preview.nested.length - 3 === 1 ? "tag" : "tags"} under #{tag} move with it.
              </span>
            </li>
          )}
          {valid && preview.existing > 0 && (
            <li className="flex gap-2">
              <span aria-hidden="true" className="text-faint">
                ·
              </span>
              <span>
                <span className="text-ink">#{name}</span> is already on {preview.existing} {preview.existing === 1 ? "note" : "notes"}. The
                two become one tag.
              </span>
            </li>
          )}
          <li className="flex gap-2">
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
            <span>Tags inside code stay as written.</span>
          </li>
        </ul>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-rule px-5 py-3">
        <span className="text-xs text-ink-3">{canUndo ? "History can undo this." : ""}</span>
        <span className="flex shrink-0 gap-2 whitespace-nowrap">
          <button type="button" onClick={onCancel} className="h-8 rounded-full px-4 text-[13px] text-ink-2 hover:bg-hover hover:text-ink">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !valid}
            onClick={() => void submit()}
            className="h-8 rounded-full bg-ink px-4 text-[13px] font-medium text-bg hover:opacity-90 disabled:opacity-50"
          >
            Rename in {notesLabel}
          </button>
        </span>
      </div>
    </Dialog>
  );
}
