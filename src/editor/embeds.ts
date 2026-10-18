/**
 * `![[Note]]` and `![[Note#Heading]]` in Preview: the embedded note's text,
 * read-only, in a quiet card with an Open button. The note stays plain
 * Markdown; only the display changes. Embeds don't nest (an embed inside an
 * embedded note shows as a link), and long notes are cut short.
 */
import { EditorView, WidgetType } from "@codemirror/view";
import { renderInline } from "./tables";

export interface EmbedHandlers {
  /** Open the embedded note. */
  openWikiLink: (target: string) => void;
  /** The embedded note's text. */
  readNote: (path: string) => Promise<string>;
  /** Image URLs, resolved from the embedded note's folder. */
  imageUrl: (src: string, embed: boolean, from?: string) => string | null;
}

/** Most blocks an embed shows before "Open to read the rest". */
const MAX_BLOCKS = 40;

/** Texts already loaded, by path, for the version they were loaded at. */
const cache = new Map<string, { version: number; text: string }>();

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** The part of a note under `heading` (until the next heading of the same or a higher level). */
export function sectionOf(text: string, heading: string | null): string {
  const body = text.replace(FRONTMATTER, "");
  // The whole note: its own "# Title" would repeat the card's header.
  if (!heading) return body.replace(/^\s*#\s[^\n]*(\r?\n|$)/, "");
  const lines = body.split(/\r?\n/);
  const wanted = heading.trim().toLowerCase();
  const start = lines.findIndex(
    (l) =>
      /^#{1,6}\s/.test(l) &&
      l
        .replace(/^#{1,6}\s+/, "")
        .replace(/\s+#*\s*$/, "")
        .toLowerCase() === wanted,
  );
  if (start < 0) return "";
  const level = /^#+/.exec(lines[start])![0].length;
  let end = start + 1;
  while (end < lines.length && !(/^#{1,6}\s/.test(lines[end]) && /^#+/.exec(lines[end])![0].length <= level)) end++;
  return lines.slice(start + 1, end).join("\n");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A light rendering of a note: headings, paragraphs, lists, tasks, quotes, code, rules. Returns false if it was cut short. */
function renderLite(text: string, into: HTMLElement, imageUrl: (src: string, embed: boolean) => string | null): boolean {
  let blocks = 0;
  let para: string[] = [];
  let code: string[] | null = null;
  let list: HTMLElement | null = null;
  const room = () => blocks < MAX_BLOCKS;
  const flushPara = () => {
    if (!para.length) return;
    const p = el("p", "cm-embed-p");
    renderInline(para.join(" "), p, imageUrl);
    into.appendChild(p);
    blocks++;
    para = [];
  };
  const endList = () => {
    list = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    if (!room()) break;
    if (code) {
      if (/^\s*(```|~~~)/.test(raw)) {
        into.appendChild(el("pre", "cm-embed-code", code.join("\n")));
        blocks++;
        code = null;
      } else code.push(raw);
      continue;
    }
    if (/^\s*(```|~~~)/.test(raw)) {
      flushPara();
      endList();
      code = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    const task = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/.exec(raw);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(raw);
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(raw);
    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (heading) {
      flushPara();
      endList();
      const h = el("div", `cm-embed-h cm-embed-h${Math.min(heading[1].length, 3)}`);
      renderInline(heading[2], h, imageUrl);
      into.appendChild(h);
      blocks++;
    } else if (task || bullet || ordered) {
      flushPara();
      if (!list) {
        list = el("div", "cm-embed-list");
        into.appendChild(list);
        blocks++;
      }
      const item = el("div", "cm-embed-li");
      const mark = el("span", "cm-embed-mark", task ? (task[1] === " " ? "☐" : "☑") : ordered ? `${ordered[1]}.` : "•");
      const body = el("span", task && task[1] !== " " ? "cm-embed-done" : undefined);
      renderInline((task?.[2] ?? ordered?.[2] ?? bullet?.[1] ?? "").trim(), body, imageUrl);
      item.append(mark, body);
      list.appendChild(item);
    } else if (quote) {
      flushPara();
      endList();
      const q = el("div", "cm-embed-quote");
      renderInline(quote[1], q, imageUrl);
      into.appendChild(q);
      blocks++;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      flushPara();
      endList();
      into.appendChild(el("hr", "cm-embed-hr"));
      blocks++;
    } else if (!raw.trim()) {
      flushPara();
      endList();
    } else {
      endList();
      para.push(raw.trim());
    }
  }
  if (room()) {
    flushPara();
    if (code) into.appendChild(el("pre", "cm-embed-code", code.join("\n")));
  }
  return room();
}

export class NoteEmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly path: string,
    readonly title: string,
    readonly heading: string | null,
    /** Bumped when notes change, so the embed loads again. */
    readonly version: number,
    readonly handlers: EmbedHandlers,
    /** Below its Markdown, on the line being edited. */
    readonly below = false,
  ) {
    super();
  }
  eq(other: NoteEmbedWidget) {
    return (
      other.path === this.path &&
      other.heading === this.heading &&
      other.version === this.version &&
      other.title === this.title &&
      other.below === this.below
    );
  }
  toDOM(view: EditorView) {
    const box = el("div", this.below ? "cm-embed cm-embed-below" : "cm-embed");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", `Embedded note: ${this.title}`);
    const head = el("div", "cm-embed-head");
    const name = el("span", "cm-embed-title", this.title);
    if (this.heading) name.appendChild(el("span", "cm-embed-section", ` · ${this.heading}`));
    const open = el("button", "cm-embed-open", "Open");
    open.type = "button";
    open.addEventListener("mousedown", (e) => e.preventDefault());
    open.addEventListener("click", (e) => {
      e.preventDefault();
      this.handlers.openWikiLink(this.target);
    });
    head.append(name, open);
    const body = el("div", "cm-embed-body");
    box.append(head, body);

    const fill = (text: string) => {
      body.textContent = "";
      const part = sectionOf(text, this.heading);
      if (!part.trim()) {
        body.appendChild(el("div", "cm-embed-empty", this.heading ? `No “${this.heading}” section in this note.` : "This note is empty."));
        return;
      }
      const complete = renderLite(part, body, (src, embed) => this.handlers.imageUrl(src, embed, this.path));
      if (!complete) body.appendChild(el("div", "cm-embed-more", "Open the note to read the rest."));
      for (const img of body.querySelectorAll("img")) img.addEventListener("load", () => view.requestMeasure());
    };
    const cached = cache.get(this.path);
    if (cached && cached.version === this.version) fill(cached.text);
    else {
      if (cached)
        fill(cached.text); // show the last text while the new one loads
      else body.appendChild(el("div", "cm-embed-empty", "Loading…"));
      this.handlers
        .readNote(this.path)
        .then((text) => {
          cache.set(this.path, { version: this.version, text });
          fill(text);
          view.requestMeasure();
        })
        .catch(() => {
          body.textContent = "";
          body.appendChild(el("div", "cm-embed-empty", "Can’t show this note."));
        });
    }

    // Clicking the card (not Open) puts the cursor on its Markdown, to edit the embed.
    box.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(box) } });
      view.focus();
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

export const embedTheme = EditorView.theme({
  ".cm-embed": {
    display: "inline-block",
    width: "100%",
    boxSizing: "border-box",
    verticalAlign: "top",
    margin: "4px 0 6px",
    padding: "10px 16px 12px",
    border: "1px solid var(--color-rule)",
    borderRadius: "10px",
    background: "var(--color-bg)",
    textIndent: "0",
    cursor: "default",
    whiteSpace: "normal",
  },
  ".cm-embed.cm-embed-below": { display: "block", marginTop: "8px" },
  ".cm-embed-head": {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    marginBottom: "4px",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    lineHeight: "1.5",
    color: "var(--color-ink-3)",
  },
  ".cm-embed-title": { fontWeight: "600", color: "var(--color-ink-2)", textTransform: "none" },
  ".cm-embed-section": { fontWeight: "400", color: "var(--color-ink-3)" },
  ".cm-embed-open": {
    height: "24px",
    padding: "0 10px",
    border: "1px solid var(--color-rule)",
    borderRadius: "999px",
    background: "var(--color-bg)",
    color: "var(--color-ink)",
    font: "inherit",
    fontWeight: "500",
    cursor: "default",
  },
  ".cm-embed-open:hover": { borderColor: "var(--color-ink-3)" },
  ".cm-embed-body": { fontSize: "0.92em", lineHeight: "1.55", color: "var(--color-ink-2)" },
  ".cm-embed-p": { margin: "0 0 8px" },
  ".cm-embed-h": { margin: "10px 0 4px", fontWeight: "500", color: "var(--color-ink)" },
  ".cm-embed-h1": { fontSize: "1.3em" },
  ".cm-embed-h2": { fontSize: "1.15em" },
  ".cm-embed-h3": { fontSize: "1.05em" },
  ".cm-embed-list": { margin: "0 0 8px" },
  ".cm-embed-li": { display: "flex", gap: "8px" },
  ".cm-embed-mark": { flexShrink: "0", minWidth: "1.1em", color: "var(--color-ink-3)" },
  ".cm-embed-done": { color: "var(--color-ink-3)", textDecoration: "line-through" },
  ".cm-embed-quote": { margin: "0 0 8px", fontStyle: "italic" },
  ".cm-embed-code": {
    margin: "0 0 8px",
    padding: "6px 10px",
    borderRadius: "6px",
    background: "var(--color-code)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.85em",
    whiteSpace: "pre-wrap",
  },
  ".cm-embed-hr": { border: "none", borderTop: "1px solid var(--color-rule)", margin: "10px 0" },
  ".cm-embed-empty, .cm-embed-more": { fontFamily: "var(--font-sans)", fontSize: "12px", color: "var(--color-ink-3)" },
  ".cm-embed code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.85em",
    background: "var(--color-code)",
    borderRadius: "4px",
    padding: "1px 4px",
  },
  ".cm-embed .cm-image-cell img": { maxWidth: "100%", maxHeight: "320px" },
  ".cm-embed .cm-mark": { background: "var(--color-mark)", color: "inherit", borderRadius: "2px" },
});
