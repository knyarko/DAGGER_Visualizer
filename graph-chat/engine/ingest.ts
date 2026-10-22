// graph-chat/engine/ingest.ts
//
// DUAL-SHAPE INGEST. Two real file shapes in, one normalised record out, and
// a report saying which shape it was.
//
// ── WHY THERE ARE TWO SHAPES ────────────────────────────────────────────────
//   The shape contract describes one of them: TRIPLET / CLUSTER / H00x nodes,
//   the triple's fields on the TRIPLET node, `msg_text`, structured `media[]`.
//   The other is what the older hierarchy graph emits: H00x nodes ONLY — zero
//   TRIPLET and zero CLUSTER — with the triple's own fields hung on the
//   category node itself, `text_msg` where the contract says `msg_text`, and
//   `all_info` / `info` holding a pre-rendered HTML blob with the record's
//   image inside it.
//
//   This matters because the corpus the product's own example question is
//   about is in the second shape. A reader built only against the contract
//   shape answers that question with zero rows and no explanation.
//
// ── WHAT THIS MODULE REFUSES TO DO ──────────────────────────────────────────
//   It never writes. It never reads a file — it is handed already-parsed JSON,
//   so it works identically behind a browser file picker and behind a node
//   service reading from disk. It never reformats anyone's data and never
//   writes back to a source file. It invents no `handling` block.
//
// ── THE COLLAPSE ────────────────────────────────────────────────────────────
//   The graph emits ONE TRIPLET NODE PER (TRIPLET, CATEGORY) PAIR. A triplet
//   carrying three categories is three nodes. Every count in this product is
//   over triplets, so the collapse happens HERE, in the ingest, before any
//   query exists to be wrong. After this module runs there is no node-shaped
//   row left for a count to multiply.

import type {
  GraphShape,
  HandlingBlock,
  MediaRef,
  NormalisedCorpus,
  NormalisedTime,
  NormalisedTriplet,
  MessageKeySource,
  RawGraph,
  RawNode,
  ShapeReport,
} from './types.js';
import { fnv1a32 } from './text.js';

// ──────────────────────────── the message key ───────────────────────────────

/**
 * THE ONE PLACE THAT DECIDES WHAT "THE SAME MESSAGE" MEANS.
 *
 * The data dictionary says `cluster_id` is the id of the originating MESSAGE,
 * shared by every row and every triplet out of it, and that `record_id` is one
 * per ROW — "a message with two attachments gets two". So a message with two
 * attachments has one cluster id and two record ids, and keying on the record
 * id splits it into two groups whose figures then get stated twice.
 *
 * Preference order is therefore cluster, then row, then nothing. Row is a
 * fallback and is reported as one, never silently substituted.
 */
export function messageKeyOf(
  t: { cluster_id: string | null; record_id: string | null },
  source: MessageKeySource,
): string | null {
  if (source === 'cluster_id') return t.cluster_id;
  if (source === 'record_id') return t.record_id;
  return null;
}

// ─────────────────────────────── coercion ───────────────────────────────────

function asString(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    // The legacy graph writes the word "Unknown" into date fields where the
    // contract shape writes a zero-padded string. It is a missing value
    // wearing a value's clothes, and it is normalised to one.
    if (t === '' || t.toLowerCase() === 'unknown' || t.toLowerCase() === 'nan') return null;
    return t;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function asText(v: unknown): string {
  return asString(v) ?? '';
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    if (Number.isFinite(n) && v.trim() !== '') return n;
  }
  return null;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const x of v) {
      const s = asString(x);
      if (s !== null) out.push(s);
    }
    return out;
  }
  const one = asString(v);
  return one === null ? [] : [one];
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

function isCategoryHierarchy(h: unknown): boolean {
  return typeof h === 'string' && /^H\d+$/.test(h);
}

// ──────────────────────────── shape detection ───────────────────────────────

/** Fields that only the legacy hierarchy graph writes. Their presence is the
 *  positive evidence for the legacy verdict; their absence is not evidence
 *  against it, because a thin legacy file may carry only some of them. */
const LEGACY_MARKER_FIELDS = [
  'text_msg', 'all_info', 'info', 'category_node', 'weekday', 'month_name',
  'triplet_justification',
];

/** A node carries a triple when it states at least a subject and an object.
 *  A predicate alone is not enough and neither is a label. */
