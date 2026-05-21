//! On-disk embedding cache (Phase 3, Stage D).
//!
//! Embeddings are stable functions of file content. The Stage A pipeline
//! re-extracts and re-embeds every file on every scan, which on a typical
//! document folder costs tens of seconds of single-threaded ONNX
//! inference. This cache short-circuits that: every successful embed is
//! written to disk keyed by `(absolute_path, mtime, size)`. Subsequent
//! scans pay only for files that actually changed.
//!
//! Storage shape: a single JSON file in the app's local data directory
//! (`ai-embeddings.json`). JSON over a binary format because at our scale
//! (a few thousand files × 384 f32s ≈ 6 MB) the simplicity wins — easy to
//! inspect, no migrations, no extra dep on `bincode`.
//!
//! Privacy: the cache stores only the 384-dim float vector per file. It
//! does NOT store extracted text or filename content beyond the path key.
//! Path keys live exclusively in the local file system. There's a sibling
//! "Clear AI cache" button in Settings (see `ai_clear_embedding_cache`).
//!
//! Eviction: on save, entries whose file no longer exists at the recorded
//! path are dropped. A hard cap of `MAX_ENTRIES` prevents unbounded
//! growth (oldest by `embedded_at` are evicted first).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Maximum cached entries before LRU-by-embedded-at trimming kicks in. At
/// ~1.5 KB per entry (384 floats + metadata) this caps the file around
/// 15 MB — well under any reasonable budget.
const MAX_ENTRIES: usize = 10_000;

/// One cached embedding.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CacheEntry {
    /// File's mtime in seconds since the Unix epoch when embedded.
    pub mtime_s: u64,
    /// File size in bytes when embedded.
    pub size: u64,
    /// L2-normalised embedding vector (384 dims for `bge-small-en-v1.5`).
    pub vec: Vec<f32>,
    /// Wall-clock epoch seconds when this entry was written. Used by the
    /// eviction policy when the cache exceeds `MAX_ENTRIES`.
    pub embedded_at: u64,
}

/// In-memory mirror of the on-disk JSON. `dirty` tracks whether we need
/// to write back. Construction is `load` or `default`; mutation is
/// `insert` / `evict_missing`; persistence is `save`.
#[derive(Default)]
pub struct EmbeddingCache {
    /// Path → entry. Path is the cache key verbatim (no normalisation).
    entries: HashMap<String, CacheEntry>,
    /// True when an insert/evict has happened since last `save`.
    dirty: bool,
}

