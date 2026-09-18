import type {
  DaggerGraph, DaggerHandling, DaggerIndex, DaggerMedia, DaggerNode,
  DaggerCategoryNode, DaggerClusterNode, DaggerTripletNode,
} from '../types';

export type FieldType = 'number' | 'date' | 'boolean' | 'string';

export interface FieldInfo {
  name: string;
  type: FieldType;
  uniqueCount: number;
  nullCount: number;
  sampleValues: unknown[];
  min?: number;
  max?: number;
  minDate?: string;
  maxDate?: string;
}

export interface ParsedDataset {
  rows: Record<string, unknown>[];
  fields: FieldInfo[];
  fileName: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T| )?([\d:.+-]*)?$/;
const SLASH_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

function tryParseNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    // Reject things like "1.2.3" or pure text
    if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function looksLikeDate(v: unknown): boolean {
  if (v instanceof Date) return true;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  if (ISO_DATE_RE.test(s) || SLASH_DATE_RE.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t);
  }
  return false;
}

function tryParseDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  if (!looksLikeDate(v)) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? new Date(t) : null;
}

function isBooleanLike(v: unknown): boolean {
  if (typeof v === 'boolean') return true;
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s === 'true' || s === 'false' || s === 'yes' || s === 'no';
}

// Detect type by majority of non-null values
function inferType(values: unknown[]): FieldType {
  let numericCount = 0;
  let dateCount = 0;
  let boolCount = 0;
  let nonNull = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    nonNull += 1;
    if (tryParseNumber(v) !== null) numericCount += 1;
    if (looksLikeDate(v)) dateCount += 1;
    if (isBooleanLike(v)) boolCount += 1;
  }
  if (nonNull === 0) return 'string';
  // Require >=90% match to commit to a non-string type
  const threshold = nonNull * 0.9;
  // Date first because numeric strings of years could be parseable both ways.
  if (dateCount >= threshold) return 'date';
  if (numericCount >= threshold) return 'number';
  if (boolCount >= threshold) return 'boolean';
  return 'string';
}

export function detectFields(rows: Record<string, unknown>[]): FieldInfo[] {
  if (rows.length === 0) return [];

  // Collect field names (union across all rows; preserve first-seen order)
  const seen = new Set<string>();
  const order: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
  }

  // How many populated values to inspect when inferring a field's type.
  const TYPE_SAMPLE_TARGET = 500;
  const fields: FieldInfo[] = [];

  for (const name of order) {
    // Gather up to TYPE_SAMPLE_TARGET NON-NULL values for type inference,
    // scanning across the whole dataset rather than blindly taking the first
    // N rows. A column that only applies to a subset of rows (e.g. `probability`
    // on causal edges but not hierarchy edges) often has a long leading run of
    // empty cells; sampling the first N rows there would see nothing but blanks
    // and mis-type the numeric column as a string — which then renders as a
    // categorical toggle list instead of a range slider. Scanning for populated
    // values keeps the widget consistent regardless of where the data sits.
    const sampleValues: unknown[] = [];
    for (const row of rows) {
      const v = row[name];
      if (v === null || v === undefined || v === '') continue;
      sampleValues.push(v);
      if (sampleValues.length >= TYPE_SAMPLE_TARGET) break;
    }
    const type = inferType(sampleValues);

    const unique = new Set<string>();
    let nullCount = 0;
    let min = Infinity;
    let max = -Infinity;
    let minDate: number | null = null;
    let maxDate: number | null = null;

    for (const row of rows) {
      const v = row[name];
      if (v === null || v === undefined || v === '') {
        nullCount += 1;
        continue;
      }
      unique.add(String(v));
      if (type === 'number') {
        const n = tryParseNumber(v);
        if (n !== null) {
          if (n < min) min = n;
          if (n > max) max = n;
        }
      } else if (type === 'date') {
        const d = tryParseDate(v);
        if (d) {
          const t = d.getTime();
          if (minDate === null || t < minDate) minDate = t;
          if (maxDate === null || t > maxDate) maxDate = t;
        }
      }
    }

    const info: FieldInfo = {
      name,
      type,
      uniqueCount: unique.size,
      nullCount,
      sampleValues: Array.from(unique).slice(0, 5),
    };
    if (type === 'number' && Number.isFinite(min)) {
      info.min = min;
      info.max = max;
    }
    if (type === 'date' && minDate !== null && maxDate !== null) {
      info.minDate = new Date(minDate).toISOString();
      info.maxDate = new Date(maxDate).toISOString();
    }
    fields.push(info);
  }

  return fields;
}