function carriesTriple(n: RawNode): boolean {
  return asString(n.subject) !== null && asString(n.object) !== null;
}

/**
 * Decide which shape a parsed graph is, and report the evidence.
 *
 * The verdict is taken from the NODES, never from the filename, never from a
 * flag and never from the edges alone — the same file must be read the same
 * way however it arrived.
 */
export function detectShape(graph: RawGraph): ShapeReport {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];

  const hierarchyCounts: Record<string, number> = {};
  let tripletNodeCount = 0;
  let clusterNodeCount = 0;
  let categoryNodeCount = 0;
  let tripleBearingCategoryNodeCount = 0;
  const legacySeen = new Set<string>();

  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const h = asString(n.hierarchy) ?? '(absent)';
    hierarchyCounts[h] = (hierarchyCounts[h] ?? 0) + 1;
    if (h === 'TRIPLET') tripletNodeCount++;
    else if (h === 'CLUSTER') clusterNodeCount++;
    else if (isCategoryHierarchy(h)) {
      categoryNodeCount++;
      if (carriesTriple(n)) tripleBearingCategoryNodeCount++;
    }
    for (const f of LEGACY_MARKER_FIELDS) {
      if (n[f] !== undefined && n[f] !== null && n[f] !== '') legacySeen.add(f);
    }
  }

  const signals: string[] = [];
  const warnings: string[] = [];
  let shape: GraphShape;
  let confidence: number;

  if (tripletNodeCount > 0) {
    shape = 'contract';
    confidence = Math.min(1, tripletNodeCount / Math.max(1, nodes.length) + 0.5);
    signals.push(`${tripletNodeCount} nodes carry hierarchy "TRIPLET".`);
    signals.push(`${clusterNodeCount} nodes carry hierarchy "CLUSTER".`);
    if (legacySeen.size > 0) {
      warnings.push(
        `This file has TRIPLET nodes but also carries legacy-only field(s): ` +
        `${[...legacySeen].sort().join(', ')}. It was read as the contract shape; ` +
        `the legacy fields were preserved but not used.`,
      );
    }
  } else if (categoryNodeCount > 0 && (tripleBearingCategoryNodeCount > 0 || legacySeen.size > 0)) {
    shape = 'legacy';
    confidence = Math.min(
      1,
      0.5 + 0.5 * (tripleBearingCategoryNodeCount / Math.max(1, categoryNodeCount)),
    );
    signals.push('Zero TRIPLET nodes and zero CLUSTER nodes.');
    signals.push(
      `${categoryNodeCount} category nodes, of which ${tripleBearingCategoryNodeCount} ` +
      `carry the triple's own fields.`,
    );
    if (legacySeen.size > 0) {
      signals.push(`Legacy-only fields present: ${[...legacySeen].sort().join(', ')}.`);
    }
    warnings.push(
      'Legacy shape: this file carries no triplet id, so every record id below ' +
      'is synthesised by the reader from the triple\'s own text and is NOT the ' +
      'pipeline\'s id.',
    );
  } else {
    shape = 'unknown';
    confidence = 0;
    signals.push(
      `No TRIPLET nodes and no triple-bearing category nodes were found in ` +
      `${nodes.length} nodes.`,
    );
    warnings.push(
      'This file is neither of the two shapes this reader knows. No triplets ' +
      'were ingested, so every query over it will correctly return nothing.',
    );
  }

  return {
    shape,
    confidence: Number(confidence.toFixed(3)),
    nodeCount: nodes.length,
    edgeCount: edges.length,
    hierarchyCounts,
    tripletNodeCount,
    clusterNodeCount,
    categoryNodeCount,
    tripleBearingCategoryNodeCount,
    legacyFieldsSeen: [...legacySeen].sort(),
    signals,
    warnings,
  };
}

// ───────────────────────────── field readers ────────────────────────────────

/** The contract's label rule: `subject → predicate → object`, U+2192, single
 *  spaces. Rebuilt only when the file has no label of its own. */
function buildLabel(subject: string, predicate: string, object: string): string {
  return [subject, predicate, object].filter(p => p !== '').join(' → ');
}

