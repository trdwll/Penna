/**
 * The small dark toolbar over a text selection (Preview mode).
 *
 * It's a CodeMirror tooltip, so it follows the selection and scrolls with
 * the page. Hidden while the editor isn't focused, so it never lingers.
 */
import { StateField, type EditorState } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip, type TooltipView, type ViewUpdate } from "@codemirror/view";
import { currentBlock, insertLink, insertWikiLink, isInlineActive, setBlock, toggleInline, type BlockKind } from "./markdownCommands";

const BLOCK_LABEL: Record<BlockKind, string> = {
  paragraph: "Paragraph",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  quote: "Quote",
};

const SVG_NS = "http://www.w3.org/2000/svg";

function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

function button(label: string, content: string | SVGSVGElement, className: string, run: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `cm-fmt-btn ${className}`;
  b.setAttribute("aria-label", label);
  b.title = label;
  if (typeof content === "string") b.textContent = content;
  else b.appendChild(content);
  // mousedown would steal focus from the editor and drop the selection.
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    run();
  });
  return b;
}

function divider() {
  const d = document.createElement("span");
  d.className = "cm-fmt-divider";
  d.setAttribute("aria-hidden", "true");
  return d;
}

function createToolbar(view: EditorView): TooltipView {
  const dom = document.createElement("div");
  dom.className = "cm-format-toolbar";
  dom.setAttribute("role", "toolbar");
  dom.setAttribute("aria-label", "Format selection");

  // Paragraph / heading picker
  const blockWrap = document.createElement("div");
  blockWrap.className = "cm-fmt-block";
  const blockButton = document.createElement("button");
  blockButton.type = "button";
  blockButton.className = "cm-fmt-btn cm-fmt-blocklabel";
  blockButton.setAttribute("aria-haspopup", "menu");
  const blockText = document.createElement("span");
  blockButton.append(blockText, icon(["m4 6 4 4 4-4"]));
  const menu = document.createElement("div");
  menu.className = "cm-fmt-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  for (const kind of Object.keys(BLOCK_LABEL) as BlockKind[]) {
    const item = button(BLOCK_LABEL[kind], BLOCK_LABEL[kind], `cm-fmt-menuitem cm-fmt-${kind}`, () => {
      menu.hidden = true;
      setBlock(view, kind);
    });
    item.setAttribute("role", "menuitem");
    menu.appendChild(item);
  }
  blockButton.addEventListener("mousedown", (e) => e.preventDefault());
  blockButton.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    blockButton.setAttribute("aria-expanded", String(!menu.hidden));
  });
  blockWrap.append(blockButton, menu);

  const bold = button("Bold (Ctrl+B)", "B", "cm-fmt-bold", () => toggleInline(view, "bold"));
  const italic = button("Italic (Ctrl+I)", "I", "cm-fmt-italic", () => toggleInline(view, "italic"));
  const strike = button("Strikethrough (Ctrl+Shift+X)", "S", "cm-fmt-strike", () => toggleInline(view, "strike"));
  const code = button("Inline code (Ctrl+`)", icon(["m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5"]), "", () =>
    toggleInline(view, "code"),
  );
  const link = button(
    "Link to a web page",
    icon(["M6.5 9.5 9.5 6.5", "M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7l1.2-1.2"]),
    "",
    () => insertLink(view),
  );
  const wiki = button("Link to a note", "[[ ]]", "cm-fmt-wiki", () => insertWikiLink(view));
  const mark = button("Highlight (Ctrl+Shift+H)", icon(["m9.5 3 3.5 3.5-5.5 5.5H4v-3.5z", "M2.5 14h11"]), "", () =>
    toggleInline(view, "highlight"),
  );

  dom.append(blockWrap, divider(), bold, italic, strike, code, divider(), link, wiki, divider(), mark);

  const refresh = (state: EditorState) => {
    blockText.textContent = BLOCK_LABEL[currentBlock(state)];
    bold.setAttribute("aria-pressed", String(isInlineActive(state, "bold")));
    italic.setAttribute("aria-pressed", String(isInlineActive(state, "italic")));
    strike.setAttribute("aria-pressed", String(isInlineActive(state, "strike")));
    code.setAttribute("aria-pressed", String(isInlineActive(state, "code")));
    mark.setAttribute("aria-pressed", String(isInlineActive(state, "highlight")));
  };
  refresh(view.state);

  return {
    dom,
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) {
        refresh(update.state);
        menu.hidden = true;
      }
    },
  };
}

