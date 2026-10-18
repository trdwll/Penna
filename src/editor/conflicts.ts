/**
 * Choosing between two versions after a sync conflict.
 *
 * The note holds Git's conflict markers (see lib/conflicts.ts). Preview shows
 * each block as a card with both versions, the words that differ highlighted,
 * and Keep this / Keep both / Edit them together. Source shows the marked
 * lines as they are, tinted, with the same choices above them. A choice
 * replaces the block with the chosen text in one undoable step and leaves a
 * quiet "Kept … · Undo" line until the text there is edited.
 */
import { presentableDiff } from "@codemirror/merge";
import { EditorSelection, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { findConflicts, keepBoth, placeName, type ConflictBlock } from "../lib/conflicts";

/** How the two sides are introduced: "This PC · 09:41", "Laptop · 09:52". */
export interface ConflictLabels {
  ours: string;
  theirs: string;
  /** The other device's name, for "Keep Laptop's". */
  theirsName: string;
}

export interface ConflictsInfo {
  /** Places still holding both versions. */
  open: { pos: number; place: string }[];
  /** Places chosen in this session (until edited). */
  kept: { pos: number; place: string; label: string }[];
  /** Index into `open` of the place at or after the cursor. */
  current: number;
}

export const setConflictLabels = StateEffect.define<ConflictLabels | null>();

const labelsField = StateField.define<ConflictLabels | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setConflictLabels)) return e.value;
    return value;
  },
});

/** The conflict blocks in the note, found again whenever the text changes. */
const conflictsField = StateField.define<ConflictBlock[]>({
  create: (state) => findConflicts(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? findConflicts(tr.state.doc.toString()) : value),
});

interface Kept {
  from: number;
  to: number;
  /** The whole conflict block, markers and all, for Undo. */
  original: string;
  label: string;
  place: string;
}

const addKept = StateEffect.define<Kept>();

const keptField = StateField.define<Kept[]>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      next = [];
      for (const k of value) {
        let touched = false;
        tr.changes.iterChangedRanges((fromA, toA) => {
          if (fromA < k.to && toA > k.from) touched = true;
        });
        if (touched) continue; // edited since the choice: it's just text now
        next.push({ ...k, from: tr.changes.mapPos(k.from, 1), to: tr.changes.mapPos(k.to, -1) });
      }
    }
    for (const e of tr.effects) if (e.is(addKept)) next = [...next, e.value];
    return next;
  },
});

function labelsOf(state: EditorState, block?: ConflictBlock): ConflictLabels {
  const set = state.field(labelsField, false);
  if (set) return set;
  const theirs = block?.theirsLabel || "the other device";
  return { ours: "This PC", theirs, theirsName: theirs };
}

export function conflictsInfo(state: EditorState): ConflictsInfo | null {
  const blocks = state.field(conflictsField, false);
  const kept = state.field(keptField, false);
  if (!blocks || !kept || (!blocks.length && !kept.length)) return null;
  const text = state.doc.toString();
  const head = state.selection.main.head;
  const current = blocks.findIndex((b) => b.to >= head);
  return {
    open: blocks.map((b) => ({ pos: b.from, place: placeName(text, b.from) })),
    kept: kept.map((k) => ({ pos: k.from, place: k.place, label: k.label })),
    current: current < 0 ? Math.max(0, blocks.length - 1) : current,
  };
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

type Choice = "ours" | "theirs" | "both";

/** The block that starts at (or contains) `pos`. */
function blockAt(state: EditorState, pos: number): ConflictBlock | undefined {
  return state.field(conflictsField).find((b) => pos >= b.from && pos <= b.to);
}

export function choose(view: EditorView, pos: number, choice: Choice, select = false): boolean {
  const { state } = view;
  const block = blockAt(state, pos);
  if (!block) return false;
  const labels = labelsOf(state, block);
  const text = choice === "ours" ? block.ours : choice === "theirs" ? block.theirs : keepBoth(block.ours, block.theirs);
  // Choosing a side that removed the lines takes their line break with them.
  const to = !text && block.to < state.doc.length ? block.to + 1 : block.to;
  const label =
    choice === "ours"
      ? "Kept this PC’s version"
      : choice === "theirs"
        ? `Kept ${labels.theirsName}’s version`
        : select
          ? "Kept both. Edit them into one"
          : "Kept both, this PC’s first";
  view.dispatch({
    changes: { from: block.from, to, insert: text },
    selection: select ? EditorSelection.range(block.from, block.from + text.length) : EditorSelection.cursor(block.from),
    effects: addKept.of({
      from: block.from,
      to: block.from + text.length,
      original: state.doc.sliceString(block.from, to),
      label,
      place: placeName(state.doc.toString(), block.from),
    }),
    scrollIntoView: true,
    userEvent: "input.conflict",
  });
  view.focus();
  return true;
}

function undoChoice(view: EditorView, from: number) {
  const kept = view.state.field(keptField).find((k) => k.from === from);
  if (!kept) return;
  view.dispatch({
    changes: { from: kept.from, to: kept.to, insert: kept.original },
    selection: EditorSelection.cursor(kept.from),
    scrollIntoView: true,
    userEvent: "input.conflict",
  });
  view.focus();
}

/** Alt+↓ / Alt+↑ when there are no Changes to step through. */
export function moveToConflict(view: EditorView, dir: 1 | -1): boolean {
  const blocks = view.state.field(conflictsField, false);
  if (!blocks?.length) return false;
  const head = view.state.selection.main.head;
  const target =
    dir > 0
      ? (blocks.find((b) => b.from > head) ?? blocks[0])
      : ([...blocks].reverse().find((b) => b.to < head) ?? blocks[blocks.length - 1]);
  view.dispatch({
    selection: EditorSelection.cursor(target.from),
    effects: EditorView.scrollIntoView(target.from, { y: "center" }),
  });
  view.focus();
  return true;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(label: string, className: string, run: () => void): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    run();
  });
  return b;
}

