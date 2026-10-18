/**
 * Tags for the Tags view: counts (a nested tag like `sync/mobile` also counts
 * toward `sync`), the tag list as a tree, narrowing by more tags, and what a
 * rename would change. Tags are lowercase keys without `#`, as the Rust side
 * gives them.
 */
import type { Mention, TaggedNote } from "../services/tauri";

/** `tag` is `parent` itself or nested under it. */
export const isUnder = (tag: string, parent: string) => tag === parent || tag.startsWith(parent + "/");

/** `a/b/c` → `a`, `a/b`, `a/b/c`. */
function withParents(tag: string): string[] {
  const parts = tag.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Notes per tag, each note once, parents included. */
export function tagCounts(notes: readonly TaggedNote[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const all = new Set(note.tags.flatMap(withParents));
    for (const t of all) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

export interface TagRow {
  tag: string;
  /** The last part of a nested tag (`mobile` for `sync/mobile`). */
  label: string;
  depth: number;
  count: number;
  hasChildren: boolean;
}

export type TagSort = "count" | "name";

/**
 * The tag list: parents before their children, siblings by count or name.
 * Collapsed parents hide their children. With a filter, tags that contain it
 * show (with their parents), whatever is collapsed.
 */
export function tagRows(counts: Map<string, number>, sort: TagSort, collapsed: ReadonlySet<string>, filter: string): TagRow[] {
  const children = new Map<string, string[]>();
  for (const tag of counts.keys()) {
    const cut = tag.lastIndexOf("/");
    const parent = cut === -1 ? "" : tag.slice(0, cut);
    children.set(parent, [...(children.get(parent) ?? []), tag]);
  }
  const order = (a: string, b: string) =>
    sort === "count" ? (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b) : a.localeCompare(b);
  const q = filter.trim().replace(/^#/, "").toLowerCase();
  const shown = (tag: string): boolean => !q || tag.includes(q) || (children.get(tag) ?? []).some(shown);

  const rows: TagRow[] = [];
  const walk = (parent: string, depth: number) => {
    for (const tag of (children.get(parent) ?? []).sort(order)) {
      if (!shown(tag)) continue;
      const kids = children.get(tag) ?? [];
      rows.push({
        tag,
        label: depth ? tag.slice(tag.lastIndexOf("/") + 1) : tag,
        depth,
        count: counts.get(tag) ?? 0,
        hasChildren: kids.length > 0,
      });
      if (kids.length && (q || !collapsed.has(tag))) walk(tag, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

/** Notes with `tag` (or a tag under it), and every tag in `narrow` too. */
export function notesWith(notes: readonly TaggedNote[], tag: string, narrow: readonly string[]): TaggedNote[] {
  const has = (note: TaggedNote, t: string) => note.tags.some((x) => isUnder(x, t));
  return notes.filter((note) => has(note, tag) && narrow.every((t) => has(note, t)));
}

/** Other tags on these notes, most shared first: for "Also tagged". */
export function alsoTagged(notes: readonly TaggedNote[], tag: string, narrow: readonly string[], limit = 8): [string, number][] {
  const counts = new Map<string, number>();
  for (const note of notes) {
    for (const t of note.tags) {
      if (isUnder(t, tag) || narrow.some((n) => isUnder(t, n))) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit);
}

/** The lines where a note writes `tag` (or a tag under it), and how many times. */
export function mentionsOf(note: TaggedNote, tag: string): { lines: Mention[]; count: number } {
  const lines = note.mentions.filter((m) => m.tags.some((t) => isUnder(t, tag)));
  const count = lines.reduce((n, m) => n + m.tags.filter((t) => isUnder(t, tag)).length, 0);
  return { lines, count };
}

/** Why `input` can't be a tag name, or null. The same rules as the Rust side. */
export function tagProblem(input: string): string | null {
  const name = cleanTag(input);
  if (!name) return "Type a name for the tag.";
  if (!/^\p{L}/u.test(name)) return "Start with a letter.";
  if (!/^[\p{L}\p{N}_\-/]+$/u.test(name)) return "Use letters, numbers, - _ and / (no spaces).";
  if (name.includes("//")) return "Use one / between parts.";
  return null;
}

/** `#Sync/ ` → `Sync`. */
export const cleanTag = (input: string) =>
  input
    .trim()
    .replace(/^#+/, "")
    .replace(/^\/+|\/+$/g, "");

export interface RenamePreview {
  notes: number;
  inText: number;
  inProperties: number;
  /** Tags under the renamed one, which move with it. */
  nested: string[];
  /** Notes that already use the new name. */
  existing: number;
}

export function renamePreview(notes: readonly TaggedNote[], from: string, to: string): RenamePreview {
  const target = cleanTag(to).toLowerCase();
  const using = notesWith(notes, from, []);
  let inText = 0;
  let inProperties = 0;
  const nested = new Set<string>();
  for (const note of using) {
    inText += mentionsOf(note, from).count;
    inProperties += note.properties.filter((t) => isUnder(t, from)).length;
    for (const t of note.tags) if (t !== from && isUnder(t, from)) nested.add(t);
  }
  const existing = target && !isUnder(target, from) ? notes.filter((n) => n.tags.some((t) => isUnder(t, target))).length : 0;
  return { notes: using.length, inText, inProperties, nested: [...nested].sort(), existing };
}
