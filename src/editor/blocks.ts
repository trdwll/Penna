/**
 * Moving blocks: the grip in Preview's margin, its menu, and Ctrl+Shift+↑/↓.
 *
 * A block is a top-level paragraph, heading, list, table, code block or
 * quote, or one item of a list (with whatever is nested under it). Blocks
 * move among their siblings: top-level blocks among top-level blocks, list
 * items within their list. The text between siblings (a blank line, or just
 * a line break in a tight list) stays where it was, so spacing survives the
 * move, and numbered lists keep counting 1, 2, 3.
 *
 * Every change is one transaction, so Ctrl+Z puts the block back.
 */
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

interface Span {
  from: number;
  to: number;
}

export interface Block extends Span {
  /** The blocks it can move among, in document order (it is one of them). */
  siblings: Span[];
  index: number;
  /** Items of a numbered list: their numbers follow their new order. */
  ordered: boolean;
}

/** Whole lines from a node's first line to its last. */
function lineSpan(state: EditorState, node: SyntaxNode): Span {
  return { from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(node.to).to };
}

/** The block on the line at `pos`, or null (blank lines, front matter). */
export function blockAt(state: EditorState, pos: number): Block | null {
  const line = state.doc.lineAt(pos);
  const at = line.from + (line.text.length - line.text.trimStart().length);
  if (!line.text.trim()) return null;
  let item: SyntaxNode | null = null;
  let top: SyntaxNode | null = null;
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(at, 1); n; n = n.parent) {
    if (n.name === "Frontmatter") return null;
    if (n.name === "ListItem" && !item) item = n;
    if (n.name !== "Document" && n.parent?.name === "Document") {
      top = n;
      break;
    }
  }
  const node = item ?? top;
  if (!node?.parent) return null;
  const siblings: SyntaxNode[] = [];
  for (let c = node.parent.firstChild; c; c = c.nextSibling) {
    if (item ? c.name === "ListItem" : c.name !== "Frontmatter") siblings.push(c);
  }
  const spans = siblings.map((s) => lineSpan(state, s));
  const index = siblings.findIndex((s) => s.from === node.from);
  if (index < 0) return null;
  return { ...spans[index], siblings: spans, index, ordered: !!item && node.parent.name === "OrderedList" };
}

const NUMBER = /^(\s*)(\d+)([.)])/;

/**
 * Move a block so it lands before sibling `slot` (`siblings.length` = after
 * the last). Keeps the cursor at the same spot inside the block.
 */
export function moveBlock(view: EditorView, block: Block, slot: number): boolean {
  const { siblings, index } = block;
  if (slot === index || slot === index + 1 || slot < 0 || slot > siblings.length) return false;
  const { doc } = view.state;
  const texts = siblings.map((s) => doc.sliceString(s.from, s.to));
  const gaps = siblings.slice(1).map((s, i) => doc.sliceString(siblings[i].to, s.from));

  const order = siblings.map((_, i) => i).filter((i) => i !== index);
  const at = slot > index ? slot - 1 : slot;
  order.splice(at, 0, index);
  const lo = Math.min(index, at);
  const hi = Math.max(index, at);

  // Numbered lists: each position keeps the number it had.
  const numbers = texts.map((t) => NUMBER.exec(t)?.[2]);
  let insert = "";
  let movedFrom = 0;
  for (let k = lo; k <= hi; k++) {
    let text = texts[order[k]];
    if (block.ordered && numbers[k] !== undefined) text = text.replace(NUMBER, (_m, sp, _n, dot) => `${sp}${numbers[k]}${dot}`);
    if (order[k] === index) movedFrom = siblings[lo].from + insert.length;
    insert += text + (k < hi ? gaps[k] : "");
  }

  const head = view.state.selection.main.head;
  const offset = head >= block.from && head <= block.to ? head - block.from : 0;
  view.dispatch({
    changes: { from: siblings[lo].from, to: siblings[hi].to, insert },
    selection: EditorSelection.cursor(Math.min(movedFrom + offset, siblings[lo].from + insert.length)),
    scrollIntoView: true,
    userEvent: "move.block",
  });
  return true;
}