/** Markdown marks shown faint, so both versions read as text but stay exact. */
const SYNTAX = /^\s*(?:#{1,6}\s|>\s?|(?:[-*+]|\d+[.)])\s(?:\[[ xX]\]\s)?)|\*\*|__|~~|==|`|\[\[|\]\]|\]\([^)\s]*\)|!?\[(?=[^\]]*\]\()/g;

/** One version's text, with the ranges in `marks` highlighted. */
function renderVersion(text: string, marks: [number, number][], emptyNote: string): HTMLElement {
  const box = el("div", "cm-conflict-text");
  if (!text.trim()) {
    box.appendChild(el("span", "cm-conflict-empty", emptyNote));
    return box;
  }
  let offset = 0;
  for (const line of text.split("\n")) {
    const row = el("div", "cm-conflict-line");
    const flags = Array.from({ length: line.length }, () => 0);
    for (const m of line.matchAll(SYNTAX)) for (let i = m.index; i < m.index + m[0].length; i++) flags[i] |= 1;
    for (const [from, to] of marks) {
      for (let i = Math.max(from - offset, 0); i < Math.min(to - offset, line.length); i++) flags[i] |= 2;
    }
    let start = 0;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && flags[i] === flags[start]) continue;
      const cls = [flags[start] & 1 ? "cm-conflict-syntax" : "", flags[start] & 2 ? "cm-conflict-diff" : ""].filter(Boolean).join(" ");
      row.appendChild(el("span", cls || undefined, line.slice(start, i)));
      start = i;
    }
    if (!line) row.appendChild(document.createElement("br"));
    box.appendChild(row);
    offset += line.length + 1;
  }
  return box;
}

const hangingMark = (glyph: string, className: string, title: string) => {
  const mark = el("span", `cm-conflict-hang ${className}`, glyph);
  mark.setAttribute("aria-hidden", "true");
  mark.title = title;
  return mark;
};

