/**
 * A note as HTML, for "Export as HTML…", "Export as PDF…" and "Print…".
 *
 * It's rendered from the same Markdown parser the editor uses (GFM plus
 * ==highlight==), so the export reads like Preview: wiki links, `#tags`,
 * task lists, tables, images and `![[Note]]` embeds (one level deep). Line
 * breaks inside a paragraph are kept, as Preview shows them. Raw HTML is
 * cleaned down to a few harmless tags, without attributes.
 */
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import { sectionOf } from "../editor/embeds";
import { Highlight } from "../editor/highlight";
import { frontmatterEnd, parseTags } from "../editor/livePreview";
import { splitRow } from "../editor/tables";

const parser = markdown({ base: markdownLanguage, extensions: [Highlight] }).language.parser;

export interface ExportContext {
  /** The URL to use for an image written as `src` (`embed` for `![[…]]`), or null when it isn't found. */
  image: (src: string, embed: boolean) => string | null;
  /** The note `![[target]]` embeds, already loaded; null when it isn't a note. */
  note: (target: string) => { title: string; text: string } | null;
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Heading anchors: "Next week!" → "next-week". */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

const MARKS = new Set([
  "HeaderMark",
  "QuoteMark",
  "ListMark",
  "EmphasisMark",
  "CodeMark",
  "LinkMark",
  "StrikethroughMark",
  "HighlightMark",
  "TaskMarker",
  "SuperscriptMark",
  "SubscriptMark",
  "TableDelimiter",
  "CodeInfo",
  "LinkTitle",
  "LinkLabel",
  "URL",
]);
const WRAP: Record<string, string> = {
  Emphasis: "em",
  StrongEmphasis: "strong",
  Strikethrough: "del",
  Highlight: "mark",
  Superscript: "sup",
  Subscript: "sub",
};
const SAFE_TAGS = new Set(
  "b i em strong u s del ins mark sub sup small kbd br hr p div span details summary ul ol li blockquote code pre table thead tbody tr th td h1 h2 h3 h4 h5 h6".split(
    " ",
  ),
);
const SAFE_LINK = /^(https?:|mailto:)/i;

/** Raw HTML, down to the tags in SAFE_TAGS without their attributes; anything else shows as text. */
function cleanHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/(<[^>]*>)/)
    .map((part, i) => {
      if (i % 2 === 0) return part.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const m = /^<(\/?)([a-z][a-z0-9]*)\b[^>]*?(\/?)>$/i.exec(part);
      return m && SAFE_TAGS.has(m[2].toLowerCase()) ? `<${m[1]}${m[2].toLowerCase()}${m[3] ? " /" : ""}>` : escapeHtml(part);
    })
    .join("");
}

class Renderer {
  constructor(
    readonly src: string,
    readonly ctx: ExportContext,
    readonly depth: number,
  ) {}

  text(from: number, to: number) {
    return this.src.slice(from, to);
  }

  blocks(node: SyntaxNode): string {
    let out = "";
    for (let c = node.firstChild; c; c = c.nextSibling) out += this.block(c);
    return out;
  }