// CSV parser supporting quoted fields, escaped quotes (""), and \r\n line endings.
export function parseCSV(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      cur.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // swallow; \n handler will commit
      i += 1;
      continue;
    }
    if (ch === '\n') {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // commit trailing field/row
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }

  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim());
  const out: Record<string, unknown>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    // Skip wholly empty lines
    if (row.length === 1 && row[0] === '') continue;
    const obj: Record<string, unknown> = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = row[c] ?? '';
    }
    out.push(obj);
  }
  return out;
}

export function parseJSONRows(text: string): Record<string, unknown>[] {
  const data = JSON.parse(text);
  // Common shapes:
  // 1. Array of objects -> use as-is
  // 2. { data: [...] } / { rows: [...] } / { items: [...] } -> use the array
  // 3. { nodes: [...], links: [...] } -> use links, flatten with source/target
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['data', 'rows', 'items', 'records', 'relationships', 'edges']) {
      const v = (data as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
    }
    if (Array.isArray((data as Record<string, unknown>).links)) {
      return (data as { links: Record<string, unknown>[] }).links;
    }
  }
  throw new Error('JSON must be an array of objects or contain a "data"/"rows"/"items"/"links" array');
}

// -------- Multi-option parsing (graph-shape JSON + per-array choice) --------

export interface DatasetOption {
  id: string;                // stable key, e.g. "graph-join" or "array:nodes"
  label: string;             // short label for the picker
  description: string;       // one-line summary (row/field counts, join key, …)
  dataset: ParsedDataset;
  recommended?: boolean;     // hint for the UI
  // Auto-join: when the source file is a graph object with BOTH a node array
  // and an edge array, the edge option carries the node array here as a lookup
  // keyed by node id. This lets the graph render from edges while still having
  // access to rich per-node attributes (all_info, timestamp, category, …) for
  // the detail panel and timeline. Undefined for plain arrays / CSVs.
  companionNodes?: {
    byId: Map<string, Record<string, unknown>>;  // node id → full (unflattened) node record
    idField: string;                              // which field held the node id
    rawNodes: Record<string, unknown>[];          // all node records (unflattened)
  };
  // Present ONLY when the source file was detected as a DAGGER Graph_Viz from
  // its own content (see isDaggerGraph). Carries the typed node/edge index that
  // the hierarchy-aware UI reads — labels, media, handling, clock fields.
  // Undefined for every other file, which is how the generic path stays
  // untouched: a consumer that does not look at this field sees no change.
  dagger?: DaggerIndex;
}

// Priority order used to pick a recommended default array when a JSON object
// contains multiple candidate arrays. Earlier matches win. `nodes` sits ahead
// of `edges`/`links` because rows in a `nodes` array typically carry richer
// per-row attributes (e.g. subject/predicate/object triples + metadata),
// while edges are usually thin source/target/label tuples.
const PREFERRED_ARRAY_KEYS = ['data', 'rows', 'items', 'records', 'relationships', 'nodes', 'edges', 'links'];

// Caps used by flattenRow to keep memory and field-list size sane.
const FLATTEN_MAX_DEPTH = 4;
const FLATTEN_MAX_ARRAY_ELEMENTS = 5;
const FLATTEN_MAX_FIELDS_PER_ROW = 250;

/**
 * Flatten one row of JSON data. Nested objects and short arrays of objects
 * become dotted field names so they can be filtered/mapped just like top-level
 * scalars. Examples:
 *
 *   { raw: { event: [{ probability: 0.0 }] } }
 *   →  { "raw.event[0].probability": 0.0 }
 *
 *   { tags: ["legal", "finance"] }
 *   →  { tags: "legal, finance" }   (scalar arrays joined for filtering)
 *
 * Skipped:
 *   · arrays of objects longer than FLATTEN_MAX_ARRAY_ELEMENTS (kept as-is,
 *     so they appear as opaque "object" fields the user can ignore)
 *   · nesting beyond FLATTEN_MAX_DEPTH
 */
