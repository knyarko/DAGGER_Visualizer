// graph-chat/engine/types.ts
//
// THE CONTRACT SURFACE. Everything the view, the service and the chart layer
// code against is declared here and nowhere else.
//
// ── WHAT THIS MODULE IS ALLOWED TO BE ───────────────────────────────────────
//   Plain TypeScript. No framework, no DOM, no `fetch`, no model call, no
//   dependency outside the standard library. It is imported unchanged by a
//   browser bundle and by a node service, so anything that only exists in one
//   of those two places cannot appear in it.
//
// ── WHY IT DOES NOT IMPORT THE VIEWER'S TYPES ───────────────────────────────
//   The viewer's `src/types.ts` already names this data well, and this file
//   deliberately reuses its field names, its optionality and its "pass an
//   unknown key through rather than drop it" rule. What it does NOT do is
//   import them. The engine must build in a node service that has no reason to
//   resolve a path into the viewer's source tree, and a build-time dependency
//   from the service onto the view is the wrong direction.
//
//   Instead the input types below are STRUCTURALLY ASSIGNABLE from the
//   viewer's: a `DaggerGraph` is a `RawGraph`, a `DaggerTripletNode` is a
//   `RawNode`, a `DaggerMedia` is a `MediaRef` input, a `DaggerHandling` is a
//   `HandlingBlock`. So a view that has already parsed a file hands its nodes
//   straight in — no conversion, no second parse, no copy.
//
// ── THE TWO RULES THAT ARE NOT NEGOTIABLE ───────────────────────────────────
//   1. A COUNT IS OVER TRIPLETS, NEVER OVER NODES. The graph emits one TRIPLET
//      node per (triplet, category) pair, so counting nodes multiplies by the
//      number of categories a triplet carries. Both numbers are reported, and
//      the node number is only ever shown as the thing that was collapsed.
//   2. THE ENGINE NEVER ADDS TWO STATED FIGURES. See `AggregateEvidence.sum`,
//      which is typed `null` so that adding them is not expressible.

// ─────────────────────────────── versioning ─────────────────────────────────

/** Bumped when any type in this file changes shape. A serialised answer
 *  carries it (see `EngineStamp`) so a reader always knows what produced it. */
export const ENGINE_CONTRACT_VERSION = '1.0.0';

/** Identifies the run that produced a result. Present on every envelope so an
 *  export can be read back years later without guessing. */
export interface EngineStamp {
  contractVersion: string;
  /** The shape the corpus was detected as. An answer means something different
   *  depending on which file it came from, so it travels with the answer. */
  shape: GraphShape;
  /** The matcher that produced the hits, with its parameters. */
  matcher: MatcherDescriptor;
}

// ───────────────────────────── raw input shapes ─────────────────────────────
//
// What arrives. Index signatures throughout: the producing pipeline adds keys
// faster than this file can track them and an unrecognised key is preserved on
// `NormalisedTriplet.extras` rather than dropped.

export interface RawNode {
  node?: string;
  label?: string;
  hierarchy?: string;
  category?: string;
  [key: string]: unknown;
}

export interface RawEdge {
  source?: string;
  target?: string;
  hierarchy_link?: string;
  [key: string]: unknown;
}

export interface RawGraph {
  nodes: RawNode[];
  edges: RawEdge[];
  [key: string]: unknown;
}

// ──────────────────────────────── shape ─────────────────────────────────────

/**
 * Which of the two real file shapes this is.
 *
 * `contract` — the shape the Graph_Viz shape contract specifies: TRIPLET /
 *   CLUSTER / H00x nodes, `msg_text`, structured `media[]`.
 * `legacy`   — the older hierarchy graph: H00x nodes ONLY, zero TRIPLET and
 *   zero CLUSTER nodes, the triple's own fields (`subject` / `predicate` /
 *   `object` / `confidence` / `triplet_justification`) carried on the H00x
 *   node itself, `text_msg` where the contract shape says `msg_text`, plus
 *   pre-rendered `all_info` / `info` HTML and `category_node` / `weekday` /
 *   `month_name`.
 * `unknown`  — neither. The corpus ingests to zero triplets and says so
 *   rather than pretending; a caller must be able to put that on screen.
 */
export type GraphShape = 'contract' | 'legacy' | 'unknown';

