// Semantic file clustering (feature S4, Phase 3) — pure, framework-free,
// unit-testable.
//
// Groups files into "potential projects" by clustering their embeddings
// (produced on-device by the bundled model via `ai_embed_text`). The
// method is **average-linkage agglomerative clustering over cosine
// distance** — the exact method the embedding spike validated (S-11, real-
// data ARI 0.822 / 0.648).
//
// Two guards come straight from the spike findings:
//   • Document scoping (`isDocumentFile`) — only document/code files are
//     clustered. The Downloads test (S-11) showed installers, archives,
//     media and raw-data files form useless type-blobs ("74 installers"),
//     not projects. Every good cluster was documents.
//   • Cohesion floor — a formed cluster is dropped unless its members are
//     genuinely mutually similar, so a loose chained blob is never
//     surfaced as a "project".
//
// Embeddings are assumed L2-normalised (the embedder normalises them), so
// cosine similarity is a plain dot product and cosine distance is 1 - dot.

/** Extensions S4 *clusters* — documents and code, which carry project
 *  semantics. Installers / archives / media / raw-data are excluded
 *  because the S-11 spike showed they form useless type-blobs (74
 *  installers, 52 geojson) rather than projects. This is the narrow
 *  CLUSTERING scope. */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  // documents
  "pdf", "doc", "docx", "odt", "rtf", "txt", "md", "markdown", "tex",
  "ppt", "pptx", "key", "pages",
  // code / config text
  "py", "js", "ts", "tsx", "jsx", "java", "c", "cpp", "h", "hpp", "cs",
  "rs", "go", "rb", "php", "swift", "kt", "sql", "sh", "html", "css",
]);

/** Extensions worth EMBEDDING for search + tagging (S7 / S9 / S10),
 *  even though they're not clustered. This is the broad INDEXING scope:
 *  it's a superset of DOCUMENT_EXTENSIONS that adds structured-data
 *  formats whose content (and especially filenames) carry searchable
 *  meaning — a "Vancouver_Zoning.geojson" should be findable under a
 *  "Geographic" tag even though it would never be a "project" cluster.
 *
 *  The split matters: clustering noise (the spike's "52 geojson blob")
 *  is a CLUSTERING problem, not a SEARCH problem. Excluding these from
 *  embedding entirely — as the old single-scope design did — meant they
 *  could never be searched or tagged at all. */
export const INDEXABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...DOCUMENT_EXTENSIONS,
  // structured data — searchable by content + filename, not clustered
  "csv", "tsv", "json", "geojson", "kml", "kmz", "gpx", "xml", "yaml",
  "yml", "toml", "ini", "xlsx", "xls", "ods", "ipynb",
]);

/** True when a file is a document/code file worth semantic CLUSTERING. */
export function isDocumentFile(nameOrPath: string): boolean {
  const dot = nameOrPath.lastIndexOf(".");
  if (dot < 0) return false;
  return DOCUMENT_EXTENSIONS.has(nameOrPath.slice(dot + 1).toLowerCase());
}

/** True when a file is worth EMBEDDING for search + tagging. Broader
 *  than `isDocumentFile` — includes structured-data formats. */
export function isIndexableFile(nameOrPath: string): boolean {
  const dot = nameOrPath.lastIndexOf(".");
  if (dot < 0) return false;
  return INDEXABLE_EXTENSIONS.has(nameOrPath.slice(dot + 1).toLowerCase());
}

/** One file's embedding. `vec` must be L2-normalised. */
export interface FileEmbedding {
  /** Caller's identifier — typically the file path. */
  id: string;
  vec: number[];
}

/** A discovered cluster of related files. */
export interface FileCluster {
  /** Member file ids, largest cluster first in the returned list. */
  ids: string[];
  /** Mean pairwise cosine similarity among members, 0..1 — how tight. */
  cohesion: number;
}

