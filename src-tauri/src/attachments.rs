//! Attachments: images and other files kept in the vault beside the notes.
//!
//! Pasted images and dropped or picked files are copied into the vault's
//! attachments folder (a vault setting; empty means "next to the note"), and
//! the note links to them with ordinary relative Markdown links. The `penna:`
//! URI scheme serves vault files to the editor's `<img>` tags, and only files
//! inside the open vault that `vault::resolve` accepts.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::http::{Response, StatusCode, header};
use walkdir::WalkDir;

use crate::error::{AppError, AppResult, IoContext};
use crate::links;
use crate::vault::{self, is_hidden, is_note, resolve, to_relative};

/// Never opened from a link (they'd run code); shown in Explorer instead.
const RUNNABLE: &[&str] = &[
    "exe",
    "com",
    "bat",
    "cmd",
    "ps1",
    "psm1",
    "vbs",
    "vbe",
    "js",
    "jse",
    "wsf",
    "wsh",
    "msi",
    "msp",
    "scr",
    "hta",
    "cpl",
    "lnk",
    "url",
    "reg",
    "jar",
    "appref-ms",
    "application",
    "pif",
    "gadget",
    "msc",
    "inf",
];

fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Every file in the vault that isn't a note (images, PDFs, …), by path.
/// Hidden files and folders are skipped, like everywhere else.
pub fn list(root: &Path) -> AppResult<Vec<String>> {
    vault::ensure_vault(root)?;
    let mut out: Vec<String> = WalkDir::new(root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !is_hidden(e.file_name()))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && !is_note(e.path()))
        .filter_map(|e| to_relative(root, e.path()))
        .collect();
    out.sort_by_key(|p| p.to_lowercase());
    Ok(out)
}

/// A safe file name: no folders, no characters Windows forbids, not hidden.
fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') && !c.is_control())
        .collect();
    let cleaned = cleaned
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' ']);
    if cleaned.is_empty() {
        "file".to_owned()
    } else {
        cleaned.to_owned()
    }
}

/// The folder new attachments for `note` go in: `folder` (vault-relative), or
/// the note's own folder when `folder` is empty.
fn target_dir(root: &Path, folder: &str, note: &str) -> AppResult<PathBuf> {
    let folder = folder.trim().trim_matches('/');
    if !folder.is_empty() {
        return resolve(root, folder);
    }
    let note = resolve(root, note)?;
    Ok(note
        .parent()
        .map_or_else(|| root.to_path_buf(), Path::to_path_buf))
}

/// Create `name` in `dir` without replacing anything: `photo.png`,
/// `photo 1.png`, `photo 2.png`, … Returns the new file's path.
fn create_unique(dir: &Path, name: &str, data: &[u8]) -> AppResult<PathBuf> {
    fs::create_dir_all(dir).ctx("creating folder", dir)?;
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 0..10_000 {
        let candidate = dir.join(if n == 0 {
            format!("{stem}{ext}")
        } else {
            format!("{stem} {n}{ext}")
        });
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(mut file) => {
                let written = file.write_all(data).and_then(|()| file.sync_all());
                if let Err(err) = written {
                    drop(file);
                    let _ = fs::remove_file(&candidate);
                    return Err(AppError::Io {
                        context: format!("writing '{}'", candidate.display()),
                        source: err,
                    });
                }
                return Ok(candidate);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                return Err(AppError::Io {
                    context: format!("creating '{}'", candidate.display()),
                    source: err,
                });
            }
        }
    }
    Err(AppError::AlreadyExists(name.to_owned()))
}

fn relative(root: &Path, path: &Path) -> AppResult<String> {
    to_relative(root, path).ok_or_else(|| AppError::InvalidPath {
        path: path.display().to_string(),
        reason: "path must be inside the vault",
    })
}

/// Save pasted file data as a new attachment for `note`. Returns its vault path.
pub fn save(root: &Path, folder: &str, note: &str, name: &str, data: &[u8]) -> AppResult<String> {
    vault::ensure_vault(root)?;
    let dir = target_dir(root, folder, note)?;
    let path = create_unique(&dir, &clean_name(name), data)?;
    relative(root, &path)
}

/// Bring files from elsewhere on the computer into the vault for `note`, and
/// return their vault paths. Files already inside the vault aren't copied;
/// the note links to them where they are.
pub fn import(root: &Path, folder: &str, note: &str, sources: &[String]) -> AppResult<Vec<String>> {
    vault::ensure_vault(root)?;
    let canonical_root = fs::canonicalize(root).ctx("reading", root)?;
    let dir = target_dir(root, folder, note)?;
    let mut out = Vec::new();
    for source in sources {
        let source = PathBuf::from(source);
        if !source.is_file() {
            continue; // folders and vanished files are skipped
        }
        if let Ok(canonical) = fs::canonicalize(&source)
            && let Some(rel) = to_relative(&canonical_root, &canonical)
            && resolve(root, &rel).is_ok()
        {
            out.push(rel);
            continue;
        }
        let data = fs::read(&source).ctx("reading", &source)?;
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let path = create_unique(&dir, &clean_name(&name), &data)?;
        out.push(relative(root, &path)?);
    }
    Ok(out)
}