  block(n: SyntaxNode): string {
    const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(n.name);
    if (heading) {
      const html = this.inline(n)
        .trim()
        .replace(/(\s*<br>\s*)+$/, ""); // a setext heading's underline
      const plain = this.text(n.from, n.to)
        .replace(/^#+\s*|\s*#*\s*$/g, "")
        .replace(/\n[=-]+\s*$/, "");
      return `<h${heading[1]} id="${escapeHtml(slug(plain))}">${html}</h${heading[1]}>\n`;
    }
    switch (n.name) {
      case "Paragraph":
        return this.paragraph(n);
      case "Blockquote":
        return `<blockquote>\n${this.blocks(n)}</blockquote>\n`;
      case "BulletList":
      case "OrderedList": {
        const tag = n.name === "BulletList" ? "ul" : "ol";
        const start =
          n.name === "OrderedList"
            ? parseInt(this.text(n.firstChild?.firstChild?.from ?? n.from, n.firstChild?.firstChild?.to ?? n.from), 10)
            : 1;
        const tasks = n.getChildren("ListItem").some((li) => li.getChild("Task"));
        const attrs = (tasks ? ' class="tasks"' : "") + (start > 1 ? ` start="${start}"` : "");
        return `<${tag}${attrs}>\n${this.blocks(n)}</${tag}>\n`;
      }
      case "ListItem": {
        const task = n.getChild("Task");
        if (!task) return `<li>${this.blocks(n).trim()}</li>\n`;
        const marker = task.getChild("TaskMarker");
        const done = marker ? /x/i.test(this.text(marker.from, marker.to)) : false;
        let rest = "";
        for (let c = task.nextSibling; c; c = c.nextSibling) rest += this.block(c);
        return `<li class="task${done ? " done" : ""}"><span class="check" aria-hidden="true"></span><span class="task-text">${this.inline(task).trim()}</span>${rest}</li>\n`;
      }
      case "FencedCode": {
        const info = n.getChild("CodeInfo");
        const lang = info ? this.text(info.from, info.to).trim().split(/\s/)[0] : "";
        const body = n.getChild("CodeText");
        const code = body ? this.text(body.from, body.to) : "";
        return `<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ""}>${escapeHtml(code)}</code></pre>\n`;
      }
      case "CodeBlock": {
        const code = this.text(n.from, n.to)
          .split("\n")
          .map((l) => l.replace(/^( {1,4}|\t)/, ""))
          .join("\n");
        return `<pre><code>${escapeHtml(code)}</code></pre>\n`;
      }
      case "HorizontalRule":
        return "<hr>\n";
      case "Table":
        return this.table(n);
      case "HTMLBlock":
        return cleanHtml(this.text(n.from, n.to)) + "\n";
      case "CommentBlock":
      case "ProcessingInstructionBlock":
      case "LinkReference":
      case "QuoteMark":
      case "ListMark":
        return "";
      default:
        return n.firstChild ? this.blocks(n) : `<p>${escapeHtml(this.text(n.from, n.to))}</p>\n`;
    }
  }

  paragraph(n: SyntaxNode): string {
    // A note embedded on its own line becomes a block.
    const own = /^!\[\[([^[\]\n]+?)\]\]$/.exec(this.text(n.from, n.to).trim());
    if (own && this.depth === 0) {
      const ref = own[1].split("|")[0];
      const target = ref.split("#")[0].trim();
      const heading = ref.includes("#") ? ref.slice(ref.indexOf("#") + 1).trim() : null;
      if (!this.ctx.image(target, true)) {
        const note = this.ctx.note(target);
        if (note) {
          const body = renderMarkdown(sectionOf(note.text, heading), this.ctx, this.depth + 1);
          const title = heading ? `${note.title} › ${heading}` : note.title;
          return `<div class="embed"><div class="embed-title">${escapeHtml(title)}</div>\n${body}</div>\n`;
        }
      }
    }
    const html = this.inline(n).trim();
    return html ? `<p>${html}</p>\n` : "";
  }

  table(n: SyntaxNode): string {
    const lines = this.text(n.from, n.to).split(/\r?\n/);
    if (lines.length < 2) return `<p>${escapeHtml(lines.join(" "))}</p>\n`;
    const align = splitRow(lines[1], 0).map(({ text }) =>
      text.startsWith(":") && text.endsWith(":") ? "center" : text.endsWith(":") ? "right" : "",
    );
    const cell = (tag: "th" | "td", text: string, i: number) =>
      `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ""}>${inlineMarkdown(text, this.ctx)}</${tag}>`;
    const header = splitRow(lines[0], 0);
    const rows = lines.slice(2).filter((l) => l.trim());
    const width = header.length;
    const pad = (cells: { text: string }[]) => Array.from({ length: width }, (_, i) => cells[i]?.text ?? "");
    return [
      "<table>",
      `<thead><tr>${pad(header)
        .map((t, i) => cell("th", t, i))
        .join("")}</tr></thead>`,
      "<tbody>",
      ...rows.map(
        (r) =>
          `<tr>${pad(splitRow(r, 0))
            .map((t, i) => cell("td", t, i))
            .join("")}</tr>`,
      ),
      "</tbody>",
      "</table>\n",
    ].join("\n");
  }

  /**
   * The inline content of a node: text between its children, and the
   * children. `[[links]]` and `![[embeds]]` aren't in the grammar (it reads
   * the inner `[…]` as a link), so they're claimed first, by their text.
   */
  inline(n: SyntaxNode, from = n.from, to = n.to): string {
    const wikis = [...this.text(from, to).matchAll(/(!?)\[\[([^[\]\n]+?)\]\]/g)].map((m) => ({
      from: from + m.index,
      to: from + m.index + m[0].length,
      embed: m[1] === "!",
      inner: m[2],
    }));
    let out = "";
    let pos = from;
    let w = 0;
    const wikisBefore = (end: number) => {
      for (; w < wikis.length && wikis[w].from < end; w++) {
        const link = wikis[w];
        if (link.from < pos) continue; // inside something already written (code, emphasis…)
        out += this.plain(pos, link.from) + this.wiki(link.embed, link.inner);
        pos = link.to;
      }
    };
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.to <= from || c.from >= to) continue;
      wikisBefore(c.from);
      if (c.from < pos) continue; // part of a [[link]]
      if (c.from > pos) out += this.plain(pos, c.from);
      out += this.inlineNode(c);
      pos = c.to;
    }
    wikisBefore(to);
    if (to > pos) out += this.plain(pos, to);
    return out;
  }

  inlineNode(c: SyntaxNode): string {
    const wrap = WRAP[c.name];
    if (wrap) return `<${wrap}>${this.inline(c)}</${wrap}>`;
    switch (c.name) {
      case "InlineCode": {
        const open = c.firstChild;
        const close = c.lastChild;
        let code = this.text(open?.to ?? c.from, close && close !== open ? close.from : c.to);
        if (/^ .*[^ ].* $/s.test(code)) code = code.slice(1, -1);
        return `<code>${escapeHtml(code)}</code>`;
      }
      case "Link":
        return this.link(c);
      case "Image":
        return this.image(c);
      case "Autolink":
      case "URL": {
        const url = c.name === "URL" ? this.text(c.from, c.to) : this.text(c.from + 1, c.to - 1);
        const href = /^www\./i.test(url) ? `https://${url}` : url;
        return SAFE_LINK.test(href) ? `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>` : escapeHtml(url);
      }
      case "Escape":
        return escapeHtml(this.text(c.from + 1, c.to));
      case "Entity": {
        const e = this.text(c.from, c.to);
        return /^&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);$/i.test(e) ? e : escapeHtml(e);
      }
      case "HardBreak":
        return "<br>\n";
      case "HTMLTag":
        return cleanHtml(this.text(c.from, c.to));
      case "Comment":
      case "ProcessingInstruction":
        return "";
      default:
        if (MARKS.has(c.name)) return "";
        return c.firstChild ? this.inline(c) : this.plain(c.from, c.to);
    }
  }

  /** `[label](url)`: web links stay links; links to other notes read as text, since they don't travel. */
  link(c: SyntaxNode): string {
    const marks = c.getChildren("LinkMark");
    const labelFrom = marks[0]?.to ?? c.from;
    const labelTo = marks[1]?.from ?? c.to;
    const label = this.inline(c, labelFrom, labelTo);
    const urlNode = c.getChild("URL");
    const url = urlNode ? this.text(urlNode.from, urlNode.to).replace(/^<(.*)>$/, "$1") : "";
    if (SAFE_LINK.test(url)) return `<a href="${escapeHtml(url)}">${label}</a>`;
    if (url.startsWith("#")) return `<a href="#${escapeHtml(slug(decodeURIComponentSafe(url.slice(1))))}">${label}</a>`;
    return `<span class="internal">${label}</span>`;
  }

  image(c: SyntaxNode): string {
    const marks = c.getChildren("LinkMark");
    const alt = this.text(marks[0]?.to ?? c.from, marks[1]?.from ?? c.to);
    const urlNode = c.getChild("URL");
    const src = urlNode ? this.text(urlNode.from, urlNode.to).replace(/^<(.*)>$/, "$1") : "";
    const url = this.ctx.image(src, false);
    return url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">` : `<span class="missing">${escapeHtml(alt || src)}</span>`;
  }

  /** Plain text: `#tags`, and line breaks, which Preview keeps. */
  plain(from: number, to: number): string {
    const s = this.text(from, to);
    let out = "";
    let last = 0;
    for (const m of s.matchAll(/\r?\n[ \t]*/g)) {
      out += this.tags(from + last, from + m.index) + "<br>\n";
      last = m.index + m[0].length;
    }
    return out + this.tags(from + last, to);
  }

  tags(from: number, to: number): string {
    const s = this.text(from, to);
    let out = "";
    let last = 0;
    for (const m of s.matchAll(/#(\p{L}[\p{L}\p{N}_\-/]*)/gu)) {
      const at = from + m.index;
      if (at > 0 && !/\s/.test(this.src[at - 1])) continue;
      const name = m[1].replace(/\/+$/, "");
      out += escapeHtml(s.slice(last, m.index)) + `<span class="tag">#${escapeHtml(name)}</span>`;
      last = m.index + 1 + name.length;
    }
    return out + escapeHtml(s.slice(last));
  }

  wiki(embed: boolean, inner: string): string {
    const pipe = inner.indexOf("|");
    const ref = pipe === -1 ? inner : inner.slice(0, pipe);
    const label = pipe === -1 ? null : inner.slice(pipe + 1).trim();
    const target = ref.split("#")[0].trim();
    const heading = ref.includes("#") ? ref.slice(ref.indexOf("#") + 1).trim() : "";
    if (embed) {
      const url = this.ctx.image(target, true);
      if (url) return `<img src="${escapeHtml(url)}" alt="${escapeHtml(label ?? "")}">`;
    }
    if (!target && heading) return `<a href="#${escapeHtml(slug(heading))}">${escapeHtml(label || heading)}</a>`;
    const text = label || (heading ? `${target} › ${heading}` : target);
    return `<span class="wikilink">${escapeHtml(text)}</span>`;
  }
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Markdown (no front matter) as HTML. */
function renderMarkdown(text: string, ctx: ExportContext, depth: number): string {
  const tree = parser.parse(text);
  return new Renderer(text, ctx, depth).blocks(tree.topNode);
}

/** One line of inline Markdown (a table cell) as HTML. */
function inlineMarkdown(text: string, ctx: ExportContext): string {
  const tree = parser.parse(text);
  const r = new Renderer(text, ctx, 1);
  const first = tree.topNode.firstChild;
  return first ? r.inline(first).trim() : "";
}

/** A whole note: its tags from front matter as pills, then its text. */
export function renderNote(text: string, ctx: ExportContext): string {
  const end = frontmatterEnd(text);
  let head = "";
  if (end) {
    const yaml = text
      .slice(0, end)
      .replace(/^---\r?\n/, "")
      .replace(/\r?\n---[ \t]*(\r?\n)?$/, "");
    const { tags } = parseTags(yaml);
    if (tags.length) head = `<div class="tags">${tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join(" ")}</div>\n`;
  }
  return head + renderMarkdown(text.slice(end), ctx, 0);
}

/** `![[…]]` targets in a note (and so the notes an export may embed). */
export function embedTargets(text: string): string[] {
  return [...text.matchAll(/!\[\[([^[\]\n]+?)\]\]/g)].map((m) => m[1].split("|")[0].split("#")[0].trim());
}

/** The look of an exported note: Penna's page, light, in print too. */
export const EXPORT_CSS = `
.penna-export { color: #1b1c1e; font-family: "Newsreader Variable", "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-size: 19px; line-height: 1.6; font-optical-sizing: auto; overflow-wrap: break-word; }
.penna-export > :first-child { margin-top: 0; }
.penna-export h1, .penna-export h2, .penna-export h3, .penna-export h4, .penna-export h5, .penna-export h6 { font-weight: 500; line-height: 1.2; letter-spacing: -0.01em; margin: 1.6em 0 0.5em; break-after: avoid; }
.penna-export h1 { font-size: 2.1em; margin-top: 0.4em; }
.penna-export h2 { font-size: 1.5em; }
.penna-export h3 { font-size: 1.25em; }
.penna-export h4, .penna-export h5, .penna-export h6 { font-size: 1.05em; font-weight: 600; }
.penna-export p { margin: 0 0 0.9em; }
.penna-export a { color: #2d5a9b; text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
.penna-export .wikilink, .penna-export .internal { color: #2d5a9b; }
.penna-export .missing { color: #686c71; font-style: italic; }
.penna-export strong { font-weight: 600; }
.penna-export mark { background: rgb(240 196 64 / 0.42); color: inherit; border-radius: 2px; padding: 0 0.1em; }
.penna-export del { color: #686c71; }
.penna-export code { font-family: "DM Mono", "Cascadia Mono", Consolas, monospace; font-size: 0.8em; background: #f0f0ee; border-radius: 4px; padding: 0.12em 0.35em; }
.penna-export pre { background: #f4f4f2; border-radius: 8px; padding: 14px 16px; margin: 0 0 1em; overflow-x: auto; line-height: 1.5; break-inside: avoid; }
.penna-export pre code { background: none; padding: 0; font-size: 0.78em; white-space: pre; }
.penna-export blockquote { margin: 0 0 1em; padding: 0 0 0 1em; border-left: 2px solid #d9d9d4; color: #4f5257; }
.penna-export ul, .penna-export ol { margin: 0 0 0.9em; padding-left: 1.4em; }
.penna-export ul { list-style: disc; }
.penna-export ul ul { list-style: circle; }
.penna-export ol { list-style: decimal; }
.penna-export li::marker { color: #686c71; }
.penna-export li { margin: 0.2em 0; }
.penna-export li > p { margin: 0; }
.penna-export li > ul, .penna-export li > ol { margin: 0.2em 0; }
.penna-export ul.tasks { list-style: none; padding-left: 0.1em; }
.penna-export li.task { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 0.55em; }
.penna-export li.task > ul, .penna-export li.task > ol { flex-basis: 100%; padding-left: 1.6em; }
.penna-export .check { flex: none; width: 0.72em; height: 0.72em; border: 1.5px solid #686c71; border-radius: 3px; transform: translateY(0.06em); }
.penna-export li.done .check { background: #2d5a9b; border-color: #2d5a9b; box-shadow: inset 0 0 0 2px #fff; }
.penna-export li.done > .task-text { color: #686c71; text-decoration: line-through; text-decoration-color: #a3a6aa; }
.penna-export table { border-collapse: collapse; margin: 0 0 1.1em; font-size: 0.86em; line-height: 1.45; break-inside: avoid; }
.penna-export th, .penna-export td { border-bottom: 1px solid #e3e3df; padding: 7px 16px 7px 0; text-align: left; vertical-align: top; }
.penna-export th { font-weight: 600; border-bottom-color: #1b1c1e; }
.penna-export img { display: inline-block; max-width: 100%; height: auto; border-radius: 6px; vertical-align: middle; }
.penna-export td img { max-height: 160px; }
.penna-export hr { border: 0; border-top: 1px solid #e3e3df; margin: 2em 0; }
.penna-export .tag { font-family: "Hanken Grotesk Variable", "Segoe UI", system-ui, sans-serif; font-size: 0.74em; color: #2d5a9b; background: rgb(45 90 155 / 0.12); border-radius: 999px; padding: 0.12em 0.55em; white-space: nowrap; }
.penna-export .tags { margin: 0 0 1.4em; }
.penna-export .embed { margin: 0 0 1.1em; padding: 0.1em 0 0.1em 1em; border-left: 2px solid #d9d9d4; }
.penna-export .embed-title { font-family: "Hanken Grotesk Variable", "Segoe UI", system-ui, sans-serif; font-size: 0.62em; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: #686c71; margin-bottom: 0.5em; }
@media print {
  .penna-export { font-size: 11.5pt; }
  .penna-export a { color: inherit; }
  .penna-export pre, .penna-export blockquote, .penna-export img, .penna-export tr { break-inside: avoid; }
}
`;

/** The fonts the app has loaded (Latin), as @font-face rules with the files inside, so an exported page looks the same anywhere. */
export async function embeddedFonts(): Promise<string> {
  const wanted = /Newsreader|DM Mono/; // the page and code; labels fall back to Segoe UI
  const rules: string[] = [];
  for (const sheet of [...document.styleSheets]) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of [...list]) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue("font-family");
      const range = rule.style.getPropertyValue("unicode-range");
      if (!wanted.test(family) || (range && !/U\+0(000)?-0?0?FF\b/i.test(range))) continue;
      const src = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue("src"))?.[1];
      if (!src) continue;
      try {
        const href = new URL(src, sheet.href ?? location.href).href;
        const bytes = new Uint8Array(await (await fetch(href)).arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const css = rule.cssText.replace(/src:[^;]+;/, `src: url(data:font/woff2;base64,${btoa(binary)}) format("woff2");`);
        rules.push(css);
      } catch {
        // without this font the page falls back to Georgia and friends
      }
    }
  }
  return rules.join("\n");
}

