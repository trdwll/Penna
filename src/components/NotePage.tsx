import { useState, type Ref } from "react";
import Editor, { type ChangesInfo, type DiffLayout, type EditorHandle, type SaveStatus, type ViewMode } from "../editor/Editor";
import type { ConflictLabels, ConflictsInfo } from "../editor/conflicts";
import type { FileHandlers } from "../editor/fileDrop";
import type { LinkHandlers } from "../editor/livePreview";
import { folderOf, noteTitle, relativeTime, wordCount } from "../lib/format";
import { dailyDateOf, longTitle } from "../lib/daily";
import { startsWithTitle } from "../lib/outline";
import { useNow } from "../lib/hooks";
import Menu, { anchorBelow, type MenuAnchor, type MenuItem } from "./Menu";
import { ConflictBar, type PausedSync } from "./SyncPaused";
import { ChevronDown, ChevronUp, CloseIcon, MoreIcon } from "./icons";
import { Segmented } from "./TitleBar";

export interface OpenNote {
  /** Stays the same while the note is open, even when it is renamed (so the editor keeps its state). */
  id: number;
  path: string;
  content: string;
  /** Bumped when the file changes on disk, which remounts the editor with fresh content. */
  revision: number;
  /** ms since the Unix epoch. */
  modified: number;
}

export interface ChangesState {
  on: boolean;
  /** Text being compared against; undefined while loading or when off. */
  base: string | undefined;
  /** "your last sync · 09:50" */
  label: string;
  info: ChangesInfo | null;
  /** Older versions of this note to compare against instead of the last sync. */
  options: { id: string; label: string }[];
  /** The chosen older version, or null for the last sync. */
  compareId: string | null;
  /** Source only: one column, or old and new side by side. */
  layout: DiffLayout;
}

export interface DayLink {
  path: string;
  label: string;
}

interface NotePageProps {
  note: OpenNote;
  /** Live text from the editor (debounced), for the word count and title check. */
  text: string;
  mode: ViewMode;
  changes: ChangesState;
  editorRef: Ref<EditorHandle>;
  onSave: (content: string) => Promise<void>;
  onStatusChange: (status: SaveStatus) => void;
  onTextChange: (text: string) => void;
  onChangesInfo: (info: ChangesInfo | null) => void;
  onNextChange: () => void;
  onPreviousChange: () => void;
  onHideChanges: () => void;
  onCompareChange: (id: string | null) => void;
  onLayoutChange: (layout: DiffLayout) => void;
  links: LinkHandlers;
  getNotes: () => string[];
  files: FileHandlers;
  /** Settings → Editor. */
  spellcheck?: boolean;
  keepCrlf?: boolean;
  /** For daily notes: the neighbouring days that have notes. */
  dayNav?: { previous: DayLink | null; next: DayLink | null };
  onOpenNote: (path: string) => void;
  /** Rename, Move to…, Delete… for the page's "more" menu. */
  menuItems: MenuItem[];
  /** A sync that stopped to ask which version to keep. */
  sync?: PausedSync | null;
  conflictLabels?: ConflictLabels | null;
  conflictsInfo?: ConflictsInfo | null;
  onConflictsInfo?: (info: ConflictsInfo | null) => void;
  onNextConflict?: () => void;
  onPreviousConflict?: () => void;
}

