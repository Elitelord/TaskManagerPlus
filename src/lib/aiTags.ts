// Phase 4 / S10 — curated tag vocabulary for "Browse by category" chips.
//
// Each tag is a preset semantic query. Clicking a chip opens the
// command palette with the tag's `query` text pre-populated, then the
// existing S7 search machinery (hybrid lexical + cosine) does the rest.
// Tags are content-defined (not extension-defined): "Code" matches
// source files by content, not just by `.py` or `.ts` extensions.
//
// This is NOT generative tagging — it's nearest-neighbour against a
// fixed vocabulary. The same embedding model that powers S4 / S7
// powers this. No new infrastructure.
//
// Adding a new tag: add an entry below. The chip appears automatically.
// The label is the chip display text; the query is the natural-language
// string that gets embedded and searched against the document index.
// Phrase queries to maximise topical separability — e.g. "academic
// papers and research" not just "academic" — so the embedder has a
// real direction to anchor in 384-dim space.

export interface TagDef {
  /** Stable identifier — used in telemetry / settings; never shown. */
  id: string;
  /** Short user-facing chip label. */
  label: string;
  /** Natural-language search query for this tag. Embedded and matched
   *  against the document index via the standard S7 pipeline. */
  query: string;
  /** SVG d-attribute for a small icon shown next to the label. Picked
   *  from the Lucide / Feather library — single-path glyphs at
   *  viewBox 0 0 24 24, strokeWidth 1.8. */
  icon: string;
}

/** Folder icon — generic fallback for tags without a dedicated glyph. */
const ICON_FOLDER = "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z";

export const TAG_VOCAB: TagDef[] = [
  {
    id: "academic",
    label: "Academic",
    query: "academic papers, research articles, theses, dissertations, scholarly publications",
    icon: "M22 12h-4l-3 9L9 3l-3 9H2",
  },
  {
    id: "coursework",
    label: "Coursework",
    query: "homework assignments, exams, lecture slides, syllabi, course material",
    icon: "M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z",
  },
  {
    id: "career",
    label: "Career",
    query: "resume, CV, cover letter, job application, employment offer",
    icon: "M20 7h-4V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM10 5h4v2h-4z",
  },
  {
    id: "financial",
    label: "Financial",
    query: "financial documents, bank statements, invoices, receipts, expense reports",
    icon: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  },
  {
    id: "personal-id",
    label: "Personal / ID",
    query: "personal identification, social security number, SSN, passport, driver license, birth certificate, ID card, sensitive personal records",
    icon: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM7 9a2 2 0 1 0 4 0 2 2 0 0 0-4 0M5 17c0-2 2-3 4-3s4 1 4 3M15 9h4M15 13h4",
  },
  {
    id: "tax",
    label: "Tax",
    query: "tax returns, W-2, 1099, IRS forms, tax deductions, federal income tax",
    icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
  },
  {
    id: "legal",
    label: "Legal",
    query: "legal documents, contracts, agreements, NDAs, terms of service",
    icon: "M12 3l-8 4v5c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V7z",
  },
  {
    id: "project-docs",
    label: "Project Docs",
    query: "project documentation, README, technical specification, design document, architecture",
    icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8",
  },
  {
    id: "code",
    label: "Code",
    query: "source code, programming files, scripts, software development",
    icon: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  },
  {
    id: "notes",
    label: "Notes",
    query: "personal notes, journal entries, brainstorms, drafts, ideas",
    icon: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z",
  },
  {
    id: "presentation",
    label: "Slides",
    query: "presentation slides, PowerPoint, Keynote, lecture decks, pitches",
    icon: "M2 3h20v14H2zM7 21h10M12 17v4",
  },
  {
    id: "travel",
    label: "Travel",
    query: "travel itineraries, flight bookings, hotel reservations, vacation plans, trip tickets",
    icon: "M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z",
  },
  {
    id: "data",
    label: "Data",
    query: "data files, spreadsheets, datasets, CSVs, tabular data, analytics",
    icon: "M3 3v18h18M7 16l5-5 4 4 5-7",
  },
  {
    id: "geographic",
    label: "Geographic",
    query: "geographic data, GIS, geojson, maps, shapefiles, location data, zoning",
    icon: "M1 6v16l7-4 8 4 7-4V2l-7 4-8-4z M8 2v16M16 6v16",
  },
  {
    id: "reference",
    label: "Reference",
    query: "reference material, user manuals, technical documentation, help guides, instructions",
    icon: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  },
  {
    id: "creative",
    label: "Creative",
    query: "creative work, design mockups, wireframes, illustrations, sketches, art",
    icon: "M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.586 7.586M11 11l3 3",
  },
];

/** Get a tag by id; returns null when unknown. */
export function getTag(id: string): TagDef | null {
  return TAG_VOCAB.find((t) => t.id === id) ?? null;
}

export { ICON_FOLDER };
