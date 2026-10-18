/**
 * Preview mode's WYSIWYG rendering.
 *
 * The document stays plain Markdown. Decorations hide the syntax and show
 * the result instead: `**` disappears and the text is bold, `- [ ]` becomes
 * a checkbox, `[[Note]]` becomes a link. On lines that hold the cursor the
 * raw Markdown comes back, so it can be edited directly. That keeps files
 * byte-for-byte as written, which is what keeps Git diffs honest.
 */
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateField } from "@codemirror/state";
import { refreshPreview } from "./refresh";
import type { SyntaxNode } from "@lezer/common";
import { blockHandles } from "./blocks";
import { NoteEmbedWidget, embedTheme } from "./embeds";
import { formatToolbar } from "./formatToolbar";
import { addBlockHandle } from "./insertMenu";
import { tables } from "./tables";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

export interface LinkHandlers {
  openWikiLink: (target: string, other?: boolean) => void;
  openUrl: (url: string, other?: boolean) => void;
  /**
   * The URL to show an image link with (`![](src)`, or `![[src]]` when `embed`), or null to leave it as text.
   * `from` is the note the link is written in, when it isn't the open one (an embedded note).
   */
  imageUrl: (src: string, embed: boolean, from?: string) => string | null;
  /** `![[Note]]`: the note it embeds (never the open note itself), or null. */
  embedNote?: (target: string) => { path: string; title: string; version: number } | null;
  /** An embedded note's text. */
  readNote?: (path: string) => Promise<string>;
  /**
   * Right-click on an image, or a link (`href`) or wiki link (`embed`): show
   * the menu for the vault file it points at. False when it isn't one.
   */
  fileMenu?: (src: string, embed: boolean, at: { x: number; y: number }) => boolean;
  /** A click on a #tag (lowercase, without #): show the notes with it. */
  openTag?: (tag: string) => void;
}

export { refreshPreview } from "./refresh";

/** Lines that hold a selection, shown as raw Markdown while the editor has focus. */
function activeLines(view: EditorView): Set<number> {
  const lines = new Set<number>();
  if (!view.hasFocus) return lines;
  const { doc, selection } = view.state;
  for (const range of selection.ranges) {
    const first = doc.lineAt(range.from).number;
    const last = doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) lines.add(n);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bullet";
    el.textContent = "•";
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-task-box";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.setAttribute("aria-label", this.checked ? "Done. Click to reopen" : "Mark as done");
    box.addEventListener("mousedown", (event) => event.preventDefault());
    box.addEventListener("click", (event) => {
      event.preventDefault();
      // Find the `[ ]` at this widget's position at click time (positions shift as you type).
      const pos = view.posAtDOM(wrap);
      const line = view.state.doc.lineAt(pos);
      const match = /\[( |x|X)\]/.exec(line.text.slice(pos - line.from));
      if (!match) return;
      const at = pos + match.index + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: this.checked ? " " : "x" } });
    });
    wrap.appendChild(box);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-hr";
    return el;
  }
}

/** An image from the vault (or the web). Clicking it puts the cursor on its Markdown. */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly label: string,
    /** `![[label]]` rather than `![](label)`. */
    readonly embed = false,
    /** Below its Markdown, on the line being edited. */
    readonly below = false,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt && other.below === this.below;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = this.below ? "cm-image cm-image-below" : "cm-image";
    // What the note says, for the right-click menu.
    wrap.dataset.src = this.label;
    if (this.embed) wrap.dataset.embed = "true";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.draggable = false;
    img.addEventListener("load", () => view.requestMeasure());
    img.addEventListener("error", () => {
      wrap.className = "cm-image-missing";
      wrap.textContent = `Can’t show ${this.label}`;
      view.requestMeasure();
    });
    wrap.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } });
      view.focus();
    });
    wrap.appendChild(img);
    return wrap;
  }
  // Right-clicks reach the editor, for the file menu; everything else stays with the image.
  ignoreEvent(event: Event) {
    return event.type !== "contextmenu";
  }
}

/**
 * Show an image for source text [from, to): in place of the Markdown, or
 * below it on a line being edited, so the picture doesn't jump away.
 */
