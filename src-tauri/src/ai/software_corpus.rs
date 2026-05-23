//! Curated software-description corpus for P5 (semantic process explanation).
//!
//! When the rule-based explainer (`src/lib/processExplain.ts`) has nothing to
//! say about a process — no publisher metadata, an unrecognised name — the
//! frontend asks the embedding model to find the closest entry here and shows
//! its plain-language description. Catches indie tools, portable utilities,
//! and OEM binaries that carry no version resource for the rules to read.
//!
//! Each entry pairs short KEYWORDS (names/aliases the embedder anchors on)
//! with a one-line, jargon-free DESCRIPTION shown verbatim to the user. The
//! query embedded against this corpus is the process's
//! `name + product + publisher + path + window title` — so a window title
//! like "Invoice 2024 — FastBooks" can match the "accounting / invoicing
//! software" entry even when the exe is unknown.
//!
//! The corpus is embedded once (lazily, on first use) and the vectors are
//! cached process-wide. Everything stays on-device.

use std::path::Path;
use std::sync::OnceLock;

/// One corpus entry: anchor keywords + the description shown to the user.
pub struct CorpusEntry {
    /// Names / aliases / strong keywords for the embedder to latch onto.
    pub keywords: &'static str,
    /// Plain-language, user-facing description. No technical jargon.
    pub description: &'static str,
}

macro_rules! entry {
    ($k:expr, $d:expr) => {
        CorpusEntry { keywords: $k, description: $d }
    };
}

/// The corpus. Mixes specific well-known apps (so an exe stripped of its
/// version info still matches) with broad category descriptions (so a
/// genuinely unknown tool maps to the right kind of software).
pub static CORPUS: &[CorpusEntry] = &[
    // --- Development / engineering ---
    entry!("code editor IDE programming source code text editor", "A code or text editor used for software development."),
    entry!("compiler build tool toolchain", "A build or compiler tool that turns source code into a program."),
    entry!("terminal command line shell console", "A command-line terminal for running text commands."),
    entry!("git version control repository commit", "A version-control tool for tracking changes to code."),
    entry!("database client SQL query browser", "A database tool for browsing and querying data."),
    entry!("docker container virtual machine", "Software for running apps in isolated containers or virtual machines."),
    entry!("api testing rest client postman", "A tool for testing web APIs and requests."),

    // --- Creative / media production ---
    entry!("video editor timeline render export footage", "Video-editing software for cutting and producing footage."),
    entry!("photo editor image raster layers retouch", "An image editor for editing and retouching photos."),
    entry!("vector graphics illustration draw design", "A drawing tool for vector graphics and illustration."),
    entry!("3d modeling animation render sculpt mesh", "3D modeling, animation, and rendering software."),
    entry!("audio editor digital audio workstation music production mixing", "Audio-editing or music-production software."),
    entry!("screen recorder capture streaming broadcast", "Software for recording or streaming your screen."),
    entry!("cad computer aided design drafting engineering drawing", "Computer-aided design (CAD) software for technical drawings."),

    // --- Office / productivity ---
    entry!("word processor document letter report writing", "A word processor for writing documents."),
    entry!("spreadsheet table formula numbers calc", "A spreadsheet program for tables and calculations."),
    entry!("presentation slides deck slideshow", "Presentation software for building slide decks."),
    entry!("pdf reader viewer annotate document", "A PDF reader for viewing and annotating documents."),
    entry!("note taking notebook markdown organize ideas", "A note-taking app for organizing notes and ideas."),
    entry!("calendar scheduling appointments planner", "A calendar or scheduling app."),
    entry!("email client mail inbox messages", "An email client for reading and sending mail."),
    entry!("accounting invoicing bookkeeping finance taxes", "Accounting or invoicing software for managing finances."),
    entry!("project management tasks kanban tracker", "A project- or task-management tool."),
    entry!("ebook reader library reading", "An e-book reader for digital books."),
    entry!("reference manager citations bibliography research", "A reference manager for research citations."),

    // --- Communication ---
    entry!("chat messaging instant message conversation", "A chat or instant-messaging app."),
    entry!("video call meeting conference webcam", "An app for video calls and online meetings."),
    entry!("voice chat voip calling", "A voice-calling app."),

    // --- Web / browsing ---
    entry!("web browser website tabs internet pages", "A web browser for visiting websites."),
    entry!("download manager torrent file transfer", "A download or file-transfer tool."),

    // --- Media playback ---
    entry!("media player video playback movie watch", "A media player for watching video."),
    entry!("music player audio playback songs playlist", "A music player for listening to audio."),

    // --- Gaming ---
    entry!("video game gameplay 3d game level multiplayer", "A video game."),
    entry!("game launcher store library install games", "A game launcher or store for installing and running games."),
    entry!("game mod modding loader patch", "A tool for modding or patching games."),
    entry!("game emulator console retro rom", "An emulator for running console or retro games."),

    // --- Utilities / system ---
    entry!("file manager explorer folders copy organize files", "A file manager for browsing and organizing files."),
    entry!("archive zip compression extract rar 7zip", "An archiving tool for compressing and extracting files."),
    entry!("backup sync cloud storage drive files", "A backup or cloud-sync tool for keeping files safe."),
    entry!("antivirus security malware scan protection", "Security software that scans for malware."),
    entry!("vpn private network proxy tunnel", "A VPN client for private network connections."),
    entry!("password manager vault credentials login", "A password manager for storing logins."),
    entry!("disk cleaner optimizer tuneup registry clean", "A system-cleanup or optimization utility."),
    entry!("hardware monitor temperature fan sensors benchmark", "A hardware-monitoring or benchmarking tool."),
    entry!("screenshot capture annotate snip image grab", "A screenshot-capture tool."),
    entry!("clipboard manager history paste snippets", "A clipboard-history utility."),
    entry!("remote desktop control connect another computer", "Remote-desktop software for controlling another computer."),
    entry!("driver update firmware device peripheral", "A driver- or firmware-update tool for hardware."),
    entry!("keyboard mouse macro rgb peripheral configuration", "Configuration software for a keyboard, mouse, or other peripheral."),
    entry!("installer setup wizard install program", "An installer that sets up another program."),
    entry!("updater auto update patch maintenance", "A background updater that keeps another app current."),
    entry!("system tray helper background agent service", "A small background helper that supports another application."),

    // --- Education / reference / misc ---
    entry!("dictionary translation language learning", "A dictionary, translation, or language-learning tool."),
    entry!("map navigation gps location geographic", "A maps or navigation tool."),
    entry!("calculator math compute numbers", "A calculator or math tool."),
    entry!("virtual machine hypervisor emulate os", "Software for running another operating system in a virtual machine."),
    entry!("crypto wallet blockchain trading exchange", "A cryptocurrency wallet or trading app."),
    entry!("weather forecast climate", "A weather app."),
];

