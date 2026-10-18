/**
 * Inserting blocks and links:
 *
 * - "/" at the start of a line opens the insert menu (headings, lists, table,
 *   code block, …). Each item shows its Markdown shortcut, so people pick up
 *   the syntax as they go.
 * - "[[" suggests notes from the vault.
 * - In Preview, a "+" button hangs in the margin beside the current line and
 *   opens the same menu.
 *
 * Built on @codemirror/autocomplete, which handles keyboard navigation.
 */
import { autocompletion, startCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import { insertAttachments } from "./fileDrop";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

interface InsertCompletion extends Completion {
  glyph: string;
  /** A plain-language hint shown instead of a Markdown shortcut. */
  note?: string;
}

type Apply = (view: EditorView, completion: Completion, from: number, to: number) => void;

/** Replace the typed "/query" (which starts one character before `from`) with `text`, cursor at `cursor`. */
function replaceSlash(build: (lb: string) => { text: string; cursor: number; select?: number }): Apply {
  return (view, _completion, from, to) => {
    const { text, cursor, select } = build(view.state.lineBreak);
    const start = from - 1;
    view.dispatch({
      changes: { from: start, to, insert: text },
      selection: EditorSelection.range(start + cursor, start + (select ?? cursor)),
      userEvent: "input.complete",
    });
  };
}

const prefix = (p: string) => replaceSlash(() => ({ text: p, cursor: p.length }));

const TEXT = { name: "Text", rank: 0 };
const INSERT = { name: "Insert", rank: 1 };

/** Asks the app for files; resolves to their Markdown ("" when cancelled). Set by `insertCompletions`. */
let pickFiles: () => Promise<string> = () => Promise.resolve("");
/** Asks the app for a template; resolves to its text (null when cancelled). Set by `insertCompletions`. */
let pickTemplate: () => Promise<{ text: string; cursor: number | null } | null> = () => Promise.resolve(null);

/** Put `text` in place of `from`–`to`, with the cursor at `cursor` within it (or after it). */
export function insertSnippet(view: EditorView, from: number, to: number, text: string, cursor: number | null) {
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + (cursor ?? text.length)),
    scrollIntoView: true,
    userEvent: "input",
  });
  view.focus();
}

const SLASH_ITEMS: InsertCompletion[] = [
  { label: "Heading", glyph: "H2", detail: "##", section: TEXT, apply: prefix("## ") },
  { label: "Subheading", glyph: "H3", detail: "###", section: TEXT, apply: prefix("### ") },
  { label: "Bulleted list", glyph: "•", detail: "-", section: TEXT, apply: prefix("- ") },
  { label: "Numbered list", glyph: "1.", detail: "1.", section: TEXT, apply: prefix("1. ") },
  { label: "Checklist", glyph: "☐", detail: "- [ ]", section: TEXT, apply: prefix("- [ ] ") },
  { label: "Quote", glyph: "“", detail: ">", section: TEXT, apply: prefix("> ") },
  {
    label: "Table",
    glyph: "▦",
    detail: "| a | b |",
    section: INSERT,
    apply: replaceSlash((lb) => ({
      text: `| Column | Column |${lb}| --- | --- |${lb}|  |  |`,
      cursor: 2,
      select: 8,
    })),
  },
  {
    label: "Code block",
    glyph: "{ }",
    detail: "```",
    section: INSERT,
    apply: replaceSlash((lb) => ({ text: `\`\`\`${lb}${lb}\`\`\``, cursor: 3 + lb.length })),
  },
  {
    label: "Link to a note",
    glyph: "[[",
    detail: "[[",
    section: INSERT,
    apply: (view, completion, from, to) => {
      replaceSlash(() => ({ text: "[[]]", cursor: 2 }))(view, completion, from, to);
      // Follow straight on with the note suggestions.
      setTimeout(() => startCompletion(view));
    },
  },
  {
    label: "Image or file",
    glyph: "▣",
    note: "or drop it in",
    section: INSERT,
    apply: (view, completion, from, to) => {
      replaceSlash(() => ({ text: "", cursor: 0 }))(view, completion, from, to);
      const at = from - 1;
      void pickFiles().then((markdown) => insertAttachments(view, Math.min(at, view.state.doc.length), markdown));
    },
  },
  {
    label: "Template",
    glyph: "❏",
    note: "from your templates",
    section: INSERT,
    apply: (view, completion, from, to) => {
      replaceSlash(() => ({ text: "", cursor: 0 }))(view, completion, from, to);
      const at = from - 1;
      void pickTemplate().then((t) => {
        const pos = Math.min(at, view.state.doc.length);
        if (t) insertSnippet(view, pos, pos, t.text, t.cursor);
      });
    },
  },
  {
    label: "Divider",
    glyph: "—",
    detail: "---",
    section: INSERT,
    apply: replaceSlash((lb) => ({ text: `---${lb}`, cursor: 3 + lb.length })),
  },
  {
    label: "Time",
    glyph: "◷",
    detail: "hh:mm",
    section: INSERT,
    apply: replaceSlash(() => {
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")} `;
      return { text: time, cursor: time.length };
    }),
  },
];

function slashSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const match = /^(\s*)\/([\w-]*)$/.exec(before);
  if (!match) return null;
  return {
    from: line.from + match[1].length + 1, // just after the "/"
    options: SLASH_ITEMS,
    validFor: /^[\w-]*$/,
  };
}

