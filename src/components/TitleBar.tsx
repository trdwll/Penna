import { useEffect, useState } from "react";
import { appWindow, type GitStatus } from "../services/tauri";
import type { SaveStatus, ViewMode } from "../editor/Editor";
import { ChangesIcon, ChevronDown, CloseGlyph, MaximizeGlyph, MinimizeGlyph, NoteIcon, RestoreGlyph, SyncIcon } from "./icons";

interface TitleBarProps {
  vaultName: string | null;
  onSwitchVault: () => void;
  /** A note is open, so the view switch and Changes apply. */
  hasNote: boolean;
  mode: ViewMode;
  onModeChange: (mode: ViewMode) => void;
  changesOn: boolean;
  /** Why Changes can't be shown (no Git history yet), or null when it can. */
  changesUnavailable: string | null;
  onToggleChanges: () => void;
  /** A note is open beside the main one. */
  besideOn?: boolean;
  onToggleBeside?: () => void;
  saveStatus: SaveStatus | null;
  git: GitStatus | null;
  syncBusy: boolean;
  onSync: () => void;
  onInitRepo: () => void;
  /** A sync stopped to ask: how many places still need a choice. */
  paused?: { left: number } | null;
}

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: "Saved",
  dirty: "Edited",
  saving: "Saving…",
  error: "Not saved",
};

/**
 * The window's title bar. Penna draws its own (decorations are off), so the
 * empty areas carry `data-tauri-drag-region` and the caption buttons call the
 * window API.
 */
export default function TitleBar(props: TitleBarProps) {
  const { vaultName, onSwitchVault, hasNote, saveStatus } = props;

  return (
    <header data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-3 pl-3.5 select-none">
      <div data-tauri-drag-region className="flex min-w-0 flex-1 basis-0">
        {vaultName && (
          <button
            type="button"
            onClick={onSwitchVault}
            title="Open another vault"
            className="flex h-8 min-w-0 items-center gap-2 rounded-md px-2.5 font-semibold hover:bg-hover"
          >
            <NoteIcon className="size-4 shrink-0" />
            <span className="truncate">{vaultName}</span>
            <ChevronDown className="size-3 shrink-0 text-ink-3" />
          </button>
        )}
      </div>

      {hasNote && <ViewControls {...props} />}

      <div data-tauri-drag-region className="flex flex-1 basis-0 items-center justify-end gap-3">
        {saveStatus && (
          <span className={`text-[13px] ${saveStatus === "error" ? "text-danger" : "text-ink-3"}`}>{SAVE_LABEL[saveStatus]}</span>
        )}
        {vaultName && <SyncPill {...props} />}
        <WindowControls />
      </div>
    </header>
  );
}