/** Preview: both versions side by side, one above the other, with the choices. */
class ConflictCard extends WidgetType {
  constructor(
    readonly block: ConflictBlock,
    readonly labels: ConflictLabels,
  ) {
    super();
  }
  eq(other: ConflictCard) {
    return (
      other.block.ours === this.block.ours &&
      other.block.theirs === this.block.theirs &&
      other.labels.ours === this.labels.ours &&
      other.labels.theirs === this.labels.theirs
    );
  }
  toDOM(view: EditorView) {
    const { ours, theirs } = this.block;
    const card = el("div", "cm-conflict");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", "Changed on both devices");
    card.appendChild(hangingMark("≠", "cm-conflict-open", "Changed on both devices"));
    // Positions are looked up at click time; the block may have moved since this was drawn.
    const run =
      (choice: Choice, select = false) =>
      () =>
        choose(view, view.posAtDOM(card), choice, select);

    const oursMarks: [number, number][] = [];
    const theirsMarks: [number, number][] = [];
    for (const c of presentableDiff(ours, theirs)) {
      if (c.toA > c.fromA) oursMarks.push([c.fromA, c.toA]);
      if (c.toB > c.fromB) theirsMarks.push([c.fromB, c.toB]);
    }

    const side = (label: string, text: string, marks: [number, number][], choice: Choice, empty: string) => {
      const wrap = el("div", "cm-conflict-side");
      const head = el("div", "cm-conflict-head");
      const who = el("span");
      const [name, ...rest] = label.split(" · ");
      who.appendChild(el("strong", undefined, name));
      if (rest.length) who.appendChild(document.createTextNode(` · ${rest.join(" · ")}`));
      head.append(who, actionButton("Keep this", "cm-conflict-keep", run(choice)));
      wrap.append(head, renderVersion(text, marks, empty));
      return wrap;
    };
    card.append(
      side(this.labels.ours, ours, oursMarks, "ours", "Deleted on this PC"),
      el("div", "cm-conflict-rule"),
      side(this.labels.theirs, theirs, theirsMarks, "theirs", `Deleted on ${this.labels.theirsName}`),
    );

    const foot = el("div", "cm-conflict-foot");
    foot.append(
      actionButton("Keep both", "cm-conflict-link", run("both")),
      actionButton("Edit them together", "cm-conflict-link cm-conflict-quiet", run("both", true)),
      el("span", "cm-conflict-spacer"),
      el("span", "cm-conflict-hint", "Words that differ are highlighted"),
    );
    card.appendChild(foot);
    return card;
  }
  ignoreEvent() {
    return true;
  }
}

/** Source: the choices above the marked lines. */
class SourceActions extends WidgetType {
  constructor(readonly labels: ConflictLabels) {
    super();
  }
  eq(other: SourceActions) {
    return other.labels.theirsName === this.labels.theirsName;
  }
  toDOM(view: EditorView) {
    const row = el("div", "cm-conflict-actions");
    const run = (choice: Choice) => () => {
      // The block starts on the line right after this widget.
      const pos = view.posAtDOM(row);
      choose(view, pos, choice);
    };
    row.append(
      actionButton("Keep this PC’s", "cm-conflict-link", run("ours")),
      actionButton(`Keep ${this.labels.theirsName}’s`, "cm-conflict-link", run("theirs")),
      actionButton("Keep both", "cm-conflict-link", run("both")),
      el("span", "cm-conflict-hint", "or edit the lines and delete the markers"),
    );
    return row;
  }
  ignoreEvent() {
    return true;
  }
}

class KeptNote extends WidgetType {
  constructor(
    readonly from: number,
    readonly label: string,
  ) {
    super();
  }
  eq(other: KeptNote) {
    return other.label === this.label && other.from === this.from;
  }
  toDOM(view: EditorView) {
    const note = el("div", "cm-conflict-kept", this.label);
    note.appendChild(actionButton("Undo", "cm-conflict-link", () => undoChoice(view, this.from)));
    return note;
  }
  ignoreEvent() {
    return true;
  }
}

class KeptMark extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return hangingMark("✓", "cm-conflict-done", "Chosen");
  }
}

class OpenMark extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    return hangingMark("≠", "cm-conflict-open", "Changed on both devices");
  }
}

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

function keptDecorations(state: EditorState, out: Range<Decoration>[]) {
  for (const k of state.field(keptField)) {
    const end = state.doc.lineAt(k.to).to;
    out.push(Decoration.widget({ widget: new KeptNote(k.from, k.label), block: true, side: 1 }).range(end));
    if (k.to > k.from) out.push(Decoration.widget({ widget: new KeptMark(), side: -1 }).range(state.doc.lineAt(k.from).from));
  }
}

const previewDecorations = EditorView.decorations.compute([conflictsField, keptField, labelsField], (state) => {
  const out: Range<Decoration>[] = [];
  for (const block of state.field(conflictsField)) {
    out.push(Decoration.replace({ widget: new ConflictCard(block, labelsOf(state, block)), block: true }).range(block.from, block.to));
  }
  keptDecorations(state, out);
  return Decoration.set(out, true);
});

const markerLine = Decoration.line({ class: "cm-conflict-marker" });
const versionLine = Decoration.line({ class: "cm-conflict-version" });