/** The text that separates this block from a neighbour (or a sensible default). */
function gapNear(state: EditorState, block: Block): string {
  const { siblings, index } = block;
  if (index + 1 < siblings.length) return state.doc.sliceString(block.to, siblings[index + 1].from);
  if (index > 0) return state.doc.sliceString(siblings[index - 1].to, block.from);
  return state.lineBreak.repeat(blockIsListItem(state, block) ? 1 : 2); // a tight list, or a blank line
}

function blockIsListItem(state: EditorState, block: Block): boolean {
  return /^\s*([-*+]|\d+[.)])\s/.test(state.doc.sliceString(block.from, block.to));
}

export function duplicateBlock(view: EditorView, block: Block): boolean {
  const text = view.state.doc.sliceString(block.from, block.to);
  const gap = gapNear(view.state, block);
  view.dispatch({
    changes: { from: block.to, insert: gap + text },
    selection: EditorSelection.cursor(block.to + gap.length),
    scrollIntoView: true,
    userEvent: "input.duplicate",
  });
  return true;
}

export function deleteBlock(view: EditorView, block: Block): boolean {
  const { siblings, index } = block;
  // Take one neighbouring gap with it, so no double blank line is left behind.
  const span =
    index + 1 < siblings.length
      ? { from: block.from, to: siblings[index + 1].from }
      : index > 0
        ? { from: siblings[index - 1].to, to: block.to }
        : { from: block.from, to: block.to };
  view.dispatch({
    changes: span,
    selection: EditorSelection.cursor(span.from),
    scrollIntoView: true,
    userEvent: "delete.block",
  });
  return true;
}

const moveBy = (dir: -1 | 1) => (view: EditorView) => {
  const block = blockAt(view.state, view.state.selection.main.head);
  if (!block) return false;
  return moveBlock(view, block, dir < 0 ? block.index - 1 : block.index + 2) || true;
};

/** Ctrl+Shift+↑ / ↓ move the block at the cursor (both modes). */
export const blockKeymap = [
  { key: "Mod-Shift-ArrowUp", run: moveBy(-1), preventDefault: true },
  { key: "Mod-Shift-ArrowDown", run: moveBy(1), preventDefault: true },
];

// ---------------------------------------------------------------------------
// Dimming the block being dragged
// ---------------------------------------------------------------------------

const setDragged = StateEffect.define<Span | null>();
const draggedLine = Decoration.line({ class: "cm-block-dragged" });

const draggedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setDragged)) continue;
      if (!e.value) return Decoration.none;
      const out: Range<Decoration>[] = [];
      for (let pos = e.value.from; pos <= e.value.to;) {
        const line = tr.state.doc.lineAt(pos);
        out.push(draggedLine.range(line.from));
        pos = line.to + 1;
      }
      return Decoration.set(out);
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------------------------------------------------------------------------
// Dragging
// ---------------------------------------------------------------------------

/** The nearest scrolling ancestor (the note page), for scrolling while dragging near an edge. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === "auto" || overflowY === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Where a block would land for a pointer at `y`, and where to draw the drop line. */
function slotAt(view: EditorView, block: Block, y: number): { slot: number; lineY: number } {
  const top = (s: Span) => view.lineBlockAt(s.from).top + view.documentTop;
  const bottom = (s: Span) => view.lineBlockAt(s.to).bottom + view.documentTop;
  const { siblings } = block;
  for (let k = 0; k < siblings.length; k++) {
    const t = top(siblings[k]);
    if (y < (t + bottom(siblings[k])) / 2) {
      const above = k > 0 ? bottom(siblings[k - 1]) : t;
      return { slot: k, lineY: k > 0 ? (above + t) / 2 : t - 3 };
    }
  }
  return { slot: siblings.length, lineY: bottom(siblings[siblings.length - 1]) + 3 };
}