/**
 * Which id a corpus supplies for "these triplets came out of one message".
 *
 * Ordered best to worst, and the ingest picks the best the file has. The
 * value travels on the corpus and onto every answer, because "grouped by
 * rows because this file has no message id" is a different claim from
 * "grouped by messages", and a reader has to be able to tell them apart.
 */
export type MessageKeySource = 'cluster_id' | 'record_id' | 'none';

/**
 * What detection saw, in full. This is not a boolean the view can only obey —
 * it is the evidence, because "this file is the legacy shape, so the answer
 * below is built from H00x nodes" is a sentence a person has to be able to
 * read on screen.
 */
export interface ShapeReport {
  shape: GraphShape;
  /** 0..1. How much of the sampled evidence pointed at `shape`. */
  confidence: number;
  nodeCount: number;
  edgeCount: number;
  /** Every distinct `hierarchy` value seen, with its node count. */
  hierarchyCounts: Record<string, number>;
  tripletNodeCount: number;
  clusterNodeCount: number;
  categoryNodeCount: number;
  /** Nodes that carried triple fields but were NOT `hierarchy: "TRIPLET"` —
   *  the legacy shape's whole payload lives here. */
  tripleBearingCategoryNodeCount: number;
  /** Legacy marker fields actually found, e.g. `text_msg`, `all_info`. */
  legacyFieldsSeen: string[];
  /** Plain sentences naming what decided the verdict. Safe to render. */
  signals: string[];
  /** Things a reader needs to know before trusting a number off this file. */
  warnings: string[];
}

// ───────────────────────────── normalised record ────────────────────────────

/**
 * One media item. Field names are the contract's (`description` / `conf` /
 * `model`, channel-agnostic, with `conf` a STRING in real output), so a
 * viewer-side `DaggerMedia` is assignable to this without conversion.
 *
 * `path` is RELATIVE and stays relative. The engine never resolves it, never
 * fetches it and never copies it; a base URL is the view's business.
 */
export interface MediaRef {
  channel: string;
  path: string;
  media_type?: string;
  filename?: string;
  /** A model's reading of the media. This is EVIDENCE, and it is one of the
   *  fields the retrieval matcher searches — "burning buildings" is far more
   *  likely to be written here than in a triple. */
  description?: string;
  conf?: string | number;
  model?: string;
  /** TRUE when this entry was not emitted as structured media but recovered by
   *  the ingest from a legacy pre-rendered HTML blob. A derived entry has no
   *  describer output and no handling block behind it; see the note on
   *  `NormalisedTriplet.handling`. Never render it as pipeline provenance. */
  derived?: boolean;
  [key: string]: unknown;
}

/**
 * The HANDLING block, carried through VERBATIM.
 *
 * `content_blur` is derived in the pipeline and is NOT recomputed here — not
 * in the engine and not in the viewer. The engine's only job is to make sure
 * the block that was on the node is the block that reaches the surface that
 * renders it. The conceal DECISION already exists, once, in the viewer's
 * `lib/contentBlur.ts`, and this engine deliberately does not own a second
 * copy of it.
 *
 * `warning_tags` is a living vocabulary on the pipeline side. It is never
 * hard-coded, never validated and never filtered here.
 */
export interface HandlingBlock {
  sensitivity: number;
  sensitivity_conf?: number;
  sensitivity_model?: string;
  content_blur?: boolean;
  filter_reason?: string;
  warning_tags?: string[];
  [key: string]: unknown;
}

/** The seven clock fields, kept as the STRINGS the producer emits (zero-padded,
 *  `"08"`, `"2017"`), because coercing them to numbers loses the padding and
 *  the legacy shape's `"Unknown"` sentinel. `"Unknown"` normalises to `null`. */
export interface NormalisedTime {
  timestamp: string | null;
  timezone: string | null;
  /** DAY-FIRST as emitted (`27/08/2017`). Not parsed here. */
  date: string | null;
  day: string | null;
  month: string | null;
  year: string | null;
  hour: string | null;
  minute: string | null;
  second: string | null;
}

/**
 * ONE TRIPLET. Not one node — one triplet.
 *
 * Every TRIPLET node the file carried for this `triplet_id` has already been
 * collapsed into this single record, and `node_ids` holds the ones that were.
 * `categories` is the union of the `category` each of those node instances
 * stood for. This collapse happens in the ingest, BEFORE any query runs,
 * which is the whole point: by the time anything is counted there is nothing
 * left to multiply.
 */