const IMG_SRC = /<img[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/**
 * Recover image references from a legacy pre-rendered HTML blob.
 *
 * The legacy graph bakes the record's picture into `all_info` / `info` as an
 * `<img>` tag instead of carrying a structured media list. Without this, a
 * retrieval answer over a legacy corpus returns triplets with no pictures,
 * which is the one thing that class of question is for.
 *
 * Every entry recovered this way is marked `derived: true`. It has NO
 * describer output behind it and no handling block, and a surface must not
 * present it as pipeline-emitted media.
 */
function mediaFromHtml(html: string): MediaRef[] {
  const out: MediaRef[] = [];
  const seen = new Set<string>();
  IMG_SRC.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMG_SRC.exec(html)) !== null) {
    const src = m[1].trim();
    if (!src || seen.has(src)) continue;
    seen.add(src);
    const filename = src.split(/[\\/]/).pop() ?? src;
    out.push({ channel: 'image', path: src, filename, media_type: 'image', derived: true });
  }
  return out;
}

function readMedia(v: unknown): MediaRef[] {
  if (!Array.isArray(v)) return [];
  const out: MediaRef[] = [];
  for (const raw of v) {
    const r = asRecord(raw);
    if (!r) continue;
    const path = asString(r.path) ?? asString(r.file_path) ?? '';
    const channel = asString(r.channel) ?? 'unknown';
    const description = asString(r.description) ?? asString(r[`${channel}_descript`]);
    // An entry with neither a path nor a description is not media and not
    // evidence; there is nothing to show and nothing to search.
    if (path === '' && !description) continue;
    const item: MediaRef = { ...r, channel, path };
    if (description) item.description = description;
    out.push(item);
  }
  return out;
}

/**
 * The handling block, or null.
 *
 * Carried through UNTOUCHED when present. `content_blur` is not recomputed,
 * not defaulted and not inferred from `sensitivity` — the pipeline's answer is
 * the answer, and the decision about what that means for a viewer belongs to
 * the viewer's own conceal module, which already exists and is not duplicated
 * here. A block with no numeric `sensitivity` is treated as absent, because
 * the conceal decision has a threshold to compare against and nothing to
 * compare.
 */
function readHandling(v: unknown): HandlingBlock | null {
  const r = asRecord(v);
  if (!r) return null;
  if (typeof r.sensitivity !== 'number' || !Number.isFinite(r.sensitivity)) return null;
  return r as HandlingBlock;
}

function readTime(n: RawNode): NormalisedTime {
  return {
    timestamp: asString(n.timestamp),
    timezone: asString(n.timezone),
    date: asString(n.date),
    day: asString(n.day),
    month: asString(n.month),
    year: asString(n.year),
    hour: asString(n.hour),
    minute: asString(n.minute),
    second: asString(n.second),
  };
}

/** Keys the normaliser consumes. Anything else on a node is preserved on
 *  `extras` rather than dropped — the producing pipeline adds keys faster than
 *  this file can track them. */
const CONSUMED_KEYS = new Set([
  'node', 'label', 'hierarchy', 'category', 'triplet_id', 'cluster_id',
  'record_id', 'subject', 'predicate', 'object', 'confidence', 'justification',
  'attributes', 'eti_message', 'triplet_categories', 'cluster_categories',
  'relationship_category', 'msg_text', 'text_msg', 'modality', 'event_name',
  'media', 'handling', 'timestamp', 'timezone', 'date', 'day', 'month',
  'year', 'hour', 'minute', 'second', 'tier', 'misc', 'triplet_count',
]);

function collectExtras(n: RawNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(n)) {
    if (CONSUMED_KEYS.has(k)) continue;
    out[k] = n[k];
  }
  return out;
}

// ──────────────────────────────── ingest ────────────────────────────────────

export interface IngestOptions {
  /** Hard ceiling on triplets ingested. Absent means no ceiling. Present only
   *  so a caller can bound a hostile file; it is NOT a display cap and must
   *  never be set from one. */
  maxTriplets?: number;
}

interface Accum {
  rec: NormalisedTriplet;
  categorySet: Set<string>;
}

