/**
 * The note editor: CodeMirror 6 with Margin's Preview (WYSIWYG) and Source
 * modes, an optional Changes overlay, and debounced auto-save.
 *
 * The parent remounts this component (via `key`) to switch notes, so each
 * instance edits one file with its own undo history. Mode and Changes are
 * swapped in place through compartments, so toggling them keeps the cursor,
 * scroll position and undo history.
 *
 * Side-by-side Changes (Source only) uses a two-editor MergeView: the old
 * text on the left, read-only, and this note on the right. Switching layouts
 * rebuilds the editor around the same text, selection and undo history.
 *
 * Save rules: saves fire `autoSaveDelayMs` after the last keystroke, on blur,
 * on Ctrl+S, on `flush()`, and on unmount. They're queued so writes land in
 * order. A failed save keeps the edits and the next edit retries. CRLF files
 * stay CRLF.
 */
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { Compartment, EditorSelection, EditorState, Prec, Text, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { MergeView, getChunks, getOriginalDoc, unifiedMergeView } from "@codemirror/merge";
import { useLatest } from "../lib/hooks";
import { blockKeymap } from "./blocks";
import { codeBlockLines } from "./codeBlocks";
import {
  conflictState,
  conflictView,
  conflictsInfo,
  moveToConflict,
  setConflictLabels,
  type ConflictLabels,
  type ConflictsInfo,
} from "./conflicts";
import { dropCaret, insertAttachments, pasteFiles, setDropCaret, type FileHandlers } from "./fileDrop";
import { insertCompletions, insertSnippet } from "./insertMenu";
import { Highlight } from "./highlight";
import { formatKeymap } from "./markdownCommands";
import { fileContextMenu, frontmatterEnd, livePreview, refreshPreview, type LinkHandlers } from "./livePreview";
import { originalSide, splitSide, unchangedPhrase } from "./splitDiff";
import { baseTheme, previewHighlight, previewTheme, sourceHighlight, sourceTheme } from "./theme";

export type SaveStatus = "saved" | "dirty" | "saving" | "error";
export type ViewMode = "preview" | "source";
export type DiffLayout = "unified" | "split";

export interface ChangeChunk {
  kind: "added" | "removed" | "edited";
  /** 1-based line in the current text. */
  line: number;
  /** Document position to jump to. */
  pos: number;
}

export interface ChangesInfo {
  chunks: ChangeChunk[];
  /** Index of the chunk at or after the cursor; -1 when there are none. */
  current: number;
  added: number;
  removed: number;
}

export interface EditorHandle {
  /** Save pending edits now. Resolves once the write finishes (or fails). */
  flush: () => Promise<void>;
  scrollTo: (pos: number) => void;
  nextChange: () => void;
  previousChange: () => void;
  /** Replace the whole text (undoable with Ctrl+Z). */
  replaceAll: (text: string) => void;
  focus: () => void;
  /** Select the first occurrence of `text` (case-insensitive) and scroll to it. */
  reveal: (text: string) => void;
  /** Show where files dropped at this window point would land; null hides it. */
  dropHint: (point: { x: number; y: number } | null) => void;
  /** Insert the Markdown for new attachments at a window point (or at the cursor when null). */
  insertFiles: (point: { x: number; y: number } | null, markdown: string) => void;
  /** Put the cursor at the start of a 1-based line and scroll it to the top. */
  scrollToLine: (line: number) => void;
  /** Put the cursor at a document position and scroll to it. */
  setCursor: (pos: number) => void;
  /** Insert text where the selection is, with the cursor at `cursor` within it (or after it). */
  insertSnippet: (text: string, cursor: number | null) => void;
  /** Draw images and links again (a file they show was renamed, replaced or deleted). */
  refresh: () => void;
  /** Go to the next / previous place that still has both versions after a sync conflict. */
  nextConflict: () => void;
  previousConflict: () => void;
}

interface EditorProps {
  initialContent: string;
  mode: ViewMode;
  /** Text to compare against. `undefined` turns Changes off; `""` means the note is new. */
  changesBase: string | undefined;
  /** How Changes shows in Source: one column, or old and new side by side. */
  layout?: DiffLayout;
  onSave: (content: string) => Promise<void>;
  onStatusChange?: (status: SaveStatus) => void;
  /** Called (debounced) with the current text, for the outline and word count. */
  onTextChange?: (text: string) => void;
  onChangesInfo?: (info: ChangesInfo | null) => void;
  links: LinkHandlers;
  /** Vault-relative note paths, for `[[` suggestions. */
  getNotes: () => string[];
  /** Pasting images and picking files to add. */
  files?: FileHandlers;
  /** After a sync conflict: how the two versions are introduced. */
  conflictLabels?: ConflictLabels | null;
  /** Places in this note that still have both versions, and the ones chosen. */
  onConflictsInfo?: (info: ConflictsInfo | null) => void;
  /** Browser spell checking (Settings → Editor). */
  spellcheck?: boolean;
  /** Keep CRLF files CRLF when saving (Settings → Editor). */
  keepCrlf?: boolean;
  autoSaveDelayMs?: number;
  /** Take the keyboard when it opens (not for the note beside, so writing carries on). */
  autoFocus?: boolean;
  ref?: Ref<EditorHandle>;
}

/** Extensions shared by every editor instance (they hold no per-note state). */
const baseExtensions: Extension[] = [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  rectangularSelection(),
  highlightSelectionMatches(),
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ "aria-label": "Note" }),
  // GFM plus ==highlight==, with lazily loaded code-block languages, inside optional YAML front matter.
  yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: languages, extensions: [Highlight] }) }),
  codeBlockLines,
  conflictState,
  baseTheme,
  placeholder("Start writing…"),
  keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
];