/// Process-wide cache of the corpus embeddings. Embedded lazily on first
/// `explain` call and reused thereafter — the corpus is static so the
/// vectors never change.
static CORPUS_VECS: OnceLock<Vec<Vec<f32>>> = OnceLock::new();

/// Dot product of two L2-normalised vectors = cosine similarity.
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut s = 0.0;
    for i in 0..a.len().min(b.len()) {
        s += a[i] * b[i];
    }
    s
}

/// Embed the corpus once (per process) and return the cached vectors.
/// Errors propagate when the model isn't installed — the caller treats that
/// as "no explanation available" and falls back to the rule-based text.
fn corpus_vectors(dir: &Path) -> Result<&'static Vec<Vec<f32>>, String> {
    if let Some(v) = CORPUS_VECS.get() {
        return Ok(v);
    }
    let texts: Vec<String> = CORPUS
        .iter()
        .map(|e| format!("{}. {}", e.keywords, e.description))
        .collect();
    let vecs = crate::ai::embeddings::embed_texts(dir, &texts)?;
    // A racing thread may have set it first; either way the stored value is
    // identical (the corpus is static), so ignore the set() result.
    let _ = CORPUS_VECS.set(vecs);
    Ok(CORPUS_VECS.get().expect("corpus vectors just set"))
}

/// Minimum cosine for a corpus match to be shown. Below this the closest
/// description is too loose to be trustworthy — better to say nothing and
/// let the rule-based fallback stand. Process queries are short (exe name +
/// window title), so this is calibrated a touch below the document-search
/// floor.
const EXPLAIN_FLOOR: f32 = 0.40;

/// Find the closest corpus description to `query_text`. Returns
/// `(description, cosine)` when a match clears `EXPLAIN_FLOOR`, else `None`.
pub fn explain(dir: &Path, query_text: &str) -> Result<Option<(String, f32)>, String> {
    let q = query_text.trim();
    if q.is_empty() {
        return Ok(None);
    }
    let vecs = corpus_vectors(dir)?;
    let mut qv = crate::ai::embeddings::try_embed_texts(dir, &[q.to_string()])?;
    let query_vec = qv.pop().ok_or_else(|| "empty query embedding".to_string())?;

    let mut best_i = 0usize;
    let mut best = f32::MIN;
    for (i, v) in vecs.iter().enumerate() {
        let s = cosine(&query_vec, v);
        if s > best {
            best = s;
            best_i = i;
        }
    }
    if best >= EXPLAIN_FLOOR {
        Ok(Some((CORPUS[best_i].description.to_string(), best)))
    } else {
        Ok(None)
    }
}
