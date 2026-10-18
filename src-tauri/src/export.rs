//! Exporting a note: a self-contained web page, or a PDF of the page.
//!
//! The frontend renders the note to HTML. For a web page it marks the vault
//! images as `src="penna-vault:<path>"`; here they're read and put inside
//! the file, so it opens anywhere. A PDF is printed by WebView2 itself, from
//! the app's own page while it shows the note in print layout.

use std::fs;
use std::path::Path;

use crate::attachments::mime;
use crate::error::{AppResult, IoContext};
use crate::links::percent_decode;
use crate::vault::resolve;

const MARK: &str = "penna-vault:";

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// A vault file as a `data:` URI, if it's there.
fn data_uri(root: &Path, rel: &str) -> Option<String> {
    let path = resolve(root, rel).ok()?;
    let bytes = fs::read(&path).ok()?;
    Some(format!("data:{};base64,{}", mime(&path), base64(&bytes)))
}

/// Put the vault images an exported page names into the page itself.
pub fn inline_images(root: &Path, html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(i) = rest.find(MARK) {
        out.push_str(&rest[..i]);
        let after = &rest[i + MARK.len()..];
        let end = after.find('"').unwrap_or(after.len());
        if let Some(uri) = percent_decode(&after[..end]).and_then(|rel| data_uri(root, &rel)) {
            out.push_str(&uri);
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// Write an exported web page where the user chose.
pub fn save_html(root: &Path, html: &str, target: &Path) -> AppResult<()> {
    fs::write(target, inline_images(root, html)).ctx("saving", target)
}

/// Print the webview's page (in print layout) to a PDF. `width` and `height`
/// are the paper size in inches. Calls `done` when WebView2 has written it.
#[cfg(windows)]
pub fn print_to_pdf(
    webview: &tauri::webview::PlatformWebview,
    path: &str,
    width: f64,
    height: f64,
    done: Box<dyn FnOnce(Result<(), String>)>,
) -> windows_core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_7, ICoreWebView2Environment6,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{HSTRING, Interface};

    unsafe {
        let core: ICoreWebView2_7 = webview.controller().CoreWebView2()?.cast()?;
        let env: ICoreWebView2Environment6 = webview.environment().cast()?;
        let settings = env.CreatePrintSettings()?;
        settings.SetShouldPrintBackgrounds(true)?;
        settings.SetShouldPrintHeaderAndFooter(false)?;
        settings.SetPageWidth(width)?;
        settings.SetPageHeight(height)?;
        settings.SetMarginTop(0.75)?;
        settings.SetMarginBottom(0.75)?;
        settings.SetMarginLeft(0.85)?;
        settings.SetMarginRight(0.85)?;
        let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
            done(match result {
                Err(err) => Err(err.message()),
                Ok(()) if ok => Ok(()),
                Ok(()) => Err("WebView2 couldn't write the PDF there".to_owned()),
            });
            Ok(())
        }));
        core.PrintToPdf(&HSTRING::from(path), &settings, &handler)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar!"), "Zm9vYmFyIQ==");
    }

    #[test]
    fn inlines_vault_images_only() {
        let dir = std::env::temp_dir().join(format!("penna-export-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Attachments")).unwrap();
        fs::write(dir.join("Attachments/dot one.png"), [1u8, 2, 3]).unwrap();
        let html = r#"<img src="penna-vault:Attachments%2Fdot%20one.png" alt=""><img src="penna-vault:..%2Fsecret.png"><img src="https://x/y.png">"#;
        assert_eq!(
            inline_images(&dir, html),
            r#"<img src="data:image/png;base64,AQID" alt=""><img src=""><img src="https://x/y.png">"#
        );
    }
}
