/**
 * New note from a template (a name, then a template to start it), or insert
 * a template into the open note. With no templates yet, offers to make one.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { noteTitle } from "../lib/format";
import { defaultName, templateExcerpt } from "../lib/templates";
import { errorMessage } from "../services/tauri";
import { Dialog } from "./NoteDialogs";

function Heading({ children }: { children: ReactNode }) {
  return <h2 className="font-serif text-[22px] leading-tight font-medium tracking-[-0.01em] text-ink">{children}</h2>;
}

const where = (folder: string) => (folder ? `In ${folder.split("/").join(" · ")}.` : "At the top of the vault.");
const code = (text: string) => <span className="font-mono text-[12px] text-ink-2">{text}</span>;

export default function TemplateDialog({
  mode,
  templates,
  folderName,
  target,
  loadText,
  onCancel,
  onCreate,
  onInsert,
  onMakeTemplate,
}: {
  mode: "new" | "insert";
  /** Template note paths, in order. */
  templates: string[];
  /** The templates folder, as set in Settings. */
  folderName: string;
  /** "new": the folder the note goes in ("" = top). "insert": the open note's title. */
  target: string;
  loadText: (path: string) => Promise<string>;
  onCancel: () => void;
  /** Reject to show the error in the dialog. */
  onCreate: (name: string, template: string) => Promise<void>;
  onInsert: (template: string) => Promise<void>;
  onMakeTemplate: () => Promise<void>;
}) {
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const [name, setName] = useState(() => (templates[0] ? defaultName(templates[0]) : ""));
  const [touched, setTouched] = useState(false);
  const [excerpts, setExcerpts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const folder = folderName.trim().replace(/^[\\/]+|[\\/]+$/g, "");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? templates.filter((t) => noteTitle(t).toLowerCase().includes(q)) : templates;
  }, [templates, query]);
  const index = Math.min(active, shown.length - 1);
  const chosen = shown[index];

  useEffect(() => {
    let stale = false;
    for (const path of templates) {
      loadText(path).then(
        (text) => !stale && setExcerpts((e) => ({ ...e, [path]: templateExcerpt(text) })),
        () => {},
      );
    }
    return () => {
      stale = true;
    };
  }, [templates, loadText]);
  useEffect(() => input.current?.select(), []);
  // The name follows the chosen template until it's typed over.
  useEffect(() => {
    if (mode === "new" && !touched && chosen) setName(defaultName(chosen));
  }, [mode, touched, chosen]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  async function submit(template = chosen) {
    if (!template || busy) return;
    const clean = name.trim();
    if (mode === "new" && !clean) {
      setError("Give the note a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === "new") await onCreate(clean, template);
      else await onInsert(template);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = shown.length;
      if (n) setActive((n + index + (e.key === "ArrowDown" ? 1 : -1)) % n);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  }

  const title = mode === "new" ? "New note from a template" : "Insert a template";
  /** A template's name inside the folder: "Meeting", or "Work · Weekly review". */
  const label = (path: string) =>
    path
      .slice(folder.length + 1)
      .replace(/\.(md|markdown)$/i, "")
      .split("/")
      .join(" · ");

  if (!templates.length) {
    return (
      <Dialog label={title} onCancel={onCancel} width={460}>
        <div className="flex flex-col gap-2 px-6 pt-5 pb-5">
          <Heading>No templates yet</Heading>
          <p className="text-[13px] leading-relaxed text-ink-2">
            {folder ? (
              <>
                Notes in the <span className="text-ink">{folder}</span> folder are templates.
              </>
            ) : (
              "Choose a folder for templates in Settings → Templates."
            )}{" "}
            Their {code("{{title}}")}, {code("{{date}}")} and {code("{{cursor}}")} are filled in when you use one.
          </p>
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-rule px-5 py-3">
          <button type="button" onClick={onCancel} className="h-8 rounded-full px-4 text-[13px] text-ink-2 hover:bg-hover hover:text-ink">
            Cancel
          </button>
          {folder && (
            <button
              type="button"
              data-autofocus
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onMakeTemplate();
                } catch (err) {
                  setError(errorMessage(err));
                  setBusy(false);
                }
              }}
              className="h-8 rounded-full bg-ink px-4 text-[13px] font-medium text-bg hover:opacity-90 disabled:opacity-50"
            >
              Make a template
            </button>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog label={title} onCancel={onCancel} width={500}>
      <div className="flex flex-col gap-1 px-6 pt-5 pb-3">
        <Heading>{title}</Heading>
        <p className="text-[13px] text-ink-3">{mode === "new" ? where(target) : `Into “${target}”, where the cursor is.`}</p>
      </div>
      <div className="px-5 pb-2">
        <input
          ref={input}
          data-autofocus
          value={mode === "new" ? name : query}
          readOnly={busy}
          onChange={(e) => {
            setError(null);
            if (mode === "new") {
              setName(e.target.value);
              setTouched(true);
            } else {
              setQuery(e.target.value);
              setActive(0);
            }
          }}
          onKeyDown={onKeyDown}
          placeholder={mode === "new" ? "Name the note" : "Find a template"}
          aria-label={mode === "new" ? "Note name" : "Find a template"}
          role="combobox"
          aria-expanded="true"
          aria-controls="template-list"
          aria-activedescendant={chosen ? `template-${index}` : undefined}
          spellCheck={false}
          className="h-[34px] w-full rounded-lg border border-rule bg-bg px-2.5 text-ink outline-none placeholder:text-ink-3 focus:border-accent"
        />
      </div>
      <ul ref={listRef} id="template-list" role="listbox" aria-label="Templates" className="max-h-[288px] overflow-y-auto px-2 pb-2">
        {shown.map((path, i) => (
          <li
            key={path}
            id={`template-${i}`}
            data-index={i}
            role="option"
            aria-selected={i === index}
            onMouseMove={() => setActive(i)}
            onClick={() => setActive(i)}
            onDoubleClick={() => void submit(path)}
            className={`flex flex-col justify-center gap-0.5 rounded-md px-3 py-2 ${i === index ? "bg-hover" : ""}`}
          >
            <span className={`truncate text-[13px] ${i === index ? "text-ink" : "text-ink-2"}`}>{label(path)}</span>
            <span className="truncate text-xs text-ink-3">{excerpts[path] || " "}</span>
          </li>
        ))}
        {!shown.length && <li className="px-3 py-2 text-[13px] text-ink-3">No templates match.</li>}
      </ul>
      {error && (
        <p role="alert" className="border-t border-rule px-6 py-2.5 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-rule px-5 py-3">
        <span className="text-xs text-ink-3">↑↓ choose · Enter {mode === "new" ? "create" : "insert"}</span>
        <span className="flex shrink-0 gap-2 whitespace-nowrap">
          <button type="button" onClick={onCancel} className="h-8 rounded-full px-4 text-[13px] text-ink-2 hover:bg-hover hover:text-ink">
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !chosen || (mode === "new" && !name.trim())}
            onClick={() => void submit()}
            className="h-8 rounded-full bg-ink px-4 text-[13px] font-medium text-bg hover:opacity-90 disabled:opacity-50"
          >
            {mode === "new" ? "Create" : "Insert"}
          </button>
        </span>
      </div>
    </Dialog>
  );
}
