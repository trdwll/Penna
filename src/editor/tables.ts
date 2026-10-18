/**
 * GFM tables in Preview: rendered as a real table until the cursor moves into
 * it; clicking a cell puts the cursor in that cell's Markdown to edit it.
 * While editing, the table's lines switch to a monospace font so the pipes
 * line up.
 */
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import type { LinkHandlers } from "./livePreview";
import { refreshPreview } from "./refresh";

/** Shows images in cells: the URL for `![](src)` (or `![[src]]` when `embed`), or null. */
type ImageUrl = (src: string, embed: boolean) => string | null;

type Align = "left" | "center" | "right";

interface Cell {
  text: string;
  /** Document position of the cell's text, for click-to-edit. */
  pos: number;
}

interface TableData {
  header: Cell[];
  align: Align[];
  rows: Cell[][];
}

/** Split a table line into cells, honoring `\|` escapes. */
export function splitRow(text: string, lineFrom: number): Cell[] {
  const cells: Cell[] = [];
  let start = 0;
  let i = 0;
  const trimmedStart = text.match(/^\s*\|?/)?.[0].length ?? 0;
  start = trimmedStart;
  i = trimmedStart;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    cells.push({ text: raw.trim().replace(/\\\|/g, "|"), pos: lineFrom + start + lead });
  };
  for (; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "|") {
      push(i);
      start = i + 1;
    }
  }
  if (text.slice(start).trim()) push(text.length);
  return cells;
}

function parseTable(state: EditorState, from: number, to: number): TableData | null {
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  if (last - first < 1) return null;
  const line = (n: number) => state.doc.line(n);
  const header = splitRow(line(first).text, line(first).from);
  const align = splitRow(line(first + 1).text, line(first + 1).from).map(({ text }): Align =>
    text.startsWith(":") && text.endsWith(":") ? "center" : text.endsWith(":") ? "right" : "left",
  );
  const rows: Cell[][] = [];
  for (let n = first + 2; n <= last; n++) rows.push(splitRow(line(n).text, line(n).from));
  return { header, align, rows };
}

/**
 * Minimal inline Markdown, for table cells and embedded notes: **bold**,
 * *italic*, `code`, ==highlight==, ~~strike~~, images, [[link|label]],
 * [text](url).
 */
export function renderInline(text: string, into: HTMLElement, imageUrl?: ImageUrl) {
  const re =
    /(!\[[^\]]*\]\([^)]*\)|!\[\[[^\]]+\]\]|\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|==[^=]+==|~~[^~]+~~|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]*\))/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) into.append(text.slice(last, m.index));
    const token = m[0];
    let el: HTMLElement;
    const image = token.startsWith("!")
      ? token.startsWith("![[")
        ? { src: token.slice(3, -2).split("|")[0].trim(), alt: token.slice(3, -2).split("|")[1]?.trim() ?? "", embed: true }
        : {
            src: token
              .slice(token.indexOf("(") + 1, -1)
              .trim()
              .replace(/^<(.*)>$/, "$1"),
            alt: token.slice(2, token.indexOf("]")),
            embed: false,
          }
      : null;
    const url = image && imageUrl ? imageUrl(image.src, image.embed) : null;
    if (image && url) {
      el = document.createElement("span");
      el.className = "cm-image cm-image-cell";
      el.dataset.src = image.src;
      if (image.embed) el.dataset.embed = "true";
      const img = document.createElement("img");
      img.src = url;
      img.alt = image.alt;
      img.draggable = false;
      el.appendChild(img);
    } else if (image) {
      el = document.createElement("span");
      el.textContent = image.alt || image.src;
    } else if (token.startsWith("==")) {
      el = document.createElement("mark");
      el.className = "cm-mark";
      el.textContent = token.slice(2, -2);
    } else if (token.startsWith("~~")) {
      el = document.createElement("s");
      el.textContent = token.slice(2, -2);
    } else if (token.startsWith("**")) {
      el = document.createElement("strong");
      el.textContent = token.slice(2, -2);
    } else if (token.startsWith("`")) {
      el = document.createElement("code");
      el.textContent = token.slice(1, -1);
    } else if (token.startsWith("[[")) {
      el = document.createElement("span");
      el.className = "cm-wikilink";
      const inner = token.slice(2, -2);
      el.textContent = inner.includes("|") ? inner.split("|")[1] : inner;
      el.dataset.target = inner.split("|")[0].split("#")[0].trim();
    } else if (token.startsWith("[")) {
      el = document.createElement("span");
      el.className = "cm-link-text";
      el.textContent = token.slice(1, token.indexOf("]"));
      el.dataset.href = token.slice(token.indexOf("(") + 1, -1);
    } else {
      el = document.createElement("em");
      el.textContent = token.slice(1, -1);
    }
    into.append(el);
    last = m.index + token.length;
  }
  if (last < text.length) into.append(text.slice(last));
}

