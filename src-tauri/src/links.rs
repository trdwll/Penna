//! Links between notes, and rewriting them when a note is renamed or moved.
//!
//! Two kinds of link point at notes:
//! - wiki links: `[[Name]]`, `[[folder/Name]]`, `[[Name#Heading|label]]`, `![[Name]]`
//! - Markdown links with a relative destination: `[text](../Other%20note.md)`
//!
//! Resolution mirrors the editor (`resolveWikiLink` and `openUrl` in the
//! frontend), so a link is rewritten exactly when clicking it would have
//! opened the renamed note. Links inside code are left alone.

use std::collections::HashMap;

use crate::vault::NOTE_EXTENSIONS;

// ---------------------------------------------------------------------------
// Path helpers (vault-relative, `/`-separated)
// ---------------------------------------------------------------------------

/// The `.md` / `.markdown` suffix (with the dot), ignoring case, or `""`.
fn note_ext(path: &str) -> &str {
    let lower = path.to_ascii_lowercase();
    NOTE_EXTENSIONS
        .iter()
        .find_map(|ext| {
            let n = ext.len() + 1;
            (lower.len() > n && lower.ends_with(&format!(".{ext}")))
                .then(|| &path[path.len() - n..])
        })
        .unwrap_or("")
}

/// `Projects/Plan.md` → `Projects/Plan`.
pub fn strip_ext(path: &str) -> &str {
    &path[..path.len() - note_ext(path).len()]
}

/// `Projects/Plan.md` → `Plan`.
pub fn stem(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    strip_ext(name)
}

/// `Projects/2026/Plan.md` → `Projects/2026`; top-level notes → `""`.
fn folder_of(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

/// Join a note's folder and a relative link, resolving `.` and `..`.
/// `None` when the link climbs out of the vault or starts at `/`.
pub fn join(folder: &str, rel: &str) -> Option<String> {
    if rel.starts_with('/') {
        return None;
    }
    let mut parts: Vec<&str> = folder.split('/').filter(|s| !s.is_empty()).collect();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            seg => parts.push(seg),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// The relative link from a note in `folder` to `target`: `../Other/Note.md`.
fn relative_to(folder: &str, target: &str) -> String {
    let from: Vec<&str> = folder.split('/').filter(|s| !s.is_empty()).collect();
    let to: Vec<&str> = target.split('/').collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut out: Vec<&str> = vec![".."; from.len() - common];
    out.extend_from_slice(&to[common..]);
    out.join("/")
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Match {
    /// The path (without extension) matched.
    Path,
    /// Only a note's name matched.
    Title,
}

/// Like the editor: a vault path (without extension) first, then the first
/// note in sidebar order with that name. Ignores case.
fn resolve<'a>(target: &str, paths: &'a [String]) -> Option<(&'a str, Match)> {
    let wanted = strip_ext(target.trim()).to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    if let Some(p) = paths.iter().find(|p| strip_ext(p).to_lowercase() == wanted) {
        return Some((p, Match::Path));
    }
    paths
        .iter()
        .find(|p| stem(p).to_lowercase() == wanted)
        .map(|p| (p.as_str(), Match::Title))
}

/// Like [`resolve`], but a name shared by several notes resolves to none of
/// them, so the answer doesn't depend on sidebar order.
pub(crate) fn resolve_unique<'a>(target: &str, paths: &'a [String]) -> Option<&'a str> {
    let wanted = strip_ext(target.trim()).to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    if let Some(p) = paths.iter().find(|p| strip_ext(p).to_lowercase() == wanted) {
        return Some(p);
    }
    let mut named = paths.iter().filter(|p| stem(p).to_lowercase() == wanted);
    match (named.next(), named.next()) {
        (Some(p), None) => Some(p),
        _ => None,
    }
}

/// How a Markdown link's destination found its note.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MdKind {
    /// Relative to the linking note's folder (standard Markdown).
    Relative,
    /// Relative to the vault's top folder.
    VaultRoot,
    /// Only by the note's name.
    Title,
}

