/**
 * Turns two versions of a note into lines for the History view: unchanged
 * context, added lines, removed lines, and edited lines with the exact words
 * that changed. Long unchanged stretches fold into a "N unchanged lines" gap.
 */
import { presentableDiff } from "@codemirror/merge";

export type Segment = { text: string; kind: "same" | "added" | "removed" };

export type DiffLine =
  | { kind: "same"; text: string }
  | { kind: "added"; text: string }
  | { kind: "removed"; text: string }
  | { kind: "edited"; segments: Segment[] }
  | { kind: "gap"; count: number };

const split = (text: string | null) => (text ?? "").replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");

type Op = { kind: "same" | "added" | "removed"; text: string };

/** Line-level diff (LCS). Notes are small, so O(n·m) is fine; very long notes fall back to a coarse diff. */
function lineDiff(a: string[], b: string[]): Op[] {
  if (a.length * b.length > 4_000_000) {
    return [...a.map((text) => ({ kind: "removed" as const, text })), ...b.map((text) => ({ kind: "added" as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "removed", text: a[i++] });
    } else {
      ops.push({ kind: "added", text: b[j++] });
    }
  }
  while (i < n) ops.push({ kind: "removed", text: a[i++] });
  while (j < m) ops.push({ kind: "added", text: b[j++] });
  return ops;
}

/** Word-level segments for a line that changed. */
function wordDiff(before: string, after: string): Segment[] {
  const segments: Segment[] = [];
  let posA = 0;
  let posB = 0;
  for (const change of presentableDiff(before, after)) {
    if (change.fromB > posB) segments.push({ kind: "same", text: after.slice(posB, change.fromB) });
    if (change.toA > change.fromA) segments.push({ kind: "removed", text: before.slice(change.fromA, change.toA) });
    if (change.toB > change.fromB) segments.push({ kind: "added", text: after.slice(change.fromB, change.toB) });
    posA = change.toA;
    posB = change.toB;
  }
  if (posB < after.length) segments.push({ kind: "same", text: after.slice(posB) });
  void posA;
  return segments;
}

/** Do two lines share enough to be shown as one edited line? */
function similar(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false;
  const same = wordDiff(a, b)
    .filter((s) => s.kind === "same")
    .reduce((n, s) => n + s.text.trim().length, 0);
  return same / Math.max(a.length, b.length) >= 0.4;
}

/**
 * Lines to render for a note that went from `before` to `after`.
 * `context` unchanged lines are kept around each change; the rest fold.
 */
export function proseDiff(before: string | null, after: string | null, context = 2): DiffLine[] {
  const ops = lineDiff(before === null ? [] : split(before), after === null ? [] : split(after));

  // Pair runs of removed+added lines into edited lines where they're similar.
  const lines: DiffLine[] = [];
  for (let k = 0; k < ops.length; ) {
    if (ops[k].kind === "same") {
      lines.push({ kind: "same", text: ops[k].text });
      k++;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    while (k < ops.length && ops[k].kind === "removed") removed.push(ops[k++].text);
    while (k < ops.length && ops[k].kind === "added") added.push(ops[k++].text);
    const pairs = Math.min(removed.length, added.length);
    for (let p = 0; p < pairs; p++) {
      if (similar(removed[p], added[p])) {
        lines.push({ kind: "edited", segments: wordDiff(removed[p], added[p]) });
      } else {
        lines.push({ kind: "removed", text: removed[p] }, { kind: "added", text: added[p] });
      }
    }
    for (const text of removed.slice(pairs)) lines.push({ kind: "removed", text });
    for (const text of added.slice(pairs)) lines.push({ kind: "added", text });
  }

  // Fold unchanged stretches, keeping `context` lines next to each change.
  const keep = lines.map((line) => line.kind !== "same");
  const changed = keep.slice();
  for (let i = 0; i < lines.length; i++) {
    if (!changed[i]) continue;
    for (let d = 1; d <= context; d++) {
      if (i - d >= 0) keep[i - d] = true;
      if (i + d < lines.length) keep[i + d] = true;
    }
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < lines.length; ) {
    if (keep[i]) {
      out.push(lines[i++]);
      continue;
    }
    let count = 0;
    while (i < lines.length && !keep[i]) {
      count++;
      i++;
    }
    out.push({ kind: "gap", count });
  }
  return out;
}

/** "1 line changed, 2 added" for a file header. */
export function summarize(lines: DiffLine[]): string {
  let edited = 0;
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "edited") edited++;
    else if (line.kind === "added") added++;
    else if (line.kind === "removed") removed++;
  }
  const parts = [
    edited && `${edited} ${edited === 1 ? "line" : "lines"} changed`,
    added && `${added} added`,
    removed && `${removed} removed`,
  ].filter(Boolean);
  return parts.join(", ") || "No text changes";
}