function addImage(out: Range<Decoration>[], from: number, to: number, active: boolean, widget: ImageWidget) {
  if (active) {
    const below = new ImageWidget(widget.src, widget.alt, widget.label, widget.embed, true);
    out.push(Decoration.widget({ widget: below, side: 1 }).range(to));
  } else out.push(Decoration.replace({ widget }).range(from, to));
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const hidden = Decoration.replace({});
const hangingMark = Decoration.mark({ class: "cm-hanging-mark" });
const hangingTime = Decoration.mark({ class: "cm-hanging-time" });
const quoteLine = Decoration.line({ class: "cm-quote" });
const doneTask = Decoration.mark({ class: "cm-task-done" });
const olMark = Decoration.mark({ class: "cm-ol-mark" });

// ---------------------------------------------------------------------------
// Inline rendering (headings, emphasis, links, lists, tasks, quotes, rules)
// ---------------------------------------------------------------------------

const HEADING = /^ATXHeading([1-6])$/;
const HIDE_WHEN_IDLE = new Set(["EmphasisMark", "StrikethroughMark", "HighlightMark"]);

/** Nesting level of a list item: 0 for top-level lists. */
function listDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let p = node.parent; p; p = p.parent) {
    if (p.name === "BulletList" || p.name === "OrderedList") depth++;
  }
  return Math.max(0, depth - 1);
}

function buildInline(view: EditorView, handlers: LinkHandlers): DecorationSet {
  const { state } = view;
  const { doc } = state;
  const active = activeLines(view);
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const out: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        if (name === "Table") return false; // rendered by tables.ts

        const heading = HEADING.exec(name);
        if (heading) {
          const line = doc.lineAt(node.from);
          out.push(Decoration.line({ class: `cm-h${heading[1]}` }).range(line.from));
          if (!isActive(node.from)) {
            const mark = node.node.getChild("HeaderMark");
            if (mark) {
              out.push(hangingMark.range(mark.from, mark.to));
              if (doc.sliceString(mark.to, mark.to + 1) === " ") out.push(hidden.range(mark.to, mark.to + 1));
            }
          }
          return;
        }

        // Log lines that start with a time ("09:41 Synced…") hang the time in the margin.
        if (name === "Paragraph" && !isActive(node.from)) {
          const line = doc.lineAt(node.from);
          const time = line.from === node.from ? /^(\d{1,2}:\d{2}) /.exec(line.text) : null;
          if (time) {
            out.push(hangingTime.range(line.from, line.from + time[1].length));
            out.push(hidden.range(line.from + time[1].length, line.from + time[0].length));
          }
          return;
        }

        if (name === "Blockquote") {
          for (let pos = node.from; pos <= node.to;) {
            const line = doc.lineAt(pos);
            out.push(quoteLine.range(line.from));
            pos = line.to + 1;
          }
          return; // children (QuoteMark) still visited below via HIDE_WHEN_IDLE
        }

        if (HIDE_WHEN_IDLE.has(name) || (name === "CodeMark" && node.node.parent?.name === "InlineCode")) {
          if (!isActive(node.from)) out.push(hidden.range(node.from, node.to));
          return;
        }

        if (name === "QuoteMark") {
          if (!isActive(node.from)) {
            const end = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
            out.push(hidden.range(node.from, end));
          }
          return;
        }

        if (name === "Image") {
          const marks = node.node.getChildren("LinkMark");
          const url = node.node.getChild("URL");
          const src = url ? doc.sliceString(url.from, url.to).replace(/^<(.*)>$/, "$1") : "";
          const href = src ? handlers.imageUrl(src, false) : null;
          if (href) {
            const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
            addImage(out, node.from, node.to, isActive(node.from), new ImageWidget(href, alt, src));
          }
          return false;
        }

        if (name === "Link") {
          if (isActive(node.from)) return false;
          const marks = node.node.getChildren("LinkMark");
          const url = node.node.getChild("URL");
          if (marks.length >= 2) {
            const textFrom = marks[0].to;
            const textTo = marks[1].from;
            const href = url ? doc.sliceString(url.from, url.to) : "";
            out.push(hidden.range(marks[0].from, marks[0].to));
            if (textTo > textFrom) {
              out.push(Decoration.mark({ class: "cm-link-text", attributes: { "data-href": href } }).range(textFrom, textTo));
            }
            // Everything after the link text (`](url "title")`) is hidden.
            out.push(hidden.range(marks[1].from, node.to));
          }
          return false;
        }

        if (name === "HorizontalRule" && !isActive(node.from)) {
          out.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
          return;
        }

        if (name === "ListMark" && !isActive(node.from)) {
          const line = doc.lineAt(node.from);
          const item = node.node.parent;
          const task = item?.getChild("Task");
          const taskMarker = task?.getChild("TaskMarker");
          const depth = listDepth(node.node);
          const indent = `${depth * 1.5}em`;
          // Leading spaces are replaced by padding so wrapped lines line up.
          if (node.from > line.from) out.push(hidden.range(line.from, node.from));

          if (taskMarker) {
            const checked = /x/i.test(doc.sliceString(taskMarker.from, taskMarker.to));
            let end = taskMarker.to;
            if (doc.sliceString(end, end + 1) === " ") end++;
            out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, end));
            out.push(
              Decoration.line({ attributes: { style: `padding-left: calc(${indent} + 1.6em); text-indent: -1.6em` } }).range(line.from),
            );
            if (checked && task && task.to > end) out.push(doneTask.range(end, task.to));
            return;
          }

          if (item?.parent?.name === "OrderedList") {
            let end = node.to;
            if (doc.sliceString(end, end + 1) === " ") end++;
            out.push(olMark.range(node.from, end));
            out.push(
              Decoration.line({ attributes: { style: `padding-left: calc(${indent} + 1.6em); text-indent: -1.6em` } }).range(line.from),
            );
            return;
          }

          let end = node.to;
          if (doc.sliceString(end, end + 1) === " ") end++;
          out.push(bullet.range(node.from, end));
          out.push(
            Decoration.line({ attributes: { style: `padding-left: calc(${indent} + 1.3em); text-indent: -1.3em` } }).range(line.from),
          );
          return;
        }
      },
    });

    addWikiLinks(view, from, to, isActive, out, handlers);
    addTags(view, from, to, isActive, out);
  }

  return Decoration.set(out, true);
}