/// Mirrors the editor's `openUrl`: relative to the note's folder first, then
/// from the top of the vault.
fn resolve_markdown<'a>(
    dest: &str,
    folder: &str,
    paths: &'a [String],
) -> Option<(&'a str, MdKind)> {
    if let Some(joined) = join(folder, dest)
        && let Some((p, m)) = resolve(&joined, paths)
    {
        return Some((
            p,
            if m == Match::Path {
                MdKind::Relative
            } else {
                MdKind::Title
            },
        ));
    }
    resolve(dest, paths).map(|(p, m)| {
        (
            p,
            if m == Match::Path {
                MdKind::VaultRoot
            } else {
                MdKind::Title
            },
        )
    })
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// A fence that opens a code block: its character and length.
fn fence(line: &str) -> Option<(u8, usize)> {
    let line = line.trim_end_matches(['\r', '\n']);
    let rest = line.trim_start_matches(' ');
    if line.len() - rest.len() > 3 {
        return None;
    }
    let ch = *rest.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let n = rest.bytes().take_while(|&c| c == ch).count();
    if n < 3 || (ch == b'`' && rest[n..].contains('`')) {
        return None;
    }
    Some((ch, n))
}

/// Does `line` close a code block opened by `open`?
fn closes(line: &str, open: (u8, usize)) -> bool {
    let line = line.trim_end_matches(['\r', '\n']);
    let rest = line.trim_start_matches(' ');
    if line.len() - rest.len() > 3 {
        return false;
    }
    let n = rest.bytes().take_while(|&c| c == open.0).count();
    n >= open.1 && rest[n..].trim().is_empty()
}

/// Byte ranges of inline code spans (`` `x` ``, ``` ``x`` ```) in a line.
pub(crate) fn code_spans(line: &str) -> Vec<(usize, usize)> {
    let b = line.as_bytes();
    let mut spans = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'`' {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i] == b'`' {
            i += 1;
        }
        let n = i - start;
        let mut j = i;
        while j < b.len() {
            if b[j] != b'`' {
                j += 1;
                continue;
            }
            let run = j;
            while j < b.len() && b[j] == b'`' {
                j += 1;
            }
            if j - run == n {
                spans.push((start, j));
                i = j;
                break;
            }
        }
    }
    spans
}

