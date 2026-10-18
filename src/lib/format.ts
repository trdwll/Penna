import type { TreeNode } from "../services/tauri";

const NOTE_EXT = /\.(md|markdown)$/i;

/** Last segment of a `/` or `\` path. */
export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** `Projects/Plan.md` → `Plan`. */
export function noteTitle(path: string): string {
  return basename(path).replace(NOTE_EXT, "");
}

/** `Projects/2026/Plan.md` → `Projects/2026`; root notes → `""`. */
export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Words in a Markdown note, ignoring syntax characters and front matter. */
export function wordCount(text: string): number {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, "");
  const words = body.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu);
  return words ? words.length : 0;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "long" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 864e5],
  ["month", 30 * 864e5],
  ["week", 7 * 864e5],
  ["day", 864e5],
  ["hour", 36e5],
  ["minute", 6e4],
];

/** "just now", "4 minutes ago", "yesterday". */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = ms - now;
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size) return relative.format(Math.round(diff / size), unit);
  }
  return "just now";
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** "09:50" today, "Oct 14" otherwise. */
export function shortTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  return d.toDateString() === new Date(now).toDateString() ? clock.format(d) : day.format(d);
}

/** "Sep 30" or "Sep 30, 2025" when it's another year. */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return d.getFullYear() === new Date().getFullYear()
    ? day.format(d)
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(d);
}

/** Every note path in the tree, depth first. */
export function notePaths(tree: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "file") out.push(node.path);
      else walk(node.children);
    }
  };
  walk(tree);
  return out;
}

/**
 * Resolve a wiki-link target (`Merge UX`, `Projects/Merge UX`, `Merge UX.md`)
 * to a note path, ignoring case. Returns `null` when no note matches.
 */
export function resolveWikiLink(target: string, paths: string[]): string | null {
  const wanted = target.trim().replace(NOTE_EXT, "").toLowerCase();
  if (!wanted) return null;
  const byPath = paths.find((p) => p.replace(NOTE_EXT, "").toLowerCase() === wanted);
  if (byPath) return byPath;
  return paths.find((p) => noteTitle(p).toLowerCase() === wanted) ?? null;
}

/** Every folder path in the tree, depth first (`Projects`, `Projects/2026`, …). */
export function folderPaths(tree: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "dir") {
        out.push(node.path);
        walk(node.children);
      }
    }
  };
  walk(tree);
  return out;
}

/**
 * Join a note's folder and a relative link, resolving `.` and `..` (the
 * backend resolves links the same way when it rewrites them). `null` when
 * the link leaves the vault.
 */
export function joinPath(folder: string, rel: string): string | null {
  if (rel.startsWith("/")) return null;
  const parts = folder.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

/** Strip characters Windows forbids in names, and trailing dots and spaces. */
function cleanSegment(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s
    .replace(/[<>:"|?*\u0000-\u001f]/g, "")
    .replace(/[. ]+$/, "")
    .trim();
}

/**
 * Turn a typed name into a vault-relative note path: `Ideas/new plan` →
 * `Ideas/new plan.md`. Strips characters Windows forbids; Rust re-validates.
 */
export function notePathFromInput(input: string): string {
  const segments = input.split(/[\\/]/).map(cleanSegment).filter(Boolean);
  if (segments.length === 0) throw new Error("Enter a note name");
  const last = segments.length - 1;
  if (!NOTE_EXT.test(segments[last])) segments[last] += ".md";
  return segments.join("/");
}

/**
 * Where a note goes when renamed to `input`: the same folder and extension,
 * unless the input names a folder too (`Archive/Plan`).
 */
export function renameTarget(from: string, input: string): string {
  const name = input.trim();
  if (/[\\/]/.test(name)) return notePathFromInput(name);
  if (!cleanSegment(name.replace(NOTE_EXT, ""))) throw new Error("Enter a name");
  const file = notePathFromInput(NOTE_EXT.test(name) ? name : name + (NOTE_EXT.exec(from)?.[0] ?? ".md"));
  const folder = folderOf(from);
  return folder ? `${folder}/${file}` : file;
}

/** Where a folder goes when renamed to `input`: beside where it is, unless the input names a path (`Archive/2026`). */
export function folderRenameTarget(from: string, input: string): string {
  const name = input.trim();
  const segments = name.split(/[\\/]/).map(cleanSegment).filter(Boolean);
  if (!segments.length) throw new Error("Enter a name");
  if (/[\\/]/.test(name)) return segments.join("/");
  const parent = folderOf(from);
  return parent ? `${parent}/${segments[0]}` : segments[0];
}

/** A note's path after moving it into `folder` (`""` is the top of the vault). */
export function moveTarget(from: string, folder: string): string {
  const clean = folder.split(/[\\/]/).map(cleanSegment).filter(Boolean).join("/");
  return clean ? `${clean}/${basename(from)}` : basename(from);
}

/** Default message for versions saved by the Sync button. */
export function backupMessage(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const dayPart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `Vault backup ${dayPart} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