export interface NormalisedTriplet {
  /** Identity. For the contract shape this is the pipeline's ULID. For the
   *  legacy shape there is no such field and this is a synthesised, stable
   *  `lgc:<hash>` — see `id_synthesised`. */
  triplet_id: string;
  /** TRUE when `triplet_id` was synthesised by the ingest rather than read off
   *  the file. A synthesised id is stable for the same content but it is NOT
   *  the pipeline's id and must never be shown as one or joined against one. */
  id_synthesised: boolean;
  /**
   * THE MESSAGE this triple came out of, and THE KEY EVERYTHING GROUPS ON.
   *
   * The data dictionary is explicit: `cluster_id` is the id "for the
   * originating MESSAGE, shared by every row and every triplet that came out
   * of it", while `record_id` below is "unique id for this ROW ... one per
   * row, so a message with two attachments gets two".
   *
   * So a message with two attachments is TWO `record_id` and ONE
   * `cluster_id`. Grouping on `record_id` splits that message in half and
   * states its casualty figure twice. Grouping on `cluster_id` does not.
   * NULL on a file that carries no such id.
   */
  cluster_id: string | null;
  /**
   * The ROW the triple was extracted from. Carried because the file carries
   * it and a consumer may legitimately want it — but it is NOT the grouping
   * key and must never be used as one. Use `cluster_id`, or ask
   * `NormalisedCorpus.messageKeyAvailable` which key this file actually has.
   */
  record_id: string | null;

  subject: string;
  predicate: string;
  object: string;
  /** `subject → predicate → object` (U+2192, single spaces) as the producer
   *  writes it, or rebuilt to that rule when the file has no label. */
  label: string;
  confidence: number | null;
  justification: string;
  /** The message the triple was extracted from. Fed by `msg_text` on the
   *  contract shape and by `text_msg` on the legacy shape. */
  msg_text: string;
  modality: string | null;
  event_name: string | null;

  /** The union of the `category` values of every node instance collapsed into
   *  this record. This is the facet to group by — not `triplet_categories`,
   *  which is what extraction proposed rather than what the graph emitted. */
  categories: string[];
  triplet_categories: string[];
  cluster_categories: string[];
  relationship_category: string[];

  attributes: Record<string, unknown>;
  eti_message: Record<string, unknown> | null;
  media: MediaRef[];

  /**
   * NULL means the file carried NO `handling` key for this triplet, and that
   * is the ordinary case — today's real pipeline output has none.
   *
   * NULL IS NOT AN ALL-CLEAR AND IT IS NOT A CONCEALMENT. It is the absence of
   * an answer, and the only correct thing to do with it is hand it to the
   * viewer's existing conceal decision and let that decide. The engine takes
   * no position, invents no placeholder, and never writes a block the pipeline
   * did not emit.
   */
  handling: HandlingBlock | null;

  time: NormalisedTime;

  /** Every graph node id that collapsed into this record. Its length is the
   *  multiplier that counting nodes instead of triplets would have applied. */
  node_ids: string[];
  /** Which shape this record was read out of. Travels per record so a merged
   *  corpus is still honest about where each row came from. */
  source_shape: GraphShape;
  /** Keys the ingest did not recognise, preserved rather than dropped. The
   *  legacy shape's `all_info` / `info` / `category_node` / `weekday` /
   *  `month_name` land here. */
  extras: Record<string, unknown>;
}