impl EmbeddingCache {
    /// Read the cache from `path`. Missing file, malformed JSON, or any
    /// IO error returns an empty cache — a corrupt cache must never break
    /// embedding; it just means the next scan pays the cold-cache cost.
    pub fn load(path: &Path) -> Self {
        let raw = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => return Self::default(),
        };
        let entries: HashMap<String, CacheEntry> = match serde_json::from_slice(&raw) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[ai_cache] ignoring corrupt cache at {}: {e}", path.display());
                return Self::default();
            }
        };
        Self { entries, dirty: false }
    }

    /// Atomic write to `path` (write to `.tmp` then rename). Skipped when
    /// the cache hasn't changed since load. Errors are logged but never
    /// propagated — failing to persist the cache must not break embedding.
    pub fn save(&mut self, path: &Path) {
        if !self.dirty {
            return;
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = path.with_extension("json.tmp");
        let serialised = match serde_json::to_vec(&self.entries) {
            Ok(b) => b,
            Err(e) => {
                eprintln!("[ai_cache] serialize failed: {e}");
                return;
            }
        };
        if let Err(e) = std::fs::write(&tmp, &serialised) {
            eprintln!("[ai_cache] write {} failed: {e}", tmp.display());
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, path) {
            eprintln!("[ai_cache] rename to {} failed: {e}", path.display());
            return;
        }
        self.dirty = false;
    }

    /// Look up a vector for `path` if the cached entry's `(mtime, size)`
    /// still matches the file on disk. Returns `None` on any mismatch —
    /// the caller should re-embed. Reads `metadata` once per call; on a
    /// hot scan this is the single bottleneck of the cache path and is
    /// still vastly cheaper than re-running tract.
    pub fn get_if_fresh(&self, path: &str) -> Option<Vec<f32>> {
        let entry = self.entries.get(path)?;
        let meta = std::fs::metadata(path).ok()?;
        let mtime_s = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if mtime_s == entry.mtime_s && meta.len() == entry.size {
            Some(entry.vec.clone())
        } else {
            None
        }
    }

    /// Write a fresh `(path, mtime, size, vec)` entry. Reads `metadata`
    /// from disk to capture the current `(mtime, size)` — the caller has
    /// always already touched the file so this is in OS cache.
    pub fn insert(&mut self, path: &str, vec: Vec<f32>) {
        let meta = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => return, // file vanished between embed and insert; skip
        };
        let mtime_s = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.entries.insert(
            path.to_string(),
            CacheEntry { mtime_s, size: meta.len(), vec, embedded_at: now },
        );
        self.dirty = true;
    }

    /// Drop entries whose file no longer exists. Plus, if the cache is
    /// over `MAX_ENTRIES`, drop the oldest-embedded ones until under the
    /// cap. Called once per save.
    pub fn trim(&mut self) {
        let before = self.entries.len();
        self.entries.retain(|p, _| Path::new(p).exists());
        if self.entries.len() < before {
            self.dirty = true;
        }
        if self.entries.len() > MAX_ENTRIES {
            let mut by_age: Vec<(String, u64)> =
                self.entries.iter().map(|(k, v)| (k.clone(), v.embedded_at)).collect();
            by_age.sort_by_key(|(_, t)| *t);
            let drop_n = self.entries.len() - MAX_ENTRIES;
            for (k, _) in by_age.iter().take(drop_n) {
                self.entries.remove(k);
            }
            self.dirty = true;
        }
    }

    /// Drop every entry — backs the `ai_clear_embedding_cache` IPC. The
    /// file isn't deleted; the next `save` writes an empty map.
    pub fn clear(&mut self) {
        if !self.entries.is_empty() {
            self.entries.clear();
            self.dirty = true;
        }
    }

    /// Count of stored entries — for the Settings UI ("Cached: N files").
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// On-disk path for the embedding cache (alongside `models/`).
pub fn cache_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    Ok(base.join("ai-embeddings.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_tmp_file(content: &str) -> PathBuf {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "tmp_cache_{}.txt",
            std::process::id() as u64 * 1_000_000
                + SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos() as u64
        ));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        path
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = std::env::temp_dir();
        let cache_file = dir.join(format!(
            "test_cache_{}.json",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos()
        ));
        let tmp = make_tmp_file("hello");
        let key = tmp.to_string_lossy().to_string();

        let mut c = EmbeddingCache::default();
        c.insert(&key, vec![0.1, 0.2, 0.3]);
        c.save(&cache_file);

        let reloaded = EmbeddingCache::load(&cache_file);
        let v = reloaded.get_if_fresh(&key).expect("fresh hit");
        assert_eq!(v, vec![0.1, 0.2, 0.3]);

        // Cleanup
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&cache_file);
    }

    #[test]
    fn invalidates_on_mtime_change() {
        let tmp = make_tmp_file("original");
        let key = tmp.to_string_lossy().to_string();
        let mut c = EmbeddingCache::default();
        c.insert(&key, vec![1.0; 4]);

        // Mutate the file to bump mtime + size.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&tmp, "rewritten with different length").unwrap();

        assert!(c.get_if_fresh(&key).is_none());

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn trim_drops_missing_files() {
        let tmp = make_tmp_file("x");
        let key = tmp.to_string_lossy().to_string();
        let mut c = EmbeddingCache::default();
        c.insert(&key, vec![1.0; 4]);
        c.insert("C:\\definitely-not-a-real-path-12345.txt", vec![2.0; 4]);

        c.trim();
        assert!(c.get_if_fresh(&key).is_some());
        assert!(c.entries.get("C:\\definitely-not-a-real-path-12345.txt").is_none());

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn corrupt_cache_loads_as_empty() {
        let dir = std::env::temp_dir();
        let cache_file = dir.join(format!(
            "corrupt_cache_{}.json",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos()
        ));
        std::fs::write(&cache_file, b"{this is not json").unwrap();

        let c = EmbeddingCache::load(&cache_file);
        assert_eq!(c.len(), 0);

        let _ = std::fs::remove_file(&cache_file);
    }
}