function startDrag(view: EditorView, grip: HTMLElement, event: PointerEvent) {
  const block = blockAt(view.state, view.state.selection.main.head);
  if (!block) return;
  const startY = event.clientY;
  let dragging = false;
  let slot = -1;
  let lastY = startY;
  let frame = 0;
  const scroller = scrollParent(view.dom);
  const indicator = document.createElement("div");
  indicator.className = "cm-block-drop";

  const place = () => {
    const at = slotAt(view, block, lastY);
    slot = at.slot;
    const noop = slot === block.index || slot === block.index + 1;
    indicator.style.display = noop ? "none" : "block";
    indicator.style.top = `${at.lineY - view.dom.getBoundingClientRect().top - 1}px`;
  };

  // Keep scrolling while the pointer rests near the top or bottom edge.
  const tick = () => {
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      const speed = lastY < r.top + 56 ? -14 : lastY > r.bottom - 56 ? 14 : 0;
      if (speed) {
        scroller.scrollTop += speed;
        place();
      }
    }
    frame = requestAnimationFrame(tick);
  };

  const finish = (drop: boolean) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("keydown", onKey, true);
    cancelAnimationFrame(frame);
    indicator.remove();
    view.dom.classList.remove("cm-block-dragging");
    if (!dragging) return;
    view.dispatch({ effects: setDragged.of(null) });
    if (drop && slot >= 0) moveBlock(view, block, slot);
    view.focus();
  };

  const onMove = (e: PointerEvent) => {
    lastY = e.clientY;
    if (!dragging) {
      if (Math.abs(e.clientY - startY) < 4) return;
      dragging = true;
      view.dom.classList.add("cm-block-dragging");
      view.dom.appendChild(indicator);
      view.dispatch({ effects: setDragged.of({ from: block.from, to: block.to }) });
      frame = requestAnimationFrame(tick);
    }
    place();
  };
  const onUp = () => {
    const wasDragging = dragging;
    finish(true);
    if (!wasDragging) openBlockMenu(view, grip, block);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("keydown", onKey, true);
}

// ---------------------------------------------------------------------------
// The block menu (click on the grip)
// ---------------------------------------------------------------------------

function openBlockMenu(view: EditorView, grip: HTMLElement, block: Block) {
  view.dom.querySelector(".cm-block-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "cm-block-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Block");

  const close = (refocus: boolean) => {
    menu.remove();
    window.removeEventListener("pointerdown", onOutside, true);
    if (refocus) view.focus();
  };
  const onOutside = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node)) close(false);
  };

  const items: { label: string; hint?: string; danger?: boolean; run: () => boolean }[] = [
    { label: "Move up", hint: "Ctrl Shift ↑", run: () => moveBlock(view, block, block.index - 1) },
    { label: "Move down", hint: "Ctrl Shift ↓", run: () => moveBlock(view, block, block.index + 2) },
    { label: "Duplicate", run: () => duplicateBlock(view, block) },
    { label: "Delete", danger: true, run: () => deleteBlock(view, block) },
  ];
  for (const item of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.tabIndex = -1;
    b.className = item.danger ? "cm-block-menuitem cm-block-danger" : "cm-block-menuitem";
    const label = document.createElement("span");
    label.textContent = item.label;
    b.appendChild(label);
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "cm-block-hint";
      hint.textContent = item.hint;
      b.appendChild(hint);
    }
    const disabled =
      (item.label === "Move up" && block.index === 0) || (item.label === "Move down" && block.index === block.siblings.length - 1);
    b.disabled = disabled;
    b.addEventListener("click", () => {
      close(true);
      item.run();
    });
    menu.appendChild(b);
  }

  menu.addEventListener("keydown", (e) => {
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") buttons[(i + 1) % buttons.length]?.focus();
    else if (e.key === "ArrowUp") buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else if (e.key === "Escape" || e.key === "Tab") close(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  const host = view.dom.getBoundingClientRect();
  const r = grip.getBoundingClientRect();
  menu.style.left = `${r.left - host.left}px`;
  menu.style.top = `${r.bottom - host.top + 4}px`;
  view.dom.appendChild(menu);
  window.addEventListener("pointerdown", onOutside, true);
  menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
}

// ---------------------------------------------------------------------------
// The grip in the margin (Preview), beside the "+"
// ---------------------------------------------------------------------------

const GRIP_DOTS = [3, 7].flatMap((cx) => [3, 7, 11].map((cy) => [cx, cy]));

class GripWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM(view: EditorView) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-block-grip";
    b.setAttribute("aria-label", "Drag to move, click for block options");
    b.title = "Drag to move · click for options";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 10 14");
    svg.setAttribute("width", "10");
    svg.setAttribute("height", "14");
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("aria-hidden", "true");
    for (const [cx, cy] of GRIP_DOTS) {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", String(cx));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", "1.2");
      svg.appendChild(c);
    }
    b.appendChild(svg);
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor's focus and selection
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startDrag(view, b, e);
    });
    b.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      const block = blockAt(view.state, view.state.selection.main.head);
      if (block) openBlockMenu(view, b, block);
    });
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

