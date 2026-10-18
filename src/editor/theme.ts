/**
 * Margin's CodeMirror look. Colors and fonts are CSS variables from
 * index.css, so the editor follows light/dark mode without JS.
 *
 * The editor grows with its content (no inner scrollbar); the page column
 * around it scrolls, so the title, eyebrow and text move together like a
 * document.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { highlightTag } from "./highlight";

const MARK_FONT = "var(--font-mono)";

/** Shared by both modes. */
export const baseTheme = EditorView.theme({
  "&": { height: "auto", backgroundColor: "transparent", color: "var(--color-ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "visible", fontFamily: "inherit", lineHeight: "inherit" },
  ".cm-content": { padding: "0", caretColor: "var(--color-accent)" },
  ".cm-line": { padding: "0", position: "relative" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--color-selection)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--color-accent-soft)" },
  ".cm-searchMatch": { backgroundColor: "var(--color-ins-strong)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": { outline: "1px solid var(--color-accent)" },
  ".cm-placeholder": { color: "var(--color-faint)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--color-faint)" },
  ".cm-lineNumbers .cm-gutterElement": {
    fontFamily: MARK_FONT,
    fontSize: "11px",
    minWidth: "40px",
    padding: "0 10px 0 0",
    boxSizing: "border-box",
  },

  // Fenced code blocks (lines tagged by `codeBlockLines`).
  ".cm-codeblock": {
    fontFamily: MARK_FONT,
    fontSize: "14px",
    lineHeight: "1.65",
    backgroundColor: "var(--color-code)",
    padding: "0 14px",
  },

  // Search panel (Ctrl+F)
  ".cm-panels": { backgroundColor: "var(--color-bg)", color: "var(--color-ink)", fontFamily: "var(--font-sans)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--color-rule)" },
  ".cm-textfield": {
    backgroundColor: "var(--color-bg)",
    border: "1px solid var(--color-rule)",
    borderRadius: "6px",
    color: "inherit",
    padding: "3px 8px",
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--color-hover)",
    border: "1px solid var(--color-rule)",
    borderRadius: "6px",
    color: "inherit",
  },

  // --- Changes (@codemirror/merge) -------------------------------------
  // The change gutter shows + / − / ~ in the margin instead of colored bars.
  ".cm-changeGutter": { width: "22px", padding: "0" },
  ".cm-changeGutter .cm-gutterElement": {
    fontFamily: MARK_FONT,
    fontSize: "13px",
    textAlign: "center",
    background: "none !important",
  },
  ".cm-changedLineGutter::after": { content: '"+"', color: "var(--color-accent)" },
  ".cm-inlineChangedLineGutter::after": { content: '"~"', color: "var(--color-accent)" },
  ".cm-deletedLineGutter::after": { content: '"−"', color: "var(--color-del)" },
  ".cm-deletedChunk": { padding: "0 !important", backgroundColor: "transparent !important" },
  ".cm-deletedChunk del, .cm-deletedLine del": { textDecoration: "none" },
  ".cm-collapsedLines": {
    margin: "6px 0",
    padding: "5px 2px !important",
    background: "none !important",
    borderTop: "1px dashed var(--color-rule)",
    borderBottom: "1px dashed var(--color-rule)",
    color: "var(--color-ink-3) !important",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    "&:before, &:after": { content: "none !important" },
  },
});

// ---------------------------------------------------------------------------
// Preview: the WYSIWYG mode
// ---------------------------------------------------------------------------