/** The ingested corpus. Built once per loaded file, then queried many times. */
export interface NormalisedCorpus {
  shape: ShapeReport;
  /** Every distinct triplet, in first-seen file order. */
  triplets: NormalisedTriplet[];
  byTripletId: Map<string, NormalisedTriplet>;
  /** message key -> the triplet ids that came out of that message. The key is
   *  whatever `messageKeyAvailable` names. Empty when the file carries
   *  neither id. */
  byMessageKey: Map<string, string[]>;
  /**
   * WHICH KEY THIS FILE ACTUALLY SUPPLIES for "these came from one message".
   *
   * `'cluster_id'` — the right one, and the one to prefer always.
   * `'record_id'` — the file has no cluster id, so rows are the best available
   *   approximation of messages. It is an APPROXIMATION: a message with two
   *   attachments is two rows and will be counted as two messages.
   * `'none'` — the file has neither, so no message count can be stated at all
   *   and nothing may be collapsed by the engine. A caller with another key
   *   (identical message text, say) applies it itself and says that it did.
   *
   * A caller must not state "from N messages" when this is `'none'`: there is
   * no such number in the file, and counting synthesised ids would report the
   * triplet count under a different name.
   */
  messageKeyAvailable: MessageKeySource;
  /** Distinct values of the groupable facets, sorted, for a filter UI. */
  facetValues: {
    category: string[];
    event_name: string[];
    modality: string[];
    year: string[];
  };
  nodeCount: number;
  edgeCount: number;
  /** TRIPLET nodes (or legacy triple-bearing nodes) seen before collapse. */
  tripletNodeCount: number;
  /** Non-fatal problems met during ingest. Rendered, not swallowed. */
  warnings: string[];
}

// ─────────────────────────────── the query ──────────────────────────────────

/** The two question classes. They are different machines and the engine does
 *  not guess between them — the caller states which one it is asking. */
export type QueryKind = 'aggregate' | 'retrieval';

/** The fields the matcher reads. Named so a hit can say where it matched. */
export type TripletTextField =
  | 'subject'
  | 'predicate'
  | 'object'
  | 'label'
  | 'msg_text'
  | 'justification'
  | 'media.description'
  | 'attributes'
  | 'event_name';

/** The fields a result can be grouped by for a chart. All of them already
 *  exist as fields on the record; none is computed. */
export type FacetField = 'category' | 'event_name' | 'modality' | 'year' | 'month' | 'day';

/** Deterministic narrowing applied BEFORE matching. Every entry is an exact
 *  field test, never a fuzzy one — a filter that guessed would make the count
 *  unreproducible. An empty or absent list means "no constraint". */
export interface QueryFilters {
  category?: string[];
  event_name?: string[];
  modality?: string[];
  year?: string[];
  month?: string[];
  day?: string[];
  /** Inclusive lower bound on `confidence`. Records with a null confidence are
   *  EXCLUDED when this is set, and the exclusion is reported. */
  minConfidence?: number;
}

/** Names the matcher and its parameters so a result can be reproduced exactly
 *  and an export can say how it was obtained. */
export interface MatcherDescriptor {
  name: string;
  version: string;
  params: Record<string, number | string | boolean>;
  /** Set by the caller when an external reranker touched the ordering. The
   *  engine never sets this itself, because the engine never calls a model. */
  rerankedBy?: string;
}

/** The question, recorded in full. This is what makes a stored answer
 *  re-askable and what a near-duplicate question cache keys on. */
export interface QueryDescriptor {
  kind: QueryKind;
  /** The user's question, verbatim, unmodified. */
  text: string;
  /** The clauses the text was split into. "burning buildings or collapsed
   *  buildings" is TWO clauses and matching either one is a hit. */
  clauses: string[];
  /** The terms actually searched, after normalisation and stemming. */
  terms: string[];
  filters: QueryFilters;
  matcher: MatcherDescriptor;
  /** ISO-8601. Injectable, so a test is deterministic. */
  issuedAt: string;
}

// ───────────────────────────── stated figures ───────────────────────────────

/**
 * How a figure was qualified in the text it was read out of. This is the
 * reason the engine refuses to add: `more than 2,000`, `at least 136` and
 * `at least 50` are a running national total, a verified subset of it, and one
 * incident inside that subset. Their sum is a number with nothing behind it.
 */
export type FigureQualifier =
  | 'exact'
  | 'at least'
  | 'more than'
  | 'nearly'
  | 'about'
  | 'up to'
  | 'fewer than'
  | 'unquantified';

/** One number a triplet states, with everything needed to show it beside the
 *  row it came from. */
export interface StatedFigure {
  /** NULL for `unquantified` ("dozens", "hundreds of") — the text asserted a
   *  magnitude without a number and the engine will not invent one. */
  value: number | null;
  qualifier: FigureQualifier;
  /** The noun the number counted, when the text gives one: `people`,
   *  `civilians`, `children`, `deaths`, `injuries`. NULL when it does not. */
  unit: string | null;
  /** The literal span the figure was read out of, for display beside it. */
  raw: string;
  field: TripletTextField;
  triplet_id: string;
  /** The MESSAGE this figure was stated in — `cluster_id` where the file has
   *  one, otherwise the next best key the corpus reported. Two figures
   *  sharing this value may be one fact said twice. NULL when the file
   *  supplies no key at all. */
  cluster_id: string | null;
}

