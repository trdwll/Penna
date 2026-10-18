//! Tags: `#inline` tags in a note's text and `tags:` in its front matter.
//!
//! Tags match without case (`#Sync` and `#sync` are one tag) and nest with
//! `/`: `#sync/mobile` is also under `#sync`. Tags inside code (fenced
//! blocks and `inline code`) don't count, and renaming leaves them as written.

use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::links::{code_spans, note_lines};
use crate::vault::{modified_ms, note_paths, resolve_note, write_note};

/// Lines of a note's text listed per note in the index (enough for snippets and counts).
const MAX_MENTIONS: usize = 200;
const MENTION_CHARS: usize = 220;

/// A line of text with inline tags on it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    /// 1-based line.
    pub line: usize,
    /// The line, trimmed (and cut when very long).
    pub text: String,
    /// The tags written on it, lowercase, once per time they're written.
    pub tags: Vec<String>,
}

/// A note that has tags.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaggedNote {
    pub path: String,
    /// ms since the Unix epoch.
    pub modified: i64,
    /// Every tag on the note, lowercase, sorted, once each.
    pub tags: Vec<String>,
    /// The ones set in front matter.
    pub properties: Vec<String>,
    pub mentions: Vec<Mention>,
}

/// What renaming a tag changed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRenameOutcome {
    /// The new name, cleaned up (no `#`).
    pub name: String,
    /// Notes that changed.
    pub notes: Vec<String>,
    /// Tags rewritten, in text and properties.
    pub changed: usize,
}

// ---------------------------------------------------------------------------
// Finding tags
// ---------------------------------------------------------------------------

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// Byte ranges of inline tag names (after the `#`) in one line, outside inline
/// code. A tag starts with `#` at the start of the line or after whitespace,
/// followed by a letter, so `# Heading`, `##`, `a#b` and `#123` don't count.
fn inline_tags(line: &str) -> Vec<(usize, usize)> {
    let code = code_spans(line);
    let mut out = Vec::new();
    let mut prev: Option<char> = None;
    let mut chars = line.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        let starts = c == '#' && prev.is_none_or(char::is_whitespace);
        prev = Some(c);
        if !starts || !chars.peek().is_some_and(|&(_, n)| n.is_alphabetic()) {
            continue;
        }
        if code.iter().any(|&(s, e)| i >= s && i < e) {
            continue;
        }
        let start = i + 1;
        let mut end = start;
        while let Some(&(j, n)) = chars.peek() {
            if !is_tag_char(n) {
                break;
            }
            end = j + n.len_utf8();
            prev = Some(n);
            chars.next();
        }
        let name = line[start..end].trim_end_matches('/');
        out.push((start, start + name.len()));
    }
    out
}

/// The front matter's line range: the index of the line after the opening
/// `---` and of the closing `---`.
pub(crate) fn front_matter(lines: &[&str]) -> Option<(usize, usize)> {
    if lines.first()?.trim_end() != "---" {
        return None;
    }
    let close = lines.iter().skip(1).position(|l| l.trim_end() == "---")? + 1;
    Some((1, close))
}

/// `tags:` or `tag:` at the start of a front-matter line: the key's length.
fn tags_key(line: &str) -> Option<usize> {
    ["tags:", "tag:"]
        .iter()
        .find(|k| line.starts_with(*k))
        .map(|k| k.len())
}

/// A tag as written in front matter: `sync`, `"sync"`, `'#sync'`. Returns the
/// name's byte range inside `raw`.
fn item_name(raw: &str) -> (usize, usize) {
    let lead = raw.len() - raw.trim_start().len();
    let mut s = raw.trim();
    let mut start = lead;
    if s.len() >= 2
        && (s.starts_with('"') && s.ends_with('"') || s.starts_with('\'') && s.ends_with('\''))
    {
        s = &s[1..s.len() - 1];
        start += 1;
    }
    if let Some(rest) = s.strip_prefix('#') {
        s = rest;
        start += 1;
    }
    (start, start + s.len())
}

