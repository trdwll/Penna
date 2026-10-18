/**
 * A sync that stopped to ask which version to keep (the "Margin — when two
 * devices edit the same note" boards): the bar on the note's page and the
 * right margin with the places, Finish sync and Stop this sync.
 */
import type { ConflictsInfo } from "../editor/conflicts";
import { displayTitle } from "../lib/daily";
import { ChevronDown, ChevronUp } from "./icons";

export interface PausedNote {
  path: string;
  /** Places that still have both versions. */
  places: number;
}

export interface PausedSync {
  /** The other device's name. */
  theirsName: string;
  notes: PausedNote[];
  /** Every place in every note has a choice. */
  ready: boolean;
  busy: boolean;
  onFinish: () => void;
  onStop: () => void;
  onOpenNote: (path: string) => void;
}

const places = (n: number) => `${n} ${n === 1 ? "place" : "places"}`;

/** Under the eyebrow of a note that changed on both devices. */
export function ConflictBar({
  sync,
  left,
  current,
  onNext,
  onPrevious,
}: {
  sync: PausedSync;
  /** Places left in this note. */
  left: number;
  /** 0-based index of the place at or after the cursor. */
  current: number;
  onNext: () => void;
  onPrevious: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Sync paused"
      className="mt-3 mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-rule pb-3 text-[13px] text-ink-2 select-none"
    >
      <span className="min-w-0">
        Changed here and on <strong className="font-semibold text-ink">{sync.theirsName}</strong> since your last sync.{" "}
        {left
          ? `Pick what to keep in ${places(left)}.`
          : sync.ready
            ? "Every place has a choice."
            : "Every place in this note has a choice."}
      </span>
      <span className="flex items-center gap-3">
        {left > 0 && (
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label="Previous place (Alt+Up)"
              onClick={onPrevious}
              className="grid size-7 place-items-center rounded-md hover:bg-hover"
            >
              <ChevronUp className="size-3" />
            </button>
            <span className="min-w-11 text-center text-ink-3">
              {Math.min(current, left - 1) + 1} of {left}
            </span>
            <button
              type="button"
              aria-label="Next place (Alt+Down)"
              onClick={onNext}
              className="grid size-7 place-items-center rounded-md hover:bg-hover"
            >
              <ChevronDown className="size-3" />
            </button>
          </span>
        )}
        {sync.ready && (
          <button
            type="button"
            onClick={sync.onFinish}
            disabled={sync.busy}
            className="h-7 rounded-full bg-ink px-3.5 text-[13px] font-semibold text-bg hover:opacity-90 disabled:opacity-50"
          >
            {sync.busy ? "Finishing…" : "Finish sync"}
          </button>
        )}
      </span>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">{children}</div>;
}

/** The right margin while a sync is paused. */
export function SyncMargin({
  sync,
  notePath,
  info,
  onJump,
}: {
  sync: PausedSync;
  /** The open note, if it's one of the paused sync's notes. */
  notePath: string | null;
  info: ConflictsInfo | null;
  onJump: (pos: number) => void;
}) {
  const here = notePath ? sync.notes.find((n) => n.path === notePath) : undefined;
  const others = sync.notes.filter((n) => n.path !== notePath);
  const items = [
    ...(info?.open ?? []).map((p) => ({ pos: p.pos, place: p.place, status: "Pick a version", done: false })),
    ...(info?.kept ?? []).map((k) => ({ pos: k.pos, place: k.place, status: k.label.replace(/ version$/, ""), done: true })),
  ].sort((a, b) => a.pos - b.pos);

  return (
    <>
      {here && (
        <section className="flex flex-col gap-2.5">
          <Label>In this note</Label>
          {items.length ? (
            items.map((item) => (
              <button
                key={`${item.pos}:${item.done}`}
                type="button"
                onClick={() => onJump(item.pos)}
                className="grid grid-cols-[16px_minmax(0,1fr)] gap-1.5 text-left text-ink-2 hover:text-ink"
              >
                <span className={`font-mono ${item.done ? "text-ok" : "text-del"}`} aria-hidden="true">
                  {item.done ? "✓" : "≠"}
                </span>
                <span className="min-w-0">
                  <span className="block truncate">{item.place}</span>
                  <span className="block text-ink-3">{item.status}</span>
                </span>
              </button>
            ))
          ) : (
            <span className="text-ink-3">Every place has a choice.</span>
          )}
        </section>
      )}

      {others.length > 0 && (
        <section className="flex flex-col gap-2">
          <Label>{here ? "The rest of the sync" : "Notes to look at"}</Label>
          {others.map((n) => (
            <button key={n.path} type="button" onClick={() => sync.onOpenNote(n.path)} className="text-left text-ink-2 hover:text-ink">
              <span className="block truncate">{displayTitle(n.path)}</span>
              <span className="block text-ink-3">{n.places ? `${places(n.places)} to choose` : "Every place has a choice"}</span>
            </button>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-2.5">
        <button
          type="button"
          onClick={sync.onFinish}
          disabled={!sync.ready || sync.busy}
          className={`h-9 rounded-full px-4 text-[13px] font-semibold ${
            sync.ready ? "bg-ink text-bg hover:opacity-90 disabled:opacity-50" : "bg-hover text-ink-3"
          }`}
        >
          {sync.busy ? "Finishing…" : "Finish sync"}
        </button>
        <span className="leading-normal text-ink-3">
          {sync.ready
            ? `Saves the merged notes as a new version and sends them to ${sync.theirsName}.`
            : "Pick a version in every place first. You can keep writing meanwhile; automatic sync waits."}
        </span>
      </section>

      <section className="flex flex-col gap-1.5 border-t border-rule pt-3.5">
        <button type="button" onClick={sync.onStop} disabled={sync.busy} className="text-left text-ink-2 hover:text-ink">
          Stop this sync…
        </button>
        <span className="leading-normal text-ink-3">
          Puts your notes back as they were. {sync.theirsName}’s edits wait for the next sync. Nothing is lost either way.
        </span>
      </section>
    </>
  );
}