/**
 * Triplets that came out of ONE MESSAGE, with the figures they state.
 *
 * This is the collapse that stops one event being counted twice because two
 * triples were extracted from the same message — and the reason it keys on
 * `cluster_id` and not `record_id` is that a message with two attachments is
 * two rows. Keyed on rows, that message is two groups and its casualty
 * figure is stated twice.
 */
export interface MessageGroup {
  /** The message these triplets came out of. `cluster_id` where the file has
   *  one; `record_id` only where it does not and rows are standing in for
   *  messages; null where neither exists and this group is one triplet. */
  cluster_id: string | null;
  /** Which of those three this group's key actually is. Carried per group so
   *  a mixed file cannot be described by one blanket sentence. */
  key_source: MessageKeySource;
  triplet_ids: string[];
  /** The record's message text, once. */
  msg_text: string;
  figures: StatedFigure[];
  /** Set when more than one triplet in this group states a figure: a plain
   *  sentence saying the figures may describe one event seen twice. */
  note: string | null;
}

/** One bar of a chart. Counts are over DISTINCT TRIPLETS and distinct records,
 *  never over nodes. */
export interface FacetCount {
  field: FacetField;
  value: string;
  tripletCount: number;
  /** Distinct MESSAGES, not rows. NULL when the corpus supplies no message
   *  key at all. */
  messageCount: number | null;
}

// ─────────────────────────────── evidence ───────────────────────────────────

/**
 * THE COUNTED EVIDENCE SET. This is what an aggregate question returns instead
 * of a number.
 */
export interface AggregateEvidence {
  /** Graph nodes that matched, before the triplet collapse. Shown ONLY as the
   *  thing that was collapsed — never as an answer. */
  matchedNodeCount: number;
  /** Distinct `triplet_id` that matched. This is the count. */
  matchedTripletCount: number;
  /** Distinct MESSAGES behind those triplets, keyed as
   *  `NormalisedCorpus.messageKeyAvailable` says. NULL when the corpus
   *  supplies no key, because then there is no such number to state. */
  distinctMessageCount: number | null;
  /** How many of the matched triplets actually state a figure. Normally far
   *  smaller than `matchedTripletCount`, and that gap is the finding. */
  tripletsWithFigures: number;
  /** Every figure, with its qualifier and its source. */
  figures: StatedFigure[];
  /**
   * Numbers that were read out of the matched text but set aside because the
   * text does not say what they count.
   *
   * A message is usually a whole news item, and it is full of numbers that are
   * not the answer: `25 kilometres`, `5 a.m.`, `2014`. Reported as a COUNT
   * rather than silently dropped, because "47 numbers in this text were not
   * about people" is itself worth knowing, and because a reader who disagrees
   * with the rule can ask for them.
   */
  unitlessFiguresSetAside: number;
  /** Identical figures (same value, qualifier and unit) restated by more than
   *  one triplet of the SAME message, collapsed to one. Reported so the
   *  collapse is visible rather than silent. */
  figuresCollapsedAsRestatements: number;
  /** The same figures, grouped by the MESSAGE they came from. */
  messageGroups: MessageGroup[];
  /** Facet breakdowns for a chart, one entry per (field, value). */
  facets: FacetCount[];
  /**
   * ALWAYS NULL, AND THE TYPE SAYS SO.
   *
   * There is no arithmetic the engine can do over `figures` that produces a
   * defensible total, so there is no field here that could hold one. A caller
   * that wants a total has to look at `messageGroups` and decide, in the open,
   * which rows are the same event — and that decision is not the engine's and
   * is not a model's either.
   */
  sum: null;
  /** The sentence to show where a total would otherwise go. */
  sumRefusalReason: string;
}

/** What a retrieval question returns per hit. */
export interface RetrievalHit {
  triplet: NormalisedTriplet;
  /** Matcher score. Comparable within one result set, meaningless across two. */
  score: number;
  /** Which clause of the query this hit answered. */
  matchedClauses: string[];
  matchedFields: TripletTextField[];
  matchedTerms: string[];
  /** Short spans around the match, for display. Never the whole message. */
  snippets: Snippet[];
}