/// Byte ranges of the text inside `[[…]]` in a line (same rule as the editor:
/// no brackets or line breaks inside).
pub(crate) fn wiki_links(line: &str) -> Vec<(usize, usize)> {
    let b = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'[' && b[i + 1] == b'[' {
            let mut j = i + 2;
            while j < b.len() && !matches!(b[j], b'[' | b']' | b'\n') {
                j += 1;
            }
            if j > i + 2 && j + 1 < b.len() && b[j] == b']' && b[j + 1] == b']' {
                out.push((i + 2, j));
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// A Markdown link destination in a line.
pub(crate) struct Dest {
    pub(crate) start: usize,
    pub(crate) end: usize,
    /// Written as `<…>`, which allows spaces without encoding.
    angle: bool,
}

/// Destinations of inline links and images, `[text](dest "title")`.
pub(crate) fn markdown_links(line: &str) -> Vec<Dest> {
    let b = line.as_bytes();
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(off) = line[from..].find("](") {
        let close = from + off;
        from = close + 2;
        if !line[..close].contains('[') {
            continue;
        }
        let mut d = close + 2;
        while d < b.len() && (b[d] == b' ' || b[d] == b'\t') {
            d += 1;
        }
        if d < b.len() && b[d] == b'<' {
            let start = d + 1;
            if let Some(len) = line[start..].find(['>', '<', '\n'])
                && b[start + len] == b'>'
                && len > 0
            {
                out.push(Dest {
                    start,
                    end: start + len,
                    angle: true,
                });
            }
            continue;
        }
        let (start, mut e, mut depth) = (d, d, 0usize);
        while e < b.len() {
            match b[e] {
                b'\\' => {
                    e += 1 + line[e + 1..].chars().next().map_or(0, char::len_utf8);
                    continue;
                }
                b'(' => depth += 1,
                b')' if depth == 0 => break,
                b')' => depth -= 1,
                b' ' | b'\t' | b'\r' | b'\n' => break,
                _ => {}
            }
            e += 1;
        }
        let e = e.min(b.len());
        if e > start {
            out.push(Dest {
                start,
                end: e,
                angle: false,
            });
        }
    }
    out
}

/// `http:`, `mailto:` and other schemes aren't notes.
fn has_scheme(dest: &str) -> bool {
    let Some(colon) = dest.find(':') else {
        return false;
    };
    let scheme = &dest[..colon];
    scheme.len() > 1
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'+' | b'.' | b'-'))
}

/// `%20` → space. `None` for malformed escapes or bytes that aren't UTF-8,
/// which the editor can't open either.
pub(crate) fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Encode what a bare link destination can't hold (spaces, brackets, `%`, `#`).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ' ' | '%' | '(' | ')' | '<' | '>' | '#' | '?' | '"' | '\\' | '^' | '`' | '{' | '}'
            | '|' | '[' | ']' => {
                out.push_str(&format!("%{:02X}", c as u32));
            }
            c if c.is_control() => {
                let mut buf = [0u8; 4];
                for byte in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
            c => out.push(c),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/// What moves: one note or a whole folder, with every note path before and
/// after (before: in sidebar order, as the editor resolves names).
pub struct Rename<'a> {
    /// Old path → new path for everything that moves: one note, or every
    /// note and file in a folder.
    pub moves: &'a HashMap<String, String>,
    /// Every note path before the moves, in sidebar order, and after them.
    pub before: &'a [String],
    pub after: &'a [String],
    /// Every file in the vault that isn't a note (images, PDFs, …), before the moves.
    pub files: &'a [String],
}

impl Rename<'_> {
    /// Where `path` is after the moves.
    fn map<'b>(&'b self, path: &'b str) -> &'b str {
        self.moves.get(path).map_or(path, String::as_str)
    }

    /// The shortest wiki link target that reaches `to` unambiguously: its
    /// name, or its path when another note has the same name.
    fn wiki_target(&self, old: &str, to: &str) -> String {
        let path_form = strip_ext(to);
        let target = if !old.contains('/') && resolve_unique(stem(to), self.after) == Some(to) {
            stem(to)
        } else {
            path_form
        };
        if note_ext(old).is_empty() {
            target.to_owned()
        } else {
            format!("{target}{}", note_ext(to))
        }
    }

    /// The new target for a wiki link, or `None` to leave it.
    fn rewrite_wiki(&self, target: &str) -> Option<String> {
        let Some((was, _)) = resolve(target, self.before) else {
            return self.rewrite_wiki_file(target);
        };
        let now = self.map(was);
        if now != was {
            // Still reaches the note (e.g. `[[Name]]` after a move): leave it.
            if resolve_unique(target, self.after) == Some(now) {
                return None;
            }
            return Some(self.wiki_target(target, now));
        }
        // A new name can make a name-only link to another note ambiguous;
        // pin it to that note's path.
        if resolve_unique(target, self.after).is_none() && self.after.iter().any(|p| p == was) {
            let path = strip_ext(was);
            return Some(if note_ext(target).is_empty() {
                path.to_owned()
            } else {
                was.to_owned()
            });
        }
        None
    }

    /// `![[Folder/photo.png]]`: a file embedded by its vault path follows a
    /// move. Embeds by name alone (`![[photo.png]]`) keep working anyway.
    fn rewrite_wiki_file(&self, target: &str) -> Option<String> {
        let file = file_for_embed(target, self.files)?;
        let now = self.map(file);
        if now == file {
            return None;
        }
        if target.contains('/') {
            return Some(now.to_owned());
        }
        // By name: unchanged when only the folder changed; otherwise the new
        // name, or the path when another file has that name too.
        let name = file_name(now);
        if name.eq_ignore_ascii_case(file_name(file)) {
            return None;
        }
        let same_name = self
            .files
            .iter()
            .map(|f| self.map(f))
            .filter(|f| file_name(f).eq_ignore_ascii_case(name))
            .count();
        Some(if same_name == 1 {
            name.to_owned()
        } else {
            now.to_owned()
        })
    }

    /// The new destination for a Markdown link in a note that was at
    /// `note_old` and is now at `note_new`, or `None` to leave it.
    fn rewrite_markdown(&self, dest: &str, note_old: &str, note_new: &str) -> Option<String> {
        let (old_folder, new_folder) = (folder_of(note_old), folder_of(note_new));
        let (target, kind) = match resolve_markdown(dest, old_folder, self.before) {
            Some(found) => found,
            // Not a note: an image or other file in the vault.
            None => {
                let joined = join(old_folder, dest).map(|j| j.to_lowercase());
                let from_root = dest.to_lowercase();
                if let Some(file) = joined
                    .as_ref()
                    .and_then(|j| self.files.iter().find(|f| f.to_lowercase() == *j))
                {
                    (file.as_str(), MdKind::Relative)
                } else {
                    (
                        self.files
                            .iter()
                            .find(|f| f.to_lowercase() == from_root)?
                            .as_str(),
                        MdKind::VaultRoot,
                    )
                }
            }
        };
        let now = self.map(target);
        // The linking note itself moved, so its relative links change too.
        let note_moved =
            note_old != note_new && kind == MdKind::Relative && old_folder != new_folder;
        if now == target && !note_moved {
            return None;
        }
        let path = match kind {
            MdKind::VaultRoot => now.to_owned(),
            MdKind::Relative | MdKind::Title => relative_to(new_folder, now),
        };
        let path = if note_ext(dest).is_empty() && !note_ext(now).is_empty() {
            strip_ext(&path).to_owned()
        } else {
            path
        };
        (path != dest).then_some(path)
    }
}

