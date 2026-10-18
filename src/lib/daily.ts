/**
 * Daily notes: `Journal/2026-10-17.md`, titled "Saturday, October 17".
 *
 * File names use ISO dates so they sort and sync cleanly; the app shows them
 * by their friendly title. The folder and template are fixed until Settings
 * lands: `Journal/` and `Templates/Daily.md` (built-in template if missing).
 */
import type { TreeNode } from "../services/tauri";
import { basename, notePaths, noteTitle } from "./format";
import { fillPlaceholders } from "./templates";

export const JOURNAL_FOLDER = "Journal";
export const TEMPLATE_PATH = "Templates/Daily.md";

const ISO_NOTE = /^(\d{4})-(\d{2})-(\d{2})\.(md|markdown)$/i;

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date as `YYYY-MM-DD`. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function sameDay(a: Date, b: Date): boolean {
  return isoDate(a) === isoDate(b);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

export function dailyPath(d: Date, folder = JOURNAL_FOLDER): string {
  const clean = folder
    .split(/[\\/]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
  return clean ? `${clean}/${isoDate(d)}.md` : `${isoDate(d)}.md`;
}

/** The date a daily note is for, from its file name; null for other notes. */
export function dailyDateOf(path: string): Date | null {
  const m = ISO_NOTE.exec(basename(path));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

const sameYear = (d: Date) => d.getFullYear() === new Date().getFullYear();

/** "Saturday, October 17" (with the year when it isn't this year). */
export function longTitle(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear(d) ? {} : { year: "numeric" }),
  }).format(d);
}

/** "Saturday, Oct 17" for lists. */
export function shortTitle(d: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(sameYear(d) ? {} : { year: "numeric" }),
  }).format(d);
}

export function weekdayName(d: Date): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(d);
}

export function clockTime(d = new Date()): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** All daily notes in the vault, newest first. */
export function dailyNotes(tree: TreeNode[]): { path: string; date: Date }[] {
  return notePaths(tree)
    .map((path) => ({ path, date: dailyDateOf(path) }))
    .filter((n): n is { path: string; date: Date } => n.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Open top-level checkboxes (`- [ ] …`) in a note, without duplicates. */
export function openTasks(markdown: string): string[] {
  const tasks: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^[-*+] \[ \] (.+)$/.exec(line);
    if (m && !tasks.includes(m[1].trim())) tasks.push(m[1].trim());
  }
  return tasks;
}

const DEFAULT_TEMPLATE = `# {{title}}

## Focus



## Log

{{time}} `;

/**
 * The text for a new daily note: the vault's template (or the built-in one)
 * with {{title}}, {{date}}, {{date:…}}, {{weekday}} and {{time}} filled in, plus the
 * previous day's unfinished tasks. Tasks go where `{{carryover}}` is, or at
 * the end.
 */
export function buildDailyNote(
  date: Date,
  template: string | null,
  previous: { date: Date; content: string } | null,
  now = new Date(),
  options: { title?: string; carryOver?: boolean } = {},
): string {
  let text = fillPlaceholders(template ?? DEFAULT_TEMPLATE, { title: options.title ?? longTitle(date), date, now });

  const tasks = previous && options.carryOver !== false ? openTasks(previous.content) : [];
  const carry = tasks.length ? `## Carried over from ${weekdayName(previous!.date)}\n\n${tasks.map((t) => `- [ ] ${t}`).join("\n")}\n` : "";
  if (text.includes("{{carryover}}")) {
    text = text.replaceAll("{{carryover}}", carry);
  } else if (carry) {
    // Trim trailing newlines only: the space after a final "{{time}} " is where you start typing.
    text = `${text.replace(/[\r\n]*$/, "")}\n\n${carry}`;
  }
  return text;
}

/** How a note is named in lists: daily notes by their date, others by file name. */
export function displayTitle(path: string): string {
  const date = dailyDateOf(path);
  return date ? shortTitle(date) : noteTitle(path);
}