const grip = Decoration.widget({ widget: new GripWidget(), side: -1 });

const gripPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.focusChanged) this.decorations = this.build(update.view);
    }
    build(view: EditorView): DecorationSet {
      const range = view.state.selection.main;
      if (!view.hasFocus || !range.empty || view.dom.classList.contains("cm-block-dragging")) return Decoration.none;
      if (!blockAt(view.state, range.head)) return Decoration.none;
      return Decoration.set([grip.range(view.state.doc.lineAt(range.head).from)]);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const blockTheme = EditorView.theme({
  ".cm-block-grip": {
    position: "absolute",
    right: "100%",
    top: "calc((var(--writing-size, 19px) * 1.62 - 24px) / 2)",
    marginRight: "12px",
    width: "18px",
    height: "24px",
    padding: "0",
    border: "none",
    borderRadius: "5px",
    background: "transparent",
    color: "var(--color-ink-3)",
    display: "grid",
    placeItems: "center",
    textIndent: "0",
    cursor: "grab",
    touchAction: "none",
  },
  ".cm-block-grip:hover": { background: "var(--color-hover)", color: "var(--color-ink)" },
  ".cm-h1 .cm-block-grip": { top: "calc((var(--writing-size, 19px) * 2.6 - 24px) / 2)" },
  ".cm-h2 .cm-block-grip": { top: "calc((var(--writing-size, 19px) * 1.85 - 24px) / 2)" },
  "&.cm-block-dragging, &.cm-block-dragging *": { cursor: "grabbing !important" },
  ".cm-block-dragged": { opacity: "0.35" },
  ".cm-block-drop": {
    position: "absolute",
    left: "0",
    right: "0",
    height: "2px",
    borderRadius: "1px",
    background: "var(--color-accent)",
    pointerEvents: "none",
    zIndex: "5",
  },
  ".cm-block-menu": {
    position: "absolute",
    zIndex: "20",
    minWidth: "200px",
    padding: "4px 0",
    border: "1px solid var(--color-rule)",
    borderRadius: "8px",
    background: "var(--color-bg)",
    boxShadow: "0 10px 30px rgb(0 0 0 / 0.14)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    lineHeight: "1",
  },
  ".cm-block-menuitem": {
    display: "flex",
    width: "100%",
    height: "32px",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "24px",
    padding: "0 12px",
    border: "none",
    background: "transparent",
    color: "var(--color-ink-2)",
    font: "inherit",
    textAlign: "left",
    outline: "none",
    cursor: "default",
  },
  ".cm-block-menuitem:hover:not(:disabled), .cm-block-menuitem:focus": { background: "var(--color-hover)", color: "var(--color-ink)" },
  ".cm-block-menuitem:disabled": { opacity: "0.4" },
  ".cm-block-danger, .cm-block-danger:hover:not(:disabled), .cm-block-danger:focus": { color: "var(--color-danger)" },
  ".cm-block-hint": { fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--color-ink-3)" },
});

/** The grip, dragging and the block menu (Preview only; the keymap works in both modes). */
export const blockHandles = [gripPlugin, draggedField, blockTheme];
