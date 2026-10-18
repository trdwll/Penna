/**
 * The quick switcher (Ctrl+P): one box that goes anywhere. Empty, it lists
 * recent notes; typing fuzzy-matches note names, folders and headings; a
 * leading ">" runs a command (Ctrl+Shift+P starts there). Enter opens,
 * Ctrl+Enter searches everything for what's typed.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { displayTitle } from "../lib/daily";
import { folderOf } from "../lib/format";
import { fuzzy, highlightRuns, type FuzzyMatch } from "../lib/fuzzy";
import type { HeadingRef } from "../services/tauri";
import { Dialog } from "./NoteDialogs";
import { NoteIcon, PlusIcon, SearchIcon } from "./icons";

export interface SwitcherCommand {
  id: string;
  label: string;
  /** A shortcut, shown on the right ("Ctrl N"). */
  hint?: string;
  run: () => void;
}

type Item =
  | { kind: "note"; path: string; title: string; folder: string; match: FuzzyMatch }
  | { kind: "heading"; heading: HeadingRef; match: FuzzyMatch }
  | { kind: "command"; command: SwitcherCommand; match: FuzzyMatch }
  | { kind: "tag"; tag: string; count: number; match: FuzzyMatch }
  | { kind: "create"; name: string };

interface Section {
  label: string;
  items: Item[];
}

const MAX_NOTES = 30;
const MAX_HEADINGS = 12;