/** The scrolling page: eyebrow, optional Changes bar, title, then the editor. */
export default function NotePage(props: NotePageProps) {
  const { note, text, mode, changes } = props;
  const now = useNow(30_000);
  const folder = folderOf(note.path);
  const words = wordCount(text);
  // Notes without a leading H1 get their file name (or date) as the title, like a document.
  const showInlineTitle = mode === "preview" && !startsWithTitle(text);
  const day = dailyDateOf(note.path);
  const inlineTitle = day ? longTitle(day) : noteTitle(note.path);
  // Side by side: old text on the left, this note on the right, across a wider page.
  const split = changes.on && mode === "source" && changes.layout === "split";
  // The change gutter (and Source's line numbers) hang in the left margin.
  const gutterOffset = !changes.on || split ? 0 : mode === "source" ? 62 : 22;
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const compareLabel = (changes.compareId && changes.options.find((o) => o.id === changes.compareId)?.label) || changes.label;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        className={`mx-auto w-full pt-10 pr-10 pb-[45vh] ${split ? "pl-10" : "pl-[80px]"}`}
        style={{ maxWidth: split ? "1140px" : "calc(var(--column-width, 680px) + 120px)" }}
      >
        <div className="flex items-baseline justify-between gap-4 text-xs text-ink-3 select-none">
          <span className="truncate tracking-[0.1em] uppercase">{folder ? folder.split("/").join(" · ") : "Vault"}</span>
          <span className="flex shrink-0 items-center gap-1.5 self-center">
            Edited {relativeTime(note.modified, now)} · {words.toLocaleString()} {words === 1 ? "word" : "words"}
            <button
              type="button"
              aria-label="Note actions"
              aria-haspopup="menu"
              aria-expanded={!!menu}
              onClick={(e) => setMenu(menu ? null : anchorBelow(e.currentTarget))}
              className={`-my-1.5 -mr-1.5 grid size-7 place-items-center rounded-md hover:bg-hover hover:text-ink ${menu ? "bg-hover text-ink" : ""}`}
            >
              <MoreIcon className="size-4" />
            </button>
          </span>
        </div>
        {menu && <Menu anchor={menu} label="Note actions" items={props.menuItems} onClose={() => setMenu(null)} />}

        {props.sync && props.sync.notes.some((n) => n.path === note.path) && (
          <ConflictBar
            sync={props.sync}
            left={props.conflictsInfo?.open.length ?? 0}
            current={props.conflictsInfo?.current ?? 0}
            onNext={() => props.onNextConflict?.()}
            onPrevious={() => props.onPreviousConflict?.()}
          />
        )}

        {changes.on && <ChangesBar {...props} />}

        {showInlineTitle && (
          <h1
            className="mt-3.5 mb-5 text-[44px] leading-[1.12] font-medium tracking-[-0.015em] text-ink"
            style={{ fontFamily: "var(--writing-font, var(--font-serif))" }}
          >
            {inlineTitle}
          </h1>
        )}

        {split && (
          <div className="grid grid-cols-2 text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase select-none">
            <span className="truncate pb-2 pl-[44px]">{compareLabel}</span>
            <span className="truncate border-l border-rule pb-2 pl-[44px]">Now</span>
          </div>
        )}

        <div className={showInlineTitle || changes.on ? "" : "mt-3.5"} style={{ marginLeft: -gutterOffset }}>
          <Editor
            key={`${note.id}#${note.revision}`}
            ref={props.editorRef}
            initialContent={note.content}
            mode={mode}
            changesBase={changes.on ? changes.base : undefined}
            layout={changes.layout}
            onSave={props.onSave}
            onStatusChange={props.onStatusChange}
            onTextChange={props.onTextChange}
            onChangesInfo={props.onChangesInfo}
            links={props.links}
            getNotes={props.getNotes}
            files={props.files}
            conflictLabels={props.conflictLabels}
            onConflictsInfo={props.onConflictsInfo}
            spellcheck={props.spellcheck}
            keepCrlf={props.keepCrlf}
          />
        </div>

        {props.dayNav && (props.dayNav.previous || props.dayNav.next) && (
          <nav aria-label="Other days" className="mt-12 flex justify-between gap-4 border-t border-rule pt-4 text-[13px] select-none">
            {props.dayNav.previous ? (
              <button type="button" onClick={() => props.onOpenNote(props.dayNav!.previous!.path)} className="text-ink-2 hover:text-ink">
                ← {props.dayNav.previous.label}
              </button>
            ) : (
              <span />
            )}
            {props.dayNav.next && (
              <button type="button" onClick={() => props.onOpenNote(props.dayNav!.next!.path)} className="text-ink-2 hover:text-ink">
                {props.dayNav.next.label} →
              </button>
            )}
          </nav>
        )}
      </div>
    </div>
  );
}

function ChangesBar({ changes, mode, onNextChange, onPreviousChange, onHideChanges, onCompareChange, onLayoutChange }: NotePageProps) {
  const info = changes.info;
  const count = info?.chunks.length ?? 0;
  const picker = (
    <span className="relative inline-flex">
      <select
        aria-label="Compare with"
        value={changes.compareId ?? ""}
        onChange={(e) => onCompareChange(e.target.value || null)}
        className="h-7 appearance-none rounded-full border border-rule bg-bg pr-8 pl-3 text-ink outline-none hover:border-ink-3/50 focus-visible:border-accent"
      >
        <option value="">{changes.compareId ? "your last sync" : changes.label}</option>
        {changes.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute top-2 right-3 size-3 text-ink-3" />
    </span>
  );
  return (
    <div
      role="region"
      aria-label="Changes"
      className="mt-3 mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule pb-3 text-[13px] text-ink-2 select-none"
    >
      <span className="flex items-center gap-2">
        {count === 0 && info ? "No changes since" : "Changes since"}
        {picker}
      </span>
      <span className="flex items-center gap-3">
        {mode === "source" && (
          <Segmented
            label="Diff layout"
            size="sm"
            value={changes.layout}
            onChange={onLayoutChange}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Side by side" },
            ]}
          />
        )}
        {info && count > 0 && (
          <>
            <span className="font-mono text-xs">
              <span className="text-accent">+{info.added}</span> <span className="text-del">−{info.removed}</span>
            </span>
            <span className="flex items-center gap-0.5">
              <button
                type="button"
                aria-label="Previous change (Alt+Up)"
                onClick={onPreviousChange}
                className="grid size-7 place-items-center rounded-md hover:bg-hover"
              >
                <ChevronUp className="size-3" />
              </button>
              <span className="min-w-11 text-center text-ink-3">
                {info.current + 1} of {count}
              </span>
              <button
                type="button"
                aria-label="Next change (Alt+Down)"
                onClick={onNextChange}
                className="grid size-7 place-items-center rounded-md hover:bg-hover"
              >
                <ChevronDown className="size-3" />
              </button>
            </span>
          </>
        )}
        <button
          type="button"
          aria-label="Hide changes (Ctrl+Shift+E)"
          onClick={onHideChanges}
          className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
        >
          <CloseIcon className="size-3.5" />
        </button>
      </span>
    </div>
  );
}
