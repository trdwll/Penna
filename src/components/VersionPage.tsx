import { useMemo, useState } from "react";
import type { FileDiff, VersionDetail } from "../services/tauri";
import { displayTitle } from "../lib/daily";
import { folderOf, shortDate, shortTime } from "../lib/format";
import { proseDiff, summarize, type DiffLine } from "../lib/proseDiff";
import { SyncIcon } from "./icons";

export interface CompareTarget {
  id: string;
  label: string;
}

interface VersionPageProps {
  /** null while loading. */
  detail: VersionDetail | null;
  pending: boolean;
  onOpenNote: (path: string, compare?: CompareTarget) => void;
  onRestore: (paths: string[]) => Promise<void>;
  onSync: () => void;
  syncBusy: boolean;
}

const when = (seconds: number) =>
  new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(
    seconds * 1000,
  );

const fileId = (path: string) => `file-${path.replace(/[^\w-]/g, "_")}`;

/** One version (or the not-yet-synced changes), read like a page. */
export default function VersionPage({ detail, pending, onOpenNote, onRestore, onSync, syncBusy }: VersionPageProps) {
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);

  if (!detail) return <div className="flex-1" />;
  const commit = detail.commit;
  const notes = detail.files.filter((f) => f.oldText !== null || f.newText !== null);
  const restorable = commit ? detail.files.filter((f) => f.status !== "deleted" && f.newText !== null).map((f) => f.path) : [];

  async function restore() {
    setRestoring(true);
    try {
      await onRestore(restorable);
    } finally {
      setRestoring(false);
      setConfirming(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <article className="mx-auto w-full pt-10 pr-10 pb-[30vh] pl-[80px]" style={{ maxWidth: "calc(var(--column-width, 680px) + 120px)" }}>
        <div className="flex items-baseline justify-between gap-4 text-xs text-ink-3 select-none">
          <span className="tracking-[0.1em] uppercase">{pending ? "Not synced yet" : "Version"}</span>
          {commit && (
            <span>
              {when(commit.timestamp)} · {commit.device ?? commit.author} · <span className="font-mono">{commit.shortId}</span>
            </span>
          )}
        </div>
        <h1 className="mt-3.5 font-serif text-[44px] leading-[1.12] font-medium tracking-[-0.015em]">
          {pending ? "Changes since your last sync" : commit?.summary || "Untitled version"}
        </h1>
        <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-2">
          <span>
            {detail.files.length} {detail.files.length === 1 ? "file" : "files"} changed
            {pending && detail.base ? ` since ${shortTime(detail.base.timestamp * 1000)}` : ""}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="rounded-[3px] bg-accent-soft px-1.5 text-ink">Added</span>
            <span className="text-del line-through">Removed</span>
          </span>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-3.5 gap-y-2.5">
          {pending ? (
            <button
              type="button"
              onClick={onSync}
              disabled={syncBusy}
              className="flex h-8 items-center gap-2 rounded-full bg-ink px-4 text-[13px] font-medium text-bg hover:opacity-90 disabled:opacity-50"
            >
              <SyncIcon className={`size-3.5 ${syncBusy ? "animate-spin" : ""}`} />
              {syncBusy ? "Syncing…" : "Sync now"}
            </button>
          ) : confirming ? (
            <span role="group" aria-label="Confirm restore" className="flex flex-wrap items-center gap-2.5 text-[13px]">
              <span className="text-ink-2">
                Put {restorable.length} {restorable.length === 1 ? "note" : "notes"} back the way {restorable.length === 1 ? "it was" : "they were"} in this
                version?
              </span>
              <button
                type="button"
                onClick={() => void restore()}
                disabled={restoring}
                className="h-8 rounded-full bg-ink px-4 font-medium text-bg hover:opacity-90 disabled:opacity-50"
              >
                {restoring ? "Restoring…" : "Restore"}
              </button>
              <button type="button" onClick={() => setConfirming(false)} className="h-8 rounded-full px-3 text-ink-2 hover:bg-hover">
                Cancel
              </button>
            </span>
          ) : (
            restorable.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="h-8 rounded-full border border-rule px-3.5 text-[13px] hover:bg-hover"
                >
                  Restore {restorable.length === 1 ? "this note" : "these notes"}…
                </button>
                <span className="text-xs text-ink-3">Restoring adds a new version. Nothing is lost.</span>
              </>
            )
          )}
        </div>

        <div className="mt-9 flex flex-col gap-10">
          {notes.map((file) => (
            <FileSection key={file.path} file={file} commitId={commit?.id ?? null} onOpenNote={onOpenNote} />
          ))}
          {detail.files
            .filter((f) => f.oldText === null && f.newText === null)
            .map((file) => (
              <div key={file.path} className="flex items-baseline justify-between gap-4 border-b border-rule pb-2 text-[13px] text-ink-2">
                <span className="truncate">{file.path}</span>
                <span className="shrink-0 text-xs text-ink-3">{STATUS_LABEL[file.status]} · not a note</span>
              </div>
            ))}
        </div>
      </article>
    </div>
  );
}

const STATUS_LABEL = { added: "Added", modified: "Changed", deleted: "Deleted", renamed: "Renamed" } as const;