export interface Snippet {
  field: TripletTextField;
  text: string;
  /** Character offsets into `text` of the matched spans, for highlighting. */
  spans: Array<{ start: number; end: number }>;
}

/** Counts behind a retrieval answer, so it can state what it searched. */
export interface RetrievalEvidence {
  /** Distinct triplets considered after filters, before scoring. */
  candidateCount: number;
  /** Triplets that scored above the floor. Equals `ResultEnvelope.total`. */
  matchedTripletCount: number;
  matchedNodeCount: number;
  distinctMessageCount: number | null;
  /** How many of the hits carry at least one media item. */
  hitsWithMedia: number;
  /** How many hits carry a `handling` block at all. The difference between
   *  this and `matchedTripletCount` is how many the conceal decision will be
   *  asked about with nothing to read. */
  hitsWithHandling: number;
  /** Per-clause hit counts, so "collapsed buildings" returning nothing is
   *  visible rather than hidden inside a combined total. */
  clauseCounts: Array<{ clause: string; tripletCount: number }>;
  facets: FacetCount[];
}

export type EvidenceBundle =
  | ({ kind: 'aggregate' } & AggregateEvidence)
  | ({ kind: 'retrieval' } & RetrievalEvidence);

// ──────────────────────────── the result shape ──────────────────────────────

/**
 * WHAT EVERY QUERY RETURNS.
 *
 * `items` is the FULL set. Always. The display cap of 25 is applied at the
 * edge by `toDisplayPage` and the envelope it was applied to is not changed by
 * it. Nothing downstream — a count, a chart, an export — is ever computed from
 * a page.
 *
 * The envelope carries the full set, the true total, the query that produced
 * it and the evidence behind every figure, which is exactly the four things a
 * later export needs. That export is NOT built here; this shape exists so it
 * does not have to be retrofitted.
 */
export interface ResultEnvelope<TItem> {
  kind: QueryKind;
  query: QueryDescriptor;
  /** THE FULL SET, never truncated. */
  items: TItem[];
  /** `items.length`, stated rather than implied so a serialiser that was
   *  handed a page can tell that it was. */
  total: number;
  evidence: EvidenceBundle;
  engine: EngineStamp;
  /** The shape of the corpus this ran against, restated on the answer. */
  shape: ShapeReport;
  /** Plain sentences a surface can render verbatim: what was excluded, what
   *  was unavailable, what a number does and does not mean. */
  notes: string[];
  /** Milliseconds spent matching. Measured, not estimated. */
  elapsedMs: number;
}

export type AggregateResult = ResultEnvelope<NormalisedTriplet>;
export type RetrievalResult = ResultEnvelope<RetrievalHit>;

/** The display cap. A DISPLAY cap. It is applied at the edge, by the surface
 *  that is about to render, and it is never applied to retrieval. */
export const DISPLAY_CAP = 25;

/** One page of an envelope, for rendering. Derived, never authoritative. */
export interface DisplayPage<TItem> {
  shown: TItem[];
  shownCount: number;
  /** The envelope's true total, carried so the caption cannot drift from it. */
  total: number;
  offset: number;
  truncated: boolean;
  capApplied: number;
  /** e.g. `"25 of 412"`, or `"412 of 412"` when nothing was cut. */
  caption: string;
}

// ──────────────────────────── extension point ───────────────────────────────

/**
 * THE ONE HOOK, and the only place a model could ever enter a query.
 *
 * The engine does not call models and cannot be made to. A service that wants
 * semantic recall beyond what the lexical matcher gives — matching "ablaze" to
 * "burning" — implements this, runs the embedder ITSELF, in its own process,
 * and hands the function in. The engine calls it with the candidates it has
 * already found and uses the ordering it gets back.
 *
 * Two consequences a caller must accept before implementing it:
 *   - whatever runs the embedder is now in the query's critical path, so an
 *     answer costs whatever that costs;
 *   - the result's `matcher.rerankedBy` must be set, or an exported answer
 *     claims to have been produced by a matcher that did not produce it.
 */
export type SemanticBooster = (
  query: QueryDescriptor,
  candidates: RetrievalHit[],
) => RetrievalHit[];
