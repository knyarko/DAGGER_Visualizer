export interface Relationship {
  id: number;
  doc_id: string;
  timestamp: string | null;
  actor: string;
  action: string;
  target: string;
  location: string | null;
  tags: string[];
}

export interface Actor {
  name: string;
  connection_count: number;
}

export interface Stats {
  totalDocuments: { count: number };
  totalTriples: { count: number };
  totalActors: { count: number };
  categories: { category: string; count: number }[];
}

export interface GraphNode {
  id: string;
  name: string;
  val: number;
  totalVal?: number;
  color?: string;
  baseColor?: string;
}

export interface GraphLink {
  source: string;
  target: string;
  action: string;
  location?: string;
  timestamp?: string;
}

export interface Document {
  doc_id: string;
  file_path: string;
  one_sentence_summary: string;
  paragraph_summary: string;
  category: string;
  date_range_earliest: string | null;
  date_range_latest: string | null;
}

export interface TagCluster {
  id: number;
  name: string;
  exemplars: string[];
  tagCount: number;
}

// ───────────────────────────── DAGGER Graph_Viz ─────────────────────────────
//
// The shape of `Graph_Viz.json` as the DAGGER pipeline emits it: `{nodes,
// edges}` and nothing else. These types describe the FILE, not the graph the
// explorer draws — the explorer still draws from the edge rows and joins by id.
//
// Honesty rule: only the fields the pipeline guarantees on every node of that
// kind are required. Everything the fixture happens to carry but the pipeline
// does not promise is optional, so a thinner file from a later pipeline run
// still typechecks. `unknown`-typed extras are deliberate: the pipeline adds
// keys faster than this file can track them, and the loader must not drop a key
// it has not heard of.

/** One media item attached to a triplet. `path` is RELATIVE and stays relative;
 *  the viewer supplies a base URL and joins them. Nothing is ever copied. */
export interface DaggerMedia {
  /** 'image' | 'audio' | 'video' in practice, but the vocabulary is the
   *  pipeline's, so an unseen channel must not break the UI. */
  channel: string;
  path: string;
  media_type?: string;
  filename?: string;
  /** A model's reading of the media — evidence, not a human caption. */
  description?: string;
  /** Emitted as a STRING in the fixture (e.g. "0.95"), not a number. */
  conf?: string | number;
  model?: string;
  [key: string]: unknown;
}

/** The HANDLING block. `content_blur` is false at exactly 0.0 and true
 *  everywhere else — it is the pipeline's answer, not a threshold the UI
 *  recomputes. */
export interface DaggerHandling {
  sensitivity: number;
  sensitivity_conf?: number;
  sensitivity_model?: string;
  content_blur?: boolean;
  filter_reason?: string;
  /** A living vocabulary on the pipeline side. Never hard-code the list.
   *  `["None"]` is the no-warning answer, not a tag to render. */
  warning_tags?: string[];
  [key: string]: unknown;
}

/** Fields every DAGGER node carries, whatever its tier. */
export interface DaggerNodeCommon {
  /** The node id. Edges reference this value in `source` / `target`. */
  node: string;
  /** Display text. For a triplet this is already `subject → predicate → object`.
   *  Render it as-is; never fall back to `node`. */
  label: string;
  /** 'TRIPLET', 'CLUSTER', or 'H000'/'H001'/… for a category tier. */
  hierarchy: string;
  category?: string;
  [key: string]: unknown;
}

/** A category node — `hierarchy: "H000"`, `"H001"`, … up the tree. */
export interface DaggerCategoryNode extends DaggerNodeCommon {
  /** Integer form of the hierarchy: H000 → 0. */
  tier?: number;
  /** `true` marks a label that never converged: it keeps its H000 node and its
   *  clusters and has zero edges upward. It floats, deliberately. Never prune. */
  misc?: boolean;
}

/** A cluster node — one message, placed once per category it carries, so the
 *  same `cluster_id` appears under several categories with different `node`
 *  ids (`..._0001`, `..._0002`). */
export interface DaggerClusterNode extends DaggerNodeCommon {
  cluster_id?: string;
  misc?: boolean;
  triplet_count?: number;
}

/** A triplet node — carries the full record. */
export interface DaggerTripletNode extends DaggerNodeCommon {
  /** The true identity of this triplet. Do not synthesise a parent id. */
  triplet_id?: string;
  cluster_id?: string;
  record_id?: string;

  subject?: string;
  predicate?: string;
  object?: string;
  confidence?: number;
  justification?: string;
  msg_text?: string;
  modality?: string;
  event_name?: string;
  attributes?: Record<string, unknown>;
  eti_message?: Record<string, unknown>;

  /** Three DISTINCT keys, not synonyms — three separate lists to display. */
  triplet_categories?: string[];
  cluster_categories?: string[];
  relationship_category?: string[];

  /** All seven clock fields. Emitted as zero-padded STRINGS ("08", "2017"),
   *  not numbers — always coerce. `date` is DAY-FIRST (`27/08/2017`); see
   *  `daggerNodeInstant` in lib/timeline.ts for why it is not parsed directly. */
  day?: string | number;
  month?: string | number;
  year?: string | number;
  hour?: string | number;
  minute?: string | number;
  second?: string | number;
  timezone?: string;
  timestamp?: string;
  date?: string;

  media?: DaggerMedia[];
  handling?: DaggerHandling;
}

export type DaggerNode = DaggerCategoryNode | DaggerClusterNode | DaggerTripletNode;

/** A structural edge. `predicate` is empty on structural edges — this graph is
 *  not causation yet. Join nodes by id. */
export interface DaggerEdge {
  source: string;
  target: string;
  /** Names the step: 'TRIPLET_to_CLUSTER', 'CLUSTER_to_H000', 'H000_to_H001', … */
  hierarchy_link: string;
  legend_key_id?: string;
  source_label?: string;
  target_label?: string;
  predicate?: string;
  [key: string]: unknown;
}

export interface DaggerGraph {
  nodes: DaggerNode[];
  edges: DaggerEdge[];
}

/**
 * The parsed DAGGER graph, keyed for lookup. Built once at load time and hung
 * off the dataset option as `.dagger` (see lib/parseData.ts). Present ONLY when
 * the loaded file was detected as DAGGER-shaped from its own content; every
 * consumer must treat it as optional and keep working when it is absent.
 */
export interface DaggerIndex {
  /** Every node from the file, keyed by its `node` id — UNFLATTENED, so
   *  `media[]` and `handling{}` arrive as real arrays/objects. */
  nodesById: Map<string, DaggerNode>;
  /** The file's edges, in document order. */
  edges: DaggerEdge[];
  /** node id → `label`. The one map to use for rendering node text. */
  labelById: Map<string, string>;
}
