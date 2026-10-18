/**
 * Fuzzy matching for the quick switcher: every character of the query must
 * appear in order. Matches score higher at word starts and in runs, and an
 * exact substring (better still, a prefix) beats a scattered match, so
 * "mrgux" finds "Merge UX" while "merge" puts "Merge UX" above "Emergency".
 */

export interface FuzzyMatch {
  score: number;
  /** Indexes in the text of the matched characters, for highlighting. */
  marks: number[];
}

const WORD_BREAK = /[\s\-_/.,:;()[\]·]/;

function wordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  return WORD_BREAK.test(prev) || (prev === prev.toLowerCase() && cur !== cur.toLowerCase());
}

export function fuzzy(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return { score: 0, marks: [] };
  const t = text.toLowerCase();

  const sub = t.indexOf(q);
  if (sub >= 0) {
    const marks = Array.from({ length: q.length }, (_, i) => sub + i);
    const bonus = sub === 0 ? 60 : wordStart(text, sub) ? 35 : 0;
    return { score: 100 + bonus - sub * 0.5 - (t.length - q.length) * 0.1, marks };
  }

  let score = 0;
  let from = 0;
  let prev = -2;
  const marks: number[] = [];
  for (const c of q.replace(/ /g, "")) {
    let at = t.indexOf(c, from);
    if (at < 0) return null;
    // A word start a little further on is a better place for this character.
    for (let k = at; k >= 0 && k < at + 16; k = t.indexOf(c, k + 1)) {
      if (wordStart(text, k)) {
        at = k;
        break;
      }
    }
    score += wordStart(text, at) ? 10 : 0;
    score += at === prev + 1 ? 6 : -Math.min(at - prev - 1, 6);
    marks.push(at);
    prev = at;
    from = at + 1;
  }
  return { score: score - t.length * 0.05, marks };
}

/** Split `text` into runs, marking the matched characters, for rendering. */
export function highlightRuns(text: string, marks: number[]): { text: string; hit: boolean }[] {
  const hit = new Set(marks);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const h = hit.has(i);
    const last = runs[runs.length - 1];
    if (last && last.hit === h) last.text += text[i];
    else runs.push({ text: text[i], hit: h });
  }
  return runs;
}
