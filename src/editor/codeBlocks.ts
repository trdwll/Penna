/**
 * Tags every visible line inside a fenced or indented code block with
 * `cm-codeblock`, so the theme can give the block a mono font and a
 * background that spans the whole column.
 */
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

const codeLine = Decoration.line({ class: "cm-codeblock" });

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc } = view.state;
  let lastLineStart = -1; // RangeSetBuilder needs strictly ordered, non-duplicate adds

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "FencedCode" && node.name !== "CodeBlock") return;
        const first = doc.lineAt(Math.max(node.from, from)).number;
        const last = doc.lineAt(Math.min(node.to, to)).number;
        for (let n = first; n <= last; n++) {
          const line = doc.line(n);
          if (line.from > lastLineStart) {
            builder.add(line.from, line.from, codeLine);
            lastLineStart = line.from;
          }
        }
        return false;
      },
    });
  }
  return builder.finish();
}

export const codeBlockLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