export const previewTheme = EditorView.theme({
  // Font and size come from Settings (--writing-font, --writing-size); headings scale with them.
  ".cm-content": { fontFamily: "var(--writing-font, var(--font-serif))", fontSize: "var(--writing-size, 19px)", lineHeight: "1.62" },
  ".cm-h1": { fontSize: "calc(var(--writing-size, 19px) * 2.32)", fontWeight: "500", lineHeight: "1.12", letterSpacing: "-0.015em" },
  ".cm-h2": { fontSize: "calc(var(--writing-size, 19px) * 1.32)", fontWeight: "500", lineHeight: "1.4" },
  ".cm-h3": { fontSize: "calc(var(--writing-size, 19px) * 1.1)", fontWeight: "500", lineHeight: "1.45" },
  ".cm-h4, .cm-h5, .cm-h6": { fontWeight: "600" },

  // `##` hangs in the left margin, so headings line up with the text.
  ".cm-hanging-mark": {
    position: "absolute",
    right: "100%",
    paddingRight: "14px",
    fontFamily: MARK_FONT,
    fontSize: "14px",
    fontWeight: "400",
    lineHeight: "1",
    letterSpacing: "0",
    color: "var(--color-faint)",
    whiteSpace: "nowrap",
  },
  // Centered on the heading's first line: (line box − mark height) / 2.
  ".cm-h1 .cm-hanging-mark": { top: "calc((var(--writing-size, 19px) * 2.6 - 14px) / 2)" },
  ".cm-h2 .cm-hanging-mark": { top: "calc((var(--writing-size, 19px) * 1.85 - 14px) / 2)" },
  ".cm-h3 .cm-hanging-mark": { top: "calc((var(--writing-size, 19px) * 1.6 - 14px) / 2)" },
  ".cm-h4 .cm-hanging-mark, .cm-h5 .cm-hanging-mark, .cm-h6 .cm-hanging-mark": {
    top: "calc((var(--writing-size, 19px) * 1.62 - 14px) / 2)",
  },
  "&.cm-show-changes .cm-hanging-mark, &.cm-show-changes .cm-hanging-time": { visibility: "hidden" },
  ".cm-hanging-time": {
    position: "absolute",
    right: "100%",
    top: "calc((var(--writing-size, 19px) * 1.62 - 13px) / 2)",
    paddingRight: "14px",
    fontFamily: MARK_FONT,
    fontSize: "13px",
    lineHeight: "1",
    color: "var(--color-ink-3)",
    whiteSpace: "nowrap",
  },

  ".cm-bullet": { display: "inline-block", width: "1.3em", color: "var(--color-ink-3)", textIndent: "0" },
  ".cm-ol-mark": { display: "inline-block", minWidth: "1.6em", color: "var(--color-ink-3)", textIndent: "0" },
  ".cm-task-box": { display: "inline-block", width: "1.6em", textIndent: "0" },
  ".cm-task-box input": {
    width: "15px",
    height: "15px",
    margin: "0",
    accentColor: "var(--color-accent)",
    transform: "translateY(1px)",
    cursor: "default",
  },
  ".cm-task-done": { color: "var(--color-ink-3)", textDecoration: "line-through", textDecorationColor: "var(--color-faint)" },
  ".cm-quote": { color: "var(--color-ink-2)", fontStyle: "italic" },
  ".cm-link-text, .cm-wikilink": {
    color: "var(--color-accent)",
    textDecoration: "underline",
    textDecorationColor: "var(--color-accent-soft)",
    textDecorationThickness: "2px",
    textUnderlineOffset: "3px",
    cursor: "pointer",
  },
  ".cm-wikilink-raw": { color: "var(--color-accent)" },
  // Images sit in the line as inline blocks (a block element there would add empty line boxes
  // around CodeMirror's cursor helpers). On the line being edited, the picture goes below the Markdown.
  ".cm-image": {
    display: "inline-block",
    maxWidth: "100%",
    margin: "6px 0",
    lineHeight: "0",
    verticalAlign: "bottom",
    textIndent: "0",
    cursor: "default",
  },
  ".cm-image.cm-image-below": { display: "block", width: "fit-content", margin: "8px 0 4px" },
  ".cm-image img": { display: "block", maxWidth: "100%", maxHeight: "720px", borderRadius: "4px" },
  ".cm-image-missing": {
    display: "inline-block",
    margin: "2px 0",
    padding: "4px 10px",
    border: "1px dashed var(--color-rule)",
    borderRadius: "6px",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    lineHeight: "1.5",
    color: "var(--color-ink-3)",
    textIndent: "0",
  },
  ".cm-hr": { display: "inline-block", width: "100%", height: "1px", verticalAlign: "middle", backgroundColor: "var(--color-rule)" },

  // Front matter shown as tag chips (when the cursor isn't in it).
  ".cm-frontmatter": {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "6px 8px",
    padding: "2px 0 14px",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    lineHeight: "1.4",
    color: "var(--color-ink-3)",
    cursor: "text",
  },
  ".cm-frontmatter-tag": {
    padding: "2px 8px",
    borderRadius: "999px",
    backgroundColor: "var(--color-accent-soft)",
    color: "var(--color-accent)",
  },
  ".cm-frontmatter-tag[data-tag]:hover, .cm-hashtag[data-tag]:hover": { textDecoration: "underline", textUnderlineOffset: "2px" },
  // #tags in the text: quiet pills, in the interface font.
  ".cm-hashtag": {
    padding: "1px 6px",
    borderRadius: "999px",
    backgroundColor: "var(--color-accent-soft)",
    color: "var(--color-accent)",
    fontFamily: "var(--font-sans)",
    fontSize: "0.8em",
  },
  ".cm-hashtag[data-tag]": { cursor: "pointer" },

  // Changes in Preview: quiet, inline.
  ".cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "transparent !important" },
  // Whole added lines get a soft tint; the exact words that changed get the strong one.
  "ins.cm-insertedLine": { background: "var(--color-accent-soft) !important", textDecoration: "none", borderRadius: "3px" },
  ".cm-changedText": {
    background: "var(--color-ins-strong) !important",
    borderRadius: "3px",
    textDecoration: "none",
  },
  ".cm-deletedText, .cm-deletedChunk .cm-deletedLine": {
    background: "var(--color-del-soft) !important",
    color: "var(--color-del)",
    textDecoration: "line-through",
    textDecorationColor: "var(--color-del)",
    borderRadius: "3px",
  },
});