function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let fieldCount = 0;

  const visit = (val: unknown, path: string, depth: number): void => {
    if (fieldCount >= FLATTEN_MAX_FIELDS_PER_ROW) return;
    if (depth > FLATTEN_MAX_DEPTH) {
      out[path] = val;
      fieldCount += 1;
      return;
    }
    if (val === null || val === undefined) {
      out[path] = val;
      fieldCount += 1;
      return;
    }
    if (Array.isArray(val)) {
      if (val.length === 0) {
        out[path] = '';
        fieldCount += 1;
        return;
      }
      // Scalar arrays: join into a string (so categorical filter has something to bite on)
      const allScalar = val.every(v => v === null || (typeof v !== 'object'));
      if (allScalar) {
        out[path] = val.join(', ');
        fieldCount += 1;
        return;
      }
      // Array of objects: index each item only when array is short
      if (val.length <= FLATTEN_MAX_ARRAY_ELEMENTS) {
        for (let i = 0; i < val.length; i++) {
          visit(val[i], `${path}[${i}]`, depth + 1);
        }
      } else {
        // Too long to flatten — record a placeholder field for visibility
        out[`${path}.length`] = val.length;
        fieldCount += 1;
      }
      return;
    }
    if (typeof val === 'object') {
      const keys = Object.keys(val as Record<string, unknown>);
      if (keys.length === 0) {
        out[path] = '';
        fieldCount += 1;
        return;
      }
      for (const k of keys) {
        visit((val as Record<string, unknown>)[k], path ? `${path}.${k}` : k, depth + 1);
      }
      return;
    }
    // Scalar (string/number/boolean)
    out[path] = val;
    fieldCount += 1;
  };

  for (const [k, v] of Object.entries(row)) {
    visit(v, k, 0);
  }
  return out;
}

function flattenRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  // Detect whether any row contains a nested object/array — if not, skip the
  // O(n) flatten pass since it'd be a no-op.
  const sample = rows.slice(0, Math.min(rows.length, 20));
  const hasNesting = sample.some(r =>
    Object.values(r).some(v => v !== null && typeof v === 'object'),
  );
  if (!hasNesting) return rows;
  return rows.map(flattenRow);
}

function makeArrayOption(key: string, items: Record<string, unknown>[], fileName: string, recommended = false): DatasetOption {
  const flat = flattenRows(items);
  const fields = detectFields(flat);
  return {
    id: `array:${key}`,
    label: `Array: ${key}`,
    description: `${flat.length} rows · ${fields.length} fields`,
    dataset: { rows: flat, fields, fileName: `${fileName} · ${key}` },
    recommended,
  };
}

// Candidate field names that typically hold a node's unique id. Checked in
// order; first one present on the majority of records wins.
const NODE_ID_FIELD_CANDIDATES = ['node', 'id', 'node_id', 'nodeId', 'name', 'key'];

// Heuristic: which array key looks like a node table vs. an edge table.
// Edge tables almost always carry source/target-ish fields; node tables don't.
const EDGE_KEY_NAMES = new Set(['edges', 'links', 'relationships']);
const NODE_KEY_NAMES = new Set(['nodes', 'vertices', 'entities']);

function findNodeIdField(items: Record<string, unknown>[]): string | null {
  if (items.length === 0) return null;
  const sample = items.slice(0, Math.min(items.length, 50));
  for (const cand of NODE_ID_FIELD_CANDIDATES) {
    const present = sample.filter(r => {
      const v = r[cand];
      return v !== null && v !== undefined && v !== '';
    }).length;
    if (present >= sample.length * 0.9) return cand;
  }
  return null;
}

function looksLikeEdgeArray(key: string, items: Record<string, unknown>[]): boolean {
  if (EDGE_KEY_NAMES.has(key.toLowerCase())) return true;
  if (NODE_KEY_NAMES.has(key.toLowerCase())) return false;
  const sample = items.slice(0, Math.min(items.length, 20));
  const hasSrcTgt = sample.some(r =>
    ('source' in r || 'src' in r || 'from' in r) &&
    ('target' in r || 'dst' in r || 'to' in r),
  );
  return hasSrcTgt;
}

// Build the companion-node lookup from a node array and attach it to an edge
// option. Returns the same option (mutated) for chaining convenience.
function attachCompanionNodes(
  edgeOption: DatasetOption,
  nodeItems: Record<string, unknown>[],
): DatasetOption {
  const idField = findNodeIdField(nodeItems);
  if (!idField) return edgeOption;
  const byId = new Map<string, Record<string, unknown>>();
  for (const n of nodeItems) {
    const idv = n[idField];
    if (idv === null || idv === undefined || idv === '') continue;
    byId.set(String(idv), n);  // keep UNFLATTENED so all_info HTML stays intact
  }
  if (byId.size === 0) return edgeOption;
  edgeOption.companionNodes = { byId, idField, rawNodes: nodeItems };
  return edgeOption;
}

