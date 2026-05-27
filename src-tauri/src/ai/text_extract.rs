//! Best-effort file text extraction for S4 content embedding (Phase 3).
//!
//! Mirrors the embedding spike's `extract.py`: plain-text / code files are
//! read directly, `.docx` is unzipped and its XML runs harvested, `.pdf`
//! is parsed. Anything else — media, archives, binaries, empty or
//! scan-only files — yields "" and the caller embeds the filename alone.
//!
//! Privacy: extraction is entirely local and in-memory; nothing is
//! transmitted. It exists only to feed the on-device embedding model.

use std::io::Read;
use std::path::Path;

/// Cap — a document's opening is the identifying part, and the embedding
/// model truncates to a few hundred tokens regardless.
const MAX_CHARS: usize = 1500;

/// Size gate for the BATCH embedding pass (200 files at once). PDF/docx
/// parsing scales with the whole document, so during a scan we cut off large
/// files and embed the filename alone — keeps a scan from taking minutes.
const BATCH_MAX_EXTRACT_BYTES: u64 = 1024 * 1024;
/// Size gate for an on-demand, single-file extraction (the B2/rename summary
/// the user explicitly asked for). Far more generous — a 3 MB problem-set PDF
/// has plenty of readable text and the user is willing to wait a beat for it.
const INTERACTIVE_MAX_EXTRACT_BYTES: u64 = 25 * 1024 * 1024;
/// PDF parse timeout, batch vs interactive. `pdf-extract` over a real
/// multi-page academic PDF routinely needs more than the 1.5 s a batch can
/// spare, so the interactive path gives it real time before giving up.
const BATCH_PDF_TIMEOUT_MS: u64 = 1500;
const INTERACTIVE_PDF_TIMEOUT_MS: u64 = 8000;

/// Extensions read verbatim as UTF-8 text. Includes geo-data formats
/// (`.geojson`, `.kml`, `.gpx`, `.topojson`) which are text under the
/// hood — without them, GeoJSON files only get filename-based embeddings
/// and search queries like "bc zoning geojson" can't differentiate the
/// 50-file blob of similarly-named files.
const TEXT_EXTS: &[&str] = &[
    "txt", "md", "markdown", "csv", "log", "bib", "tex", "py", "js", "ts",
    "tsx", "jsx", "java", "c", "cpp", "h", "rs", "go", "rb", "sh", "html",
    "css", "json", "xml", "yaml", "yml", "ini", "toml",
    "geojson", "topojson", "kml", "gpx",
];

/// Return a short text snippet for `path`, or "" when there is no
/// extractable text. Uses the BATCH limits (tight size/timeout) — call this
/// from the embedding pass that processes many files at once.
pub fn extract_text(path: &Path) -> String {
    extract_text_limited(path, BATCH_MAX_EXTRACT_BYTES, BATCH_PDF_TIMEOUT_MS)
}

/// Same, but with generous limits for an on-demand, single-file extraction
/// (B2 summary, smart rename) — a larger size cap and a longer PDF timeout so
/// real multi-MB documents (problem sets, papers) actually yield their text.
pub fn extract_text_generous(path: &Path) -> String {
    extract_text_limited(path, INTERACTIVE_MAX_EXTRACT_BYTES, INTERACTIVE_PDF_TIMEOUT_MS)
}

/// Core extraction. Never panics — a parser blowing up on a malformed file
/// degrades to "".
fn extract_text_limited(path: &Path, max_bytes: u64, pdf_timeout_ms: u64) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    // Size gate — parsers that scale with the whole file (PDF / docx) get cut
    // off above `max_bytes`. Text-like formats are read in one shot via
    // `read_to_string` and truncated to MAX_CHARS after; a 50 MB GeoJSON
    // would briefly allocate 50 MB just to drop 99 % of it. Apply the same
    // gate to the big-data text formats and to CSV/JSON.
    let needs_size_gate = matches!(
        ext.as_str(),
        "docx" | "pdf" | "geojson" | "topojson" | "kml" | "gpx" | "json" | "csv" | "xml"
    );
    if needs_size_gate {
        match std::fs::metadata(path) {
            Ok(m) if m.len() > max_bytes => return String::new(),
            _ => {}
        }
    }

    let raw: Option<String> = if TEXT_EXTS.contains(&ext.as_str()) {
        std::fs::read_to_string(path).ok()
    } else if ext == "docx" {
        docx_text(path)
    } else if ext == "pdf" {
        pdf_text(path, pdf_timeout_ms)
    } else {
        None
    };

    clean(&raw.unwrap_or_default())
}

/// Collapse all whitespace to single spaces and cap the length.
fn clean(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_CHARS).collect()
}

/// Visible text of a `.docx` — the `<w:t>` runs inside `word/document.xml`.
fn docx_text(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut zip = zip::ZipArchive::new(file).ok()?;
    let mut doc = zip.by_name("word/document.xml").ok()?;
    let mut xml = String::new();
    doc.read_to_string(&mut xml).ok()?;
    Some(harvest_w_t(&xml))
}

/// Pull the text out of every `<w:t ...>...</w:t>` run in a document XML.
fn harvest_w_t(xml: &str) -> String {
    let mut out = String::new();
    let mut rest = xml;
    while let Some(open) = rest.find("<w:t") {
        rest = &rest[open..];
        // Skip past the (possibly attributed) opening tag.
        let Some(gt) = rest.find('>') else { break };
        rest = &rest[gt + 1..];
        let Some(close) = rest.find("</w:t>") else { break };
        out.push_str(&rest[..close]);
        out.push(' ');
        rest = &rest[close + "</w:t>".len()..];
    }
    out
}

/// First pages of a `.pdf`. `pdf-extract` is a third-party parser run over
/// arbitrary user files; two failure modes are explicit:
///   • A panic on a malformed PDF — `catch_unwind` keeps it local.
///   • An infinite loop on a broken cross-reference table — wrapped in a
///     worker thread with a hard timeout. A leaked thread is acceptable;
///     hanging the entire embedding pass is not.
fn pdf_text(path: &Path, timeout_ms: u64) -> Option<String> {
    use std::sync::mpsc;
    use std::time::Duration;

    let owned = path.to_path_buf();
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let result =
            std::panic::catch_unwind(move || pdf_extract::extract_text(&owned).ok())
                .ok()
                .flatten();
        let _ = tx.send(result); // receiver may have timed out — fine.
    });
    // Batch passes give ~1.5s (a slow PDF shouldn't stall a 200-file scan);
    // the interactive path gives several seconds so real multi-page PDFs
    // finish. Past the budget we leak the worker thread and fall back to "".
    match rx.recv_timeout(Duration::from_millis(timeout_ms)) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("[ai_embed] pdf_text timed out after {timeout_ms}ms, leaking thread for {}",
                      path.display());
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harvests_docx_runs() {
        let xml = r#"<w:p><w:r><w:t>Hello</w:t></w:r>"#.to_string()
            + r#"<w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>"#;
        assert_eq!(harvest_w_t(&xml).split_whitespace().collect::<Vec<_>>(),
                   vec!["Hello", "world"]);
    }

    #[test]
    fn harvest_handles_no_runs() {
        assert_eq!(harvest_w_t("<w:p></w:p>"), "");
    }

    #[test]
    fn clean_collapses_whitespace_and_caps() {
        assert_eq!(clean("  a\n\n  b\t c "), "a b c");
        assert_eq!(clean(&"x".repeat(5000)).len(), MAX_CHARS);
    }
}