export default function QuickSwitcher({
  initial,
  notes,
  recent,
  loadHeadings,
  loadTags,
  commands,
  onOpen,
  onOpenHeading,
  onOpenTag,
  onCreate,
  onSearch,
  onClose,
  placeholder = "Go to a note or heading, # for tags, > for commands",
}: {
  initial: string;
  /** Every note path, in sidebar order. */
  notes: string[];
  /** Recently opened notes, newest first. */
  recent: string[];
  loadHeadings: () => Promise<HeadingRef[]>;
  /** Every tag with its note count, for "#" queries. */
  loadTags: () => Promise<{ tag: string; count: number }[]>;
  commands: SwitcherCommand[];
  onOpen: (path: string) => void;
  onOpenHeading: (path: string, line: number) => void;
  onOpenTag: (tag: string) => void;
  onCreate: (name: string) => void;
  onSearch: (query: string) => void;
  onClose: () => void;
  /** What the box says when empty (opening a note beside, say). */
  placeholder?: string;
}) {
  const [query, setQuery] = useState(initial);
  const [active, setActive] = useState(0);
  const [headings, setHeadings] = useState<HeadingRef[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stale = false;
    loadHeadings().then(
      (h) => !stale && setHeadings(h),
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [loadHeadings]);
  useEffect(() => {
    let stale = false;
    loadTags().then(
      (t) => !stale && setTags(t),
      () => {},
    );
    return () => {
      stale = true;
    };
  }, [loadTags]);

  const sections = useMemo<Section[]>(() => {
    const q = query.trim();
    if (q.startsWith(">")) {
      const cq = q.slice(1).trim();
      const items = commands
        .map((command) => ({ command, match: fuzzy(cq, command.label) }))
        .filter((c): c is { command: SwitcherCommand; match: FuzzyMatch } => c.match !== null)
        .sort((a, b) => b.match.score - a.match.score)
        .map((c) => ({ kind: "command" as const, ...c }));
      return [{ label: "Commands", items }];
    }
    if (q.startsWith("#")) {
      const tq = q.slice(1);
      const items = tags
        .map((t) => ({ kind: "tag" as const, ...t, match: fuzzy(tq, t.tag) }))
        .filter((t): t is { kind: "tag"; tag: string; count: number; match: FuzzyMatch } => t.match !== null)
        .sort((a, b) => b.match.score - a.match.score || b.count - a.count)
        .slice(0, MAX_NOTES);
      return [{ label: "Tags", items }];
    }
    const known = new Set(notes);
    if (!q) {
      const items = recent
        .filter((p) => known.has(p))
        .slice(0, 8)
        .map((path) => ({
          kind: "note" as const,
          path,
          title: displayTitle(path),
          folder: folderOf(path),
          match: { score: 0, marks: [] },
        }));
      return [{ label: items.length ? "Recent" : "Notes", items: items.length ? items : notes.slice(0, 8).map(noteItem) }];
    }

    const recency = new Map(recent.map((p, i) => [p, i]));
    const scored = notes
      .map((path) => {
        const title = displayTitle(path);
        const byTitle = fuzzy(q, title);
        const byPath = fuzzy(q, path.replace(/\.(md|markdown)$/i, ""));
        const match =
          byTitle && (!byPath || byTitle.score >= byPath.score * 0.8) ? byTitle : byPath ? { score: byPath.score * 0.8, marks: [] } : null;
        return match ? { kind: "note" as const, path, title, folder: folderOf(path), match } : null;
      })
      .filter((n): n is NonNullable<typeof n> => n !== null)
      // Better matches first; among equals, the ones opened most recently.
      .sort((a, b) => b.match.score - a.match.score || (recency.get(a.path) ?? 1e9) - (recency.get(b.path) ?? 1e9))
      .slice(0, MAX_NOTES);
    const heads = headings
      // A note's own "# Title" would only repeat the note above it.
      .filter((h) => !(h.level === 1 && h.text.toLowerCase() === displayTitle(h.path).toLowerCase()))
      .map((heading) => ({ kind: "heading" as const, heading, match: fuzzy(q, heading.text) }))
      .filter((h): h is { kind: "heading"; heading: HeadingRef; match: FuzzyMatch } => h.match !== null && h.match.score > 0)
      .sort((a, b) => b.match.score - a.match.score)
      .slice(0, MAX_HEADINGS);
    const exact = notes.some((p) => displayTitle(p).toLowerCase() === q.toLowerCase());
    const out: Section[] = [];
    if (scored.length) out.push({ label: "Notes", items: scored });
    if (heads.length) out.push({ label: "Headings", items: heads });
    if (!exact) out.push({ label: "", items: [{ kind: "create", name: q }] });
    return out;
  }, [query, notes, recent, headings, tags, commands]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(item: Item | undefined) {
    if (!item) return;
    onClose();
    if (item.kind === "note") onOpen(item.path);
    else if (item.kind === "heading") onOpenHeading(item.heading.path, item.heading.line);
    else if (item.kind === "command") item.command.run();
    else if (item.kind === "tag") onOpenTag(item.tag);
    else onCreate(item.name);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const n = flat.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Enter" && e.ctrlKey) {
      e.preventDefault();
      const q = query.replace(/^>/, "").trim();
      onClose();
      onSearch(q);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(flat[active]);
    }
  }

  let index = -1;
  return (
    <Dialog label="Go to" onCancel={onClose} width={580}>
      <label className="flex items-center gap-2.5 border-b border-rule px-4">
        <SearchIcon className="size-4 shrink-0 text-ink-3" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Go to"
          role="combobox"
          aria-expanded="true"
          aria-controls="switcher-results"
          aria-activedescendant={flat[active] ? `switcher-${active}` : undefined}
          spellCheck={false}
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3"
        />
        <span className="font-mono text-[11px] text-ink-3">Esc</span>
      </label>
      <div ref={listRef} id="switcher-results" role="listbox" aria-label="Results" className="max-h-[400px] overflow-y-auto px-2 py-1.5">
        {sections.map((section) => (
          <div key={section.label || "create"} role="group" aria-label={section.label || "New note"}>
            {section.label && (
              <div className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">{section.label}</div>
            )}
            {section.items.map((item) => {
              const i = ++index;
              return (
                <div
                  key={keyOf(item)}
                  id={`switcher-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(item)}
                  className={`flex h-9 items-center gap-3 rounded-md px-3 text-[13px] ${i === active ? "bg-hover text-ink" : "text-ink-2"}`}
                >
                  <Row item={item} />
                </div>
              );
            })}
          </div>
        ))}
        {!flat.length && (
          <div className="px-3 py-3 text-[13px] text-ink-3">{query.trim().startsWith("#") ? "No tags match." : "No commands match."}</div>
        )}
      </div>
      <div className="flex gap-4 border-t border-rule px-4 py-2 text-xs text-ink-3">
        <span>↑↓ choose</span>
        <span>Enter open</span>
        <span>Ctrl Enter search everything</span>
        <span>Esc close</span>
      </div>
    </Dialog>
  );
}

function noteItem(path: string): Item {
  return { kind: "note", path, title: displayTitle(path), folder: folderOf(path), match: { score: 0, marks: [] } };
}

function keyOf(item: Item): string {
  if (item.kind === "note") return `n:${item.path}`;
  if (item.kind === "heading") return `h:${item.heading.path}:${item.heading.line}`;
  if (item.kind === "command") return `c:${item.command.id}`;
  if (item.kind === "tag") return `t:${item.tag}`;
  return `new:${item.name}`;
}

function Marked({ text, marks }: { text: string; marks: number[] }) {
  return (
    <>
      {highlightRuns(text, marks).map((run, i) =>
        run.hit ? (
          <span key={i} className="font-semibold text-ink">
            {run.text}
          </span>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

function Row({ item }: { item: Item }) {
  if (item.kind === "note") {
    return (
      <>
        <NoteIcon className="size-3.5 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate">
          <Marked text={item.title} marks={item.match.marks} />
        </span>
        {item.folder && <span className="max-w-[45%] shrink-0 truncate text-xs text-ink-3">{item.folder.split("/").join(" · ")}</span>}
      </>
    );
  }
  if (item.kind === "heading") {
    return (
      <>
        <span aria-hidden="true" className="w-3.5 shrink-0 text-center font-mono text-[11px] text-faint">
          {"#".repeat(Math.min(item.heading.level, 3))}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <Marked text={item.heading.text} marks={item.match.marks} />
        </span>
        <span className="max-w-[45%] shrink-0 truncate text-xs text-ink-3">in {displayTitle(item.heading.path)}</span>
      </>
    );
  }
  if (item.kind === "command") {
    return (
      <>
        <span aria-hidden="true" className="w-3.5 shrink-0 text-center font-mono text-[12px] text-faint">
          ›
        </span>
        <span className="min-w-0 flex-1 truncate">
          <Marked text={item.command.label} marks={item.match.marks} />
        </span>
        {item.command.hint && <span className="shrink-0 font-mono text-[11px] text-ink-3">{item.command.hint}</span>}
      </>
    );
  }
  if (item.kind === "tag") {
    return (
      <>
        <span aria-hidden="true" className="w-3.5 shrink-0 text-center font-mono text-[12px] text-faint">
          #
        </span>
        <span className="min-w-0 flex-1 truncate">
          <Marked text={item.tag} marks={item.match.marks} />
        </span>
        <span className="shrink-0 text-xs text-ink-3">
          {item.count} {item.count === 1 ? "note" : "notes"}
        </span>
      </>
    );
  }
  return (
    <>
      <PlusIcon className="size-3.5 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate">
        New note <span className="font-medium text-ink">“{item.name}”</span>
      </span>
    </>
  );
}