export interface ClusterOptions {
  /** Cosine-distance cutoff; clusters stop merging past this. Default 0.45
   *  — the threshold the spike's real-data ARI peaked at. */
  threshold?: number;
  /** Minimum mean intra-cluster cosine similarity to surface a cluster.
   *  Default 0.67 — average-linkage agglomerative chains things together
   *  via intermediate-distance pairs (exam → answer-key → solutions →
   *  certificate → random-PDF, all individually similar but the endpoints
   *  unrelated). The chained blobs land at ~0.60–0.65 cohesion; legit
   *  project clusters land at ~0.70+. Pulled in from 0.50 → 0.67 after a
   *  real-data run produced a 42-file blob at 0.640 alongside legit
   *  clusters at 0.704 / 0.692 / 0.989. */
  minCohesion?: number;
  /** Smallest cluster size worth surfacing. Default 2. */
  minSize?: number;
  /** Hard cap on input size — clustering is O(n²) memory. Default 2500. */
  maxFiles?: number;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Mean pairwise cosine similarity within a member set (the cohesion). */
function meanIntraCosine(members: number[], items: FileEmbedding[]): number {
  if (members.length < 2) return 1;
  let sum = 0;
  let pairs = 0;
  for (let a = 0; a < members.length; a++) {
    for (let b = a + 1; b < members.length; b++) {
      sum += dot(items[members[a]].vec, items[members[b]].vec);
      pairs++;
    }
  }
  return pairs > 0 ? sum / pairs : 1;
}

/**
 * Cluster `items` into potential projects. Returns only multi-file
 * clusters that clear the cohesion floor, largest first. Singletons and
 * loose blobs are dropped.
 */
export function clusterEmbeddings(
  items: FileEmbedding[],
  opts: ClusterOptions = {},
): FileCluster[] {
  const threshold = opts.threshold ?? 0.45;
  const minCohesion = opts.minCohesion ?? 0.67;
  const minSize = opts.minSize ?? 2;
  const maxFiles = opts.maxFiles ?? 2500;

  const work = items.length > maxFiles ? items.slice(0, maxFiles) : items;
  const n = work.length;
  if (n < 2) return [];

  // Pairwise cosine-distance matrix (1 - dot, vectors pre-normalised).
  const d: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dist = 1 - dot(work[i].vec, work[j].vec);
      d[i][j] = dist;
      d[j][i] = dist;
    }
  }

  const members: number[][] = work.map((_, i) => [i]);
  const active: boolean[] = new Array(n).fill(true);
  // Nearest-neighbour cache — keeps the merge loop ~O(n²) rather than O(n³).
  const nn: number[] = new Array(n).fill(-1);
  const nnDist: number[] = new Array(n).fill(Infinity);
  const recomputeNN = (i: number): void => {
    let bi = -1;
    let bd = Infinity;
    for (let k = 0; k < n; k++) {
      if (k === i || !active[k]) continue;
      if (d[i][k] < bd) {
        bd = d[i][k];
        bi = k;
      }
    }
    nn[i] = bi;
    nnDist[i] = bd;
  };
  for (let i = 0; i < n; i++) recomputeNN(i);

  let count = n;
  while (count > 1) {
    // Global closest pair = the smallest cached nearest-neighbour distance.
    let a = -1;
    let ad = Infinity;
    for (let i = 0; i < n; i++) {
      if (active[i] && nnDist[i] < ad) {
        ad = nnDist[i];
        a = i;
      }
    }
    if (a < 0 || ad > threshold) break;
    const b = nn[a];

    // Merge b into a; Lance-Williams average-linkage distance update.
    const na = members[a].length;
    const nb = members[b].length;
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a || k === b) continue;
      const nd = (na * d[a][k] + nb * d[b][k]) / (na + nb);
      d[a][k] = nd;
      d[k][a] = nd;
    }
    members[a] = members[a].concat(members[b]);
    active[b] = false;
    count--;

    // Refresh the NN cache: `a` changed; anyone pointing at `a`/`b` is stale.
    recomputeNN(a);
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === a) continue;
      if (nn[k] === a || nn[k] === b) {
        recomputeNN(k);
      } else if (d[a][k] < nnDist[k]) {
        nn[k] = a;
        nnDist[k] = d[a][k];
      }
    }
  }

  const out: FileCluster[] = [];
  for (let i = 0; i < n; i++) {
    if (!active[i] || members[i].length < minSize) continue;
    const cohesion = meanIntraCosine(members[i], work);
    if (cohesion >= minCohesion) {
      out.push({ ids: members[i].map((m) => work[m].id), cohesion });
    }
  }
  out.sort((x, y) => y.ids.length - x.ids.length);
  return out;
}