/// A link to a note found in a line.
struct Link {
    /// Byte range of the target as written, to replace when rewriting.
    start: usize,
    end: usize,
    /// The target as the editor reads it (trimmed; `%`-decoded for Markdown links).
    target: String,
    kind: LinkKind,
}

#[derive(Clone, Copy)]
enum LinkKind {
    Wiki,
    /// `angle`: written as `<…>`, which allows spaces without encoding.
    Markdown {
        angle: bool,
    },
}

/// A note's lines (with their line endings), each marked when it sits in a
/// fenced code block (fences included).
pub(crate) fn note_lines(text: &str) -> Vec<(&str, bool)> {
    let mut open_fence: Option<(u8, usize)> = None;
    text.split_inclusive('\n')
        .map(|line| {
            if let Some(open) = open_fence {
                if closes(line, open) {
                    open_fence = None;
                }
                (line, true)
            } else if let Some(open) = fence(line) {
                open_fence = Some(open);
                (line, true)
            } else {
                (line, false)
            }
        })
        .collect()
}

/// Wiki links and relative Markdown links in a line, outside inline code.
fn links_in_line(line: &str) -> Vec<Link> {
    let code = code_spans(line);
    let in_code = |pos: usize| code.iter().any(|&(s, e)| pos >= s && pos < e);
    let mut out = Vec::new();

    for (start, end) in wiki_links(line) {
        if in_code(start) {
            continue;
        }
        let inner = &line[start..end];
        // The target ends at `|` or `#`; `\|` is a pipe escaped inside a table.
        let mut cut = inner.find(['|', '#']).unwrap_or(inner.len());
        if inner[cut..].starts_with('|') && inner[..cut].ends_with('\\') {
            cut -= 1;
        }
        let raw = &inner[..cut];
        let target = raw.trim();
        let lead = raw.len() - raw.trim_start().len();
        out.push(Link {
            start: start + lead,
            end: start + lead + target.len(),
            target: target.to_owned(),
            kind: LinkKind::Wiki,
        });
    }

    for dest in markdown_links(line) {
        if in_code(dest.start) {
            continue;
        }
        let raw = &line[dest.start..dest.end];
        let path_raw = &raw[..raw.find('#').unwrap_or(raw.len())]; // `#heading` stays as written
        if path_raw.is_empty() || has_scheme(path_raw) {
            continue;
        }
        let decoded = if dest.angle {
            Some(path_raw.to_owned())
        } else {
            percent_decode(path_raw)
        };
        if let Some(target) = decoded {
            out.push(Link {
                start: dest.start,
                end: dest.start + path_raw.len(),
                target,
                kind: LinkKind::Markdown { angle: dest.angle },
            });
        }
    }
    out.sort_by_key(|link| link.start);
    out
}

/// Rewrite the links in one note's text that point at the renamed note. The
/// note itself was at `note_old` and is now at `note_new` (they differ only
/// for the renamed note). Returns the new text and how many links changed;
/// everything else, line endings included, is kept byte for byte.
pub fn rewrite(text: &str, note_old: &str, note_new: &str, rename: &Rename) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut changed = 0;
    for (line, in_code_block) in note_lines(text) {
        if in_code_block {
            out.push_str(line);
            continue;
        }
        let mut pos = 0;
        for link in links_in_line(line) {
            if link.start < pos {
                continue; // overlaps an earlier link
            }
            let new = match link.kind {
                LinkKind::Wiki => rename.rewrite_wiki(&link.target),
                LinkKind::Markdown { angle } => rename
                    .rewrite_markdown(&link.target, note_old, note_new)
                    .map(|new| if angle { new } else { percent_encode(&new) }),
            };
            if let Some(new) = new {
                out.push_str(&line[pos..link.start]);
                out.push_str(&new);
                pos = link.end;
                changed += 1;
            }
        }
        out.push_str(&line[pos..]);
    }
    (out, changed)
}

