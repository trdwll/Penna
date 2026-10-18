//! Unlinked mentions: places where another note writes this note's name (or
//! one of its `aliases`) as plain text. "Mentioned in" lists them, and
//! "Link" turns them into wiki links.
//!
//! A mention is a whole-word match, ignoring case, outside code, links and
//! web addresses. Like backlinks, this reads the vault on each call.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::links::{
    code_spans, markdown_links, note_lines, resolve_unique, stem, strip_ext, wiki_links,
};
use crate::tags::{front_matter, list_property};
use crate::vault::{note_paths, resolve_note, to_relative, write_note};

/// Shorter names (like "Go") would match all over the place.
const MIN_NAME_CHARS: usize = 3;
const MAX_PER_NOTE: usize = 5;
const MAX_NOTES: usize = 40;
/// Characters of context on each side of a mention.
const CONTEXT: usize = 44;

/// One unlinked mention: where it is (1-based line, byte range in that
/// line, for linking it later) and the text around it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    pub line: usize,
    pub start: usize,
    pub end: usize,
    pub before: String,
    pub text: String,
    pub after: String,
}

/// A note with unlinked mentions; `more` counts the ones past the first few.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mentioning {
    pub path: String,
    pub mentions: Vec<Mention>,
    pub more: usize,
}

/// A mention to link, as [`unlinked`] gave it.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Place {
    pub line: usize,
    pub start: usize,
    pub end: usize,
}

/// The names a note goes by: its file name, then its `aliases`, longest
/// first, each once (ignoring case).
pub fn names_of(path: &str, text: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for name in
        std::iter::once(stem(path).to_owned()).chain(list_property(text, &["aliases", "alias"]))
    {
        let name = name.trim().to_owned();
        if name.chars().count() >= MIN_NAME_CHARS
            && !names
                .iter()
                .any(|n| n.to_lowercase() == name.to_lowercase())
        {
            names.push(name);
        }
    }
    names.sort_by_key(|n| std::cmp::Reverse(n.chars().count()));
    names
}

/// Byte ranges of a line that are code, links or web addresses.
fn covered(line: &str) -> Vec<(usize, usize)> {
    let mut out = code_spans(line);
    for (s, e) in wiki_links(line) {
        out.push((s.saturating_sub(3), (e + 2).min(line.len()))); // `![[` … `]]`
    }
    for dest in markdown_links(line) {
        let open = line[..dest.start]
            .rfind("](")
            .and_then(|close| line[..close].rfind('['));
        out.push((open.unwrap_or(dest.start), (dest.end + 1).min(line.len())));
    }
    let mut from = 0;
    while let Some(i) = line[from..].find("://") {
        let at = from + i;
        let start = line[..at]
            .rfind(|c: char| c.is_whitespace() || matches!(c, '<' | '(' | '['))
            .map_or(0, |s| s + 1);
        let end = line[at..]
            .find(|c: char| c.is_whitespace() || matches!(c, '>' | ')' | ']'))
            .map_or(line.len(), |e| at + e);
        out.push((start, end));
        from = end.max(at + 3);
    }
    out
}

