/**
 * Templates: notes in the vault's templates folder (Settings → Templates)
 * that start a new note, or get inserted into the open one. Placeholders
 * are filled in when they're used:
 *
 *   {{title}}               the note's name
 *   {{date}}                today, as 2026-10-18
 *   {{date:dddd, MMMM D}}   today, in your own format (the Daily notes title tokens)
 *   {{weekday}}, {{time}}   Sunday, 14:05
 *   {{cursor}}              where typing starts (the first one)
 *
 * The daily note's template uses the same filling, plus {{carryover}}.
 */
import { noteTitle } from "./format";
import { formatDate } from "./settings";

export const CURSOR = "{{cursor}}";

const pad = (n: number) => String(n).padStart(2, "0");

/** Fill {{title}}, {{date}}, {{date:FORMAT}}, {{weekday}} and {{time}}. */
export function fillPlaceholders(text: string, values: { title: string; date: Date; now?: Date }): string {
  const now = values.now ?? new Date();
  const iso = `${values.date.getFullYear()}-${pad(values.date.getMonth() + 1)}-${pad(values.date.getDate())}`;
  return text
    .replace(/\{\{date:([^}\n]+)\}\}/g, (_, format: string) => formatDate(values.date, format.trim()))
    .replaceAll("{{title}}", () => values.title)
    .replaceAll("{{date}}", () => iso)
    .replaceAll("{{weekday}}", () => formatDate(values.date, "dddd"))
    .replaceAll("{{time}}", () => `${pad(now.getHours())}:${pad(now.getMinutes())}`);
}

/** Where the first {{cursor}} was, with every one taken out. */
export function takeCursor(text: string): { text: string; cursor: number | null } {
  const at = text.indexOf(CURSOR);
  return { text: text.replaceAll(CURSOR, ""), cursor: at === -1 ? null : at };
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** A template's text for a new note called `title`. */
export function fromTemplate(template: string, title: string, now = new Date()) {
  return takeCursor(fillPlaceholders(template.replaceAll("{{carryover}}", ""), { title, date: now, now }));
}

/** A template's text to insert into the note `title`: without its front matter. */
export function forInsert(template: string, title: string, now = new Date()) {
  return fromTemplate(template.replace(FRONTMATTER, "").replace(/^(\r?\n)+/, ""), title, now);
}

/** The notes in the templates folder (and folders inside it), by name. */
export function templatePaths(paths: readonly string[], folder: string): string[] {
  const f = folder
    .trim()
    .replace(/^[\\/]+|[\\/]+$/g, "")
    .toLowerCase();
  if (!f) return [];
  return paths
    .filter((p) => p.toLowerCase().startsWith(`${f}/`))
    .sort((a, b) => noteTitle(a).localeCompare(noteTitle(b)) || a.localeCompare(b));
}

/** The first line of a template's text worth showing in a list (no front matter, no heading marks). */
export function templateExcerpt(text: string): string {
  const lines = text
    .replace(FRONTMATTER, "")
    .replaceAll(CURSOR, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?|>\s*|\d+[.)]\s+)/, "").trim())
    .filter((l) => l && !/^\{\{(title|cursor)\}\}$/.test(l) && !/^[-*_]{3,}$/.test(l));
  return lines[0] ?? "";
}

/** A name for a note started from `template`: "Meeting 2026-10-18". */
export function defaultName(template: string, now = new Date()): string {
  return `${noteTitle(template)} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What "Make a template" starts with. */
export const STARTER_TEMPLATE = `# {{title}}

{{date:dddd, MMMM D}}

{{cursor}}
`;
