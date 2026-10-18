/**
 * The note beside the one you're writing: a real page with its own editor
 * (it saves as you type), a quieter header, and Swap / Close.
 */
import { useState, type Ref } from "react";
import Editor, { type EditorHandle, type SaveStatus, type ViewMode } from "../editor/Editor";
import type { FileHandlers } from "../editor/fileDrop";
import type { LinkHandlers } from "../editor/livePreview";
import { dailyDateOf, longTitle } from "../lib/daily";
import { folderOf, noteTitle } from "../lib/format";
import { startsWithTitle } from "../lib/outline";
import { CloseIcon } from "./icons";

export interface BesideNote {
  path: string;
  content: string;
  modified: number;
  /** Bumped when the text is replaced from disk, so the editor starts over. */
  revision: number;
}

const STATUS: Record<SaveStatus, string> = { saved: "Saved", dirty: "Edited", saving: "Saving…", error: "Not saved" };

const SwapIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-[13px]" aria-hidden="true">
    <path d="M2.5 5.5h10l-2.5-2.5M13.5 10.5h-10l2.5 2.5" />
  </svg>
);

export default function BesidePane({
  note,
  mode,
  editorRef,
  links,
  getNotes,
  files,
  spellcheck,
  keepCrlf,
  status,
  onStatusChange,
  onSave,
  onSwap,
  onClose,
}: {
  note: BesideNote;
  mode: ViewMode;
  editorRef: Ref<EditorHandle>;
  links: LinkHandlers;
  getNotes: () => string[];
  files: FileHandlers;
  spellcheck?: boolean;
  keepCrlf?: boolean;
  status: SaveStatus;
  onStatusChange: (status: SaveStatus) => void;
  onSave: (content: string) => Promise<void>;
  onSwap: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(note.content);
  const folder = folderOf(note.path);
  const day = dailyDateOf(note.path);
  const title = day ? longTitle(day) : noteTitle(note.path);
  const showInlineTitle = mode === "preview" && !startsWithTitle(text);

  return (
    <section data-pane="beside" aria-label={`Beside: ${title}`} className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-rule">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full pt-10 pr-10 pb-[45vh] pl-[80px]" style={{ maxWidth: "calc(var(--column-width, 680px) + 120px)" }}>
          <div className="flex items-center justify-between gap-3 text-xs text-ink-3 select-none">
            <span className="truncate tracking-[0.1em] uppercase">Beside · {folder ? folder.split("/").join(" · ") : "Vault"}</span>
            <span className="-my-1.5 -mr-1.5 flex shrink-0 items-center gap-0.5">
              <span className="mr-1.5" aria-live="polite">
                {STATUS[status]}
              </span>
              <button
                type="button"
                onClick={onSwap}
                title="Swap the two notes"
                className="flex h-[26px] items-center gap-1.5 rounded-md px-2 text-ink-2 hover:bg-hover hover:text-ink"
              >
                <SwapIcon />
                Swap
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close the note beside"
                title="Close (Ctrl+\)"
                className="grid size-[26px] place-items-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"
              >
                <CloseIcon className="size-3" />
              </button>
            </span>
          </div>

          {showInlineTitle && (
            <h1
              className="mt-3.5 mb-5 text-[44px] leading-[1.12] font-medium tracking-[-0.015em] text-ink"
              style={{ fontFamily: "var(--writing-font, var(--font-serif))" }}
            >
              {title}
            </h1>
          )}
          <div className={showInlineTitle ? "" : "mt-3.5"}>
            <Editor
              key={`${note.path}#${note.revision}`}
              ref={editorRef}
              initialContent={note.content}
              mode={mode}
              changesBase={undefined}
              onSave={onSave}
              onStatusChange={onStatusChange}
              onTextChange={setText}
              links={links}
              getNotes={getNotes}
              files={files}
              spellcheck={spellcheck}
              keepCrlf={keepCrlf}
              autoFocus={false}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
