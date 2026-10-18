import type { VersionDetail, VersionSummary } from "../services/tauri";
import { shortTime } from "../lib/format";

interface HistoryPanelProps {
  pending: VersionDetail | null;
  versions: VersionSummary[];
  more: boolean;
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onLoadMore: () => void;
}

export const PENDING = "pending";

const dayLabel = (ms: number) => {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  }).format(d);
};
const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** History's left panel: what isn't synced yet, then every saved version, newest first, by day. */
export default function HistoryPanel({ pending, versions, more, loading, selected, onSelect, onLoadMore }: HistoryPanelProps) {
  const groups: { label: string; items: VersionSummary[] }[] = [];
  for (const version of versions) {
    const label = dayLabel(version.commit.timestamp * 1000);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.items.push(version);
    else groups.push({ label, items: [version] });
  }
  const pendingCount = pending?.files.length ?? 0;

  return (
    <aside aria-label="Versions" className="flex w-64 shrink-0 flex-col gap-5 overflow-y-auto py-3.5 pr-5 pl-2 select-none">
      {pendingCount > 0 && (
        <button
          type="button"
          onClick={() => onSelect(PENDING)}
          aria-current={selected === PENDING ? "page" : undefined}
          className={`grid grid-cols-[68px_minmax(0,1fr)] items-start rounded-lg border p-2.5 text-left ${
            selected === PENDING ? "border-ink-3/50 bg-hover" : "border-rule hover:bg-hover"
          }`}
        >
          <span className="pt-1.5 pl-1">
            <span className="block size-[7px] rounded-full bg-accent" />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">Not synced yet</span>
            <span className="text-xs text-ink-3">
              {pendingCount} {pendingCount === 1 ? "file" : "files"} changed
              {pending?.base ? ` since ${shortTime(pending.base.timestamp * 1000)}` : ""}
            </span>
          </span>
        </button>
      )}

      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <div className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">{group.label}</div>
          {group.items.map(({ commit, files }) => {
            const current = selected === commit.id;
            return (
              <button
                key={commit.id}
                type="button"
                onClick={() => onSelect(commit.id)}
                aria-current={current ? "page" : undefined}
                className={`grid grid-cols-[68px_minmax(0,1fr)] rounded-md px-2.5 py-[7px] text-left ${
                  current ? "bg-hover text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
                }`}
              >
                <span className="pt-0.5 font-mono text-xs whitespace-nowrap text-ink-3">{clock.format(commit.timestamp * 1000)}</span>
                <span className="flex min-w-0 flex-col gap-px">
                  <span className={`truncate ${current ? "font-medium" : ""}`}>{commit.summary || "Untitled version"}</span>
                  <span className="truncate text-xs text-ink-3">
                    {commit.device ?? commit.author} · {files.length} {files.length === 1 ? "file" : "files"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ))}

      {more && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loading}
          className="rounded-md px-2.5 py-2 text-left text-[13px] text-accent hover:bg-hover disabled:opacity-50"
        >
          {loading ? "Loading…" : "Show older versions"}
        </button>
      )}
      {!loading && versions.length === 0 && pendingCount === 0 && (
        <p className="px-2.5 text-[13px] text-ink-3">No saved versions yet. Sync saves one.</p>
      )}
    </aside>
  );
}