export const previewHighlight = HighlightStyle.define([
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--color-ink-3)" },
  { tag: highlightTag, backgroundColor: "var(--color-mark)", borderRadius: "2px", boxDecorationBreak: "clone" },
  { tag: t.link, color: "var(--color-accent)" },
  { tag: t.url, color: "var(--color-ink-3)" },
  {
    tag: t.monospace,
    fontFamily: MARK_FONT,
    fontSize: "0.82em",
    backgroundColor: "var(--color-code)",
    borderRadius: "4px",
    padding: "1px 4px",
  },
  { tag: [t.processingInstruction, t.meta, t.labelName, t.contentSeparator], color: "var(--color-faint)" },
  ...codeTokenStyles(),
]);

// ---------------------------------------------------------------------------
// Source: raw Markdown in DM Mono
// ---------------------------------------------------------------------------

export const sourceTheme = EditorView.theme({
  ".cm-content": { fontFamily: MARK_FONT, fontSize: "15px", lineHeight: "1.8" },
  ".cm-codeblock": { fontSize: "inherit", lineHeight: "inherit", padding: "0 10px" },

  // Changes in Source: a proper line diff.
  ".cm-changedLine": { backgroundColor: "var(--color-accent-soft) !important" },
  ".cm-inlineChangedLine": { backgroundColor: "transparent !important" },
  // The line tint marks added lines; only the changed words get the strong highlight.
  "ins.cm-insertedLine": { background: "none !important", textDecoration: "none" },
  ".cm-changedText": { background: "var(--color-ins-strong) !important", textDecoration: "none" },
  ".cm-deletedChunk": { backgroundColor: "var(--color-del-soft) !important", color: "var(--color-ink-2)" },
  ".cm-deletedText": {
    background: "var(--color-del-strong) !important",
    textDecoration: "line-through",
    textDecorationColor: "var(--color-del)",
  },
});

export const sourceHighlight = HighlightStyle.define([
  { tag: [t.processingInstruction, t.meta, t.labelName, t.contentSeparator, t.url], color: "var(--color-ink-3)" },
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "500" },
  { tag: t.strong, fontWeight: "500" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: highlightTag, backgroundColor: "var(--color-mark)", borderRadius: "2px" },
  { tag: t.link, color: "var(--color-accent)" },
  { tag: t.quote, color: "var(--color-ink-2)" },
  ...codeTokenStyles(),
]);

function codeTokenStyles() {
  return [
    { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "var(--color-accent)" },
    { tag: [t.string, t.special(t.string), t.regexp], color: "var(--color-ok)" },
    { tag: [t.number, t.bool, t.null, t.atom], color: "var(--color-del)" },
    { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--color-ink-3)", fontStyle: "italic" },
    { tag: [t.typeName, t.className], color: "var(--color-ink-2)", fontWeight: "500" },
  ];
}