const TAG = /(^|\s)#(\p{L}[\p{L}\p{N}_\-/]*)/gu;

/**
 * `#tags` in the text show as pills. Off the line being edited, a click
 * opens the Tags view; on it, the cursor goes where you click, as with links.
 */
function addTags(view: EditorView, from: number, to: number, isActive: (pos: number) => boolean, out: Range<Decoration>[]) {
  const { state } = view;
  const skip = frontmatterEnd(state.doc.sliceString(0, Math.min(state.doc.length, 4000)));
  const text = state.doc.sliceString(from, to);
  for (const m of text.matchAll(TAG)) {
    const start = from + m.index + m[1].length;
    if (start < skip) continue;
    const name = m[2].replace(/\/+$/, "");
    const end = start + 1 + name.length;
    if (/Code|URL|Link|HTML|Comment/.test(syntaxTree(state).resolveInner(start + 1, 1).name)) continue;
    const attributes = isActive(start) ? undefined : { "data-tag": name.toLowerCase(), title: "Show the notes with this tag" };
    out.push(Decoration.mark({ class: "cm-hashtag", attributes }).range(start, end));
  }
}

/** `[[Target]]`, `[[Target|Label]]`, `[[Target#Heading]]` aren't in the Markdown grammar, so match them here. */
function addWikiLinks(
  view: EditorView,
  from: number,
  to: number,
  isActive: (pos: number) => boolean,
  out: Range<Decoration>[],
  handlers: LinkHandlers,
) {
  const { state } = view;
  const text = state.doc.sliceString(from, to);
  const re = /\[\[([^[\]\n]+?)\]\]/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = from + m.index;
    const end = start + m[0].length;
    const inCode = syntaxTree(state)
      .resolveInner(start + 2, 1)
      .name.match(/Code/);
    if (inCode) continue;
    const inner = m[1];
    const target = inner.split("|")[0].split("#")[0].trim();
    // `![[photo.png]]`: an embedded image. `![[Note]]`: an embedded note.
    if (start > 0 && state.doc.sliceString(start - 1, start) === "!") {
      const href = handlers.imageUrl(target, true);
      if (href) {
        const alt = inner.includes("|") ? inner.slice(inner.indexOf("|") + 1).trim() : "";
        addImage(out, start - 1, end, isActive(start), new ImageWidget(href, alt, target, true));
        if (isActive(start)) out.push(Decoration.mark({ class: "cm-wikilink-raw" }).range(start, end));
        continue;
      }
      const note = handlers.embedNote?.(target);
      if (note && handlers.readNote) {
        const heading = inner.split("|")[0].split("#")[1]?.trim() || null;
        const embed = { openWikiLink: handlers.openWikiLink, readNote: handlers.readNote, imageUrl: handlers.imageUrl };
        const active = isActive(start);
        const widget = new NoteEmbedWidget(target, note.path, note.title, heading, note.version, embed, active);
        if (active) {
          out.push(Decoration.mark({ class: "cm-wikilink-raw" }).range(start, end));
          out.push(Decoration.widget({ widget, side: 1 }).range(end));
        } else out.push(Decoration.replace({ widget }).range(start - 1, end));
        continue;
      }
    }
    if (isActive(start)) {
      out.push(Decoration.mark({ class: "cm-wikilink-raw" }).range(start, end));
      continue;
    }
    const pipe = inner.indexOf("|");
    const labelFrom = pipe === -1 ? start + 2 : start + 2 + pipe + 1;
    if (labelFrom >= end - 2) continue; // `[[x|]]`: nothing to show as a label
    out.push(hidden.range(start, labelFrom));
    out.push(Decoration.mark({ class: "cm-wikilink", attributes: { "data-target": target } }).range(labelFrom, end - 2));
    out.push(hidden.range(end - 2, end));
  }
}

