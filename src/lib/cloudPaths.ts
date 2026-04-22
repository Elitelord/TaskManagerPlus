// Cloud-sync path detection.
//
// When a file lives under a cloud-sync root (OneDrive, Dropbox, Google Drive,
// iCloud Drive), the user action we recommend is categorically different:
//   • Local-only file → "Delete" is destructive; it's gone.
//   • Cloud-synced file → "Remove from local" is safe; the cloud copy remains.
//
// The organizer uses this module to:
//   1. Adjust button labels and help copy per-finding.
//   2. Flag duplicate groups where one copy is a cloud mirror of another.
//   3. Warn when a "delete" action targets a cloud-synced file so the user
//      understands the sync will propagate the deletion.

export type CloudProvider =
  | "OneDrive"
  | "Dropbox"
  | "Google Drive"
  | "iCloud Drive"
  | "Box"
  | "MEGA"
  | "pCloud"
  | null;

// Patterns are matched case-insensitively against any path segment. OneDrive
// uses "OneDrive - Contoso" style folders for business accounts so we match a
// prefix rather than an exact string.
const PROVIDER_PATTERNS: { provider: Exclude<CloudProvider, null>; patterns: RegExp[] }[] = [
  {
    provider: "OneDrive",
    patterns: [/^onedrive(\s*-\s*.+)?$/i, /^onedrive$/i],
  },
  { provider: "Dropbox",       patterns: [/^dropbox$/i] },
  { provider: "Google Drive",  patterns: [/^(google\s+drive|googledrive|gdrive|drivefs)$/i, /^my\s+drive$/i] },
  { provider: "iCloud Drive",  patterns: [/^(icloud\s*drive|icloud~com~|icloud)$/i] },
  { provider: "Box",           patterns: [/^box(\s*sync)?$/i] },
  { provider: "MEGA",          patterns: [/^mega(\s*sync)?$/i] },
  { provider: "pCloud",        patterns: [/^pcloud(\s*drive)?$/i] },
];

/** Identify which cloud provider (if any) syncs the given path. Matches by
 *  looking for a known provider folder name anywhere in the path. */
export function detectCloudProvider(path: string): CloudProvider {
  if (!path) return null;
  // Split on both slashes so macOS/Linux paths also work, though this app is
  // Windows-only today — doesn't hurt to be portable.
  const segments = path.split(/[\\/]+/).filter(Boolean);
  for (const seg of segments) {
    for (const { provider, patterns } of PROVIDER_PATTERNS) {
      for (const re of patterns) {
        if (re.test(seg)) return provider;
      }
    }
  }
  return null;
}

/** Convenience: is this path inside *any* cloud-sync tree? */
export function isCloudSynced(path: string): boolean {
  return detectCloudProvider(path) !== null;
}

/** Produce the verb we'd use in UI copy for a given path. For cloud-synced
 *  files we prefer "Remove from local" — subtly warns the user that the
 *  action propagates, and doesn't imply the file is gone forever. */
export function deleteVerb(path: string): "Delete" | "Remove from local" {
  return isCloudSynced(path) ? "Remove from local" : "Delete";
}

/** Returns a short, user-readable label like "OneDrive", "Dropbox", or null
 *  if the path isn't inside a recognised sync root. */
export function cloudProviderLabel(path: string): string | null {
  return detectCloudProvider(path);
}

/** Given a duplicate group of paths, returns the index (or indices) that look
 *  like "cloud mirrors" of another group member. A cloud mirror is a path
 *  under a cloud provider's folder whose basename matches a non-cloud peer.
 *  The caller uses this to flag "this copy is already synced to $provider"
 *  and to pick a sensible default keeper. */
export function cloudMirrorIndices(paths: string[]): number[] {
  if (paths.length < 2) return [];
  const bases = paths.map((p) => leaf(p).toLowerCase());
  const out: number[] = [];
  for (let i = 0; i < paths.length; i++) {
    if (!isCloudSynced(paths[i])) continue;
    // Does any *other* path (cloud or not) share the same leaf?
    for (let j = 0; j < paths.length; j++) {
      if (i === j) continue;
      if (bases[j] === bases[i]) { out.push(i); break; }
    }
  }
  return out;
}

function leaf(p: string): string {
  const norm = p.replace(/[/]/g, "\\");
  const idx = norm.lastIndexOf("\\");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}