/// What opening an attachment from a link should do.
#[derive(Debug, PartialEq, Eq)]
pub enum Open {
    /// Open with its default app.
    App(PathBuf),
    /// Programs and scripts are only shown in Explorer, never run.
    Reveal(PathBuf),
}

pub fn open_target(root: &Path, rel: &str) -> AppResult<Open> {
    let path = resolve(root, rel)?;
    if !path.is_file() {
        return Err(AppError::NotFound(rel.to_owned()));
    }
    Ok(if RUNNABLE.contains(&extension(&path).as_str()) {
        Open::Reveal(path)
    } else {
        Open::App(path)
    })
}

pub(crate) fn mime(path: &Path) -> &'static str {
    match extension(path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "md" | "markdown" | "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = code;
    response
}

/// Answer a `penna:` request: `/<percent-encoded vault path>` → the file's bytes.
/// Only files inside the open vault are served (no `..`, no hidden folders).
pub fn serve(root: Option<PathBuf>, uri_path: &str) -> Response<Vec<u8>> {
    let Some(root) = root else {
        return status(StatusCode::NOT_FOUND);
    };
    let Some(rel) = links::percent_decode(uri_path.trim_start_matches('/')) else {
        return status(StatusCode::BAD_REQUEST);
    };
    let Ok(path) = resolve(&root, &rel) else {
        return status(StatusCode::FORBIDDEN);
    };
    match fs::read(&path) {
        Ok(data) => {
            let mut response = Response::new(data);
            let headers = response.headers_mut();
            if let Ok(value) = mime(&path).parse() {
                headers.insert(header::CONTENT_TYPE, value);
            }
            // Edited images show up right away.
            headers.insert(
                header::CACHE_CONTROL,
                header::HeaderValue::from_static("no-cache"),
            );
            // An SVG can hold scripts; never let it run them.
            headers.insert(
                header::CONTENT_SECURITY_POLICY,
                header::HeaderValue::from_static(
                    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                ),
            );
            response
        }
        Err(_) => status(StatusCode::NOT_FOUND),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("penna-attach-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn saves_imports_lists_and_serves() {
        let root = temp_vault("save");
        fs::create_dir_all(root.join("Projects")).unwrap();
        fs::write(root.join("Projects/Plan.md"), "# Plan").unwrap();

        // Into the attachments folder, never overwriting.
        let a = save(
            &root,
            "Attachments",
            "Projects/Plan.md",
            "Pasted image.png",
            b"one",
        )
        .unwrap();
        let b = save(
            &root,
            "Attachments",
            "Projects/Plan.md",
            "Pasted image.png",
            b"two",
        )
        .unwrap();
        assert_eq!(a, "Attachments/Pasted image.png");
        assert_eq!(b, "Attachments/Pasted image 1.png");
        // Empty folder setting: next to the note. Names are cleaned.
        let c = save(
            &root,
            "",
            "Projects/Plan.md",
            "..\\..\\evil:name?.pdf",
            b"x",
        )
        .unwrap();
        assert_eq!(c, "Projects/evilname.pdf");
        assert!(save(&root, "../outside", "Projects/Plan.md", "x.png", b"x").is_err());
        assert!(save(&root, ".git", "Projects/Plan.md", "x.png", b"x").is_err());

        // Files from outside are copied; files already in the vault are linked in place.
        let outside = temp_vault("save-outside");
        fs::write(outside.join("photo.jpg"), b"jpg").unwrap();
        let imported = import(
            &root,
            "Attachments",
            "Projects/Plan.md",
            &[
                outside.join("photo.jpg").display().to_string(),
                root.join("Projects/evilname.pdf").display().to_string(),
                outside.display().to_string(), // a folder: skipped
            ],
        )
        .unwrap();
        assert_eq!(imported, ["Attachments/photo.jpg", "Projects/evilname.pdf"]);

        assert_eq!(
            list(&root).unwrap(),
            [
                "Attachments/Pasted image 1.png",
                "Attachments/Pasted image.png",
                "Attachments/photo.jpg",
                "Projects/evilname.pdf"
            ]
        );

        let ok = serve(Some(root.clone()), "/Attachments%2FPasted%20image.png");
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.body(), b"one");
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(
            serve(Some(root.clone()), "/..%2Fsecret.txt").status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            serve(Some(root.clone()), "/.git%2Fconfig").status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            serve(Some(root.clone()), "/missing.png").status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(serve(None, "/a.png").status(), StatusCode::NOT_FOUND);

        fs::write(root.join("Attachments/setup.exe"), b"MZ").unwrap();
        assert!(matches!(
            open_target(&root, "Attachments/setup.exe"),
            Ok(Open::Reveal(_))
        ));
        assert!(matches!(
            open_target(&root, "Attachments/photo.jpg"),
            Ok(Open::App(_))
        ));
        assert!(open_target(&root, "Attachments/none.png").is_err());

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }
}