/** Side by side only applies to Changes in Source. */
const isSplit = (layout: DiffLayout, mode: ViewMode, base: string | undefined) =>
  layout === "split" && mode === "source" && base !== undefined;

function modeExtensions(mode: ViewMode, links: LinkHandlers): Extension {
  return mode === "preview"
    ? [previewTheme, syntaxHighlighting(previewHighlight), livePreview(links), conflictView("preview"), fileContextMenu(links)]
    : [sourceTheme, syntaxHighlighting(sourceHighlight), conflictView("source"), fileContextMenu(links)];
}

function changesExtensions(mode: ViewMode, base: string | undefined): Extension {
  if (base === undefined) return [];
  return [
    unifiedMergeView({
      original: Text.of(base.split(/\r\n|\r|\n/)),
      mergeControls: false,
      gutter: true,
      highlightChanges: true,
      allowInlineDiffs: mode === "preview",
      syntaxHighlightDeletions: mode === "source",
      collapseUnchanged: mode === "source" ? { margin: 3, minSize: 4 } : undefined,
    }),
    mode === "source" ? lineNumbers() : [],
    unchangedPhrase,
    EditorView.editorAttributes.of({ class: "cm-show-changes" }),
  ];
}

const spellAttr = (on: boolean) => EditorView.contentAttributes.of({ spellcheck: String(on) });

/** The unified view keeps the old text in its state; the side-by-side view keeps it in the left editor. */
function unifiedOriginal(state: EditorState): Text | null {
  try {
    return getOriginalDoc(state);
  } catch {
    return null;
  }
}

function changesInfo(state: EditorState, original: Text | null): ChangesInfo | null {
  const result = getChunks(state);
  if (!result) return null;
  const { doc } = state;
  const head = state.selection.main.head;
  let added = 0;
  let removed = 0;
  let current = -1;
  const chunks: ChangeChunk[] = result.chunks.map((chunk, i) => {
    const hasA = chunk.toA > chunk.fromA;
    const hasB = chunk.toB > chunk.fromB;
    if (hasA && original) removed += original.lineAt(chunk.endA).number - original.lineAt(chunk.fromA).number + 1;
    if (hasB) added += doc.lineAt(chunk.endB).number - doc.lineAt(chunk.fromB).number + 1;
    if (current === -1 && chunk.endB >= head) current = i;
    const pos = Math.min(chunk.fromB, doc.length);
    return {
      kind: hasA && hasB ? "edited" : hasB ? "added" : "removed",
      line: doc.lineAt(pos).number,
      pos,
    };
  });
  if (current === -1 && chunks.length) current = chunks.length - 1;
  return { chunks, current, added, removed };
}