/// `Folder/photo.png` → `photo.png`.
fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// The file a `[[…]]` / `![[…]]` target names, like the editor: a vault
/// path, or a file name found anywhere (the first in path order).
fn file_for_embed<'f>(target: &str, files: &'f [String]) -> Option<&'f str> {
    let wanted = target.trim().to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    if let Some(f) = files.iter().find(|f| f.to_lowercase() == wanted) {
        return Some(f);
    }
    if wanted.contains('/') {
        return None;
    }
    let suffix = format!("/{wanted}");
    files
        .iter()
        .find(|f| f.to_lowercase().ends_with(&suffix))
        .map(String::as_str)
}

/// The vault files that aren't notes (images, PDFs, …) that a note at `at`
/// links to or embeds: relative or vault-root Markdown links and `[[…]]`
/// embeds by path or name. Links in code don't count. Sorted, no repeats.
pub fn files_linked<'f>(text: &str, at: &str, files: &'f [String]) -> Vec<&'f str> {
    let exact = |p: &str| {
        let p = p.to_lowercase();
        files
            .iter()
            .find(|f| f.to_lowercase() == p)
            .map(String::as_str)
    };
    let mut out = Vec::new();
    for (line, in_code_block) in note_lines(text) {
        if in_code_block {
            continue;
        }
        for link in links_in_line(line) {
            let found = match link.kind {
                LinkKind::Wiki => file_for_embed(&link.target, files),
                LinkKind::Markdown { .. } => join(folder_of(at), &link.target)
                    .and_then(|j| exact(&j))
                    .or_else(|| exact(&link.target)),
            };
            out.extend(found);
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// The first line of `text` (a note at `at`) that links to the note
/// `target`, trimmed; "Linked from" shows it. `paths` is every note path in
/// sidebar order.
pub fn line_linking_to<'t>(
    text: &'t str,
    at: &str,
    target: &str,
    paths: &[String],
) -> Option<&'t str> {
    note_lines(text)
        .into_iter()
        .filter(|(_, in_code_block)| !in_code_block)
        .map(|(line, _)| line)
        .find(|line| {
            links_in_line(line).iter().any(|link| {
                let found = match link.kind {
                    LinkKind::Wiki => resolve(&link.target, paths).map(|(p, _)| p),
                    LinkKind::Markdown { .. } => {
                        resolve_markdown(&link.target, folder_of(at), paths).map(|(p, _)| p)
                    }
                };
                found == Some(target)
            })
        })
        .map(str::trim)
}

/// The ATX headings in a note (`## Next week`): level, text and 1-based
/// line. Front matter and fenced code are skipped.
pub fn headings(text: &str) -> Vec<(u8, String, usize)> {
    let mut out = Vec::new();
    let mut lines = note_lines(text).into_iter().enumerate().peekable();
    // Front matter: `---` … `---` at the very top.
    if lines
        .peek()
        .is_some_and(|(_, (l, _))| l.trim_end() == "---")
    {
        lines.next();
        for (_, (line, _)) in lines.by_ref() {
            if line.trim_end() == "---" {
                break;
            }
        }
    }
    for (i, (line, in_code_block)) in lines {
        if in_code_block {
            continue;
        }
        let line = line.trim_end_matches(['\r', '\n']);
        let hashes = line.bytes().take_while(|&b| b == b'#').count();
        if (1..=6).contains(&hashes) && line[hashes..].starts_with(' ') {
            let text = line[hashes..].trim().trim_end_matches('#').trim();
            if !text.is_empty() {
                out.push((hashes as u8, text.to_owned(), i + 1));
            }
        }
    }
    out
}

