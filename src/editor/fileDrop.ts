/**
 * Adding files to a note: pasting an image, dropping files from Explorer,
 * or picking them from the "/" menu. The app copies the files into the
 * vault and hands back the Markdown that links them; this module puts that
 * Markdown in the right place and shows where a drop will land.
 */
import { EditorSelection, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

export interface FileHandlers {
  /** Store pasted file data in the vault; resolves to the Markdown that links it. */
  savePasted: (file: File) => Promise<string>;
  /** Let the person pick files to add; resolves to the Markdown that links them ("" when cancelled). */
  pickFiles: () => Promise<string>;
  /** Let the person choose a template; resolves to its filled-in text and where the cursor goes (null when cancelled). */
  pickTemplate?: () => Promise<{ text: string; cursor: number | null } | null>;
}

/**
 * Insert Markdown for new attachments at `pos`. Images go on their own
 * line (after the line at `pos` when it has text); links to other files go
 * right where the cursor or drop was.
 */
export function insertAttachments(view: EditorView, pos: number, markdown: string) {
  if (!markdown) return;
  const { state } = view;
  const lb = state.lineBreak;
  const text = markdown.replace(/\n/g, lb);
  let from = pos;
  let insert = text;
  // An image becomes its own paragraph: blank lines around it, unless they're already there.
  if (markdown.startsWith("!")) {
    const line = state.doc.lineAt(pos);
    const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
    if (line.text.trim()) {
      from = line.to;
      insert = lb + lb + text;
    } else {
      from = line.from;
      const prev = line.number > 1 ? state.doc.line(line.number - 1) : null;
      if (prev?.text.trim()) insert = lb + insert;
    }
    if (next?.text.trim()) insert += lb;
  }
  view.dispatch({
    changes: { from, to: from, insert },
    selection: EditorSelection.cursor(from + insert.length),
    scrollIntoView: true,
    userEvent: "input.drop",
  });
  view.focus();
}

/** Paste an image (a screenshot, a copied file): save it and link it instead of pasting nothing. */
export function pasteFiles(getHandlers: () => FileHandlers | undefined) {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const files = [...(event.clipboardData?.files ?? [])];
      const handlers = getHandlers();
      if (!files.length || !handlers) return false;
      event.preventDefault();
      const at = view.state.selection.main.from;
      void (async () => {
        const parts: string[] = [];
        for (const file of files) {
          try {
            parts.push(await handlers.savePasted(file));
          } catch {
            // the app shows the error; keep going with the rest
          }
        }
        insertAttachments(view, Math.min(at, view.state.doc.length), parts.join("\n"));
      })();
      return true;
    },
  });
}

// ---------------------------------------------------------------------------
// Where a drop will land
// ---------------------------------------------------------------------------

export const setDropCaret = StateEffect.define<number | null>();

class CaretWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-file-drop-caret";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
}

const caret = Decoration.widget({ widget: new CaretWidget(), side: 1 });

export const dropCaret = [
  StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(setDropCaret)) return e.value === null ? Decoration.none : Decoration.set([caret.range(e.value)]);
      }
      return tr.docChanged ? value.map(tr.changes) : value;
    },
    provide: (f) => EditorView.decorations.from(f),
  }),
  EditorView.theme({
    ".cm-file-drop-caret": {
      display: "inline-block",
      width: "0",
      height: "1.2em",
      marginRight: "-2px",
      borderLeft: "2px solid var(--color-accent)",
      verticalAlign: "text-bottom",
      pointerEvents: "none",
    },
  }),
];
