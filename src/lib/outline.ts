export interface Heading {
  level: number;
  text: string;
  /** Offset in the editor document (line breaks count as one character). */
  pos: number;
}

/**
 * ATX headings in a Markdown note, skipping front matter and fenced code.
 * Positions are computed on LF-normalized text so they match CodeMirror's
 * offsets for CRLF files too.
 */
export function extractHeadings(text: string): Heading[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const headings: Heading[] = [];
  let pos = 0;
  let fence: string | null = null;
  let i = 0;

  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close > 0) {
      for (; i <= close; i++) pos += lines[i].length + 1;
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
    } else if (!fence) {
      const h = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) {
        const plain = h[2]
          .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/[*_`~]/g, "");
        headings.push({ level: h[1].length, text: plain, pos });
      }
    }
    pos += line.length + 1;
  }
  return headings;
}

/** Does the note open with an H1 (after any front matter)? */
export function startsWithTitle(text: string): boolean {
  const body = text.replace(/\r\n?/g, "\n").replace(/^---\n[\s\S]*?\n---[ \t]*(\n|$)/, "");
  return /^\s*#\s+\S/.test(body);
}
