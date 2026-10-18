/**
 * Images and files linked from notes: building the Markdown for a new
 * attachment, and finding the file a link points at. Paths are
 * vault-relative with `/`, like note paths.
 */
import { basename, folderOf, joinPath } from "./format";

/** Files Preview shows inline as images. */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const NOTE_FILE = /\.(md|markdown)$/i;

/** The relative link from a note in `folder` to `target`: `../Attachments/photo.png`. */
export function relativeFrom(folder: string, target: string): string {
  const from = folder.split("/").filter(Boolean);
  const to = target.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...Array(from.length - common).fill(".."), ...to.slice(common)].join("/");
}

/** Encode what a bare Markdown link destination can't hold (spaces, brackets, `%`, `#`), as the backend does. */
export function encodeLinkPath(path: string): string {
  return path.replace(/[ %()<>#?"\\^`{}|[\]\u0000-\u001f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** `![](../Attachments/photo.png)` for images, `[report.pdf](report.pdf)` for other files. */
export function attachmentMarkdown(notePath: string, file: string): string {
  const link = encodeLinkPath(relativeFrom(folderOf(notePath), file));
  if (IMAGE_FILE.test(file)) return `![](${link})`;
  const label = basename(file).replace(/[[\]\\]/g, (c) => `\\${c}`);
  return `[${label}](${link})`;
}

/** A case-insensitive lookup of the vault's attachments. */
export function fileIndex(files: string[]): Map<string, string> {
  return new Map(files.map((f) => [f.toLowerCase(), f]));
}

/**
 * The vault file a Markdown link destination points at, resolved like note
 * links: relative to the note's folder first, then from the vault root.
 * `dest` is already %-decoded. `null` when no attachment matches.
 */
export function resolveAttachment(dest: string, notePath: string, files: Map<string, string>): string | null {
  const relative = joinPath(folderOf(notePath), dest);
  return (relative && files.get(relative.toLowerCase())) || files.get(dest.toLowerCase()) || null;
}

/** `![[photo.png]]` / `[[report.pdf]]`: a vault path, or just a file name found anywhere. */
export function resolveEmbed(target: string, files: Map<string, string>): string | null {
  const wanted = target.trim().toLowerCase();
  if (!wanted || NOTE_FILE.test(wanted)) return null;
  const byPath = files.get(wanted);
  if (byPath) return byPath;
  for (const [lower, path] of files) {
    if (lower === wanted || lower.endsWith(`/${wanted}`)) return path;
  }
  return null;
}

/** A name for pasted image data: "Pasted image 2026-10-18 091530.png". */
export function pastedName(type: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ext =
    type
      .split("/")[1]
      ?.replace("jpeg", "jpg")
      .replace("svg+xml", "svg")
      .replace(/[^a-z0-9]/gi, "") || "png";
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted image ${stamp}.${ext}`;
}