// ─────────────────────────── DAGGER Graph_Viz ingestion ──────────────────────
//
// A DAGGER-shaped file is recognised FROM ITS OWN CONTENT — `hierarchy` on the
// nodes and `hierarchy_link` on the edges. There is no flag, no toggle and no
// filename check, so the same file works however it reaches the app (sample
// button, drag-and-drop, URL) and a non-DAGGER file can never be mistaken for
// one. When detection says no, every line below is skipped and the generic
// loader behaves exactly as it did before this sprint.

/** Share of sampled records that must carry the marker field. Matches the 0.9
 *  threshold `inferType` and `findNodeIdField` already use. */
const DAGGER_MATCH_RATIO = 0.9;
const DAGGER_SAMPLE_SIZE = 50;

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function ratioWith(items: Record<string, unknown>[], key: string): number {
  if (items.length === 0) return 0;
  const sample = items.slice(0, Math.min(items.length, DAGGER_SAMPLE_SIZE));
  const hits = sample.filter(r => nonEmptyString(r[key])).length;
  return hits / sample.length;
}

/**
 * Content detection for a DAGGER `Graph_Viz.json`. True when the value is an
 * object carrying a `nodes` array whose records have `node` + `hierarchy`, and
 * an `edges` array whose records have `hierarchy_link`.
 *
 * Deliberately strict on all three markers: `Test_Graph_Viz.csv` is the EDGE
 * table alone, so it has `hierarchy_link` but no node array and is (correctly)
 * NOT detected — there is nothing to index without the nodes.
 */
export function isDaggerGraph(data: unknown): data is DaggerGraph {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  const nodes = obj.nodes;
  const edges = obj.edges;
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  if (!Array.isArray(edges) || edges.length === 0) return false;
  const nodeRecs = nodes.filter(n => n && typeof n === 'object' && !Array.isArray(n)) as Record<string, unknown>[];
  const edgeRecs = edges.filter(e => e && typeof e === 'object' && !Array.isArray(e)) as Record<string, unknown>[];
  if (nodeRecs.length !== nodes.length || edgeRecs.length !== edges.length) return false;
  return (
    ratioWith(nodeRecs, 'node') >= DAGGER_MATCH_RATIO &&
    ratioWith(nodeRecs, 'hierarchy') >= DAGGER_MATCH_RATIO &&
    ratioWith(edgeRecs, 'hierarchy_link') >= DAGGER_MATCH_RATIO
  );
}

/**
 * Build the lookup Dana, Ravi and the timeline read from. Nodes are stored
 * UNFLATTENED, so `media[]` is still an array and `handling{}` still an object;
 * flattening them would turn `media[0].path` into a string field and lose the
 * second media entry entirely.
 *
 * A duplicate `node` id keeps the FIRST record — the pipeline places one cluster
 * once per category with a distinct `..._000N` id, so duplicates are not
 * expected; first-wins simply makes the outcome deterministic if one appears.
 */
export function buildDaggerIndex(graph: DaggerGraph): DaggerIndex {
  const nodesById = new Map<string, DaggerNode>();
  const labelById = new Map<string, string>();
  for (const n of graph.nodes) {
    const id = n?.node;
    if (!nonEmptyString(id)) continue;
    if (nodesById.has(id)) continue;
    nodesById.set(id, n);
    if (nonEmptyString(n.label)) labelById.set(id, n.label);
  }
  return { nodesById, edges: graph.edges, labelById };
}

export function isTripletNode(n: DaggerNode | undefined | null): n is DaggerTripletNode {
  return !!n && n.hierarchy === 'TRIPLET';
}

export function isClusterNode(n: DaggerNode | undefined | null): n is DaggerClusterNode {
  return !!n && n.hierarchy === 'CLUSTER';
}

/** A category node — `hierarchy` matching H followed by digits (H000, H001, …). */
export function isCategoryNode(n: DaggerNode | undefined | null): n is DaggerCategoryNode {
  return !!n && typeof n.hierarchy === 'string' && /^H\d+$/.test(n.hierarchy);
}

