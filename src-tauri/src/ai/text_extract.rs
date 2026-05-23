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

/// Skip text extraction on files larger than this. PDF/docx parsing scales
/// with the whole document, and even ~1 MB PDFs can take many seconds in
/// `pdf-extract`. At this size the filename alone is a better embedding
/// input. Pulled in from 5 MB → 1 MB after the first real scan still hung.
const MAX_EXTRACT_BYTES: u64 = 1024 * 1024;

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
/// extractable text. Never panics — a parser blowing up on a malformed
/// file degrades to "".
pub fn extract_text(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    // Size gate — parsers that scale with the whole file (PDF / docx)
    // get cut off above MAX_EXTRACT_BYTES. Text-like formats are read in
    // one shot too via `read_to_string` and we truncate to MAX_CHARS
    // after; a 50 MB GeoJSON would briefly allocate 50 MB just to drop
    // 99 % of it. Apply the same gate to the big-data text formats and
    // to CSV/JSON which can also exceed 1 MB in the wild.
    let needs_size_gate = matches!(
        ext.as_str(),
        "docx" | "pdf" | "geojson" | "topojson" | "kml" | "gpx" | "json" | "csv" | "xml"
    );
    if needs_size_gate {
        match std::fs::metadata(path) {
            Ok(m) if m.len() > MAX_EXTRACT_BYTES => return String::new(),
            _ => {}
        }
    }

    let raw: Option<String> = if TEXT_EXTS.contains(&ext.as_str()) {
        std::fs::read_to_string(path).ok()
    } else if ext == "docx" {
        docx_text(path)
    } else if ext == "pdf" {
        pdf_text(path)
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
fn pdf_text(path: &Path) -> Option<String> {
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
    // 1.5s budget: well-formed PDFs parse in under 500ms even at the
    // 1 MB size cap, so anything that takes longer is almost certainly
    // malformed — better to fall back to filename-only embedding than
    // to spend 3 seconds chasing a broken cross-reference table.
    match rx.recv_timeout(Duration::from_millis(1500)) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("[ai_embed] pdf_text timed out, leaking thread for {}",
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