const sourceDecorations = EditorView.decorations.compute([conflictsField, keptField, labelsField], (state) => {
  const out: Range<Decoration>[] = [];
  for (const block of state.field(conflictsField)) {
    out.push(Decoration.widget({ widget: new SourceActions(labelsOf(state, block)), block: true, side: -1 }).range(block.from));
    out.push(Decoration.widget({ widget: new OpenMark(), side: -1 }).range(block.from));
    for (let pos = block.from; pos <= block.to;) {
      const line = state.doc.lineAt(pos);
      const marker = /^(<{7}|={7}|\|{7}|>{7})/.test(line.text);
      out.push((marker ? markerLine : versionLine).range(line.from));
      pos = line.to + 1;
    }
  }
  keptDecorations(state, out);
  return Decoration.set(out, true);
});

const conflictTheme = EditorView.theme({
  ".cm-conflict": {
    position: "relative",
    margin: "4px 0 6px",
    border: "1px solid var(--color-rule)",
    borderRadius: "10px",
    background: "var(--color-bg)",
    boxShadow: "0 0 0 3px var(--color-del-soft)",
  },
  ".cm-conflict-side": { padding: "10px 16px 14px" },
  ".cm-conflict-head": {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    marginBottom: "4px",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    lineHeight: "1.4",
    color: "var(--color-ink-3)",
  },
  ".cm-conflict-head strong": { fontWeight: "600", color: "var(--color-ink-2)" },
  ".cm-conflict-keep": {
    height: "26px",
    padding: "0 12px",
    border: "1px solid var(--color-rule)",
    borderRadius: "999px",
    background: "var(--color-bg)",
    color: "var(--color-ink)",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    fontWeight: "500",
    cursor: "default",
  },
  ".cm-conflict-keep:hover": { borderColor: "var(--color-ink-3)" },
  ".cm-conflict-text": { whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  ".cm-conflict-syntax": { color: "var(--color-faint)" },
  ".cm-conflict-diff": { borderRadius: "3px", background: "var(--color-ins-strong)" },
  ".cm-conflict-empty": { fontFamily: "var(--font-sans)", fontSize: "13px", fontStyle: "italic", color: "var(--color-ink-3)" },
  ".cm-conflict-rule": { height: "1px", background: "var(--color-rule)" },
  ".cm-conflict-foot": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "4px 14px",
    padding: "7px 10px 7px 12px",
    borderTop: "1px solid var(--color-rule)",
    borderRadius: "0 0 10px 10px",
    background: "var(--color-hover)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    lineHeight: "1.4",
  },
  ".cm-conflict-link": {
    height: "28px",
    padding: "0 6px",
    border: "none",
    borderRadius: "6px",
    background: "transparent",
    color: "var(--color-accent)",
    font: "inherit",
    fontWeight: "500",
    cursor: "default",
  },
  ".cm-conflict-link:hover": { background: "var(--color-hover)" },
  ".cm-conflict-quiet": { color: "var(--color-ink-2)", fontWeight: "400" },
  ".cm-conflict-spacer": { flex: "1" },
  ".cm-conflict-hint": { fontSize: "12px", color: "var(--color-ink-3)" },
  ".cm-conflict-hang": {
    position: "absolute",
    right: "100%",
    marginRight: "16px",
    fontFamily: "var(--font-mono)",
    fontSize: "14px",
    lineHeight: "1",
    textIndent: "0",
  },
  ".cm-conflict > .cm-conflict-hang": { top: "12px" },
  ".cm-line > .cm-conflict-hang": { top: "calc((1lh - 14px) / 2)" },
  // The line being edited has the "+" and the grip in the margin instead.
  ".cm-line:has(.cm-add-block) > .cm-conflict-hang": { display: "none" },
  ".cm-conflict-open": { color: "var(--color-del)" },
  ".cm-conflict-done": { color: "var(--color-ok)" },
  ".cm-conflict-kept": {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    margin: "0 0 4px",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    lineHeight: "1.6",
    color: "var(--color-ink-3)",
  },
  ".cm-conflict-kept .cm-conflict-link": { height: "22px", fontSize: "12px" },
  // Source
  ".cm-conflict-actions": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0 8px",
    padding: "2px 0",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    lineHeight: "1.6",
  },
  ".cm-conflict-actions .cm-conflict-link": { height: "24px", padding: "0 4px", fontSize: "12px" },
  ".cm-conflict-marker": { background: "var(--color-hover)", color: "var(--color-ink-3)" },
  ".cm-conflict-version": { background: "var(--color-accent-soft)" },
});

/** The note's conflict state; lives outside the mode so choices survive switching Preview / Source. */
export const conflictState: Extension = [labelsField, conflictsField, keptField];

/** The conflict display for one mode. */
export function conflictView(mode: "preview" | "source"): Extension {
  return [mode === "preview" ? previewDecorations : sourceDecorations, conflictTheme];
}