/**
 * The integer tier of a category node. Prefers the pipeline's own `tier` field
 * and derives it from the hierarchy string only when `tier` is absent. Returns
 * null for cluster and triplet nodes, which have no tier.
 */
export function daggerNodeTier(n: DaggerNode | undefined | null): number | null {
  if (!n) return null;
  if (typeof n.tier === 'number' && Number.isFinite(n.tier)) return n.tier;
  const m = typeof n.hierarchy === 'string' ? /^H(\d+)$/.exec(n.hierarchy) : null;
  return m ? Number(m[1]) : null;
}

/**
 * The text to render for a node. Always the `label` field — never the id.
 * Falls back to the id only when a node genuinely has no label, which the
 * pipeline does not produce; the fallback exists so an unlabelled node is still
 * findable rather than blank.
 */
export function daggerNodeLabel(n: DaggerNode | undefined | null): string {
  if (!n) return '';
  if (nonEmptyString(n.label)) return n.label;
  return nonEmptyString(n.node) ? n.node : '';
}

/**
 * The node's media entries, ALWAYS an array. Absent, null or malformed `media`
 * yields `[]`, so a caller can map over the result without a guard. Entries
 * without a usable `path` are dropped — there is nothing to point a base URL at.
 */
export function daggerNodeMedia(n: DaggerNode | undefined | null): DaggerMedia[] {
  if (!n) return [];
  const raw = (n as DaggerTripletNode).media;
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is DaggerMedia =>
    !!m && typeof m === 'object' && !Array.isArray(m) && nonEmptyString((m as DaggerMedia).path));
}

/**
 * The node's HANDLING block, or null when it has none. Returns the pipeline's
 * object untouched: `content_blur` is NOT recomputed here, because false at
 * exactly 0.0 and true everywhere else is the pipeline's answer, and a UI that
 * re-derives it will drift from it.
 */
export function daggerNodeHandling(n: DaggerNode | undefined | null): DaggerHandling | null {
  if (!n) return null;
  const raw = (n as DaggerTripletNode).handling;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.sensitivity !== 'number' || !Number.isFinite(raw.sensitivity)) return null;
  return raw;
}

/**
 * The node's warning tags, always an array, with the `["None"]` no-warning
 * answer normalised away to `[]` so the UI stays quiet instead of rendering a
 * chip reading "None". Any other tag is passed through verbatim — the
 * vocabulary is a living dictionary on the pipeline side and is never
 * hard-coded or validated here.
 */
export function daggerWarningTags(n: DaggerNode | undefined | null): string[] {
  const h = daggerNodeHandling(n);
  if (!h || !Array.isArray(h.warning_tags)) return [];
  const tags = h.warning_tags.filter(nonEmptyString).map(t => t.trim());
  if (tags.length === 1 && tags[0].toLowerCase() === 'none') return [];
  return tags;
}

// ── The pruning walk (AA045) ─────────────────────────────────────────────────
//
// THE one graph walk. Any filter that narrows the graph to a set of TRIPLETS
// goes through here — the warning-tag filter and the modality filter are two
// callers of the same function, not two implementations of the same rule.
//
// The rule, in Rusty's words: "It needs to only show the triplets -> clusters ->
// and branches connected to them specifically. Nothing else." So the visible
// graph is exactly the selected triplets, the cluster nodes they hang off,
// every category node reachable UPWARD from those clusters (H000, then H001,
// and so on to the top), and the edges joining precisely those nodes. A
// category with no surviving triplet under it disappears, and so does its whole
// branch.
//
// WHY THIS EXISTS: the previous tag filter narrowed edge ROWS by looking at
// each row's two endpoints in isolation. A `CLUSTER_to_H000` or `H003_to_H004`
// row has no triplet on either end, so it was always kept, and the entire
// category tree stayed drawn behind a handful of surviving triplets. Only the
// 22 `TRIPLET_to_CLUSTER` rows could ever drop. Judging a row by its own two
// endpoints cannot answer a question about reachability; nothing short of a
// walk can.

/** What survives a filter: the node set, and the rows that join those nodes. */
export interface DaggerSubgraph {
  /**
   * Every node id that survives — the selected triplets plus everything
   * reachable upward from them. This is the answer to "is this node visible?"
   * for anything that has to decide per node (selection highlighting, counts).
   *
   * A node here is *eligible* to be drawn. The graph is built from edge rows,
   * so a surviving node that ends up on no surviving row is not drawn — that is
   * pre-existing behaviour (VB005), not something this walk introduces.
   */
  nodes: Set<string>;
  /** The surviving rows, in the order they were given. Never the same array. */
  rows: Record<string, unknown>[];
}