function startRecord(
  id: string,
  synthesised: boolean,
  n: RawNode,
  shape: GraphShape,
  msgText: string,
): Accum {
  const subject = asText(n.subject);
  const predicate = asText(n.predicate);
  const object = asText(n.object);

  // LABEL. The contract shape's `label` is already `subject -> predicate ->
  // object` and is used as it stands. The legacy shape's `label` is the
  // category name on a category node, or the source record's own id — never
  // the triple — so on that shape the label is REBUILT to the contract's rule
  // and the file's own string is preserved on `extras.source_label`.
  const fileLabel = asString(n.label);
  const built = buildLabel(subject, predicate, object);
  const label = shape === 'legacy' ? (built || fileLabel || '') : (fileLabel ?? built);

  const media = readMedia(n.media);
  if (media.length === 0 && shape === 'legacy') {
    const blob = `${asText(n.all_info)}\n${asText(n.info)}`;
    if (blob.includes('<img')) media.push(...mediaFromHtml(blob));
  }

  return {
    rec: {
      triplet_id: id,
      id_synthesised: synthesised,
      cluster_id: asString(n.cluster_id),
      record_id: asString(n.record_id),
      subject,
      predicate,
      object,
      label,
      confidence: asNumber(n.confidence),
      justification: asText(n.justification) || asText(n.triplet_justification),
      msg_text: msgText,
      modality: asString(n.modality),
      event_name: asString(n.event_name),
      categories: [],
      triplet_categories: asStringArray(n.triplet_categories),
      cluster_categories: asStringArray(n.cluster_categories),
      relationship_category: asStringArray(n.relationship_category),
      attributes: asRecord(n.attributes) ?? {},
      eti_message: asRecord(n.eti_message),
      media,
      handling: readHandling(n.handling),
      time: readTime(n),
      node_ids: [],
      source_shape: shape,
      extras: shape === 'legacy' && fileLabel !== null && fileLabel !== label
        ? { ...collectExtras(n), source_label: fileLabel }
        : collectExtras(n),
    },
    categorySet: new Set<string>(),
  };
}

/**
 * Ingest a parsed graph into the normalised corpus.
 *
 * Both shapes land in the same record type and the same collapse. The only
 * difference between them is where the triple's fields were found and whether
 * the file had an id of its own to use.
 */