/// The items of an inline `tags:` value: `[a, b]`, `a, b` or `a b`. Returns
/// whether it was bracketed, the separator to join with, and each item's text.
fn flow_items(value: &str) -> (bool, &'static str, Vec<&str>) {
    let v = value.trim();
    let bracketed = v.starts_with('[') && v.ends_with(']');
    let inner = if bracketed { &v[1..v.len() - 1] } else { v };
    let items: Vec<&str> = if bracketed || inner.contains(',') {
        inner
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        inner.split_whitespace().collect()
    };
    (
        bracketed,
        if bracketed || inner.contains(',') {
            ", "
        } else {
            " "
        },
        items,
    )
}

/// A `- item` line of a block list: the item's text.
fn list_item(line: &str) -> Option<&str> {
    let t = line.trim_start();
    let rest = t
        .strip_prefix("- ")
        .or_else(|| (t.trim_end() == "-").then_some(""))?;
    Some(rest.trim_end_matches(['\r', '\n']))
}

/// Tags in front matter, lowercase, with their 1-based lines.
fn property_tags(lines: &[&str]) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let Some((from, to)) = front_matter(lines) else {
        return out;
    };
    let mut i = from;
    while i < to {
        let line = lines[i].trim_end_matches(['\r', '\n']);
        i += 1;
        let Some(key) = tags_key(line) else { continue };
        let value = &line[key..];
        if value.trim().is_empty() {
            while i < to {
                let Some(item) = list_item(lines[i]) else {
                    break;
                };
                let (s, e) = item_name(item);
                if e > s {
                    out.push((item[s..e].to_lowercase(), i + 1));
                }
                i += 1;
            }
        } else {
            for item in flow_items(value).2 {
                let (s, e) = item_name(item);
                if e > s {
                    out.push((item[s..e].to_lowercase(), i));
                }
            }
        }
    }
    out
}

/// The values of a list property in front matter, as written and without
/// quotes: `aliases: [MUX, "Merge design"]`, `aliases: MUX`, or a `- MUX`
/// list. Unlike tags, a plain value is one item even with spaces in it.
pub fn list_property(text: &str, keys: &[&str]) -> Vec<String> {
    let unquote = |s: &str| {
        let s = s.trim();
        let quoted = s.len() >= 2
            && (s.starts_with('"') && s.ends_with('"') || s.starts_with('\'') && s.ends_with('\''));
        (if quoted { &s[1..s.len() - 1] } else { s }).to_owned()
    };
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut out = Vec::new();
    let Some((from, to)) = front_matter(&lines) else {
        return out;
    };
    let mut i = from;
    while i < to {
        let line = lines[i].trim_end_matches(['\r', '\n']);
        i += 1;
        let Some(value) = keys
            .iter()
            .find_map(|k| line.strip_prefix(k).and_then(|rest| rest.strip_prefix(':')))
        else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            while i < to {
                let Some(item) = list_item(lines[i]) else {
                    break;
                };
                out.push(unquote(item));
                i += 1;
            }
        } else if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
            out.extend(inner.split(',').map(unquote));
        } else {
            out.push(unquote(value));
        }
    }
    out.retain(|v| !v.is_empty());
    out
}

/// Every tag in a note, lowercase, sorted, once each (Search's tag filter).
pub fn keys(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut tags: Vec<String> = property_tags(&lines).into_iter().map(|(t, _)| t).collect();
    for m in mentions(text) {
        tags.extend(m.tags);
    }
    tags.sort();
    tags.dedup();
    tags
}

/// Lines of the text (not front matter, not code) that have inline tags.
fn mentions(text: &str) -> Vec<Mention> {
    let lines = note_lines(text);
    let plain: Vec<&str> = lines.iter().map(|(l, _)| *l).collect();
    let skip = front_matter(&plain).map_or(0, |(_, close)| close + 1);
    let mut out = Vec::new();
    for (i, (line, in_code)) in lines.iter().enumerate().skip(skip) {
        if *in_code {
            continue;
        }
        let found = inline_tags(line);
        if found.is_empty() {
            continue;
        }
        let trimmed = line.trim();
        let text = if trimmed.chars().count() > MENTION_CHARS {
            format!(
                "{}…",
                trimmed.chars().take(MENTION_CHARS).collect::<String>()
            )
        } else {
            trimmed.to_owned()
        };
        out.push(Mention {
            line: i + 1,
            text,
            tags: found
                .iter()
                .map(|&(s, e)| line[s..e].to_lowercase())
                .collect(),
        });
    }
    out
}