fn lower(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// Whole-word, case-insensitive matches of `name` in `line` (byte ranges).
fn find_in_line(line: &str, name: &str) -> Vec<(usize, usize)> {
    let wanted: Vec<char> = name.chars().map(lower).collect();
    let chars: Vec<(usize, char)> = line.char_indices().collect();
    let n = wanted.len();
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = Vec::new();
    let mut i = 0;
    while n > 0 && i + n <= chars.len() {
        if (0..n).all(|k| lower(chars[i + k].1) == wanted[k]) {
            let before = i.checked_sub(1).map(|j| chars[j].1);
            let after = chars.get(i + n).map(|c| c.1);
            let end = chars.get(i + n).map_or(line.len(), |c| c.0);
            let rest = &line[end..];
            let ok = !before.is_some_and(|c| word(c) || matches!(c, '#' | '/' | '\\' | '[' | '@'))
                && !after.is_some_and(|c| word(c) || matches!(c, ']' | '/'))
                && !rest.to_ascii_lowercase().starts_with(".md");
            if ok {
                out.push((chars[i].0, end));
                i += n;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Some characters of `s` from the end (`tail`) or the start, with … where it's cut.
fn clip(s: &str, tail: bool) -> String {
    let count = s.chars().count();
    if count <= CONTEXT {
        return s.to_owned();
    }
    if tail {
        format!(
            "…{}",
            s.chars()
                .skip(count - CONTEXT)
                .collect::<String>()
                .trim_start()
        )
    } else {
        format!(
            "{}…",
            s.chars().take(CONTEXT).collect::<String>().trim_end()
        )
    }
}

/// Unlinked mentions of any of `names` in one note's text.
fn mentions_in(text: &str, names: &[String]) -> Vec<Mention> {
    let lines = note_lines(text);
    let plain: Vec<&str> = lines.iter().map(|(l, _)| *l).collect();
    let skip = front_matter(&plain).map_or(0, |(_, close)| close + 1);
    let mut out = Vec::new();
    for (i, (raw, in_code)) in lines.iter().enumerate().skip(skip) {
        if *in_code {
            continue;
        }
        let line = raw.trim_end_matches(['\r', '\n']);
        let mut taken = covered(line);
        for name in names {
            for (s, e) in find_in_line(line, name) {
                if taken.iter().any(|&(a, b)| s < b && e > a) {
                    continue;
                }
                taken.push((s, e));
                out.push(Mention {
                    line: i + 1,
                    start: s,
                    end: e,
                    before: clip(line[..s].trim_start(), true),
                    text: line[s..e].to_owned(),
                    after: clip(line[e..].trim_end(), false),
                });
            }
        }
    }
    out.sort_by_key(|m| (m.line, m.start));
    out
}

/// Every note that mentions `rel` by name without linking it there, in sidebar order.
pub fn unlinked(root: &Path, rel: &str) -> AppResult<Vec<Mentioning>> {
    let target_abs = resolve_note(root, rel)?;
    let Some(target) = to_relative(root, &target_abs) else {
        return Ok(Vec::new());
    };
    let names = names_of(
        &target,
        &fs::read_to_string(&target_abs).unwrap_or_default(),
    );
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for path in note_paths(root)? {
        if path == target {
            continue;
        }
        let Ok(text) = fs::read_to_string(resolve_note(root, &path)?) else {
            continue;
        };
        let mut mentions = mentions_in(&text, &names);
        if mentions.is_empty() {
            continue;
        }
        let more = mentions.len().saturating_sub(MAX_PER_NOTE);
        mentions.truncate(MAX_PER_NOTE);
        out.push(Mentioning {
            path,
            mentions,
            more,
        });
        if out.len() == MAX_NOTES {
            break;
        }
    }
    Ok(out)
}

/// Turn mentions in `path` into links to `target`: `[[Merge UX]]`, or
/// `[[Merge UX|merge ux]]` when written differently (an alias, other case),
/// or by path when another note has the same name. Places that no longer
/// hold one of the names are left alone. Returns how many were linked.
pub fn link(root: &Path, path: &str, target: &str, places: &[Place]) -> AppResult<usize> {
    let paths = note_paths(root)?;
    let target_text = fs::read_to_string(resolve_note(root, target)?).unwrap_or_default();
    let names: Vec<String> = names_of(target, &target_text)
        .iter()
        .map(|n| n.to_lowercase())
        .collect();
    let name = stem(target);
    let link_to = if resolve_unique(name, &paths) == Some(target) {
        name
    } else {
        strip_ext(target)
    };

    let text = fs::read_to_string(resolve_note(root, path)?)
        .map_err(|_| AppError::NotFound(path.to_owned()))?;
    let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_owned).collect();
    let mut places = places.to_vec();
    // Last first, so earlier offsets on the same line stay right.
    places.sort_by_key(|p| std::cmp::Reverse((p.line, p.start)));
    let mut linked = 0;
    for p in places {
        let Some(line) = p.line.checked_sub(1).and_then(|i| lines.get_mut(i)) else {
            continue;
        };
        if p.start >= p.end
            || p.end > line.len()
            || !line.is_char_boundary(p.start)
            || !line.is_char_boundary(p.end)
        {
            continue;
        }
        let found = line[p.start..p.end].to_owned();
        if !names.contains(&found.to_lowercase()) {
            continue;
        }
        let wiki = if found == link_to {
            format!("[[{link_to}]]")
        } else {
            format!("[[{link_to}|{found}]]")
        };
        line.replace_range(p.start..p.end, &wiki);
        linked += 1;
    }
    if linked == 0 {
        return Err(AppError::MentionsMoved(stem(path).to_owned()));
    }
    write_note(root, path, &lines.concat())?;
    Ok(linked)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(line: &str, name: &str) -> Vec<String> {
        let names = vec![name.to_owned()];
        mentions_in(line, &names)
            .into_iter()
            .map(|m| m.text)
            .collect()
    }

    #[test]
    fn names_include_aliases() {
        let text = "---\naliases: [MUX, \"Merge design\"]\n---\n# Merge UX\n";
        assert_eq!(
            names_of("Projects/Merge UX.md", text),
            ["Merge design", "Merge UX", "MUX"]
        );
        assert_eq!(
            names_of("Go.md", "---\nalias:\n  - Golang\n---\n"),
            ["Golang"]
        );
    }

    #[test]
    fn finds_whole_words_outside_links_and_code() {
        assert_eq!(
            texts("The merge ux review, then Merge UX again.", "Merge UX"),
            ["merge ux", "Merge UX"]
        );
        assert!(texts("Remerge UXs and Merge UXy", "Merge UX").is_empty());
        let skip = "[[Merge UX]] and ![[Merge UX]] and [Merge UX](Merge%20UX.md) and `Merge UX` and https://x.io/Merge UX/ and #Merge";
        assert!(
            texts(skip, "Merge").is_empty(),
            "{:?}",
            texts(skip, "Merge")
        );
        assert!(texts("see Projects/Plan.md and Plan.md", "Plan").is_empty());
        assert_eq!(texts("A plan, the Plan.", "Plan"), ["plan", "Plan"]);
        assert!(texts("```\nMerge UX\n```\n", "Merge UX").is_empty());
        assert!(texts("---\ntitle: Merge UX\n---\nBody\n", "Merge UX").is_empty());
    }

    #[test]
    fn context_is_clipped() {
        let line = format!("{} Merge UX {}", "a".repeat(60), "b".repeat(60));
        let m = &mentions_in(&line, &["Merge UX".to_owned()])[0];
        assert!(m.before.starts_with('…') && m.before.chars().count() <= CONTEXT + 1);
        assert!(m.after.ends_with('…'));
    }

    #[test]
    fn lists_and_links_mentions() {
        let dir = std::env::temp_dir().join(format!("penna-mentions-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Projects")).unwrap();
        fs::create_dir_all(dir.join("Old")).unwrap();
        fs::write(
            dir.join("Projects/Merge UX.md"),
            "---\naliases: [MUX]\n---\n# Merge UX\n",
        )
        .unwrap();
        fs::write(
            dir.join("Plan.md"),
            "# Plan\n\nShip merge ux soon. MUX first, then Merge UX.\nAlready [[Merge UX]].\n",
        )
        .unwrap();
        fs::write(dir.join("Other.md"), "Nothing here.\n").unwrap();

        let found = unlinked(&dir, "Projects/Merge UX.md").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, "Plan.md");
        let texts: Vec<&str> = found[0].mentions.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, ["merge ux", "MUX", "Merge UX"]);

        let places: Vec<Place> = found[0]
            .mentions
            .iter()
            .map(|m| Place {
                line: m.line,
                start: m.start,
                end: m.end,
            })
            .collect();
        assert_eq!(
            link(&dir, "Plan.md", "Projects/Merge UX.md", &places).unwrap(),
            3
        );
        assert_eq!(
            fs::read_to_string(dir.join("Plan.md")).unwrap(),
            "# Plan\n\nShip [[Merge UX|merge ux]] soon. [[Merge UX|MUX]] first, then [[Merge UX]].\nAlready [[Merge UX]].\n"
        );
        assert!(unlinked(&dir, "Projects/Merge UX.md").unwrap().is_empty());
        // The same places again no longer hold the name: nothing changes.
        assert!(link(&dir, "Plan.md", "Projects/Merge UX.md", &places).is_err());

        // Two notes named the same: the link uses the path.
        fs::write(dir.join("Old/Merge UX.md"), "# Old\n").unwrap();
        fs::write(dir.join("Other.md"), "About Merge UX.\n").unwrap();
        let found = unlinked(&dir, "Projects/Merge UX.md").unwrap();
        let other = found.iter().find(|n| n.path == "Other.md").unwrap();
        let m = &other.mentions[0];
        link(
            &dir,
            "Other.md",
            "Projects/Merge UX.md",
            &[Place {
                line: m.line,
                start: m.start,
                end: m.end,
            }],
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("Other.md")).unwrap(),
            "About [[Projects/Merge UX|Merge UX]].\n"
        );
    }
}