export function ingestGraph(graph: RawGraph, options: IngestOptions = {}): NormalisedCorpus {
  const shapeReport = detectShape(graph);
  const shape = shapeReport.shape;
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const warnings: string[] = [...shapeReport.warnings];

  const accums = new Map<string, Accum>();
  const order: string[] = [];
  let tripletNodeCount = 0;
  let synthesisedCount = 0;
  let derivedMediaCount = 0;
  let cappedAt: number | null = null;

  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const h = asString(n.hierarchy);

    let isSource = false;
    if (shape === 'contract') isSource = h === 'TRIPLET';
    else if (shape === 'legacy') isSource = isCategoryHierarchy(h) && carriesTriple(n);
    if (!isSource) continue;

    tripletNodeCount++;

    // `text_msg` is the legacy name for `msg_text`. Both are read whichever
    // shape we are in, so a hybrid file loses nothing.
    const msgText = asText(n.msg_text) || asText(n.text_msg);

    // IDENTITY. The pipeline's own id when the file has one. When it does not
    // — the legacy shape never does — a stable hash of the triple's own text,
    // so the same triple in the same file always lands on the same record, in
    // a browser and in a service alike.
    let id = asString(n.triplet_id);
    let synthesised = false;
    if (id === null) {
      const subject = asText(n.subject);
      const predicate = asText(n.predicate);
      const object = asText(n.object);
      id = `lgc:${fnv1a32(`${subject}|${predicate}|${object}|${msgText}`)}`;
      synthesised = true;
    }

    let acc = accums.get(id);
    if (!acc) {
      if (options.maxTriplets !== undefined && accums.size >= options.maxTriplets) {
        cappedAt = options.maxTriplets;
        continue;
      }
      acc = startRecord(id, synthesised, n, shape, msgText);
      accums.set(id, acc);
      order.push(id);
      if (synthesised) synthesisedCount++;
      derivedMediaCount += acc.rec.media.filter(m => m.derived === true).length;
    }

    // THE COLLAPSE. One node instance per (triplet, category); this is where
    // the instances stop being rows.
    const nodeId = asString(n.node);
    if (nodeId !== null) acc.rec.node_ids.push(nodeId);
    const cat = asString(n.category) ?? asString(n.category_node) ?? asString(n.label);
    if (cat !== null) acc.categorySet.add(cat);

    // A later instance may carry a field the first one did not. Fill gaps,
    // never overwrite: the first instance of a triplet owns its values, which
    // makes the result independent of node order in the file.
    const r = acc.rec;
    if (r.msg_text === '' && msgText !== '') r.msg_text = msgText;
    if (r.record_id === null) r.record_id = asString(n.record_id);
    if (r.cluster_id === null) r.cluster_id = asString(n.cluster_id);
    if (r.event_name === null) r.event_name = asString(n.event_name);
    if (r.modality === null) r.modality = asString(n.modality);
    if (r.confidence === null) r.confidence = asNumber(n.confidence);
    if (r.handling === null) r.handling = readHandling(n.handling);
    if (r.media.length === 0) {
      const more = readMedia(n.media);
      if (more.length > 0) r.media = more;
    }
  }

  const triplets: NormalisedTriplet[] = [];
  const byTripletId = new Map<string, NormalisedTriplet>();
  const byMessageKey = new Map<string, string[]>();
  const catVals = new Set<string>();
  const eventVals = new Set<string>();
  const modalityVals = new Set<string>();
  const yearVals = new Set<string>();

  // WHICH KEY THIS FILE SUPPLIES, decided over the whole corpus before any
  // grouping. A file that carries a cluster id on even one triplet is a
  // cluster-keyed file; falling back per-triplet would mix two kinds of group
  // in one answer and make the count unexplainable.
  let anyCluster = false;
  let anyRecord = false;
  for (const id of order) {
    const acc = accums.get(id);
    if (!acc) continue;
    if (acc.rec.cluster_id !== null) anyCluster = true;
    if (acc.rec.record_id !== null) anyRecord = true;
    if (anyCluster) break;
  }
  const messageKeyAvailable: MessageKeySource =
    anyCluster ? 'cluster_id' : anyRecord ? 'record_id' : 'none';

  for (const id of order) {
    const acc = accums.get(id);
    if (!acc) continue;
    const r = acc.rec;
    r.categories = [...acc.categorySet].sort();
    triplets.push(r);
    byTripletId.set(id, r);
    const mk = messageKeyOf(r, messageKeyAvailable);
    if (mk !== null) {
      const list = byMessageKey.get(mk);
      if (list) list.push(id);
      else byMessageKey.set(mk, [id]);
    }
    for (const c of r.categories) catVals.add(c);
    if (r.event_name !== null) eventVals.add(r.event_name);
    if (r.modality !== null) modalityVals.add(r.modality);
    if (r.time.year !== null) yearVals.add(r.time.year);
  }

  if (messageKeyAvailable === 'none' && triplets.length > 0) {
    warnings.push(
      'This file carries neither a cluster id nor a record id, so there is no ' +
      'key for "these triplets came out of one message". Duplicate figures ' +
      'cannot be collapsed and no "from N messages" number can be stated.',
    );
  } else if (messageKeyAvailable === 'record_id') {
    warnings.push(
      'This file carries no cluster id, so triplets are grouped by record id ' +
      'instead. A record id is one per ROW, and a message with two attachments ' +
      'is two rows — so a multi-attachment message will be counted as two ' +
      'messages here. The grouping is an approximation and is reported as one.',
    );
  }
  if (synthesisedCount > 0) {
    warnings.push(
      `${synthesisedCount} of ${triplets.length} triplet ids were synthesised ` +
      'from the triple\'s own text because the file carries none. They are ' +
      'stable but they are not the pipeline\'s ids.',
    );
  }
  if (derivedMediaCount > 0) {
    warnings.push(
      `${derivedMediaCount} media references were recovered from pre-rendered ` +
      'HTML in this file rather than from a structured media list. They carry ' +
      'no describer output and no handling block.',
    );
  }
  if (cappedAt !== null) {
    warnings.push(`Ingest stopped at the caller's maxTriplets ceiling of ${cappedAt}.`);
  }
  if (tripletNodeCount > 0 && triplets.length > 0 && tripletNodeCount !== triplets.length) {
    warnings.push(
      `${tripletNodeCount} source nodes collapsed to ${triplets.length} distinct ` +
      'triplets. Counting nodes would have multiplied every figure by the ' +
      'number of categories each triplet carries.',
    );
  }

  const sorted = (s: Set<string>) => [...s].sort();

  return {
    shape: shapeReport,
    triplets,
    byTripletId,
    byMessageKey,
    messageKeyAvailable,
    facetValues: {
      category: sorted(catVals),
      event_name: sorted(eventVals),
      modality: sorted(modalityVals),
      year: sorted(yearVals),
    },
    nodeCount: shapeReport.nodeCount,
    edgeCount: shapeReport.edgeCount,
    tripletNodeCount,
    warnings,
  };
}