const inlinePreview = (handlers: LinkHandlers) =>
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildInline(view, handlers);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state) ||
          update.transactions.some((t) => t.effects.some((e) => e.is(refreshPreview)))
        ) {
          this.decorations = buildInline(update.view, handlers);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

// ---------------------------------------------------------------------------
// Front matter: a block of tag chips until the cursor moves into it
// ---------------------------------------------------------------------------

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** End offset of the front-matter block (after its closing line), or 0. */
export function frontmatterEnd(text: string): number {
  const match = FRONTMATTER.exec(text);
  return match ? match[0].length : 0;
}

export function parseTags(yaml: string): { tags: string[]; others: string[] } {
  const tags: string[] = [];
  const others: string[] = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === "tags" || key === "tag") {
      if (value.startsWith("[")) {
        tags.push(
          ...value
            .replace(/[[\]]/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      } else if (value) {
        tags.push(...value.split(/[\s,]+/).filter(Boolean));
      } else {
        for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) {
          tags.push(lines[j].replace(/^\s*-\s+/, "").trim());
        }
      }
    } else if (value) {
      others.push(`${key}: ${value}`);
    }
  }
  return { tags: tags.map((tag) => tag.replace(/^#/, "")), others };
}

class FrontmatterWidget extends WidgetType {
  constructor(
    readonly yaml: string,
    readonly openTag?: (tag: string) => void,
  ) {
    super();
  }
  eq(other: FrontmatterWidget) {
    return other.yaml === this.yaml;
  }
  toDOM(view: EditorView) {
    const { tags, others } = parseTags(this.yaml);
    const el = document.createElement("div");
    el.className = "cm-frontmatter";
    el.title = "Click to edit the note's properties";
    for (const tag of tags) {
      const chip = document.createElement("span");
      chip.className = "cm-frontmatter-tag";
      chip.textContent = `#${tag}`;
      if (this.openTag) {
        chip.dataset.tag = tag.toLowerCase();
        chip.title = "Show the notes with this tag";
      }
      el.appendChild(chip);
    }
    for (const other of others) {
      const span = document.createElement("span");
      span.textContent = other;
      el.appendChild(span);
    }
    if (!tags.length && !others.length) el.textContent = "Properties";
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const tag = (event.target as HTMLElement).closest<HTMLElement>("[data-tag]")?.dataset.tag;
      if (tag && this.openTag && event.button === 0) return this.openTag(tag);
      view.dispatch({ selection: { anchor: 4 } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function buildFrontmatter(state: EditorState, openTag?: (tag: string) => void): DecorationSet {
  const text = state.doc.sliceString(0, Math.min(state.doc.length, 4000));
  const match = FRONTMATTER.exec(text);
  if (!match) return Decoration.none;
  // Block replacements must cover whole lines: through the end of the closing `---`.
  const end = state.doc.lineAt(match[0].replace(/\n$/, "").length).to;
  // Show the raw YAML while any selection touches it.
  if (state.selection.ranges.some((range) => range.from <= end)) return Decoration.none;
  return Decoration.set([Decoration.replace({ widget: new FrontmatterWidget(match[1], openTag), block: true }).range(0, end)]);
}

const frontmatterField = (handlers: LinkHandlers) =>
  StateField.define<DecorationSet>({
    create: (state) => buildFrontmatter(state, handlers.openTag),
    update(value, tr) {
      return tr.docChanged || tr.selection ? buildFrontmatter(tr.state, handlers.openTag) : value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });

// ---------------------------------------------------------------------------
// Clicks on links
// ---------------------------------------------------------------------------

function linkClicks(handlers: LinkHandlers): Extension {
  return EditorView.domEventHandlers({
    mousedown(event) {
      if (event.button !== 0 || event.altKey) return false;
      const el = (event.target as HTMLElement).closest<HTMLElement>("[data-target], [data-href], [data-tag]");
      if (!el) return false;
      if (el.dataset.tag !== undefined && !handlers.openTag) return false;
      event.preventDefault();
      // Ctrl+click opens a note in the other pane (beside, or back in the main one).
      const other = event.ctrlKey || event.metaKey;
      if (el.dataset.tag !== undefined) handlers.openTag?.(el.dataset.tag);
      else if (el.dataset.target) handlers.openWikiLink(el.dataset.target, other);
      else if (el.dataset.href) handlers.openUrl(el.dataset.href, other);
      return true;
    },
  });
}

/** The link or embed at a document position, from the Markdown itself (raw lines, Source mode). */
function linkAt(view: EditorView, pos: number): { src: string; embed: boolean } | null {
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === "Link" || node.name === "Image") {
      const url = node.getChild("URL");
      if (!url) return null;
      return { src: view.state.doc.sliceString(url.from, url.to).replace(/^<(.*)>$/, "$1"), embed: false };
    }
  }
  const line = view.state.doc.lineAt(pos);
  for (const m of line.text.matchAll(/\[\[([^[\]\n]+?)\]\]/g)) {
    const from = line.from + m.index;
    if (pos >= from && pos <= from + m[0].length) return { src: m[1].split("|")[0].split("#")[0].trim(), embed: true };
  }
  return null;
}

/**
 * Right-click on an image, a link to a file, or `[[file]]`: the file's menu
 * (Open, Show in Explorer, Rename…, Delete…). Elsewhere the usual menu stays.
 */
export function fileContextMenu(handlers: LinkHandlers): Extension {
  return EditorView.domEventHandlers({
    contextmenu(event, view) {
      if (!handlers.fileMenu) return false;
      const el = (event.target as HTMLElement).closest<HTMLElement>("[data-src], [data-href], [data-target]");
      let target: { src: string; embed: boolean } | null = null;
      if (el) {
        target = {
          src: el.dataset.src ?? el.dataset.href ?? el.dataset.target ?? "",
          embed: el.dataset.src !== undefined ? el.dataset.embed === "true" : el.dataset.target !== undefined,
        };
      } else {
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos !== null) target = linkAt(view, pos);
      }
      if (!target?.src || !handlers.fileMenu(target.src, target.embed, { x: event.clientX, y: event.clientY })) return false;
      event.preventDefault();
      return true;
    },
  });
}

/** Everything Preview mode adds on top of the shared editor setup. */
export function livePreview(handlers: LinkHandlers): Extension {
  return [
    inlinePreview(handlers),
    frontmatterField(handlers),
    tables(handlers),
    formatToolbar,
    addBlockHandle,
    blockHandles,
    embedTheme,
    linkClicks(handlers),
  ];
}