/**
 * Prune a graph to the branches that carry a chosen set of triplets.
 *
 * `selectedTripletIds` is whatever the caller's filter selected — tag, modality,
 * or two of them intersected. Compose by intersecting the ID SETS and calling
 * this once; do not run it twice and merge the results, which would keep a
 * branch that only one of the two filters wanted.
 *
 * The hierarchy is walked over `index.edges` — the file's own edges — not over
 * `rows`, so an ancestor is still found when an unrelated field filter has
 * already dropped the row that would have led to it. Direction is the file's:
 * a DAGGER edge points child → parent (`TRIPLET_to_CLUSTER` has the triplet as
 * `source`), so "upward" is simply "outgoing", and no tier arithmetic or
 * `hierarchy_link` string parsing is involved. That is also why a `misc: true`
 * node behaves correctly for free: it has no upward edges, so the walk stops
 * there and it floats with its own branch, exactly as the pipeline intends.
 *
 * A row is kept when BOTH of its endpoints survive. An endpoint that is empty,
 * or that is not a node of this graph at all, is not judged — so a dataset that
 * merely happens to be open alongside a DAGGER index is never silently emptied.
 *
 * An EMPTY `selectedTripletIds` prunes everything, and that is correct: it is
 * "no triplet matched", not "no filter". A caller with no active filter must
 * not call this at all and should use its rows unchanged.
 */
export function daggerVisibleSubgraph(
  rows: Record<string, unknown>[],
  index: DaggerIndex,
  selectedTripletIds: ReadonlySet<string>,
  sourceField: string,
  targetField: string,
): DaggerSubgraph {
  // child → parents, built from the file's edges.
  const upward = new Map<string, string[]>();
  for (const e of index.edges) {
    const s = e?.source;
    const t = e?.target;
    if (!nonEmptyString(s) || !nonEmptyString(t)) continue;
    const parents = upward.get(s);
    if (parents) parents.push(t);
    else upward.set(s, [t]);
  }

  // Breadth of the walk does not matter, only its closure; an explicit stack
  // keeps it iterative, so a deep or cyclic hierarchy cannot blow the stack.
  const nodes = new Set<string>();
  const pending: string[] = [];
  for (const id of selectedTripletIds) {
    if (!index.nodesById.has(id) || nodes.has(id)) continue;
    nodes.add(id);
    pending.push(id);
  }
  while (pending.length > 0) {
    const current = pending.pop() as string;
    const parents = upward.get(current);
    if (!parents) continue;
    for (const parent of parents) {
      if (nodes.has(parent)) continue;
      nodes.add(parent);
      pending.push(parent);
    }
  }

  const survives = (value: unknown): boolean => {
    if (value === null || value === undefined || value === '') return true;
    const id = String(value);
    if (!index.nodesById.has(id)) return true;
    return nodes.has(id);
  };

  return {
    nodes,
    rows: rows.filter(r => survives(r[sourceField]) && survives(r[targetField])),
  };
}

/**
 * Parse a file into one or more dataset options. Behaviour:
 *  - CSV → single option (just the rows).
 *  - JSON top-level array → single option.
 *  - JSON object with multiple arrays → one option per array; the recommended
 *    default is the first array whose key matches the preferred list
 *    (data/rows/items/records/relationships/edges/links), falling back to the
 *    first array in document order.
 *
 * The first item in the returned array is the recommended default.
 */