/** `[[` → note names. `getNotes` returns vault-relative note paths. */
function wikiSource(getNotes: () => string[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\[\[[^[\]\n|#]*$/);
    if (!match) return null;
    const from = match.from + 2;
    const closes = context.state.sliceDoc(context.pos, context.pos + 2) === "]]";
    const options: Completion[] = getNotes().map((path) => {
      const name =
        path
          .replace(/\.(md|markdown)$/i, "")
          .split("/")
          .pop() ?? path;
      const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      return {
        label: name,
        detail: folder,
        apply: (view, _c, f, t) => {
          const insert = closes ? name : `${name}]]`;
          view.dispatch({
            changes: { from: f, to: t, insert },
            selection: EditorSelection.cursor(f + name.length + 2),
            userEvent: "input.complete",
          });
        },
      };
    });
    return { from, options, validFor: /^[^[\]\n|#]*$/ };
  };
}

function noteRender(completion: Completion): Node | null {
  const note = (completion as InsertCompletion).note;
  if (!note) return null;
  const el = document.createElement("span");
  el.className = "cm-insert-note";
  el.textContent = note;
  return el;
}

function glyphRender(completion: Completion): Node | null {
  const glyph = (completion as InsertCompletion).glyph;
  if (!glyph) return null;
  const el = document.createElement("span");
  el.className = "cm-insert-glyph";
  el.setAttribute("aria-hidden", "true");
  el.textContent = glyph;
  return el;
}

/** Keep the insert menu in its designed order (headings first) instead of alphabetical. */
const SLASH_ORDER = new Map(SLASH_ITEMS.map((item, i) => [item.label, i]));

function compareCompletions(a: Completion, b: Completion): number {
  const ia = SLASH_ORDER.get(a.label);
  const ib = SLASH_ORDER.get(b.label);
  if (ia !== undefined && ib !== undefined) return ia - ib;
  return a.label.localeCompare(b.label);
}

export function insertCompletions(
  getNotes: () => string[],
  pick: () => Promise<string>,
  template: () => Promise<{ text: string; cursor: number | null } | null>,
) {
  pickFiles = pick;
  pickTemplate = template;
  return [
    autocompletion({
      override: [slashSource, wikiSource(getNotes)],
      compareCompletions,
      icons: false,
      addToOptions: [
        { render: glyphRender, position: 20 },
        { render: noteRender, position: 90 },
      ],
      closeOnBlur: true,
      maxRenderedOptions: 60,
    }),
    insertMenuTheme,
  ];
}

// ---------------------------------------------------------------------------
// "+" in the margin (Preview)
// ---------------------------------------------------------------------------

class AddBlockWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM(view: EditorView) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-add-block";
    b.setAttribute("aria-label", "Insert a block");
    b.title = "Insert a block (or type / on an empty line)";
    b.textContent = "+";
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const empty = line.text.trim() === "";
      const insert = empty ? "/" : `${view.state.lineBreak}/`;
      const at = empty ? line.from : line.to;
      view.dispatch({
        changes: { from: at, to: empty ? line.to : at, insert },
        selection: EditorSelection.cursor(at + insert.length),
        userEvent: "input",
      });
      view.focus();
      startCompletion(view);
    });
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

const addBlock = Decoration.widget({ widget: new AddBlockWidget(), side: -1 });

export const addBlockHandle = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      const range = view.state.selection.main;
      if (!view.hasFocus || !range.empty) return Decoration.none;
      const line = view.state.doc.lineAt(range.head);
      return Decoration.set([addBlock.range(line.from)]);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const insertMenuTheme = EditorView.theme({
  ".cm-add-block": {
    position: "absolute",
    right: "100%",
    top: "calc((var(--writing-size, 19px) * 1.62 - 24px) / 2)",
    marginRight: "32px", // the block grip sits between it and the text
    width: "24px",
    height: "24px",
    padding: "0",
    border: "none",
    borderRadius: "6px",
    background: "transparent",
    color: "var(--color-ink-3)",
    fontFamily: "var(--font-sans)",
    fontSize: "18px",
    lineHeight: "24px",
    textIndent: "0",
    cursor: "default",
  },
  ".cm-add-block:hover": { background: "var(--color-hover)", color: "var(--color-ink)" },
  ".cm-h1 .cm-add-block": { top: "calc((var(--writing-size, 19px) * 2.6 - 24px) / 2)" },
  ".cm-h2 .cm-add-block": { top: "calc((var(--writing-size, 19px) * 1.85 - 24px) / 2)" },

  ".cm-tooltip.cm-tooltip-autocomplete": {
    border: "1px solid var(--color-rule)",
    borderRadius: "10px",
    background: "var(--color-bg)",
    boxShadow: "0 12px 36px rgb(0 0 0 / 0.14)",
    padding: "6px",
    fontFamily: "var(--font-sans)",
    fontSize: "14px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { maxHeight: "22em", minWidth: "300px", fontFamily: "var(--font-sans)" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    height: "34px",
    padding: "0 8px !important",
    borderRadius: "6px",
    color: "var(--color-ink)",
    lineHeight: "1.2",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--color-hover)",
    color: "var(--color-ink)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > completion-section": {
    display: "block",
    padding: "10px 8px 6px",
    border: "none",
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--color-ink-3)",
  },
  ".cm-insert-glyph": {
    width: "26px",
    height: "26px",
    flexShrink: "0",
    display: "grid",
    placeItems: "center",
    border: "1px solid var(--color-rule)",
    borderRadius: "5px",
    fontFamily: "var(--font-serif)",
    fontSize: "13px",
    color: "var(--color-ink-2)",
  },
  ".cm-completionLabel": { flex: "1" },
  ".cm-insert-note": { marginLeft: "auto", fontSize: "12px", color: "var(--color-ink-3)" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "600" },
  ".cm-completionDetail": {
    marginLeft: "auto",
    fontStyle: "normal",
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    color: "var(--color-ink-3)",
  },
});