function FileSection({
  file,
  commitId,
  onOpenNote,
}: {
  file: FileDiff;
  commitId: string | null;
  onOpenNote: (path: string, compare?: CompareTarget) => void;
}) {
  const lines = useMemo(() => proseDiff(file.oldText, file.newText), [file.oldText, file.newText]);
  const folder = folderOf(file.path);
  const note =
    file.status === "added"
      ? "New note"
      : file.status === "deleted"
        ? "Deleted"
        : file.status === "renamed"
          ? `Renamed from ${displayTitle(file.oldPath ?? "")}`
          : summarize(lines);

  return (
    <section id={fileId(file.path)} aria-label={displayTitle(file.path)}>
      <div className="flex items-baseline justify-between gap-4 border-b border-rule pb-2">
        <h2 className="min-w-0 font-serif text-[25px] leading-[1.3] font-medium">
          {file.status === "deleted" ? (
            <span className="text-ink-2">{displayTitle(file.path)}</span>
          ) : (
            <button type="button" onClick={() => onOpenNote(file.path)} className="truncate text-left hover:text-accent">
              {displayTitle(file.path)}
            </button>
          )}
        </h2>
        <span className="flex shrink-0 items-baseline gap-3 text-xs text-ink-3">
          <span>{[folder.split("/").join(" · "), note].filter(Boolean).join(" · ")}</span>
          {commitId && file.status !== "deleted" && (
            <button
              type="button"
              onClick={() => onOpenNote(file.path, { id: commitId, label: "" })}
              className="text-accent hover:text-ink"
            >
              Compare with now
            </button>
          )}
        </span>
      </div>
      <DiffBody lines={lines} />
    </section>
  );
}

const SHOW_AT_MOST = 40;

function DiffBody({ lines }: { lines: DiffLine[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? lines : lines.slice(0, SHOW_AT_MOST);
  return (
    <div className="mt-3 font-serif text-[17px] leading-[1.62] text-pretty">
      {shown.map((line, i) => (
        <Line key={i} line={line} />
      ))}
      {lines.length > SHOW_AT_MOST && !expanded && (
        <button type="button" onClick={() => setExpanded(true)} className="mt-2 font-sans text-[13px] text-accent hover:text-ink">
          Show {lines.length - SHOW_AT_MOST} more lines
        </button>
      )}
    </div>
  );
}

const MARK = "absolute right-full pr-3.5 font-mono text-[13px] leading-[inherit] select-none";
const heading = (text: string) => /^#{1,6}\s/.test(text);

function Line({ line }: { line: DiffLine }) {
  if (line.kind === "gap") {
    return (
      <div className="my-2 border-y border-dashed border-rule py-1 font-sans text-xs text-ink-3 select-none">
        {line.count} unchanged {line.count === 1 ? "line" : "lines"}
      </div>
    );
  }
  if (line.kind === "edited") {
    const text = line.segments.map((s) => s.text).join("");
    return (
      <p className={`relative min-h-[1.62em] whitespace-pre-wrap ${heading(text) ? "font-semibold" : ""}`}>
        <span aria-hidden="true" className={`${MARK} text-accent`}>
          ~
        </span>
        {line.segments.map((s, i) =>
          s.kind === "same" ? (
            <span key={i}>{s.text}</span>
          ) : s.kind === "added" ? (
            <ins key={i} className="rounded-[3px] bg-ins-strong px-0.5 no-underline">
              {s.text}
            </ins>
          ) : (
            <del key={i} className="rounded-[3px] bg-del-soft px-0.5 text-del decoration-del">
              {s.text}
            </del>
          ),
        )}
      </p>
    );
  }
  const text = line.text;
  // Blank lines carry no content to highlight; keep their space only.
  if ((line.kind === "added" || line.kind === "removed") && !text.trim()) return <p className="min-h-[1.62em]" />;
  if (line.kind === "added") {
    return (
      <p className={`relative min-h-[1.62em] whitespace-pre-wrap ${heading(text) ? "font-semibold" : ""}`}>
        <span aria-hidden="true" className={`${MARK} text-accent`}>
          +
        </span>
        <ins className="rounded-[3px] bg-accent-soft px-0.5 no-underline [box-decoration-break:clone]">{text || " "}</ins>
      </p>
    );
  }
  if (line.kind === "removed") {
    return (
      <p className="relative min-h-[1.62em] whitespace-pre-wrap text-del">
        <span aria-hidden="true" className={MARK}>
          −
        </span>
        <del className="rounded-[3px] bg-del-soft px-0.5 decoration-del [box-decoration-break:clone]">{text || " "}</del>
      </p>
    );
  }
  return <p className={`min-h-[1.62em] whitespace-pre-wrap text-ink-3 ${heading(text) ? "font-semibold" : ""}`}>{text || " "}</p>;
}

/** History's right margin: the files in this version and stepping to neighbours. */
export function VersionMargin({
  detail,
  onStep,
  canStep,
}: {
  detail: VersionDetail | null;
  onStep: (dir: -1 | 1) => void;
  canStep: { newer: boolean; older: boolean };
}) {
  const files = detail?.files ?? [];
  return (
    <aside aria-label="About this version" className="hidden w-60 shrink-0 flex-col gap-7 overflow-y-auto pt-[92px] pr-7 pb-6 pl-2 text-[13px] select-none xl:flex">
      <section className="flex flex-col gap-2">
        <div className="text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">In this version</div>
        {files.map((f) => (
          <button
            key={f.path}
            type="button"
            onClick={() => document.getElementById(fileId(f.path))?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="truncate text-left text-ink-2 hover:text-ink"
          >
            {displayTitle(f.path)}
          </button>
        ))}
      </section>
      {detail?.commit && (
        <section className="flex flex-col gap-2">
          <div className="text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">Step through</div>
          <button type="button" disabled={!canStep.newer} onClick={() => onStep(-1)} className="text-left text-accent disabled:text-ink-3">
            Newer version
          </button>
          <button type="button" disabled={!canStep.older} onClick={() => onStep(1)} className="text-left text-accent disabled:text-ink-3">
            Older version
          </button>
          <span className="text-xs text-ink-3">Saved {shortDate(detail.commit.timestamp * 1000)}</span>
        </section>
      )}
    </aside>
  );
}