export async function parseFileToOptions(file: File): Promise<DatasetOption[]> {
  const text = await file.text();
  const looksJSON = file.name.toLowerCase().endsWith('.json') ||
    file.type === 'application/json' ||
    text.trim().startsWith('{') || text.trim().startsWith('[');

  if (!looksJSON) {
    const rows = parseCSV(text);
    return [makeArrayOption('rows', rows, file.name, true)];
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // Fall back to CSV if JSON parse fails
    const rows = parseCSV(text);
    return [makeArrayOption('rows', rows, file.name, true)];
  }

  // Top-level array → single option (flattening happens inside makeArrayOption)
  if (Array.isArray(data)) {
    return [makeArrayOption('rows', data as Record<string, unknown>[], file.name, true)];
  }

  if (!data || typeof data !== 'object') {
    throw new Error('JSON must be an array or an object containing arrays');
  }

  // Find every candidate array of objects on the top-level object
  const obj = data as Record<string, unknown>;
  const arrays: { key: string; items: Record<string, unknown>[] }[] = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null && !Array.isArray(v[0])) {
      arrays.push({ key: k, items: v as Record<string, unknown>[] });
    }
  }
  if (arrays.length === 0) throw new Error('No arrays of objects found in JSON');

  // ── DAGGER Graph_Viz: build the typed index once, from the raw parsed JSON ──
  // Done here, before the arrays are flattened, because flattening would turn
  // `media[]` into `media[0].path` strings and `handling{}` into dotted scalars.
  // The index is attached to EVERY option from this file, so switching between
  // the `edges` and `nodes` views in the source picker does not lose it.
  const daggerIndex = isDaggerGraph(data) ? buildDaggerIndex(data) : undefined;

  // ── Auto-join: graph files shaped like { nodes: [...], edges: [...] } ───────
  // Identify the node array and the edge array. When we have both, the edge
  // array becomes the recommended default (that's what draws the graph) and we
  // attach the node array to it as a lookup so the detail panel + timeline can
  // read per-node attributes (all_info, timestamp, …).
  const edgeArrays = arrays.filter(a => looksLikeEdgeArray(a.key, a.items));
  const nodeArrays = arrays.filter(a => !looksLikeEdgeArray(a.key, a.items) && findNodeIdField(a.items));

  const opts = arrays.map(a => makeArrayOption(a.key, a.items, file.name, false));
  if (daggerIndex) for (const o of opts) o.dagger = daggerIndex;

  if (edgeArrays.length >= 1 && nodeArrays.length >= 1) {
    // Pick the first edge array as the join target, first node array as the source.
    const edgeKey = edgeArrays[0].key;
    const nodeItems = nodeArrays[0].items;
    const edgeOpt = opts.find(o => o.id === `array:${edgeKey}`);
    if (edgeOpt) {
      attachCompanionNodes(edgeOpt, nodeItems);
      edgeOpt.recommended = true;
      edgeOpt.description += ' · +node data';
      return [edgeOpt, ...opts.filter(o => o !== edgeOpt)];
    }
  }

  // ── Fallback: original behaviour (no clean node/edge split) ────────────────
  // Decide which array is the recommended default — prefer well-known edge-list
  // keys, otherwise fall back to the first array in document order.
  const preferred = PREFERRED_ARRAY_KEYS.map(k => arrays.findIndex(a => a.key === k)).find(i => i >= 0);
  const defaultIdx = preferred !== undefined ? preferred : 0;

  // Reuse `opts` rather than rebuilding: identical content (same arrays, same
  // flatten, same field detection), one less full pass, and it keeps whatever
  // was attached above. A DAGGER file always has both a node and an edge array
  // so it never reaches this branch, but nothing here assumes that.
  if (opts[defaultIdx]) opts[defaultIdx].recommended = true;
  return opts;
}

export async function parseURLToOptions(url: string, displayName?: string): Promise<DatasetOption[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const text = await res.text();
  // Reuse parseFileToOptions by wrapping the text as a File-like object
  const name = displayName ?? url.split('/').pop() ?? url;
  const file = new File([text], name, {
    type: name.toLowerCase().endsWith('.json') ? 'application/json' : 'text/csv',
  });
  return parseFileToOptions(file);
}

export async function parseFile(file: File): Promise<ParsedDataset> {
  const text = await file.text();
  const isJSON = file.name.toLowerCase().endsWith('.json') ||
    file.type === 'application/json' ||
    text.trim().startsWith('{') || text.trim().startsWith('[');
  let rows: Record<string, unknown>[];
  if (isJSON) {
    try {
      rows = parseJSONRows(text);
    } catch {
      // Fall back to CSV if JSON parse fails
      rows = parseCSV(text);
    }
  } else {
    rows = parseCSV(text);
  }
  const fields = detectFields(rows);
  return { rows, fields, fileName: file.name };
}

export async function parseURL(url: string, displayName?: string): Promise<ParsedDataset> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const text = await res.text();
  const isJSON = url.toLowerCase().endsWith('.json') || text.trim().startsWith('{') || text.trim().startsWith('[');
  const rows = isJSON ? parseJSONRows(text) : parseCSV(text);
  const fields = detectFields(rows);
  return { rows, fields, fileName: displayName ?? url.split('/').pop() ?? url };
}