/// Every note with at least one tag, in sidebar order.
pub fn index(root: &Path) -> AppResult<Vec<TaggedNote>> {
    let mut out = Vec::new();
    for path in note_paths(root)? {
        let file = resolve_note(root, &path)?;
        let Ok(text) = fs::read_to_string(&file) else {
            continue;
        };
        let lines: Vec<&str> = text.split_inclusive('\n').collect();
        let mut properties: Vec<String> =
            property_tags(&lines).into_iter().map(|(t, _)| t).collect();
        properties.sort();
        properties.dedup();
        let mut mentions = mentions(&text);
        if properties.is_empty() && mentions.is_empty() {
            continue;
        }
        let mut tags: Vec<String> = properties
            .iter()
            .cloned()
            .chain(mentions.iter().flat_map(|m| m.tags.iter().cloned()))
            .collect();
        tags.sort();
        tags.dedup();
        mentions.truncate(MAX_MENTIONS);
        out.push(TaggedNote {
            modified: modified_ms(&file).unwrap_or(0),
            path,
            tags,
            properties,
            mentions,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Renaming
// ---------------------------------------------------------------------------

/// A tag name as typed (`#Sync/mobile `) made ready to write, or why it can't be one.
pub fn clean_name(input: &str) -> AppResult<String> {
    let name = input.trim().trim_start_matches('#').trim_matches('/');
    let ok = name.chars().next().is_some_and(char::is_alphabetic)
        && name.chars().all(is_tag_char)
        && !name.contains("//");
    if ok {
        Ok(name.to_owned())
    } else {
        Err(AppError::InvalidTag(input.trim().to_owned()))
    }
}

/// The new name for `name` when `from` (lowercase) becomes `to`, if it's
/// `from` itself or nested under it.
fn renamed(name: &str, from: &str, to: &str) -> Option<String> {
    let lower = name.to_lowercase();
    if lower == from {
        return Some(to.to_owned());
    }
    if lower.starts_with(from) && lower[from.len()..].starts_with('/') {
        let rest: String = name.chars().skip(from.chars().count()).collect();
        return Some(format!("{to}{rest}"));
    }
    None
}

/// Rewrite one front-matter item, keeping its quotes and `#`.
fn rename_item(item: &str, from: &str, to: &str) -> Option<String> {
    let (s, e) = item_name(item);
    let new = renamed(&item[s..e], from, to)?;
    Some(format!("{}{new}{}", &item[..s], &item[e..]))
}

/// Rename the tags in one front-matter list. Gives each item its new text,
/// or `None` to drop it (a renamed tag listed twice is kept once), plus how
/// many changed; `None` when none did.
fn rename_list(items: &[&str], from: &str, to: &str) -> Option<(Vec<Option<String>>, usize)> {
    let renamed: Vec<Option<String>> = items
        .iter()
        .map(|item| rename_item(item, from, to))
        .collect();
    let changed = renamed.iter().filter(|r| r.is_some()).count();
    if changed == 0 {
        return None;
    }
    let key = |s: &str| {
        let (a, b) = item_name(s);
        s[a..b].to_lowercase()
    };
    let finals: Vec<String> = items
        .iter()
        .zip(&renamed)
        .map(|(item, r)| r.clone().unwrap_or_else(|| (*item).to_owned()))
        .collect();
    let touched: Vec<String> = finals
        .iter()
        .zip(&renamed)
        .filter(|(_, r)| r.is_some())
        .map(|(f, _)| key(f))
        .collect();
    let mut seen: Vec<String> = Vec::new();
    let out = finals
        .into_iter()
        .map(|f| {
            let k = key(&f);
            if touched.contains(&k) {
                if seen.contains(&k) {
                    return None;
                }
                seen.push(k);
            }
            Some(f)
        })
        .collect();
    Some((out, changed))
}

/// Rename a tag in one note's text. Returns the new text and how many tags
/// changed, or `None` when it doesn't use the tag.
pub fn rename_in(text: &str, from: &str, to: &str) -> Option<(String, usize)> {
    let from = from.to_lowercase();
    let lines = note_lines(text);
    let plain: Vec<&str> = lines.iter().map(|(l, _)| *l).collect();
    let fm = front_matter(&plain);
    let (fm_start, fm_end) = fm.unwrap_or((0, 0));
    let mut out = String::with_capacity(text.len() + 16);
    let mut changed = 0;
    let mut i = 0;
    while i < lines.len() {
        let (line, in_code) = lines[i];
        if fm.is_some() && (i < fm_start || i == fm_end) {
            out.push_str(line); // the --- lines
            i += 1;
            continue;
        }
        if i < fm_end {
            i += 1;
            let body = line.trim_end_matches(['\r', '\n']);
            let Some(key) = tags_key(body) else {
                out.push_str(line);
                continue;
            };
            let value = &body[key..];
            if value.trim().is_empty() {
                // A block list of `- item` lines.
                out.push_str(line);
                let first = i;
                while i < fm_end && list_item(plain[i]).is_some() {
                    i += 1;
                }
                let items: Vec<&str> = plain[first..i]
                    .iter()
                    .filter_map(|l| list_item(l))
                    .collect();
                match rename_list(&items, &from, to) {
                    None => plain[first..i].iter().for_each(|l| out.push_str(l)),
                    Some((news, n)) => {
                        changed += n;
                        for ((item_line, item), new) in plain[first..i].iter().zip(&items).zip(news)
                        {
                            let Some(new) = new else { continue };
                            let at = item_line.len() - item_line.trim_start().len() + 2;
                            let at = at.min(item_line.len());
                            out.push_str(&item_line[..at]);
                            out.push_str(&new);
                            out.push_str(&item_line[at + item.len()..]);
                        }
                    }
                }
                continue;
            }
            let (bracketed, sep, items) = flow_items(value);
            match rename_list(&items, &from, to) {
                None => out.push_str(line),
                Some((news, n)) => {
                    changed += n;
                    let joined = news.into_iter().flatten().collect::<Vec<_>>().join(sep);
                    let joined = if bracketed {
                        format!("[{joined}]")
                    } else {
                        joined
                    };
                    let space = &value[..value.len() - value.trim_start().len()];
                    let space = if space.is_empty() { " " } else { space };
                    out.push_str(&format!(
                        "{}{space}{joined}{}",
                        &body[..key],
                        &line[body.len()..]
                    ));
                }
            }
            continue;
        }
        i += 1;
        if in_code {
            out.push_str(line);
            continue;
        }
        let mut last = 0;
        for (s, e) in inline_tags(line) {
            if let Some(new) = renamed(&line[s..e], &from, to) {
                out.push_str(&line[last..s]);
                out.push_str(&new);
                last = e;
                changed += 1;
            }
        }
        out.push_str(&line[last..]);
    }
    (changed > 0).then_some((out, changed))
}

/// Rename a tag (and the tags nested under it) in every note.
pub fn rename(root: &Path, from: &str, to: &str) -> AppResult<TagRenameOutcome> {
    let from = clean_name(from)?;
    let name = clean_name(to)?;
    let mut notes = Vec::new();
    let mut changed = 0;
    for path in note_paths(root)? {
        let file = resolve_note(root, &path)?;
        let Ok(text) = fs::read_to_string(&file) else {
            continue;
        };
        if let Some((new, n)) = rename_in(&text, &from, &name)
            && new != text
        {
            write_note(root, &path, &new)?;
            notes.push(path);
            changed += n;
        }
    }
    Ok(TagRenameOutcome {
        name,
        notes,
        changed,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_inline_tags_outside_code() {
        let line =
            "Work on #merge-ux and #Sync/mobile/, not a#tag, `#code`, #123 or ## heading. #end";
        let names: Vec<&str> = inline_tags(line)
            .into_iter()
            .map(|(s, e)| &line[s..e])
            .collect();
        assert_eq!(names, ["merge-ux", "Sync/mobile", "end"]);
        let text =
            "---\ntags: [Sync, \"q4\"]\n---\n# Title #inline\n\n```\n#fenced\n```\nLast #one\n";
        assert_eq!(keys(text), ["inline", "one", "q4", "sync"]);
        let m = mentions(text);
        assert_eq!(m.iter().map(|m| m.line).collect::<Vec<_>>(), [4, 9]);
        assert_eq!(keys("---\ntags:\n  - a\n  - '#b'\n---\n"), ["a", "b"]);
        assert_eq!(keys("---\ntag: a b\n---\n"), ["a", "b"]);
    }

    #[test]
    fn renames_inline_and_nested_tags() {
        let text = "Plan #sync and #Sync/mobile, not #syncing or `#sync`.\n```\n#sync\n```\n";
        let (new, n) = rename_in(text, "sync", "reliability").unwrap();
        assert_eq!(
            new,
            "Plan #reliability and #reliability/mobile, not #syncing or `#sync`.\n```\n#sync\n```\n"
        );
        assert_eq!(n, 2);
        assert!(rename_in("Nothing #here\n", "sync", "x").is_none());
    }

    #[test]
    fn renames_front_matter_and_keeps_one_of_each() {
        let text = "---\ntitle: Plan\ntags: [sync, \"reliability\", q4]\n---\n# Plan #sync\n";
        let (new, n) = rename_in(text, "sync", "reliability").unwrap();
        assert_eq!(
            new,
            "---\ntitle: Plan\ntags: [reliability, q4]\n---\n# Plan #reliability\n"
        );
        assert_eq!(n, 2);

        let text = "---\ntags:\n  - sync/mobile\n  - '#sync'\n  - other\n---\nBody\n";
        let (new, _) = rename_in(text, "sync", "s").unwrap();
        assert_eq!(
            new,
            "---\ntags:\n  - s/mobile\n  - '#s'\n  - other\n---\nBody\n"
        );

        let text = "---\r\ntags: sync reliability\r\n---\r\n";
        assert_eq!(
            rename_in(text, "sync", "reliability").unwrap().0,
            "---\r\ntags: reliability\r\n---\r\n"
        );

        let text = "---\ntags:\n  - reliability\n  - sync\n---\n";
        assert_eq!(
            rename_in(text, "sync", "reliability").unwrap().0,
            "---\ntags:\n  - reliability\n---\n"
        );
    }

    #[test]
    fn cleans_names() {
        assert_eq!(clean_name(" #Reliability/ ").unwrap(), "Reliability");
        assert_eq!(clean_name("a/b-c_d").unwrap(), "a/b-c_d");
        for bad in ["", "#", "1abc", "two words", "a//b", "a.b"] {
            assert!(clean_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn renames_across_the_vault() {
        let dir = std::env::temp_dir().join(format!("penna-tags-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let root = dir.as_path();
        fs::create_dir_all(root.join("Projects")).unwrap();
        fs::write(root.join("A.md"), "# A\n\n#sync now\n").unwrap();
        fs::write(root.join("Projects/B.md"), "---\ntags: [sync]\n---\n# B\n").unwrap();
        fs::write(root.join("C.md"), "# C\n\nNo tags.\n").unwrap();
        let index_before = index(root).unwrap();
        assert_eq!(
            index_before
                .iter()
                .map(|n| n.path.as_str())
                .collect::<Vec<_>>(),
            ["Projects/B.md", "A.md"]
        );
        assert_eq!(index_before[0].properties, ["sync"]);

        let outcome = rename(root, "#sync", "#Reliability").unwrap();
        assert_eq!(outcome.name, "Reliability");
        assert_eq!(outcome.notes, ["Projects/B.md", "A.md"]);
        assert_eq!(outcome.changed, 2);
        assert_eq!(
            fs::read_to_string(root.join("A.md")).unwrap(),
            "# A\n\n#Reliability now\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("Projects/B.md")).unwrap(),
            "---\ntags: [Reliability]\n---\n# B\n"
        );
        assert!(rename(root, "reliability", "two words").is_err());
    }
}