/// When a note's name changes and its first line (after front matter) is a
/// `# Heading` with the old name, the heading takes the new name, so the
/// page title follows the rename. `None` when there's no such heading.
pub fn retitle(text: &str, old: &str, new: &str) -> Option<String> {
    let mut offset = 0;
    let mut lines = text.split_inclusive('\n').peekable();
    // Skip front matter: `---` … `---` at the very top.
    if lines.peek().is_some_and(|l| l.trim_end() == "---") {
        offset += lines.next()?.len();
        loop {
            let line = lines.next()?;
            offset += line.len();
            if line.trim_end() == "---" {
                break;
            }
        }
    }
    for line in lines {
        let body = line.trim_end_matches(['\r', '\n']);
        if body.trim().is_empty() {
            offset += line.len();
            continue;
        }
        let title = body.strip_prefix("# ")?;
        if title.trim() != old {
            return None;
        }
        let start = offset + 2 + (title.len() - title.trim_start().len());
        let end = start + title.trim().len();
        return Some(format!("{}{new}{}", &text[..start], &text[end..]));
    }
    None
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    /// Rename `from` → `to` in a vault of `notes`, rewriting `text` (a note at `at`).
    fn run(notes: &[&str], from: &str, to: &str, at: &str, text: &str) -> (String, usize) {
        run_with_files(notes, &[], from, to, at, text)
    }

    fn run_with_files(
        notes: &[&str],
        files: &[&str],
        from: &str,
        to: &str,
        at: &str,
        text: &str,
    ) -> (String, usize) {
        let before = paths(notes);
        let files = paths(files);
        let after: Vec<String> = before
            .iter()
            .map(|p| if p == from { to.to_owned() } else { p.clone() })
            .collect();
        let moves = HashMap::from([(from.to_owned(), to.to_owned())]);
        let rename = Rename {
            moves: &moves,
            before: &before,
            after: &after,
            files: &files,
        };
        let at_new = if at == from { to } else { at };
        rewrite(text, at, at_new, &rename)
    }

    #[test]
    fn moved_note_keeps_its_images() {
        let notes = ["Projects/Plan.md"];
        let files = ["Projects/diagram.png", "Attachments/Pasted image.png"];
        let text = "![](diagram.png) ![shot](../Attachments/Pasted%20image.png) ![[diagram.png]] ![gone](missing.png)\n";
        let (out, n) = run_with_files(
            &notes,
            &files,
            "Projects/Plan.md",
            "Archive/2026/Plan.md",
            "Projects/Plan.md",
            text,
        );
        assert_eq!(n, 2);
        assert_eq!(
            out,
            "![](../../Projects/diagram.png) ![shot](../../Attachments/Pasted%20image.png) ![[diagram.png]] ![gone](missing.png)\n"
        );
        // Other notes' image links don't change when a note moves.
        let (_, n) = run_with_files(
            &["Projects/Plan.md", "Home.md"],
            &files,
            "Projects/Plan.md",
            "Archive/Plan.md",
            "Home.md",
            "![](Projects/diagram.png)\n",
        );
        assert_eq!(n, 0);
    }

    #[test]
    fn path_helpers() {
        assert_eq!(strip_ext("a/B.MD"), "a/B");
        assert_eq!(strip_ext("x.markdown"), "x");
        assert_eq!(strip_ext(".md"), ".md");
        assert_eq!(stem("a/b/Plan.md"), "Plan");
        assert_eq!(join("a/b", "../c.md").as_deref(), Some("a/c.md"));
        assert_eq!(join("", "./c.md").as_deref(), Some("c.md"));
        assert_eq!(join("a", "../../c.md"), None);
        assert_eq!(relative_to("a/b", "a/c/x.md"), "../c/x.md");
        assert_eq!(relative_to("", "a/x.md"), "a/x.md");
        assert_eq!(relative_to("a", "x.md"), "../x.md");
        assert_eq!(relative_to("a", "a/x.md"), "x.md");
        assert_eq!(
            percent_decode("My%20note.md").as_deref(),
            Some("My note.md")
        );
        assert_eq!(percent_decode("bad%2"), None);
        assert_eq!(percent_encode("My note (1).md"), "My%20note%20%281%29.md");
        assert!(has_scheme("https://x") && has_scheme("mailto:a@b") && !has_scheme("Notes/a.md"));
    }

    #[test]
    fn renames_wiki_links_in_every_form() {
        let notes = ["Projects/Merge UX.md", "Roadmap.md"];
        let text = "See [[Merge UX]], [[merge ux|the sketch]], [[Merge UX#Layout]],\r\n\
                    [[Projects/Merge UX]], [[Merge UX.md]] and ![[Merge UX]].\r\n\
                    Not [[Merge UX v2]] or [[Roadmap]].\r\n";
        let (out, n) = run(
            &notes,
            "Projects/Merge UX.md",
            "Projects/Merge flow.md",
            "Roadmap.md",
            text,
        );
        assert_eq!(n, 6);
        assert_eq!(
            out,
            "See [[Merge flow]], [[Merge flow|the sketch]], [[Merge flow#Layout]],\r\n\
             [[Projects/Merge flow]], [[Merge flow.md]] and ![[Merge flow]].\r\n\
             Not [[Merge UX v2]] or [[Roadmap]].\r\n"
        );
    }

    #[test]
    fn moving_keeps_name_links_and_updates_path_links() {
        let notes = ["Inbox/Idea.md", "Roadmap.md"];
        let text = "[[Idea]] and [[Inbox/Idea|it]]\n";
        let (out, n) = run(
            &notes,
            "Inbox/Idea.md",
            "Projects/Idea.md",
            "Roadmap.md",
            text,
        );
        assert_eq!(n, 1);
        assert_eq!(out, "[[Idea]] and [[Projects/Idea|it]]\n");
    }

    #[test]
    fn uses_the_path_when_the_new_name_is_taken() {
        let notes = ["A/Old.md", "B/New.md", "Roadmap.md"];
        let (out, _) = run(
            &notes,
            "A/Old.md",
            "A/New.md",
            "Roadmap.md",
            "[[Old]] vs [[New]]\n",
        );
        // Both links stay unambiguous: the renamed note and the other "New".
        assert_eq!(out, "[[A/New]] vs [[B/New]]\n");
    }

    #[test]
    fn leaves_links_that_point_elsewhere() {
        // A top-level "Old" wins over "A/Old" for `[[Old]]`, like in the editor.
        let notes = ["A/Old.md", "Old.md", "Roadmap.md"];
        let (out, n) = run(
            &notes,
            "A/Old.md",
            "A/Renamed.md",
            "Roadmap.md",
            "[[Old]] and [[A/Old]]\n",
        );
        assert_eq!(n, 1);
        assert_eq!(out, "[[Old]] and [[A/Renamed]]\n");
    }

    #[test]
    fn skips_code_blocks_and_inline_code() {
        let notes = ["Old.md", "Roadmap.md"];
        let text = "[[Old]] `[[Old]]` ``a [[Old]] b``\n```md\n[[Old]]\n```\n~~~\n[[Old]]\n~~~\nlast [[Old]]";
        let (out, n) = run(&notes, "Old.md", "New.md", "Roadmap.md", text);
        assert_eq!(n, 2);
        assert_eq!(
            out,
            "[[New]] `[[Old]]` ``a [[Old]] b``\n```md\n[[Old]]\n```\n~~~\n[[Old]]\n~~~\nlast [[New]]"
        );
    }

    #[test]
    fn keeps_escaped_table_pipes() {
        let notes = ["Old.md", "Roadmap.md"];
        let (out, _) = run(
            &notes,
            "Old.md",
            "New.md",
            "Roadmap.md",
            "| [[Old\\|alias]] | x |\n",
        );
        assert_eq!(out, "| [[New\\|alias]] | x |\n");
    }

    #[test]
    fn rewrites_relative_markdown_links() {
        let notes = ["Projects/Merge UX.md", "Projects/Plan.md", "Roadmap.md"];
        let text = "[a](Projects/Merge%20UX.md) [b](<Projects/Merge UX.md>) [c](Projects/Merge%20UX.md#Layout \"t\")\n\
                    [web](https://example.com/Merge%20UX.md) ![img](Projects/Merge%20UX.png)\n";
        let (out, n) = run(
            &notes,
            "Projects/Merge UX.md",
            "Archive/Merge (old).md",
            "Roadmap.md",
            text,
        );
        assert_eq!(n, 3);
        assert_eq!(
            out,
            "[a](Archive/Merge%20%28old%29.md) [b](<Archive/Merge (old).md>) [c](Archive/Merge%20%28old%29.md#Layout \"t\")\n\
             [web](https://example.com/Merge%20UX.md) ![img](Projects/Merge%20UX.png)\n"
        );

        // From a sibling in Projects: relative to the note's folder, with `..`.
        let (out, _) = run(
            &notes,
            "Projects/Merge UX.md",
            "Archive/Merge UX.md",
            "Projects/Plan.md",
            "[m](Merge%20UX.md)\n",
        );
        assert_eq!(out, "[m](../Archive/Merge%20UX.md)\n");
    }

    #[test]
    fn moved_note_keeps_its_own_relative_links_working() {
        let notes = ["Projects/Plan.md", "Projects/Spec.md", "Home.md"];
        let text = "[spec](Spec.md) [home](../Home.md) [[Spec]] [self](Plan.md)\n";
        let (out, n) = run(
            &notes,
            "Projects/Plan.md",
            "Archive/2026/Plan.md",
            "Projects/Plan.md",
            text,
        );
        assert_eq!(n, 2);
        assert_eq!(
            out,
            "[spec](../../Projects/Spec.md) [home](../../Home.md) [[Spec]] [self](Plan.md)\n"
        );
    }

    #[test]
    fn finds_the_line_that_links() {
        let notes = paths(&["Projects/Plan.md", "Projects/Spec.md", "Home.md"]);
        let text = "```\n[[Plan]]\n```\nIntro `[[Plan]]`\n  See [the plan](Projects/Plan.md) too\n[[Plan]]\n";
        assert_eq!(
            line_linking_to(text, "Home.md", "Projects/Plan.md", &notes),
            Some("See [the plan](Projects/Plan.md) too")
        );
        assert_eq!(
            line_linking_to(
                "[s](Spec.md)",
                "Projects/Plan.md",
                "Projects/Spec.md",
                &notes
            ),
            Some("[s](Spec.md)")
        );
        assert_eq!(
            line_linking_to("[[Planning]]", "Home.md", "Projects/Plan.md", &notes),
            None
        );
    }

    #[test]
    fn retitles_a_matching_heading() {
        assert_eq!(
            retitle("# Old\r\nBody\r\n", "Old", "New").as_deref(),
            Some("# New\r\nBody\r\n")
        );
        assert_eq!(
            retitle("---\ntags: [a]\n---\n\n# Old \n", "Old", "New").as_deref(),
            Some("---\ntags: [a]\n---\n\n# New \n")
        );
        assert_eq!(retitle("# Something else\n", "Old", "New"), None);
        assert_eq!(retitle("Intro\n# Old\n", "Old", "New"), None);
        assert_eq!(retitle("## Old\n", "Old", "New"), None);
        assert_eq!(retitle("---\nunclosed\n", "Old", "New"), None);
    }

    #[test]
    fn renaming_a_file_updates_embeds_by_name_and_path() {
        let notes = ["Home.md"];
        let files = [
            "Attachments/pic.png",
            "Other/pic.png",
            "Attachments/report.pdf",
        ];
        let text = "![[pic.png]] ![[Attachments/pic.png]] ![](Attachments/pic.png) [r](Attachments/report.pdf)\n";
        // Renamed: name-only embeds take the new name.
        let (out, n) = run_with_files(
            &notes,
            &files,
            "Attachments/pic.png",
            "Attachments/diagram.png",
            "Home.md",
            text,
        );
        assert_eq!(n, 3);
        assert_eq!(
            out,
            "![[diagram.png]] ![[Attachments/diagram.png]] ![](Attachments/diagram.png) [r](Attachments/report.pdf)\n"
        );
        // Renamed to a name another file has: the path keeps it unambiguous.
        let (out, _) = run_with_files(
            &notes,
            &files,
            "Attachments/pic.png",
            "Attachments/pic2.png",
            "Home.md",
            "![[pic.png]]\n",
        );
        assert_eq!(out, "![[pic2.png]]\n");
        let files2 = ["Attachments/a.png", "Other/b.png"];
        let (out, _) = run_with_files(
            &notes,
            &files2,
            "Attachments/a.png",
            "Attachments/b.png",
            "Home.md",
            "![[a.png]]\n",
        );
        assert_eq!(out, "![[Attachments/b.png]]\n");
    }

    #[test]
    fn finds_the_files_a_note_uses() {
        let files = paths(&[
            "Attachments/pic.png",
            "Projects/diagram.png",
            "Attachments/unused.pdf",
            "notes.txt",
        ]);
        let text = "![](../Attachments/pic.png) ![[diagram.png]] `![[notes.txt]]` [x](https://e.com/a.pdf)\n";
        assert_eq!(
            files_linked(text, "Projects/Plan.md", &files),
            ["Attachments/pic.png", "Projects/diagram.png"]
        );
        assert_eq!(
            files_linked("![](Attachments/pic.png)", "Deep/Down/Note.md", &files),
            ["Attachments/pic.png"]
        );
    }

    #[test]
    fn lists_headings() {
        let text = "---\ntitle: # not a heading\n---\n# Plan\n\n## Next week ##\n```\n# code\n```\n#nope\n### Later\n";
        assert_eq!(
            headings(text),
            [
                (1, "Plan".to_owned(), 4),
                (2, "Next week".to_owned(), 6),
                (3, "Later".to_owned(), 11)
            ]
        );
    }

    #[test]
    fn leaves_text_without_links_untouched() {
        let notes = ["Old.md"];
        let text = "# Title\r\n\r\nNo links ] ( here [x] (y)\r\n";
        assert_eq!(
            run(&notes, "Old.md", "New.md", "Other.md", text),
            (text.to_owned(), 0)
        );
    }
}