export default function Editor({
  initialContent,
  mode,
  changesBase,
  layout = "unified",
  onSave,
  onStatusChange,
  onTextChange,
  onChangesInfo,
  links,
  getNotes,
  files,
  conflictLabels = null,
  onConflictsInfo,
  spellcheck = true,
  keepCrlf = true,
  autoSaveDelayMs = 800,
  autoFocus = true,
  ref,
}: EditorProps) {
  const getNotesRef = useLatest(getNotes);
  const hostRef = useRef<HTMLDivElement>(null);
  /** The editable view: the only one, or the right side of the merge view. */
  const viewRef = useRef<EditorView | null>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const rebuildRef = useRef<(split: boolean, mode: ViewMode, base: string | undefined) => void>(() => {});
  const modeCompartment = useRef(new Compartment());
  const changesCompartment = useRef(new Compartment());
  const spellCompartment = useRef(new Compartment());
  const spellRef = useLatest(spellcheck);
  const initialKeepCrlf = useRef(keepCrlf);

  const onSaveRef = useLatest(onSave);
  const onStatusRef = useLatest(onStatusChange);
  const onTextRef = useLatest(onTextChange);
  const onChangesRef = useLatest(onChangesInfo);
  const linksRef = useLatest(links);
  const filesRef = useLatest(files);
  const onConflictsRef = useLatest(onConflictsInfo);
  const labelsRef = useLatest(conflictLabels);
  /** Calls through to the latest handlers, so extensions never hold stale ones. */
  const handlers = useRef<LinkHandlers>({
    openWikiLink: (target, other) => linksRef.current.openWikiLink(target, other),
    openUrl: (url, other) => linksRef.current.openUrl(url, other),
    imageUrl: (src, embed, from) => linksRef.current.imageUrl(src, embed, from),
    embedNote: (target) => linksRef.current.embedNote?.(target) ?? null,
    readNote: (path) => linksRef.current.readNote?.(path) ?? Promise.reject(new Error("no notes")),
    fileMenu: (src, embed, at) => linksRef.current.fileMenu?.(src, embed, at) ?? false,
    openTag: (tag) => linksRef.current.openTag?.(tag),
  }).current;
  // Initial values for the mount effect; later changes go through compartments.
  const initialMode = useRef(mode);
  const initialFocus = useRef(autoFocus);
  const initialBase = useRef(changesBase);
  const initialLayout = useRef(layout);

  const originalOf = (state: EditorState) => mergeRef.current?.a.state.doc ?? unifiedOriginal(state);

  useImperativeHandle(
    ref,
    () => ({
      flush: () => flushRef.current(),
      scrollTo: (pos) => {
        const view = viewRef.current;
        if (!view) return;
        const at = Math.min(pos, view.state.doc.length);
        view.dispatch({
          selection: EditorSelection.cursor(at),
          effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 96 }),
        });
        view.focus();
      },
      nextChange: () => moveToChange(1),
      previousChange: () => moveToChange(-1),
      replaceAll: (text) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      },
      focus: () => viewRef.current?.focus(),
      reveal: (text) => {
        const view = viewRef.current;
        const needle = text.trim().toLowerCase();
        if (!view || !needle) return;
        const at = view.state.doc.toString().toLowerCase().indexOf(needle);
        if (at < 0) return;
        view.dispatch({
          selection: EditorSelection.range(at, at + needle.length),
          effects: EditorView.scrollIntoView(at, { y: "center" }),
        });
        view.focus();
      },
      dropHint: (point) => {
        const view = viewRef.current;
        if (!view) return;
        const pos = point ? view.posAtCoords(point, false) : null;
        view.dispatch({ effects: setDropCaret.of(pos) });
      },
      scrollToLine: (line) => {
        const view = viewRef.current;
        if (!view) return;
        const at = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from;
        view.dispatch({
          selection: EditorSelection.cursor(at),
          effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 96 }),
        });
        view.focus();
      },
      setCursor: (pos) => {
        const view = viewRef.current;
        if (!view) return;
        const at = Math.max(0, Math.min(pos, view.state.doc.length));
        view.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: "center" }) });
        view.focus();
      },
      insertSnippet: (text, cursor) => {
        const view = viewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        insertSnippet(view, from, to, text, cursor);
      },
      refresh: () => {
        viewRef.current?.dispatch({ effects: refreshPreview.of(null) });
      },
      nextConflict: () => {
        if (viewRef.current) moveToConflict(viewRef.current, 1);
      },
      previousConflict: () => {
        if (viewRef.current) moveToConflict(viewRef.current, -1);
      },
      insertFiles: (point, markdown) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ effects: setDropCaret.of(null) });
        const pos = (point && view.posAtCoords(point)) ?? view.state.selection.main.head;
        insertAttachments(view, pos, markdown);
      },
    }),
    [],
  );

  /** Returns false when there are no changes, so Alt+↑/↓ falls back to moving lines. */
  function moveToChange(dir: 1 | -1): boolean {
    const view = viewRef.current;
    if (!view) return false;
    const info = changesInfo(view.state, null);
    if (!info || !info.chunks.length) return false;
    const head = view.state.selection.main.head;
    const target =
      dir > 0
        ? (info.chunks.find((c) => c.pos > head) ?? info.chunks[0])
        : ([...info.chunks].reverse().find((c) => c.pos < head) ?? info.chunks[info.chunks.length - 1]);
    view.dispatch({
      selection: EditorSelection.cursor(target.pos),
      effects: EditorView.scrollIntoView(target.pos, { y: "center" }),
    });
    view.focus();
    return true;
  }

  // Mount once per note.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let lastSaved = initialContent;
    let status: SaveStatus = "saved";
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    let textTimer: ReturnType<typeof setTimeout> | undefined;
    let queue: Promise<void> = Promise.resolve();
    let disposed = false;

    const setStatus = (next: SaveStatus) => {
      if (disposed || next === status) return;
      status = next;
      onStatusRef.current?.(next);
    };

    // sliceDoc() (not doc.toString()) honors the lineSeparator facet, so CRLF stays CRLF.
    const currentText = () => viewRef.current?.state.sliceDoc() ?? lastSaved;

    const flush = (): Promise<void> => {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      const content = currentText();
      queue = queue.then(async () => {
        if (content === lastSaved) return;
        setStatus("saving");
        try {
          await onSaveRef.current(content);
          lastSaved = content;
          setStatus(currentText() === lastSaved ? "saved" : "dirty");
        } catch {
          setStatus("error"); // the parent reports the message; the next edit retries
        }
      });
      return queue;
    };

    const reportChanges = (state: EditorState) => {
      if (!disposed) onChangesRef.current?.(changesInfo(state, originalOf(state)));
    };
    let lastConflicts = "";
    const reportConflicts = (state: EditorState) => {
      const info = conflictsInfo(state);
      const key = JSON.stringify(info);
      if (disposed || key === lastConflicts) return;
      lastConflicts = key;
      onConflictsRef.current?.(info);
    };

    const links = handlers;

    // With "Keep Windows line endings" off, CRLF notes are saved as LF.
    const crlf = initialContent.includes("\r\n") && initialKeepCrlf.current;
    const start = frontmatterEnd(initialContent.replace(/\r\n/g, "\n"));

    /** The editable note's extensions. `carried` hands over undo history when the layout switches. */
    const noteExtensions = (split: boolean, mode: ViewMode, base: string | undefined, carried?: EditorState): Extension => [
      baseExtensions,
      crlf ? EditorState.lineSeparator.of("\r\n") : [],
      modeCompartment.current.of(modeExtensions(split ? "source" : mode, links)),
      changesCompartment.current.of(split ? splitSide : changesExtensions(mode, base)),
      spellCompartment.current.of(spellAttr(spellRef.current)),
      // Ahead of the default keymap (whose Ctrl+I selects the parent syntax node).
      Prec.high(
        keymap.of([
          ...formatKeymap,
          ...blockKeymap,
          { key: "Mod-s", preventDefault: true, run: () => (void flush(), true) },
          { key: "Alt-ArrowDown", run: (v) => moveToChange(1) || moveToConflict(v, 1) },
          { key: "Alt-ArrowUp", run: (v) => moveToChange(-1) || moveToConflict(v, -1) },
        ]),
      ),
      insertCompletions(
        () => getNotesRef.current(),
        () => filesRef.current?.pickFiles() ?? Promise.resolve(""),
        () => filesRef.current?.pickTemplate?.() ?? Promise.resolve(null),
      ),
      pasteFiles(() => filesRef.current),
      dropCaret,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          setStatus("dirty");
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => void flush(), autoSaveDelayMs);
          clearTimeout(textTimer);
          textTimer = setTimeout(() => onTextRef.current?.(currentText()), 250);
        }
        if (update.docChanged || update.selectionSet || update.transactions.some((t) => t.reconfigured)) {
          reportChanges(update.state);
        }
        if (update.docChanged || update.selectionSet) reportConflicts(update.state);
      }),
      EditorView.domEventHandlers({ blur: () => void flush() }),
      carried ? historyField.init(() => carried.field(historyField)) : [],
    ];

    const build = (split: boolean, mode: ViewMode, base: string | undefined, carried?: EditorState) => {
      const doc = carried ? carried.doc : initialContent;
      const selection = carried ? carried.selection : EditorSelection.cursor(Math.min(start, initialContent.length));
      if (split) {
        const merge = new MergeView({
          a: { doc: base ?? "", extensions: originalSide },
          b: { doc, selection, extensions: noteExtensions(true, mode, base, carried) },
          parent: host,
          gutter: false,
          highlightChanges: true,
          collapseUnchanged: { margin: 3, minSize: 4 },
        });
        mergeRef.current = merge;
        viewRef.current = merge.b;
      } else {
        mergeRef.current = null;
        viewRef.current = new EditorView({
          parent: host,
          state: EditorState.create({ doc, selection, extensions: noteExtensions(false, mode, base, carried) }),
        });
      }
    };

    rebuildRef.current = (split, mode, base) => {
      const old = viewRef.current;
      if (!old) return;
      const hadFocus = old.hasFocus;
      const carried = old.state;
      (mergeRef.current ?? old).destroy();
      build(split, mode, base, carried);
      const view = viewRef.current!;
      view.dispatch({
        effects: [
          EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }),
          setConflictLabels.of(labelsRef.current ?? null),
        ],
      });
      if (hadFocus) view.focus();
      reportChanges(view.state);
    };

    build(isSplit(initialLayout.current, initialMode.current, initialBase.current), initialMode.current, initialBase.current);
    flushRef.current = flush;
    viewRef.current!.dispatch({ effects: setConflictLabels.of(labelsRef.current ?? null) });
    reportChanges(viewRef.current!.state);
    reportConflicts(viewRef.current!.state);
    if (initialFocus.current) viewRef.current!.focus();

    return () => {
      void flush(); // persist anything still pending before the view goes away
      disposed = true;
      clearTimeout(textTimer);
      flushRef.current = () => Promise.resolve();
      rebuildRef.current = () => {};
      (mergeRef.current ?? viewRef.current)?.destroy();
      mergeRef.current = null;
      viewRef.current = null;
    };
    // Mount once per note; the parent changes `key` to load a different file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: spellCompartment.current.reconfigure(spellAttr(spellcheck)) });
  }, [spellcheck]);

  // Labels arrive once the paused sync's details load.
  const labelsKey = conflictLabels ? `${conflictLabels.ours}|${conflictLabels.theirs}|${conflictLabels.theirsName}` : "";
  useEffect(() => {
    viewRef.current?.dispatch({ effects: setConflictLabels.of(labelsRef.current ?? null) });
  }, [labelsKey, labelsRef]);

  // Swap mode / Changes / layout in place.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const split = isSplit(layout, mode, changesBase);
    const merge = mergeRef.current;
    if (split !== !!merge) {
      rebuildRef.current(split, mode, changesBase);
      return;
    }
    if (merge) {
      // Still side by side, but maybe against another version: swap the left side's text.
      const next = (changesBase ?? "").replace(/\r\n?/g, "\n");
      const a = merge.a;
      if (a.state.doc.toString() !== next) a.dispatch({ changes: { from: 0, to: a.state.doc.length, insert: next } });
    } else {
      view.dispatch({
        effects: [
          modeCompartment.current.reconfigure(modeExtensions(mode, handlers)),
          changesCompartment.current.reconfigure(changesExtensions(mode, changesBase)),
        ],
      });
    }
    // The merge view builds its chunks after the reconfigure settles.
    const id = requestAnimationFrame(() => {
      const current = viewRef.current;
      if (current) onChangesRef.current?.(changesInfo(current.state, originalOf(current.state)));
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, changesBase, layout, linksRef, onChangesRef]);

  return <div ref={hostRef} />;
}
