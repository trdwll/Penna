import type { Backlink, Mentioning, NoteHistory, NoteStamp } from "../services/tauri";
import type { ChangesInfo } from "../editor/Editor";
import type { ConflictsInfo } from "../editor/conflicts";
import { SyncMargin, type PausedSync } from "./SyncPaused";
import type { Heading } from "../lib/outline";
import { shortDate, shortTime } from "../lib/format";
import { displayTitle } from "../lib/daily";

interface MarginPanelProps {
  headings: Heading[];
  backlinks: Backlink[] | null;
  /** Notes that mention this one by name without linking it. */
  mentions?: Mentioning[] | null;
  onOpenMention?: (path: string, line: number) => void;
  /** Turn a note's mentions into links. */
  onLinkMentions?: (note: Mentioning) => void;
  /** null while loading; "untracked" when the vault has no Git history. */
  history: NoteHistory | "untracked" | null;
  changesOn: boolean;
  changesInfo: ChangesInfo | null;
  changesLabel: string;
  onJump: (pos: number) => void;
  onOpenNote: (path: string) => void;
  onUndoChanges: () => void;
  /** Daily notes only: other notes edited the same day. */
  editedToday?: NoteStamp[];
  /** While a sync is paused, the margin is about that. */
  sync?: PausedSync | null;
  notePath?: string;
  conflictsInfo?: ConflictsInfo | null;
}

const MARK: Record<string, { glyph: string; className: string; label: string }> = {
  added: { glyph: "+", className: "text-accent", label: "added" },
  removed: { glyph: "−", className: "text-del", label: "removed" },
  edited: { glyph: "~", className: "text-accent", label: "edited" },
};

/** The quiet right margin: outline, backlinks and history, or the list of changes. */
export default function MarginPanel(props: MarginPanelProps) {
  return (
    <aside
      aria-label="About this note"
      className="hidden w-60 shrink-0 flex-col gap-7 overflow-y-auto pt-[92px] pr-7 pb-6 pl-2 text-[13px] select-none xl:flex"
    >
      {props.sync ? (
        <SyncMargin sync={props.sync} notePath={props.notePath ?? null} info={props.conflictsInfo ?? null} onJump={props.onJump} />
      ) : props.changesOn ? (
        <ChangesList {...props} />
      ) : (
        <About {...props} />
      )}
    </aside>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">{children}</div>;
}

function About({
  headings,
  backlinks,
  mentions,
  onOpenMention,
  onLinkMentions,
  history,
  onJump,
  onOpenNote,
  editedToday,
}: MarginPanelProps) {
  const outline = headings.filter((h) => h.level >= 2 && h.level <= 3);
  return (
    <>
      <section className="flex flex-col gap-2">
        <Label>On this page</Label>
        {outline.length ? (
          outline.map((h) => (
            <button
              key={`${h.pos}`}
              type="button"
              onClick={() => onJump(h.pos)}
              style={{ paddingLeft: (h.level - 2) * 12 }}
              className="truncate text-left text-ink-2 hover:text-ink"
            >
              {h.text}
            </button>
          ))
        ) : (
          <span className="text-ink-3">Headings you add show up here.</span>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <Label>Linked from</Label>
        {backlinks === null ? (
          <span className="text-ink-3">…</span>
        ) : backlinks.length ? (
          backlinks.map((link) => (
            <button
              key={link.path}
              type="button"
              onClick={() => onOpenNote(link.path)}
              title={link.context}
              className="truncate text-left text-ink-2 hover:text-ink"
            >
              {displayTitle(link.path)}
            </button>
          ))
        ) : (
          <span className="text-ink-3">Nothing links here yet.</span>
        )}
      </section>

      {mentions && mentions.length > 0 && (
        <section aria-label="Mentioned in" className="flex flex-col gap-3">
          <Label>Mentioned in</Label>
          {mentions.map((note) => {
            const first = note.mentions[0];
            const count = note.mentions.length + note.more;
            return (
              <div key={note.path} className="flex flex-col gap-1">
                <span className="flex items-baseline justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenMention?.(note.path, first.line)}
                    className="min-w-0 truncate text-left text-ink-2 hover:text-ink"
                  >
                    {displayTitle(note.path)}
                  </button>
                  <button
                    type="button"
                    onClick={() => onLinkMentions?.(note)}
                    title={
                      note.mentions.length === 1
                        ? "Turn this mention into a link"
                        : `Turn these ${note.mentions.length} mentions into links`
                    }
                    className="shrink-0 text-xs text-accent hover:text-ink"
                  >
                    Link
                  </button>
                </span>
                <span className="line-clamp-2 text-xs leading-snug text-ink-3">
                  {first.before}
                  <span className="font-medium text-ink-2">{first.text}</span>
                  {first.after}
                </span>
                {count > 1 && <span className="text-xs text-faint">{count} mentions</span>}
              </div>
            );
          })}
        </section>
      )}

      {editedToday && (
        <section className="flex flex-col gap-2">
          <Label>Also edited today</Label>
          {editedToday.length ? (
            editedToday.slice(0, 8).map((n) => (
              <button
                key={n.path}
                type="button"
                onClick={() => onOpenNote(n.path)}
                className="flex justify-between gap-3 text-left text-ink-2 hover:text-ink"
              >
                <span className="truncate">{displayTitle(n.path)}</span>
                <span className="shrink-0 text-ink-3">{shortTime(n.modified)}</span>
              </button>
            ))
          ) : (
            <span className="text-ink-3">Nothing else yet.</span>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <Label>History</Label>
        {history === null ? (
          <span className="text-ink-3">…</span>
        ) : history === "untracked" ? (
          <span className="text-ink-3">Set up history to keep versions.</span>
        ) : history.versions.length ? (
          <span className="text-ink-2">
            {history.more ? "Over " : ""}
            {history.versions.length} {history.versions.length === 1 ? "version" : "versions"} since{" "}
            {shortDate(history.versions[history.versions.length - 1].timestamp * 1000)}
          </span>
        ) : (
          <span className="text-ink-3">No saved versions yet.</span>
        )}
      </section>
    </>
  );
}

function ChangesList({ changesInfo, changesLabel, onJump, onUndoChanges }: MarginPanelProps) {
  const chunks = changesInfo?.chunks ?? [];
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <Label>
          {chunks.length} {chunks.length === 1 ? "change" : "changes"}
        </Label>
        {chunks.map((chunk, i) => {
          const mark = MARK[chunk.kind];
          return (
            <button
              key={`${chunk.pos}-${i}`}
              type="button"
              onClick={() => onJump(chunk.pos)}
              className={`grid grid-cols-[16px_minmax(0,1fr)] gap-1.5 text-left ${
                i === changesInfo?.current ? "text-ink" : "text-ink-2 hover:text-ink"
              }`}
            >
              <span className={`font-mono ${mark.className}`}>{mark.glyph}</span>
              <span>
                Line {chunk.line}
                <span className="block text-ink-3">{mark.label}</span>
              </span>
            </button>
          );
        })}
        {chunks.length === 0 && <span className="text-ink-3">Nothing changed since {changesLabel}.</span>}
      </section>
      {chunks.length > 0 && (
        <section className="flex flex-col gap-2">
          <button type="button" onClick={onUndoChanges} className="text-left text-ink-2 hover:text-ink">
            Undo changes since {changesLabel.replace(/^your /, "")}
          </button>
          <span className="text-xs text-ink-3">Ctrl+Z brings them back.</span>
        </section>
      )}
    </>
  );
}
