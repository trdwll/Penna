/**
 * Markdown-aware formatting commands for the toolbar and shortcuts.
 *
 * They edit the Markdown text (adding or removing `**`, `#`, `>`, …), never a
 * separate rich-text model, so the file stays exactly what you'd type by hand.
 * Toggling uses the syntax tree, so un-bolding `**word**` removes the right
 * markers even when the selection sits inside them.
 */
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

type InlineKind = "bold" | "italic" | "strike" | "code" | "highlight";

const INLINE: Record<InlineKind, { node: string; mark: string; marker: string }> = {
  bold: { node: "StrongEmphasis", mark: "EmphasisMark", marker: "**" },
  italic: { node: "Emphasis", mark: "EmphasisMark", marker: "*" },
  strike: { node: "Strikethrough", mark: "StrikethroughMark", marker: "~~" },
  code: { node: "InlineCode", mark: "CodeMark", marker: "`" },
  highlight: { node: "Highlight", mark: "HighlightMark", marker: "==" },
};

/** The innermost `name` node that covers [from, to]. */
function enclosing(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(from, 1); n; n = n.parent) {
    if (n.name === name && n.from <= from && n.to >= to) return n;
  }
  return null;
}

export function isInlineActive(state: EditorState, kind: InlineKind): boolean {
  const { from, to } = state.selection.main;
  return enclosing(state, from, to, INLINE[kind].node) !== null;
}

/** Wrap the selection in a marker, or remove it when the selection is already inside one. */
export function toggleInline(view: EditorView, kind: InlineKind): boolean {
  const { node: nodeName, mark, marker } = INLINE[kind];
  const { state } = view;
  const spec = state.changeByRange((range) => {
    const node = enclosing(state, range.from, range.to, nodeName);
    if (node) {
      const marks = node.getChildren(mark);
      if (marks.length >= 2) {
        const open = marks[0];
        const close = marks[marks.length - 1];
        const openLen = open.to - open.from;
        return {
          changes: [
            { from: open.from, to: open.to },
            { from: close.from, to: close.to },
          ],
          range: EditorSelection.range(
            Math.max(open.from, range.from - openLen),
            Math.max(open.from, Math.min(range.to, close.from) - openLen),
          ),
        };
      }
    }
    return {
      changes: [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ],
      range: EditorSelection.range(range.from + marker.length, range.to + marker.length),
    };
  });
  view.dispatch(state.update(spec, { scrollIntoView: true, userEvent: "input.format" }));
  view.focus();
  return true;
}

export type BlockKind = "paragraph" | "h1" | "h2" | "h3" | "quote";

const BLOCK_PREFIX: Record<BlockKind, string> = { paragraph: "", h1: "# ", h2: "## ", h3: "### ", quote: "> " };
const BLOCK_MARKER = /^(\s*)(#{1,6}\s+|>\s?)?/;

export function currentBlock(state: EditorState): BlockKind {
  const line = state.doc.lineAt(state.selection.main.from).text;
  const h = /^\s*(#{1,6})\s/.exec(line);
  if (h) return h[1].length === 1 ? "h1" : h[1].length === 2 ? "h2" : "h3";
  if (/^\s*>/.test(line)) return "quote";
  return "paragraph";
}

/** Turn every line the selection touches into a paragraph, heading or quote. */
export function setBlock(view: EditorView, kind: BlockKind): boolean {
  const { state } = view;
  const changes: TransactionSpec["changes"] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to;) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        const match = BLOCK_MARKER.exec(line.text)!;
        const indent = match[1].length;
        const existing = match[2]?.length ?? 0;
        (changes as { from: number; to: number; insert: string }[]).push({
          from: line.from + indent,
          to: line.from + indent + existing,
          insert: BLOCK_PREFIX[kind],
        });
      }
      pos = line.to + 1;
    }
  }
  view.dispatch({ changes, scrollIntoView: true, userEvent: "input.format" });
  view.focus();
  return true;
}

/** `[selection](https://)` with the URL selected, ready to paste over. */
export function insertLink(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const url = "https://";
  view.dispatch({
    changes: [
      { from: range.from, insert: "[" },
      { from: range.to, insert: `](${url})` },
    ],
    selection: EditorSelection.range(range.to + 3, range.to + 3 + url.length),
    scrollIntoView: true,
    userEvent: "input.format",
  });
  view.focus();
  return true;
}

/** `[[selection]]`: the selected text becomes the linked note's name. */
export function insertWikiLink(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  view.dispatch({
    changes: [
      { from: range.from, insert: "[[" },
      { from: range.to, insert: "]]" },
    ],
    selection: EditorSelection.range(range.from + 2, range.to + 2),
    userEvent: "input.format",
  });
  view.focus();
  return true;
}

export const formatKeymap = [
  { key: "Mod-b", run: (v: EditorView) => toggleInline(v, "bold") },
  { key: "Mod-i", run: (v: EditorView) => toggleInline(v, "italic") },
  { key: "Mod-Shift-x", run: (v: EditorView) => toggleInline(v, "strike") },
  { key: "Mod-`", run: (v: EditorView) => toggleInline(v, "code") },
  { key: "Mod-Shift-h", run: (v: EditorView) => toggleInline(v, "highlight") },
];