function toolbarTooltip(state: EditorState): Tooltip | null {
  const range = state.selection.main;
  if (range.empty || state.selection.ranges.length > 1) return null;
  // Not over a selection that spans many lines: it'd cover what you selected.
  return { pos: range.from, above: true, strictSide: false, arrow: false, create: createToolbar };
}

const toolbarField = StateField.define<Tooltip | null>({
  create: toolbarTooltip,
  update(value, tr) {
    if (!tr.selection && !tr.docChanged) return value;
    const next = toolbarTooltip(tr.state);
    // Keep the same tooltip (and DOM) while a selection exists so it doesn't flicker.
    if (value && next) return { ...value, pos: next.pos };
    return next;
  },
  provide: (field) => showTooltip.from(field),
});

export const formatToolbarTheme = EditorView.theme({
  "&:not(.cm-focused) .cm-tooltip:has(.cm-format-toolbar)": { display: "none" },
  ".cm-tooltip:has(.cm-format-toolbar)": { border: "none", background: "transparent" },
  ".cm-format-toolbar": {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "4px",
    marginBottom: "6px",
    borderRadius: "10px",
    background: "var(--color-tooltip)",
    color: "var(--color-on-tooltip)",
    boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    lineHeight: "1",
    whiteSpace: "nowrap",
  },
  ".cm-fmt-btn": {
    minWidth: "30px",
    height: "30px",
    padding: "0 8px",
    border: "none",
    borderRadius: "6px",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    cursor: "default",
  },
  ".cm-fmt-btn:hover, .cm-fmt-btn[aria-pressed=true]": { background: "rgb(127 127 127 / 0.28)" },
  ".cm-fmt-bold, .cm-fmt-italic, .cm-fmt-strike": { fontFamily: "var(--font-serif)", fontSize: "17px", padding: "0" },
  ".cm-fmt-bold": { fontWeight: "700" },
  ".cm-fmt-italic": { fontStyle: "italic" },
  ".cm-fmt-strike": { textDecoration: "line-through" },
  ".cm-fmt-wiki": { fontFamily: "var(--font-mono)", fontSize: "12px" },
  ".cm-fmt-divider": { width: "1px", height: "18px", margin: "0 3px", background: "currentColor", opacity: "0.22" },
  ".cm-fmt-block": { position: "relative" },
  ".cm-fmt-blocklabel": { padding: "0 8px 0 10px" },
  ".cm-fmt-menu": {
    position: "absolute",
    top: "calc(100% + 8px)",
    left: "-4px",
    minWidth: "150px",
    padding: "4px",
    borderRadius: "10px",
    background: "var(--color-tooltip)",
    boxShadow: "0 10px 30px rgb(0 0 0 / 0.18)",
    display: "flex",
    flexDirection: "column",
  },
  ".cm-fmt-menu[hidden]": { display: "none" },
  ".cm-fmt-menuitem": { justifyContent: "flex-start", width: "100%", padding: "0 10px" },
  ".cm-fmt-h1": { fontFamily: "var(--font-serif)", fontSize: "18px" },
  ".cm-fmt-h2": { fontFamily: "var(--font-serif)", fontSize: "16px" },
  ".cm-fmt-h3": { fontFamily: "var(--font-serif)", fontSize: "15px" },
  ".cm-fmt-quote": { fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: "15px" },
});

export const formatToolbar = [toolbarField, formatToolbarTheme];
