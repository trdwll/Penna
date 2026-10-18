/**
 * Side-by-side Changes (Source mode): extensions for the two editors of a
 * @codemirror/merge MergeView. The left editor is the note as it was
 * (read-only); the right one is the note itself.
 *
 * MergeView already aligns the sides, highlights changed words and folds
 * unchanged stretches. This adds Margin's look: line numbers colored by
 * change, a soft tint (no word highlight) for wholly added or removed lines,
 * and hatched filler opposite them.
 */
import { EditorState, RangeSetBuilder, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  drawSelection,
  gutter,
  highlightSpecialChars,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { getChunks } from "@codemirror/merge";
import { codeBlockLines } from "./codeBlocks";
import { baseTheme, sourceHighlight, sourceTheme } from "./theme";

/** "Show 4 unchanged lines" on the fold, as in the design. Used by both layouts. */
export const unchangedPhrase = EditorState.phrases.of({ "$ unchanged lines": "Show $ unchanged lines" });

const wholeLine = Decoration.line({ class: "cm-wholeChange" });

/** Which lines are changed on this side, and which belong to a change with nothing opposite. */
class SideChanges {
  changed = new Set<number>();
  deco: DecorationSet = Decoration.none;

  constructor(view: EditorView) {
    this.compute(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || getChunks(update.startState)?.chunks !== getChunks(update.state)?.chunks) this.compute(update.view);
  }

  compute(view: EditorView) {
    this.changed = new Set();
    const result = getChunks(view.state);
    const builder = new RangeSetBuilder<Decoration>();
    if (result) {
      const { doc } = view.state;
      const isA = result.side === "a";
      for (const chunk of result.chunks) {
        const from = isA ? chunk.fromA : chunk.fromB;
        const to = Math.min(isA ? chunk.toA : chunk.toB, doc.length + 1);
        const whole = isA ? chunk.toB === chunk.fromB : chunk.toA === chunk.fromA;
        for (let pos = from; pos < to && pos <= doc.length;) {
          const line = doc.lineAt(pos);
          this.changed.add(line.from);
          if (whole) builder.add(line.from, line.from, wholeLine);
          pos = line.to + 1;
        }
      }
    }
    this.deco = builder.finish();
  }
}

const sideChanges = ViewPlugin.fromClass(SideChanges, { decorations: (p) => p.deco });

class NumberMarker extends GutterMarker {
  constructor(
    readonly number: number,
    readonly changed: boolean,
  ) {
    super();
    if (changed) this.elementClass = "cm-changedLineNumber";
  }
  eq(other: NumberMarker) {
    return other.number === this.number && other.changed === this.changed;
  }
  toDOM() {
    return document.createTextNode(String(this.number));
  }
}

/** Line numbers, tinted on changed lines (removed on the left, added on the right). */
const numbers = gutter({
  class: "cm-lineNumbers",
  lineMarker(view, line) {
    const changed = view.plugin(sideChanges)?.changed.has(line.from) ?? false;
    return new NumberMarker(view.state.doc.lineAt(line.from).number, changed);
  },
  lineMarkerChange: (update) => update.docChanged || getChunks(update.startState)?.chunks !== getChunks(update.state)?.chunks,
  initialSpacer: (view) => new NumberMarker(view.state.doc.lines, false),
  updateSpacer: (_spacer, update) => new NumberMarker(update.view.state.doc.lines, false),
});

const splitTheme = EditorView.theme({
  ".cm-content": { fontSize: "13px", lineHeight: "1.75" },
  ".cm-line": { padding: "0 10px" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "34px", padding: "0 2px 0 0" },
  "&.cm-merge-b": { borderLeft: "1px solid var(--color-rule)" },

  // Old text on the left, in the "removed" colors; new text on the right, in the "added" ones.
  "&.cm-merge-a .cm-changedLine": { backgroundColor: "var(--color-del-soft) !important", color: "var(--color-ink-2)" },
  "&.cm-merge-a .cm-changedText": {
    background: "var(--color-del-strong) !important",
    color: "var(--color-ink)",
    textDecoration: "line-through",
    textDecorationColor: "var(--color-del)",
    borderRadius: "2px",
  },
  "&.cm-merge-b .cm-changedLine": { backgroundColor: "var(--color-accent-soft) !important" },
  "&.cm-merge-b .cm-changedText": { background: "var(--color-ins-strong) !important", borderRadius: "2px" },
  // A line added or removed whole keeps just the soft tint.
  ".cm-wholeChange .cm-changedText": { background: "none !important", textDecoration: "none", color: "inherit" },
  "del.cm-deletedLine, ins.cm-insertedLine": { textDecoration: "none", background: "none" },

  "&.cm-merge-a .cm-changedLineNumber": { color: "var(--color-del)" },
  "&.cm-merge-b .cm-changedLineNumber": { color: "var(--color-accent)" },

  // Filler opposite added or removed lines.
  ".cm-mergeSpacer": { background: "repeating-linear-gradient(135deg, transparent 0 7px, var(--color-rule) 7px 8px)" },
  // The fold spans both columns; its label shows once, on the left.
  ".cm-collapsedLines": { margin: "4px 0", cursor: "pointer" },
  "&.cm-merge-b .cm-collapsedLines": { color: "transparent !important" },
});

/** Shared by both sides of the side-by-side view. */
export const splitSide: Extension = [
  sideChanges,
  numbers,
  splitTheme,
  unchangedPhrase,
  EditorView.editorAttributes.of({ class: "cm-show-changes cm-split" }),
];

/** The left side: the note as it was, read-only, styled like Source. */
export const originalSide: Extension = [
  highlightSpecialChars(),
  drawSelection(),
  EditorView.lineWrapping,
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.contentAttributes.of({ "aria-label": "The note as it was" }),
  yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages }) }),
  codeBlockLines,
  baseTheme,
  sourceTheme,
  syntaxHighlighting(sourceHighlight),
  splitSide,
];