function ViewControls({ mode, onModeChange, changesOn, changesUnavailable, onToggleChanges, besideOn, onToggleBeside }: TitleBarProps) {
  return (
    <div className="flex items-center gap-2.5">
      <Segmented
        label="View"
        title="Switch view (Ctrl+E)"
        value={mode}
        options={[
          { value: "preview", label: "Preview" },
          { value: "source", label: "Source" },
        ]}
        onChange={onModeChange}
      />
      <span className="font-mono text-[11px] text-ink-3">Ctrl E</span>
      <button
        type="button"
        aria-pressed={changesOn}
        disabled={!!changesUnavailable}
        onClick={onToggleChanges}
        title={changesUnavailable ?? "Show what changed (Ctrl+Shift+E)"}
        className={`ml-1.5 flex h-[30px] items-center gap-1.5 rounded-lg px-2.5 text-[13px] disabled:opacity-40 ${
          changesOn ? "bg-accent-soft font-medium text-accent" : "text-ink-3 hover:bg-hover hover:text-ink"
        }`}
      >
        <ChangesIcon className="size-3.5" />
        Changes
      </button>
      {onToggleBeside && (
        <button
          type="button"
          aria-pressed={!!besideOn}
          onClick={onToggleBeside}
          title={besideOn ? "Close the note beside (Ctrl+\\)" : "Open a note beside this one (Ctrl+\\)"}
          className={`flex h-[30px] items-center gap-1.5 rounded-lg px-2.5 text-[13px] ${
            besideOn ? "bg-hover font-medium text-ink" : "text-ink-3 hover:bg-hover hover:text-ink"
          }`}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-3.5" aria-hidden="true">
            <rect x="2" y="3" width="12" height="10" rx="1.5" />
            <path d="M8 3v10" />
          </svg>
          Beside
        </button>
      )}
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  title,
  value,
  options,
  onChange,
  size = "md",
}: {
  label: string;
  title?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
}) {
  const height = size === "sm" ? "h-6 text-xs" : "h-[26px] text-[13px]";
  return (
    <div role="group" aria-label={label} title={title} className="flex rounded-lg bg-hover p-0.5">
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(option.value)}
            className={`${height} rounded-md border px-3 ${
              on ? "border-rule bg-bg font-medium text-ink" : "border-transparent text-ink-3 hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function SyncPill({ git, syncBusy, onSync, onInitRepo, paused }: TitleBarProps) {
  if (!git) return null;

  if (paused) {
    return (
      <button
        type="button"
        onClick={onSync}
        disabled={syncBusy}
        title={
          paused.left
            ? "Sync is waiting for you to pick what to keep. Click to go to the next place."
            : "Every place has a choice. Click to finish the sync."
        }
        className="flex h-[30px] items-center gap-2.5 rounded-full border border-rule py-0 pr-1.5 pl-3 text-[13px] text-ink-2 hover:border-ink-3/40"
      >
        <span className="flex items-center gap-[7px]">
          <span className="size-[7px] rounded-full bg-del" />
          Sync paused
        </span>
        <span className="flex h-[22px] items-center rounded-full bg-del-soft px-2.5 font-semibold text-del">
          {syncBusy ? "Finishing…" : paused.left ? `${paused.left} to choose` : "Ready to finish"}
        </span>
      </button>
    );
  }

  if (!git.isRepo) {
    return (
      <button
        type="button"
        onClick={onInitRepo}
        disabled={syncBusy}
        title="Start tracking this vault's history with Git"
        className="flex h-[30px] items-center gap-2 rounded-full border border-rule px-3 text-[13px] text-ink-2 hover:bg-hover"
      >
        <SyncIcon className="size-3.5" />
        Set up history
      </button>
    );
  }

  const changes = git.changedFiles;
  const action = git.hasRemote ? "Sync" : "Save version";
  const details = [
    git.branch ? `On ${git.branch}` : "Detached HEAD",
    git.hasUpstream ? `${git.ahead} to send, ${git.behind} to get` : git.hasRemote ? "Not synced yet" : "No remote set up",
    git.lastCommit ? `Last version: ${git.lastCommit.summary}` : "No versions yet",
  ].join(" · ");

  return (
    <button
      type="button"
      onClick={onSync}
      disabled={syncBusy}
      title={`${details}\n${git.hasRemote ? "Save a version, get changes, then send yours (Ctrl+Shift+S)" : "Save a version of every changed note"}`}
      className="flex h-[30px] items-center gap-2.5 rounded-full border border-rule py-0 pr-1.5 pl-3 text-[13px] text-ink-2 hover:border-ink-3/40"
    >
      <span className="flex items-center gap-[7px]">
        <span className={`size-[7px] rounded-full ${changes > 0 ? "bg-accent" : "bg-ok"}`} />
        {changes > 0 ? `${changes} ${changes === 1 ? "change" : "changes"}` : "Up to date"}
        {git.conflictedFiles > 0 && <span className="text-danger">· {git.conflictedFiles} conflicted</span>}
      </span>
      <span className="flex h-[22px] items-center gap-1.5 rounded-full bg-accent-soft px-2.5 font-semibold text-accent">
        <SyncIcon className={`size-[13px] ${syncBusy ? "animate-spin" : ""}`} />
        {syncBusy ? "Syncing…" : action}
      </span>
    </button>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const update = () => void appWindow.isMaximized().then((m) => !disposed && setMaximized(m));
    update();
    appWindow
      .onResized(update)
      .then((fn) => (disposed ? fn() : (unlisten = fn)))
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const base = "grid h-11 w-[46px] place-items-center text-ink-2";
  return (
    <div className="ml-1.5 flex">
      <button type="button" aria-label="Minimize" onClick={() => void appWindow.minimize()} className={`${base} hover:bg-hover`}>
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={() => void appWindow.toggleMaximize()}
        className={`${base} hover:bg-hover`}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => void appWindow.close()}
        className={`${base} hover:bg-[#c42b1c] hover:text-white`}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}
