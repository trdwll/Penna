/**
 * The Tags view: every tag in the vault on the left (nested tags under their
 * parents), the notes with the chosen tag set like a page in the middle, and
 * what you can do with the tag in the margin.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { TaggedNote } from "../services/tauri";
import { displayTitle } from "../lib/daily";
import { folderOf, relativeTime } from "../lib/format";
import { alsoTagged, isUnder, mentionsOf, notesWith, tagCounts, tagRows, type TagSort } from "../lib/tags";
import { ChevronDown, ChevronRight, CloseIcon, SearchIcon } from "./icons";

interface TagsViewProps {
  /** Every note with tags; null while loading. */
  notes: TaggedNote[] | null;
  error: string | null;
  selected: string | null;
  onSelect: (tag: string) => void;
  /** Open a note, at a line when the tag is written in its text. */
  onOpen: (path: string, line: number | null) => void;
  onRename: (tag: string) => void;
  onSearch: (tag: string) => void;
}

const TAG_IN_TEXT = /(^|\s)(#\p{L}[\p{L}\p{N}_\-/]*)/gu;

/** A line as it reads: without the list bullet, heading marks or quote mark in front. */
const readable = (line: string) => line.replace(/^(?:\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s*)+/, "");

/** Text with its tags as pills; the chosen one stands out. */
function TagText({ text, tag }: { text: string; tag: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TAG_IN_TEXT)) {
    const start = m.index + m[1].length;
    parts.push(text.slice(last, start));
    const name = m[2].slice(1).replace(/\/+$/, "").toLowerCase();
    parts.push(
      <span
        key={start}
        className={`rounded-full px-1.5 py-px font-sans text-[14px] ${isUnder(name, tag) ? "bg-accent-soft text-accent" : "bg-rule/70 text-ink-2"}`}
      >
        {m[2]}
      </span>,
    );
    last = start + m[2].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function TagsView({ notes, error, selected, onSelect, onOpen, onRename, onSearch }: TagsViewProps) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<TagSort>("count");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [narrow, setNarrow] = useState<string[]>([]);
  const [order, setOrder] = useState<"recent" | "name">("recent");
  const [active, setActive] = useState(0);
  const filterRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => filterRef.current?.focus(), []);

  const counts = useMemo(() => tagCounts(notes ?? []), [notes]);
  const rows = useMemo(() => tagRows(counts, sort, collapsed, filter), [counts, sort, collapsed, filter]);
  const current = selected && counts.has(selected) ? selected : null;

  // A tag is always chosen while there are any: the one asked for, else the first.
  useEffect(() => {
    if (notes && !current && rows.length) onSelect(rows[0].tag);
  }, [notes, current, rows, onSelect]);
  useEffect(() => {
    setNarrow([]);
    setActive(0);
  }, [current]);

  const total = useMemo(() => (current ? notesWith(notes ?? [], current, []).length : 0), [notes, current]);
  const tagged = useMemo(() => {
    if (!current) return [];
    const list = notesWith(notes ?? [], current, narrow);
    return list.sort((a, b) => (order === "recent" ? b.modified - a.modified : displayTitle(a.path).localeCompare(displayTitle(b.path))));
  }, [notes, current, narrow, order]);
  const also = useMemo(() => (current ? alsoTagged(tagged, current, narrow) : []), [tagged, current, narrow]);
  const nested = useMemo(
    () => (current ? [...counts.keys()].filter((t) => t !== current && isUnder(t, current)).sort() : []),
    [counts, current],
  );
  const now = Date.now();

  function onFilterKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const i = rows.findIndex((r) => r.tag === current);
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) onSelect(next.tag);
    } else if (e.key === "Enter") {
      e.preventDefault();
      resultsRef.current?.querySelector<HTMLButtonElement>("button[data-index]")?.focus();
    } else if (e.key === "Escape" && filter) {
      e.stopPropagation();
      setFilter("");
    }
  }

  function onResultsKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const next = Math.max(0, Math.min(tagged.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
    resultsRef.current?.querySelector<HTMLButtonElement>(`button[data-index="${next}"]`)?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "F2" && current && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      onRename(current);
    }
  }

  const toggleCollapsed = (tag: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });

  return (
    <div className="contents" onKeyDown={onKeyDown}>
      <aside aria-label="Tags" className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto py-3.5 pr-4 pl-3.5 select-none">
        <label className="flex h-[34px] items-center gap-2 rounded-lg bg-hover px-2.5 text-ink-3">
          <SearchIcon className="size-3.5 shrink-0" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onFilterKey}
            placeholder="Filter tags"
            aria-label="Filter tags"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-3"
          />
        </label>
        <div className="flex items-center justify-between px-2.5 pt-1.5">
          <span className="text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">{plural(counts.size, "tag")}</span>
          <span className="relative inline-flex items-center text-xs">
            <select
              aria-label="Sort tags"
              value={sort}
              onChange={(e) => setSort(e.target.value as TagSort)}
              className="appearance-none bg-transparent pr-3.5 text-ink-2 outline-none"
            >
              <option value="count">Most used</option>
              <option value="name">A–Z</option>
            </select>
            <span aria-hidden="true" className="pointer-events-none absolute right-0 text-[9px]">
              ▾
            </span>
          </span>
        </div>
        <ul className="m-0 flex list-none flex-col gap-px p-0 text-[14px]">
          {rows.map((row) => {
            const isCurrent = row.tag === current;
            const open = !collapsed.has(row.tag) || !!filter.trim();
            return (
              <li key={row.tag} className="flex items-center">
                <span aria-hidden="true" className="shrink-0" style={{ width: row.depth * 16 }} />
                {row.hasChildren ? (
                  <button
                    type="button"
                    aria-label={`${open ? "Hide" : "Show"} the tags under #${row.tag}`}
                    aria-expanded={open}
                    onClick={() => toggleCollapsed(row.tag)}
                    className="grid size-5 shrink-0 place-items-center rounded text-faint hover:text-ink"
                  >
                    {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  </button>
                ) : (
                  <span aria-hidden="true" className="w-5 shrink-0" />
                )}
                <button
                  type="button"
                  title={`#${row.tag}`}
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => onSelect(row.tag)}
                  className={`flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left ${
                    isCurrent ? "bg-hover font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
                  }`}
                >
                  {row.depth === 0 && <span className="font-normal text-faint">#</span>}
                  <span className="min-w-0 flex-1 truncate">{row.label}</span>
                  <span className="text-xs font-normal text-ink-3">{row.count}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {notes && counts.size > 0 && rows.length === 0 && <p className="px-2.5 text-[13px] text-ink-3">No tags match.</p>}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col border-l border-rule">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full pt-9 pr-10 pb-[30vh] pl-[80px]" style={{ maxWidth: "calc(var(--column-width, 680px) + 120px)" }}>
            {error ? (
              <p className="text-[13px] text-danger">{error}</p>
            ) : !notes ? (
              <p className="text-[13px] text-ink-3">Gathering tags…</p>
            ) : !current ? (
              <div className="flex flex-col gap-2">
                <h1 className="border-b border-ink pb-3 font-serif text-[34px] leading-tight font-medium">No tags yet</h1>
                <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
                  Tag a note by writing <span className="text-ink-2">#idea</span> anywhere in it, or{" "}
                  <span className="font-mono text-[12px] text-ink-2">tags: [idea]</span> in its properties. Tags show up here, with every
                  note that uses them.
                </p>
              </div>
            ) : (
              <>
                <h1 className="border-b border-ink pb-3 font-serif text-[34px] leading-tight font-medium break-words">
                  <span className="text-faint">#</span>
                  {current}
                </h1>
                <div className="mt-3 flex items-center justify-between gap-4 text-[13px] text-ink-3 select-none">
                  <span>
                    {narrow.length ? `${tagged.length} of ${plural(total, "note")}` : plural(total, "note")}
                    {!narrow.length &&
                      nested.length > 0 &&
                      `, with ${nested
                        .slice(0, 2)
                        .map((t) => `#${t}`)
                        .join(", ")}${nested.length > 2 ? ` and ${nested.length - 2} more` : ""}`}
                  </span>
                  <span className="relative inline-flex items-center">
                    <select
                      aria-label="Sort notes"
                      value={order}
                      onChange={(e) => setOrder(e.target.value as "recent" | "name")}
                      className="appearance-none bg-transparent pr-4 text-ink-2 outline-none"
                    >
                      <option value="recent">Recently edited</option>
                      <option value="name">Name</option>
                    </select>
                    <span aria-hidden="true" className="pointer-events-none absolute right-0 text-[10px]">
                      ▾
                    </span>
                  </span>
                </div>

                {(narrow.length > 0 || also.length > 0) && (
                  <div
                    className="mt-4 flex flex-wrap items-center gap-1.5 text-[13px] select-none"
                    aria-label="Narrow by another tag"
                    role="group"
                  >
                    <span className="mr-1 text-ink-3">Also tagged</span>
                    {narrow.map((t) => (
                      <button
                        key={t}
                        type="button"
                        aria-pressed="true"
                        aria-label={`Stop narrowing to #${t}`}
                        onClick={() => setNarrow((n) => n.filter((x) => x !== t))}
                        className="flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pr-1.5 pl-2.5 text-accent hover:opacity-80"
                      >
                        #{t}
                        <CloseIcon className="size-3" />
                      </button>
                    ))}
                    {also.map(([t, n]) => (
                      <button
                        key={t}
                        type="button"
                        aria-pressed="false"
                        title={`Only notes also tagged #${t}`}
                        onClick={() => setNarrow((list) => [...list, t])}
                        className="flex items-center gap-1.5 rounded-full bg-hover px-2.5 py-0.5 text-ink-2 hover:text-ink"
                      >
                        #{t}
                        <span className="text-xs text-ink-3">{n}</span>
                      </button>
                    ))}
                  </div>
                )}

                <div ref={resultsRef} onKeyDown={onResultsKey} className="mt-3.5 flex flex-col">
                  {tagged.map((note, i) => {
                    const { lines, count } = mentionsOf(note, current);
                    const first = lines[0];
                    const folder = folderOf(note.path);
                    return (
                      <button
                        key={note.path}
                        type="button"
                        data-index={i}
                        onClick={() => onOpen(note.path, first?.line ?? null)}
                        onMouseEnter={() => setActive(i)}
                        onFocus={() => setActive(i)}
                        className={`-mx-4 flex flex-col gap-1.5 rounded-lg px-4 py-4 text-left outline-none ${i === active ? "bg-hover" : ""}`}
                      >
                        <span className="flex items-baseline justify-between gap-4">
                          <span className="font-serif text-[23px] leading-tight font-medium">{displayTitle(note.path)}</span>
                          <span className="shrink-0 text-xs text-ink-3">{count ? plural(count, "mention") : "In properties"}</span>
                        </span>
                        <span className="text-xs tracking-[0.08em] text-ink-3 uppercase">
                          {[folder ? folder.split("/").join(" · ") : "Vault", `Edited ${relativeTime(note.modified, now)}`].join(" · ")}
                        </span>
                        {first ? (
                          <span className="font-serif text-[17px] leading-relaxed text-ink-2">
                            <TagText text={readable(first.text)} tag={current} />
                          </span>
                        ) : (
                          <span className="flex flex-wrap gap-1.5 text-[14px]">
                            {note.properties.map((t) => (
                              <span
                                key={t}
                                className={`rounded-full px-1.5 py-px ${isUnder(t, current) ? "bg-accent-soft text-accent" : "bg-rule/70 text-ink-2"}`}
                              >
                                #{t}
                              </span>
                            ))}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </main>

      <aside
        aria-label="About this tag"
        className="hidden w-60 shrink-0 flex-col gap-2.5 pt-[118px] pr-7 pl-2 text-[13px] text-ink-2 select-none xl:flex"
      >
        {current && (
          <>
            <div className="text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">This tag</div>
            <button type="button" onClick={() => onRename(current)} className="self-start text-left text-accent hover:text-ink">
              Rename #{current}…
            </button>
            <button type="button" onClick={() => onSearch(current)} className="self-start text-left text-accent hover:text-ink">
              Search for #{current}
            </button>
          </>
        )}
        <div className={`text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase ${current ? "mt-5" : ""}`}>Keys</div>
        <Key label="Next tag">↑ ↓</Key>
        <Key label="To the notes">Enter</Key>
        <Key label="Rename tag">F2</Key>
        <Key label="From any view">Ctrl Shift T</Key>
      </aside>
    </div>
  );
}

function Key({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="flex justify-between gap-3">
      {label}
      <span className="font-mono text-xs whitespace-nowrap text-ink-3">{children}</span>
    </span>
  );
}