class TableWidget extends WidgetType {
  constructor(
    readonly data: TableData,
    readonly source: string,
    readonly imageUrl: ImageUrl | undefined,
    /** The image URLs the cells show, so a changed file redraws the table. */
    readonly images: string,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source && other.images === this.images;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-table";
    const cell = (tag: "th" | "td", c: Cell | undefined, i: number) => {
      const el = document.createElement(tag);
      el.style.textAlign = this.data.align[i] ?? "left";
      if (c) {
        renderInline(c.text, el, this.imageUrl);
        el.dataset.pos = String(c.pos);
      }
      return el;
    };
    const thead = table.createTHead().insertRow();
    this.data.header.forEach((c, i) => thead.appendChild(cell("th", c, i)));
    const tbody = table.createTBody();
    for (const row of this.data.rows) {
      const tr = tbody.insertRow();
      this.data.header.forEach((_, i) => tr.appendChild(cell("td", row[i], i)));
    }
    wrap.appendChild(table);
    for (const img of wrap.querySelectorAll("img")) img.addEventListener("load", () => view.requestMeasure());
    wrap.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-target], [data-href]")) return; // links handle themselves
      const pos = target.closest<HTMLElement>("[data-pos]")?.dataset.pos;
      event.preventDefault();
      const at = pos ? Number(pos) : view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: Math.min(at, view.state.doc.length) } });
      view.focus();
    });
    return wrap;
  }
  // Right-clicks reach the editor, for an image's file menu.
  ignoreEvent(event: Event) {
    return event.type !== "contextmenu";
  }
}

const rawLine = Decoration.line({ class: "cm-table-raw" });

const IMAGE_IN_CELL = /!\[[^\]]*\]\(([^)]*)\)|!\[\[([^\]|]+)/g;

function build(state: EditorState, imageUrl?: ImageUrl): DecorationSet {
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Table") return;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      const editing = state.selection.ranges.some((r) => r.to >= from && r.from <= to);
      if (editing) {
        for (let pos = from; pos <= to;) {
          const line = state.doc.lineAt(pos);
          out.push(rawLine.range(line.from));
          pos = line.to + 1;
        }
      } else {
        const data = parseTable(state, from, to);
        if (data) {
          const source = state.sliceDoc(from, to);
          const images = imageUrl
            ? [...source.matchAll(IMAGE_IN_CELL)].map((m) => imageUrl(m[1] ?? m[2] ?? "", !m[1]) ?? "").join(" ")
            : "";
          out.push(Decoration.replace({ widget: new TableWidget(data, source, imageUrl, images), block: true }).range(from, to));
        }
      }
      return false;
    },
  });
  return Decoration.set(out, true);
}

const tableField = (imageUrl?: ImageUrl) =>
  StateField.define<DecorationSet>({
    create: (state) => build(state, imageUrl),
    update(value, tr) {
      if (
        tr.docChanged ||
        tr.selection ||
        syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
        tr.effects.some((e) => e.is(refreshPreview))
      ) {
        return build(tr.state, imageUrl);
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

export const tableTheme = EditorView.theme({
  ".cm-table-wrap": { overflowX: "auto", padding: "4px 0 10px", cursor: "text" },
  ".cm-table": { width: "100%", borderCollapse: "collapse", fontSize: "17px", lineHeight: "1.45" },
  ".cm-table th": {
    padding: "6px 16px 8px 0",
    borderBottom: "1px solid var(--color-ink-3)",
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    fontWeight: "600",
    letterSpacing: "0.12em",
    textTransform: "uppercase",
    color: "var(--color-ink-3)",
  },
  ".cm-table td": { padding: "9px 16px 9px 0", borderBottom: "1px solid var(--color-rule)", verticalAlign: "top" },
  ".cm-table code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.82em",
    background: "var(--color-code)",
    borderRadius: "4px",
    padding: "1px 4px",
  },
  ".cm-table-raw": { fontFamily: "var(--font-mono)", fontSize: "15px", lineHeight: "1.8" },
  ".cm-table .cm-image-cell": { display: "inline-block", margin: "2px 0", verticalAlign: "top" },
  ".cm-table .cm-image-cell img": { maxWidth: "100%", maxHeight: "240px" },
  ".cm-mark": { background: "var(--color-mark)", color: "inherit", borderRadius: "2px" },
});

export const tables = (handlers?: Pick<LinkHandlers, "imageUrl">) => [tableField(handlers?.imageUrl), tableTheme];
