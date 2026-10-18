/**
 * `==highlighted text==`, as Obsidian and other Markdown editors write it.
 *
 * It isn't in CommonMark or GFM, so it's added to the Markdown grammar as a
 * delimiter like `~~strikethrough~~`: `==` opens when it's followed by
 * text and closes when it follows text, so `a == b` stays plain.
 */
import { Tag, tags } from "@lezer/highlight";
import type { DelimiterType, MarkdownConfig } from "@lezer/markdown";

/** Styles the whole `==…==` span; the theme gives it the highlighter color. */
export const highlightTag = Tag.define();

const delimiter: DelimiterType = { resolve: "Highlight", mark: "HighlightMark" };
const PUNCTUATION = /[\p{S}\p{P}]/u;
const EQUALS = 61;

export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": highlightTag } },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const spaceBefore = /\s|^$/.test(before);
        const spaceAfter = /\s|^$/.test(after);
        const punctBefore = PUNCTUATION.test(before);
        const punctAfter = PUNCTUATION.test(after);
        return cx.addDelimiter(
          delimiter,
          pos,
          pos + 2,
          !spaceAfter && (!punctAfter || spaceBefore || punctBefore),
          !spaceBefore && (!punctBefore || spaceAfter || punctAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};
