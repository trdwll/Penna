//! Full-text search over the vault's notes.
//!
//! Each search reads the notes from disk, which is fast enough for vaults of a
//! few thousand notes and keeps results exactly in sync with the files. A
//! persistent index can replace the scan later without changing the shape of
//! the results.
//!
//! Queries are case-insensitive. Every word must appear (in any order); text
//! in double quotes must appear as an exact phrase.

use std::fs;
use std::path::Path;

use serde::Serialize;
use walkdir::WalkDir;

use crate::error::AppResult;
use crate::vault::{ensure_vault, is_hidden, is_note, to_relative};

/// Notes bigger than this are skipped (they're not prose).
const MAX_NOTE_BYTES: u64 = 2 * 1024 * 1024;
const SNIPPET_CHARS: usize = 170;
const MAX_SNIPPETS: usize = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    /// The line (or a window of it) holding a match. The frontend highlights the terms.
    pub text: String,
    /// 1-based line number in the note.
    pub line: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    /// ms since the Unix epoch.
    pub modified: i64,
    /// Every term appears in the note's name.
    pub title_match: bool,
    /// Total occurrences of all terms in the text.
    pub count: usize,
    pub snippets: Vec<Snippet>,
    /// Tags from front matter and inline `#tags`, lowercased, without `#`.
    pub tags: Vec<String>,
}

/// Split a query into lowercase terms: words, and "quoted phrases" kept whole.
pub fn parse_query(query: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut rest = query.trim();
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix('"') {
            let end = after.find('"').unwrap_or(after.len());
            let phrase = after[..end].trim();
            if !phrase.is_empty() {
                terms.push(phrase.to_lowercase());
            }
            rest = after.get(end + 1..).unwrap_or("").trim_start();
        } else {
            let end = rest
                .find(|c: char| c.is_whitespace() || c == '"')
                .unwrap_or(rest.len());
            let word = &rest[..end];
            if !word.is_empty() {
                terms.push(word.to_lowercase());
            }
            rest = rest[end..].trim_start();
        }
    }
    terms.sort();
    terms.dedup();
    terms
}

/// Does `text` (already lowercased) contain every term?
pub fn contains_all(lower: &str, terms: &[String]) -> bool {
    !terms.is_empty() && terms.iter().all(|t| lower.contains(t.as_str()))
}

fn count_matches(lower: &str, terms: &[String]) -> usize {
    terms
        .iter()
        .map(|t| lower.matches(t.as_str()).count())
        .sum()
}

/// A line trimmed to about `SNIPPET_CHARS` characters around its first match.
pub fn snippet_of(line: &str, terms: &[String]) -> String {
    let line = line.trim();
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= SNIPPET_CHARS {
        return line.to_owned();
    }
    let lower = line.to_lowercase();
    // Byte offset of the first match, mapped to a char index (lowercasing can
    // change byte lengths, so search the lowercase copy and count chars).
    let first = terms
        .iter()
        .filter_map(|t| lower.find(t.as_str()))
        .min()
        .map(|byte| lower[..byte].chars().count())
        .unwrap_or(0);
    let start = first
        .saturating_sub(SNIPPET_CHARS / 3)
        .min(chars.len() - SNIPPET_CHARS);
    let end = (start + SNIPPET_CHARS).min(chars.len());
    let mut out: String = chars[start..end].iter().collect();
    if start > 0 {
        out.insert(0, '…');
    }
    if end < chars.len() {
        out.push('…');
    }
    out
}

/// Front-matter tags plus inline `#tags` (outside code), lowercase, without `#`.
pub fn tags_of(text: &str) -> Vec<String> {
    crate::tags::keys(text)
}

/// Search every note in the vault. With `titles_only`, only note names count.
pub fn search(root: &Path, query: &str, titles_only: bool) -> AppResult<Vec<SearchHit>> {
    ensure_vault(root)?;
    let terms = parse_query(query);
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    let walker = WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_hidden(e.file_name()));

    let mut hits = Vec::new();
    for entry in walker.filter_map(Result::ok) {
        let path = entry.path();
        if !entry.file_type().is_file() || !is_note(path) {
            continue;
        }
        let Some(rel) = to_relative(root, path) else {
            continue;
        };
        let name = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let title_match = contains_all(&name, &terms);
        if titles_only && !title_match {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta.len() > MAX_NOTE_BYTES {
            continue;
        }
        let Ok(text) = fs::read_to_string(path) else {
            continue;
        };
        let lower = text.to_lowercase();
        let text_match = contains_all(&lower, &terms);
        if !title_match && !text_match {
            continue;
        }

        let mut snippets = Vec::new();
        for (i, line) in text.lines().enumerate() {
            if snippets.len() == MAX_SNIPPETS {
                break;
            }
            let line_lower = line.to_lowercase();
            if terms.iter().any(|t| line_lower.contains(t.as_str())) {
                snippets.push(Snippet {
                    text: snippet_of(line, &terms),
                    line: i + 1,
                });
            }
        }

        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0);
        hits.push(SearchHit {
            path: rel,
            modified,
            title_match,
            count: if text_match {
                count_matches(&lower, &terms)
            } else {
                0
            },
            snippets,
            tags: tags_of(&text),
        });
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_words_and_phrases() {
        assert_eq!(
            parse_query(r#"  Sync "lost text"  conflict "#),
            ["conflict", "lost text", "sync"]
        );
        assert_eq!(
            parse_query(r#""unterminated phrase"#),
            ["unterminated phrase"]
        );
        assert!(parse_query("   ").is_empty());
    }

    #[test]
    fn snippets_window_long_lines() {
        let long = format!("{} needle {}", "a ".repeat(200), "b ".repeat(200));
        let s = snippet_of(&long, &["needle".into()]);
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert!(s.contains("needle"));
        assert!(s.chars().count() <= SNIPPET_CHARS + 2);
        assert_eq!(snippet_of("  short line  ", &["x".into()]), "short line");
    }

    #[test]
    fn finds_tags() {
        let text = "---\ntags: [Sync, q4]\n---\n# Title\n\nWork on #merge-ux and #sync. Not a#tag, not ## heading.";
        assert_eq!(tags_of(text), ["merge-ux", "q4", "sync"]);
        assert_eq!(tags_of("---\ntags:\n  - a\n  - b\n---\n"), ["a", "b"]);
    }

    #[test]
    fn searches_titles_and_text() {
        let root = std::env::temp_dir().join(format!("penna-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Projects")).unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(
            root.join("Projects/Merge UX.md"),
            "Resolving a conflict should feel like choosing.\nAnother conflict line.",
        )
        .unwrap();
        fs::write(root.join("Roadmap.md"), "Nothing relevant here.").unwrap();
        fs::write(root.join("Conflicts.md"), "Title-only match.").unwrap();
        fs::write(root.join(".git/conflict.md"), "hidden, never searched").unwrap();

        let mut hits = search(&root, "conflict", false).unwrap();
        hits.sort_by(|a, b| a.path.cmp(&b.path));
        let paths: Vec<_> = hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, ["Conflicts.md", "Projects/Merge UX.md"]);
        assert!(hits[0].title_match && hits[0].count == 0);
        assert_eq!(hits[1].count, 2);
        assert_eq!(hits[1].snippets.len(), 2);
        assert_eq!(hits[1].snippets[0].line, 1);

        let titles = search(&root, "conflict", true).unwrap();
        assert_eq!(titles.len(), 1);
        assert_eq!(
            search(&root, "conflict \"feel like\"", false)
                .unwrap()
                .len(),
            1
        );
        assert!(
            search(&root, "conflict zebra", false).unwrap().is_empty(),
            "every word must match"
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
