import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as api from "../services/tauri";
import type { HistoryHit, SearchHit } from "../services/tauri";
import { displayTitle } from "../lib/daily";
import { relativeTime, shortDate } from "../lib/format";
import { SearchIcon } from "./icons";

interface SearchViewProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** Open a note and jump to the first match of `term`. */
  onOpenNote: (path: string, term: string) => void;
  /** Open the version an older-version match came from. */
  onOpenVersion: (hit: HistoryHit) => void;
}

type Edited = "any" | "week" | "month";

/** Same rules as the Rust side: words, plus "quoted phrases" kept whole. */
export function parseTerms(query: string): string[] {
  const terms: string[] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  for (let m = re.exec(query); m; m = re.exec(query)) {
    const term = (m[1] ?? m[2] ?? "").trim().toLowerCase();
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map(escape).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-[3px] bg-accent-soft px-0.5 text-ink">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

const topFolder = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "");

/** The whole Search view: filters, results, and keyboard hints. */
export default function SearchView({ query, onQueryChange, onOpenNote, onOpenVersion }: SearchViewProps) {
  const [titlesOnly, setTitlesOnly] = useState(false);
  const [withHistory, setWithHistory] = useState(true);
  const [hiddenFolders, setHiddenFolders] = useState<ReadonlySet<string>>(new Set());
  const [edited, setEdited] = useState<Edited>("any");
  const [tags, setTags] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<"best" | "recent">("best");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [older, setOlder] = useState<HistoryHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const terms = useMemo(() => parseTerms(query), [query]);

  useEffect(() => inputRef.current?.focus(), []);

  // Search as you type (debounced). Older versions are searched after the current notes.
  useEffect(() => {
    if (!terms.length) {
      setHits(null);
      setOlder(null);
      return;
    }
    let stale = false;
    const id = setTimeout(async () => {
      try {
        const found = await api.searchNotes(query, titlesOnly);
        if (stale) return;
        setHits(found);
        setError(null);
        setSelected(0);
        if (withHistory && !titlesOnly) {
          setOlder(null);
          const past = await api.searchHistory(query);
          if (!stale) setOlder(past);
        } else {
          setOlder([]);
        }
      } catch (err) {
        if (!stale) setError(api.errorMessage(err));
      }
    }, 200);
    return () => {
      stale = true;
      clearTimeout(id);
    };
  }, [query, terms.length, titlesOnly, withHistory]);

  const now = Date.now();
  const since = edited === "week" ? now - 7 * 864e5 : edited === "month" ? now - 31 * 864e5 : 0;
  const inWindow = (hit: SearchHit) => hit.modified >= since;

  // Facet counts come from the results that pass the *other* filters.
  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const hit of hits ?? []) if (inWindow(hit)) counts.set(topFolder(hit.path), (counts.get(topFolder(hit.path)) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [hits, since]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    const list = (hits ?? []).filter(
      (hit) => !hiddenFolders.has(topFolder(hit.path)) && inWindow(hit) && [...tags].every((t) => hit.tags.includes(t)),
    );
    const score = (h: SearchHit) => (h.titleMatch ? 100 : 0) + Math.min(h.count, 20) * 5 - (now - h.modified) / 864e5 / 30;
    return list.sort((a, b) => (sort === "recent" ? b.modified - a.modified : score(b) - score(a)));
  }, [hits, hiddenFolders, tags, sort, since]); // eslint-disable-line react-hooks/exhaustive-deps

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const hit of visible) for (const t of hit.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const t of tags) if (!counts.has(t)) counts.set(t, 0);
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 14);
  }, [visible, tags]);

  const matchCount = visible.reduce((n, h) => n + Math.max(h.count, h.titleMatch ? 1 : 0), 0);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, visible.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && visible[selected]) {
      onOpenNote(visible[selected].path, terms[0] ?? "");
    } else if (e.key === "Escape") {
      onQueryChange("");
    }
  }

  const toggle = <T,>(set: ReadonlySet<T>, value: T) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <>
      <aside aria-label="Search filters" className="flex w-64 shrink-0 flex-col gap-6 overflow-y-auto py-4 pr-5 pl-4.5 select-none">
        <Fieldset legend="Look in">
          <Radio name="scope" checked={!titlesOnly} onChange={() => setTitlesOnly(false)}>
            Titles and text
          </Radio>
          <Radio name="scope" checked={titlesOnly} onChange={() => setTitlesOnly(true)}>
            Titles only
          </Radio>
          <label className="flex items-center gap-2.5 text-ink">
            <input
              type="checkbox"
              checked={withHistory}
              disabled={titlesOnly}
              onChange={(e) => setWithHistory(e.target.checked)}
              className="m-0 accent-accent"
            />
            Older versions too
          </label>
        </Fieldset>

        {folderCounts.length > 0 && (
          <Fieldset legend="Folders">
            {folderCounts.map(([folder, count]) => (
              <label key={folder || "(root)"} className="flex items-center gap-2.5 text-ink">
                <input
                  type="checkbox"
                  checked={!hiddenFolders.has(folder)}
                  onChange={() => setHiddenFolders((s) => toggle(s, folder))}
                  className="m-0 accent-accent"
                />
                <span className="flex-1 truncate">{folder || "Vault"}</span>
                <span className="text-xs text-ink-3">{count}</span>
              </label>
            ))}
          </Fieldset>
        )}

        <Fieldset legend="Edited">
          {(
            [
              ["any", "Any time"],
              ["week", "Past week"],
              ["month", "Past month"],
            ] as const
          ).map(([value, label]) => (
            <Radio key={value} name="edited" checked={edited === value} onChange={() => setEdited(value)}>
              {label}
            </Radio>
          ))}
        </Fieldset>

        {tagCounts.length > 0 && (
          <div className="flex flex-col gap-2.5">
            <div className="text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">Tags</div>
            <div className="flex flex-wrap gap-1.5 text-[13px]">
              {tagCounts.map(([tag]) => (
                <button
                  key={tag}
                  type="button"
                  aria-pressed={tags.has(tag)}
                  onClick={() => setTags((s) => toggle(s, tag))}
                  className={`rounded-full px-2.5 py-0.5 ${tags.has(tag) ? "bg-accent-soft text-accent" : "bg-hover text-ink-2 hover:text-ink"}`}
                >
                  #{tag}
                </button>
              ))}
            </div>
          </div>
        )}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col border-l border-rule">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full pt-9 pr-10 pb-[30vh] pl-[80px]" style={{ maxWidth: "calc(var(--column-width, 680px) + 120px)" }}>
            <label className="flex items-center gap-3.5 border-b border-ink pb-3">
              <SearchIcon className="size-[22px] shrink-0 text-ink-3" strokeWidth={1.3} />
              <input
                ref={inputRef}
                type="search"
                value={query}
                onChange={(e) => onQueryChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search notes"
                aria-label="Search notes"
                className="min-w-0 flex-1 bg-transparent font-serif text-[34px] [&::-webkit-search-cancel-button]:appearance-none leading-tight text-ink outline-none placeholder:text-faint"
              />
              <span className="font-mono text-[11px] text-ink-3">Esc</span>
            </label>

            {terms.length > 0 && hits && (
              <div className="mt-3 flex items-center justify-between text-[13px] text-ink-3 select-none">
                <span>
                  {matchCount} {matchCount === 1 ? "match" : "matches"} in {visible.length} {visible.length === 1 ? "note" : "notes"}
                </span>
                <span className="relative inline-flex items-center">
                  <select
                    aria-label="Sort results"
                    value={sort}
                    onChange={(e) => setSort(e.target.value as "best" | "recent")}
                    className="appearance-none bg-transparent pr-4 text-ink-2 outline-none"
                  >
                    <option value="best">Best match</option>
                    <option value="recent">Recently edited</option>
                  </select>
                  <span aria-hidden="true" className="pointer-events-none absolute right-0 text-[10px]">
                    ▾
                  </span>
                </span>
              </div>
            )}

            {error && <p className="mt-6 text-[13px] text-danger">{error}</p>}

            {!terms.length && (
              <div className="mt-8 flex flex-col gap-2 text-[13px] text-ink-3">
                <p>Every word must appear, in any order. Put a phrase in "quotes" to match it exactly.</p>
                <p>With “Older versions too”, Penna also finds text you've since deleted.</p>
              </div>
            )}

            <div className="mt-2.5 flex flex-col">
              {visible.map((hit, i) => (
                <button
                  key={hit.path}
                  type="button"
                  onClick={() => onOpenNote(hit.path, terms[0] ?? "")}
                  onMouseEnter={() => setSelected(i)}
                  className={`-mx-4 flex flex-col gap-1.5 rounded-lg px-4 py-4 text-left ${i === selected ? "bg-hover" : ""}`}
                >
                  <span className="flex items-baseline justify-between gap-4">
                    <span className="font-serif text-[23px] leading-tight font-medium">
                      <Highlight text={displayTitle(hit.path)} terms={hit.titleMatch ? terms : []} />
                    </span>
                    <span className="shrink-0 text-xs text-ink-3">
                      {hit.count > 0 ? `${hit.count} ${hit.count === 1 ? "match" : "matches"}` : "Title"}
                    </span>
                  </span>
                  <span className="text-xs tracking-[0.08em] text-ink-3 uppercase">
                    {[topFolder(hit.path) || "Vault", `Edited ${relativeTime(hit.modified, now)}`].join(" · ")}
                  </span>
                  {hit.snippets.map((s) => (
                    <span key={s.line} className="font-serif text-[17px] leading-relaxed text-ink-2">
                      <Highlight text={s.text} terms={terms} />
                    </span>
                  ))}
                </button>
              ))}
              {terms.length > 0 && hits && visible.length === 0 && (
                <p className="mt-6 text-[13px] text-ink-3">
                  {hits.length
                    ? "No notes match with these filters."
                    : withHistory && !titlesOnly
                      ? "No current notes match."
                      : "No notes match."}
                </p>
              )}
            </div>

            {terms.length > 0 && !titlesOnly && withHistory && (older === null || older.length > 0) && (
              <div className="mt-6 flex flex-col gap-1.5 border-t border-rule pt-5">
                <span className="text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase select-none">
                  In older versions {older === null && <span className="font-normal tracking-normal normal-case">· searching…</span>}
                </span>
                {older?.map((hit) => (
                  <div key={hit.path} className="mt-3 flex flex-col gap-1.5">
                    <span className="flex items-baseline justify-between gap-4">
                      <span className="font-serif text-[21px] font-medium">{displayTitle(hit.path)}</span>
                      <button type="button" onClick={() => onOpenVersion(hit)} className="shrink-0 text-[13px] text-accent hover:text-ink">
                        {hit.deleted ? "See where it was deleted" : `Open the ${shortDate(hit.version.timestamp * 1000)} version`}
                      </button>
                    </span>
                    <span className="font-serif text-[17px] leading-relaxed text-ink-2">
                      <Highlight text={hit.snippet} terms={terms} />{" "}
                      <span className="font-sans text-[13px] text-ink-3">
                        {hit.deleted ? "Note deleted" : "Removed"} {shortDate(hit.removedIn.timestamp * 1000)}.
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      <aside
        aria-label="Search keys"
        className="hidden w-60 shrink-0 flex-col gap-2.5 pt-[118px] pr-7 pl-2 text-[13px] text-ink-2 select-none xl:flex"
      >
        <div className="text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">Keys</div>
        <Key label="Move">↑ ↓</Key>
        <Key label="Open">Enter</Key>
        <Key label="Clear">Esc</Key>
        <Key label="Exact phrase">"…"</Key>
        <Key label="From any view">Ctrl Shift F</Key>
      </aside>
    </>
  );
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
      <legend className="pb-2.5 text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">{legend}</legend>
      {children}
    </fieldset>
  );
}

function Radio({ name, checked, onChange, children }: { name: string; checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <label className={`flex items-center gap-2.5 ${checked ? "text-ink" : "text-ink-2"}`}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="m-0 accent-accent" />
      {children}
    </label>
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
