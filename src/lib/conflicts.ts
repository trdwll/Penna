/**
 * Git's conflict markers in a note, written when a sync finds both devices
 * changed the same lines:
 *
 *     <<<<<<< This PC's device name
 *     this device's text
 *     =======
 *     the other device's text
 *     >>>>>>> The other device's name
 *
 * (A `||||||| base` section, from the diff3 style, is accepted and ignored.)
 */

export interface ConflictBlock {
  /** Start of the `<<<<<<<` line. */
  from: number;
  /** End of the `>>>>>>>` line (before its line break). */
  to: number;
  ours: string;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
}

const OPEN = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: .*)?$/;
const SPLIT = /^={7}\s*$/;
const CLOSE = /^>{7}(?: (.*))?$/;

/** Every complete conflict block, in order. Line breaks inside versions are kept as written. */
export function findConflicts(text: string): ConflictBlock[] {
  if (!text.includes("<<<<<<<")) return [];
  const out: ConflictBlock[] = [];
  type Part = "ours" | "base" | "theirs";
  let open: { from: number; label: string; part: Part; ours: string[]; theirs: string[] } | null = null;
  let pos = 0;
  for (const raw of text.split("\n")) {
    const lineStart = pos;
    pos += raw.length + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const lineEnd = lineStart + line.length;
    let m: RegExpExecArray | null;
    if ((m = OPEN.exec(line))) {
      open = { from: lineStart, label: (m[1] ?? "").trim(), part: "ours", ours: [], theirs: [] };
    } else if (!open) {
      continue;
    } else if (open.part === "ours" && BASE.test(line)) {
      open.part = "base";
    } else if (open.part !== "theirs" && SPLIT.test(line)) {
      open.part = "theirs";
    } else if (open.part === "theirs" && (m = CLOSE.exec(line))) {
      out.push({
        from: open.from,
        to: lineEnd,
        ours: open.ours.join("\n"),
        theirs: open.theirs.join("\n"),
        oursLabel: open.label,
        theirsLabel: (m[1] ?? "").trim(),
      });
      open = null;
    } else if (open.part === "ours") {
      open.ours.push(line);
    } else if (open.part === "theirs") {
      open.theirs.push(line);
    }
  }
  return out;
}

export const countConflicts = (text: string) => findConflicts(text).length;

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s/;

/**
 * Both versions, this device's first. Paragraphs get a blank line between
 * them; list items stay one list.
 */
export function keepBoth(ours: string, theirs: string, lineBreak = "\n"): string {
  if (!ours.trim()) return theirs;
  if (!theirs.trim()) return ours;
  const list = LIST_ITEM.test(ours) && LIST_ITEM.test(theirs);
  return [ours, theirs].join(lineBreak.repeat(list ? 1 : 2));
}

/** What a place in a note is called in lists: the heading above it, or "Top of the note". */
export function placeName(text: string, at: number): string {
  const before = text.slice(0, at).split("\n");
  for (let i = before.length - 1; i >= 0; i--) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(before[i].replace(/\r$/, ""));
    if (h) return h[1];
  }
  return "Top of the note";
}