/** Paper for a PDF, in inches: Letter where it's the norm, A4 elsewhere. */
export function paperSize(language = navigator.language): [number, number] {
  return /^(en-(US|CA|PH)|es-(US|MX|CO|VE|CL|PR)|fil)\b/i.test(language) ? [8.5, 11] : [8.27, 11.69];
}

/**
 * Show a note in print layout while `run` prints (or saves a PDF of) the
 * page: the app is hidden for print, only the note shows. Waits for its
 * images and fonts first.
 */
export async function withPrintLayout<T>(title: string, body: string, run: () => Promise<T>): Promise<T> {
  const root = document.createElement("div");
  root.id = "print-root";
  root.innerHTML = `<style>${EXPORT_CSS}</style><article class="penna-export">${body}</article>`;
  document.body.appendChild(root);
  const appTitle = document.title;
  document.title = title; // the print dialog's file name
  try {
    await Promise.all([...root.querySelectorAll("img")].map((img) => img.decode().catch(() => {})));
    await document.fonts.ready;
    return await run();
  } finally {
    document.title = appTitle;
    root.remove();
  }
}

/** The system print dialog; resolves when it closes. */
export function printDialog(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("afterprint", done);
      resolve();
    };
    window.addEventListener("afterprint", done);
    window.print();
  });
}

/** A self-contained web page for a note. */
export function htmlDocument(title: string, body: string, fonts: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Penna">
<title>${escapeHtml(title)}</title>
<style>
${fonts}
html { background: #fafaf9; }
body { margin: 0; padding: 64px 24px 96px; }
.penna-export { max-width: 680px; margin: 0 auto; }
@media print { html { background: #fff; } body { padding: 0; } .penna-export { max-width: none; } }
${EXPORT_CSS}
</style>
</head>
<body>
<article class="penna-export">
${body}</article>
</body>
</html>
`;
}
