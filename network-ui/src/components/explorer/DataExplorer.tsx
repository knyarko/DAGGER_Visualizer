import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FileUpload from './FileUpload';
import FieldMapper from './FieldMapper';
import FilterPanel from './FilterPanel';
import DirectedGraph, { type DaggerNodeKind } from './DirectedGraph';
import NodeMedia, { type ContentOverride } from './NodeMedia';
import { daggerNodeHandling, daggerNodeMedia, daggerVisibleSubgraph, daggerWarningTags, isCategoryNode, isClusterNode, isTripletNode, type DatasetOption } from '../../lib/parseData';
import type { DaggerNode } from '../../types';
import { MEDIA_BASE_URLS } from '../../lib/mediaConfig';
import { suggestMapping, type FilterMap, type VisualMapping } from '../../lib/mapping';
import { enumerateChains, reachableWithin, chainToEdgeKeys } from '../../lib/chains';
import { buildLabel, BUILD_SHA_FULL, BUILD_TIME } from '../../lib/buildInfo';
import { computeTimeRange, buildOpacityMap, buildRowDateLookup, formatCursor, fadeDurationToMs, DEFAULT_FADE_DURATION, MS_PER_MINUTE, type FadeDuration } from '../../lib/timeline';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const CHAIN_MAX_PATHS = 200;

// ── AA043: the media root is CONFIGURATION, not a viewer setting ─────────────
//
// It used to be a text box in the sidebar, persisted in `localStorage` under
// `mediaBaseUrl`. Rusty's call: "Giving the user the option to give the base
// url is a bad design. This should be an internal configuration." The control
// is gone and the roots now come from `lib/mediaConfig.ts` as a LIST, tried in
// order, because one graph file can carry paths from more than one collection.
//
// Nothing here reads `localStorage.mediaBaseUrl` any more, and nothing writes
// or clears it. A value a viewer stored in an earlier build is left exactly
// where it is — it is simply no longer consulted. We do not delete a user's
// data to tidy up after ourselves.

interface Props {
  onSwitchMode?: () => void;
}

/**
 * Iteratively prune nodes whose undirected degree (in + out) falls below `k`,
 * recompute, repeat until convergence. Returns the surviving edge rows.
 *
 * Standard k-core decomposition. k=2 is the natural answer to "show only
 * multi-hop chains" — a node survives iff it's interior to the remaining
 * graph after all dangling leaves have been peeled off.
 */
function applyKCore(
  rows: Record<string, unknown>[],
  srcField: string,
  tgtField: string,
  k: number,
): Record<string, unknown>[] {
  if (k <= 0 || rows.length === 0) return rows;

  // Index edges + initial degrees
  type Edge = { s: string; t: string; row: Record<string, unknown> };
  const edges: Edge[] = [];
  const degree = new Map<string, number>();
  for (const r of rows) {
    const sv = r[srcField];
    const tv = r[tgtField];
    if (sv === null || sv === undefined || sv === '') continue;
    if (tv === null || tv === undefined || tv === '') continue;
    const s = String(sv);
    const t = String(tv);
    edges.push({ s, t, row: r });
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
  }

  const removed = new Set<string>();
  // Repeat until no more nodes drop below k
  let changed = true;
  while (changed) {
    changed = false;
    for (const [node, deg] of degree.entries()) {
      if (removed.has(node)) continue;
      if (deg < k) {
        removed.add(node);
        changed = true;
      }
    }
    if (!changed) break;
    // Recompute degrees on the surviving subgraph
    degree.clear();
    for (const e of edges) {
      if (removed.has(e.s) || removed.has(e.t)) continue;
      degree.set(e.s, (degree.get(e.s) ?? 0) + 1);
      degree.set(e.t, (degree.get(e.t) ?? 0) + 1);
    }
  }

  return edges.filter(e => !removed.has(e.s) && !removed.has(e.t)).map(e => e.row);
}

function applyFilters(
  rows: Record<string, unknown>[],
  filters: FilterMap,
): Record<string, unknown>[] {
  const entries = Object.entries(filters);
  if (entries.length === 0) return rows;
  return rows.filter(row => {
    for (const [field, f] of entries) {
      const v = row[field];
      if (f.type === 'categorical') {
        if (v === null || v === undefined || v === '') return false;
        if (!f.allowed.has(String(v))) return false;
      } else if (f.type === 'numeric') {
        if (v === null || v === undefined || v === '') return false;
        const n = Number(v);
        if (!Number.isFinite(n)) return false;
        if (n < f.min || n > f.max) return false;
      } else if (f.type === 'date') {
        if (v === null || v === undefined || v === '') return false;
        const t = Date.parse(String(v));
        if (!Number.isFinite(t)) return false;
        if (t < f.min || t > f.max) return false;
      } else if (f.type === 'text') {
        if (v === null || v === undefined || v === '') return false;
        if (!String(v).toLowerCase().includes(f.query.toLowerCase())) return false;
      }
    }
    return true;
  });
}

/**
 * What a node IS, for AA047's "highlight its other occurrences".
 *
 * Rusty: "that same color should highlight across other branches based on its
 * triplet_id or cluster_id". The pipeline places one cluster once per category
 * it carries, so a single cluster_id becomes several node ids
 * (`…_0001`, `…_0002`, …) sitting under different parents. The same is true of a
 * triplet that belongs to more than one category. Those — and only those — are
 * "other occurrences" of the thing you clicked.
 *
 * The kind is part of the key on purpose. A triplet node also carries the
 * cluster_id of the cluster it belongs to, so matching on the bare id would
 * light every sibling triplet in that cluster as well, and a sibling is a
 * different triplet, not another occurrence of this one. Returns null for a
 * category node (no such id) and for any node whose id is missing — the clicked
 * node itself is still lit; it simply has no occurrences to light.
 */
function nodeIdentity(node: DaggerNode | undefined | null): string | null {
  if (isTripletNode(node)) {
    const id = node.triplet_id;
    return typeof id === 'string' && id !== '' ? `TRIPLET:${id}` : null;
  }
  if (isClusterNode(node)) {
    const id = node.cluster_id;
    return typeof id === 'string' && id !== '' ? `CLUSTER:${id}` : null;
  }
  return null;
}

export default function DataExplorer({ onSwitchMode }: Props) {
  const [options, setOptions] = useState<DatasetOption[] | null>(null);
  const [sourceFileName, setSourceFileName] = useState<string>('');
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<VisualMapping | null>(null);
  const [filters, setFilters] = useState<FilterMap>({});
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [showMapper, setShowMapper] = useState(true);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [kCore, setKCore] = useState(0);
  const [chainDepth, setChainDepth] = useState(0);
  const [chainDirection, setChainDirection] = useState<'downstream' | 'upstream'>('downstream');
  const [selectedChainIndex, setSelectedChainIndex] = useState<number | null>(null);
  // Visual layout: spread is a multiplier on link distance + charge repulsion.
  // 1.0 = packed default; higher values pull dense clusters apart.
  const [spread, setSpread] = useState(1.0);
  // Timeline: cursor is the current "time" in epoch ms. null = timeline off
  // (all nodes shown regardless of date). Enabled only when the selected
  // option carries companion node data with resolvable dates.
  const [timeCursor, setTimeCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<number | null>(null);
  // Persistence window: how long a node stays before it disappears. Adjustable
  // in years/months/days/hours/minutes; default 30 days (= previous behaviour).
  const [fadeDuration, setFadeDuration] = useState<FadeDuration>(DEFAULT_FADE_DURATION);
  const fadeWindowMs = useMemo(() => fadeDurationToMs(fadeDuration), [fadeDuration]);
  // Edge label visibility: 'auto' (show below density cap), 'on', or 'off'.
  const [edgeLabelMode, setEdgeLabelMode] = useState<'auto' | 'on' | 'off'>('auto');
  // ── HANDLING tier (VT003) ──────────────────────────────────────────────────
  // The viewer's REVEAL THRESHOLD. Content whose `sensitivity` is at or below it
  // is shown; everything above it stays blurred until the viewer reveals that
  // one node. It starts at 0.0 so a first-time viewer sees only what the
  // pipeline marked as certainly safe.
  //
  // Deliberately NOT persisted, unlike the media base URL. A base URL is a
  // machine setting and remembering it is a convenience; a reveal threshold is a
  // decision about what this viewer wants to look at now, and restoring
  // yesterday's "show me everything" to a new session would quietly undo the
  // safe default. Every session starts closed.
  const [revealThreshold, setRevealThreshold] = useState(0);

  // ── AA048: Hide All Content / Reveal All Content ───────────────────────────
  // Rusty: "Add a Hide All Content button and a Reveal all Content Button. These
  // will override the slider. But the slider with auto unselect them upon
  // movement."
  //
  // ONE piece of state for BOTH buttons, not one boolean each. Two booleans can
  // represent "hide and reveal are both on", which is not a state that exists,
  // and every reader would then have to carry a rule for what that means. With
  // one value the three states Rusty described — Hide All, Reveal All, and the
  // threshold — are the only three values it can hold, and "exactly one is in
  // force" is true by construction rather than by discipline.
  //
  // null means the threshold is deciding. It is the default for the same reason
  // `revealThreshold` starts at 0.00: a viewer who has touched nothing gets the
  // pipeline's own answer, not an override they did not ask for.
  //
  // Not persisted, like the threshold beside it and for the same reason.
  const [contentOverride, setContentOverride] = useState<ContentOverride | null>(null);

  // Moving the slider hands control back to the threshold. This is the ONLY
  // place the slider's value changes, so the clearing cannot be forgotten at
  // some other call site — there is no other call site. A drag that ends on the
  // value it started from fires no change event and correctly clears nothing:
  // "upon movement" is movement of the value, not of the mouse.
  const setThresholdFromSlider = useCallback((value: number) => {
    setRevealThreshold(value);
    setContentOverride(null);
  }, []);

  // Warning tags the viewer has selected. Empty = no tag filter at all, which is
  // the default: a tag filter is a positive selection ("show me these"), so an
  // empty selection narrows nothing. The vocabulary itself is derived from the
  // loaded file below — never hard-coded.
  const [activeWarningTags, setActiveWarningTags] = useState<Set<string>>(new Set());

  const toggleWarningTag = useCallback((tag: string) => {
    setActiveWarningTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  // ── AA046: the modality filter ─────────────────────────────────────────────
  // Rusty: "there should be a modality filter so only triplets of that modality
  // are visible." Same shape as the tag filter above and for the same reasons:
  // a positive selection, empty by default, and the vocabulary comes from the
  // loaded file — `text`, `text+image`, `audio`, … are the pipeline's values and
  // are never hard-coded here.
  const [activeModalities, setActiveModalities] = useState<Set<string>>(new Set());

  const toggleModality = useCallback((modality: string) => {
    setActiveModalities(prev => {
      const next = new Set(prev);
      if (next.has(modality)) next.delete(modality);
      else next.add(modality);
      return next;
    });
  }, []);

  const selectedOption = useMemo(() => {
    if (!options || !selectedOptionId) return null;
    return options.find(o => o.id === selectedOptionId) ?? null;
  }, [options, selectedOptionId]);

  const dataset = useMemo(() => selectedOption?.dataset ?? null, [selectedOption]);

  // Timeline date source, keyed by graph node id:
  //   1. Edge array: the auto-joined companion node lookup carries the dates
  //      (edges themselves are undated), keyed by node id = source/target.
  //   2. Any other array (e.g. the raw node/triple array drawn subject→object):
  //      dates live on each row, so key by the current source/target values and
  //      take each entity's earliest-dated row.
  const nodeData = useMemo<Map<string, Record<string, unknown>> | null>(() => {
    const companion = selectedOption?.companionNodes?.byId;
    if (companion && companion.size > 0) return companion;
    if (dataset && mapping) {
      const idFields = [mapping.sourceField, mapping.targetField].filter(Boolean);
      if (idFields.length > 0) {
        const lookup = buildRowDateLookup(dataset.rows, idFields);
        if (lookup.size > 0) return lookup;
      }
    }
    return null;
  }, [selectedOption, dataset, mapping]);

  // The DAGGER index, present only when the loaded file was detected as a
  // Graph_Viz from its own content. null for every other file — everything
  // below that reads it must tolerate that and fall back to generic behaviour.
  const dagger = useMemo(() => selectedOption?.dagger ?? null, [selectedOption]);

  // node id → label, so a triplet reads `subject → predicate → object` rather
  // than its id. Presentation only; the graph is still keyed and joined by id.
  const nodeLabels = useMemo(() => dagger?.labelById ?? null, [dagger]);

  // ── The warning-tag vocabulary, DERIVED FROM THE LOADED FILE ───────────────
  // Every tag any node in this file carries, with how many nodes carry it. The
  // list is never hard-coded: the vocabulary is a living dictionary upstream
  // (new tags are invented and cleaned there), so a tag this UI has never seen
  // must appear here simply because the data contains it. `daggerWarningTags`
  // has already reduced the `["None"]` no-warning answer to `[]`, so "None"
  // cannot become a chip. Sorted by count then name for a stable order.
  const warningTagCounts = useMemo(() => {
    if (!dagger) return [] as [string, number][];
    const counts = new Map<string, number>();
    for (const node of dagger.nodesById.values()) {
      for (const tag of daggerWarningTags(node)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [dagger]);

  // ── The modality vocabulary, DERIVED FROM THE LOADED FILE (AA046) ──────────
  // Every `modality` value any TRIPLET in this file carries, with how many
  // triplets carry it. Built exactly like the warning-tag chips above: the
  // pipeline owns this vocabulary and adds to it, so a value this UI has never
  // seen must appear here simply because the data contains it. Only triplets are
  // counted — clusters and categories have no modality. Sorted by count then
  // name, so the order is stable between renders.
  const modalityCounts = useMemo(() => {
    if (!dagger) return [] as [string, number][];
    const counts = new Map<string, number>();
    for (const node of dagger.nodesById.values()) {
      if (!isTripletNode(node)) continue;
      const raw = node.modality;
      if (typeof raw !== 'string') continue;
      const modality = raw.trim();
      if (modality === '') continue;
      counts.set(modality, (counts.get(modality) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [dagger]);

  // ── AA045: which TRIPLETS the tag filter selects ───────────────────────────
  // The filter's only job is to name a set of triplet ids; the pruning that
  // follows is `daggerVisibleSubgraph`'s and is shared with every other triplet
  // filter. null means "no tag filter is active", which is NOT the same as an
  // empty set: an empty set means no triplet matched and the graph is empty.
  const taggedTripletIds = useMemo<Set<string> | null>(() => {
    if (!dagger || activeWarningTags.size === 0) return null;
    const ids = new Set<string>();
    for (const [id, node] of dagger.nodesById) {
      if (!isTripletNode(node)) continue;
      if (daggerWarningTags(node).some(t => activeWarningTags.has(t))) ids.add(id);
    }
    return ids;
  }, [dagger, activeWarningTags]);

  // ── AA046: which TRIPLETS the modality filter selects ──────────────────────
  // Same contract as `taggedTripletIds`, because the pruning that follows is the
  // same function: name a set of triplet ids and nothing else. null means "no
  // modality filter is active"; an empty set would mean "no triplet matched",
  // which prunes the graph to nothing — so the two must not be confused.
  const modalityTripletIds = useMemo<Set<string> | null>(() => {
    if (!dagger || activeModalities.size === 0) return null;
    const ids = new Set<string>();
    for (const [id, node] of dagger.nodesById) {
      if (!isTripletNode(node)) continue;
      const raw = node.modality;
      if (typeof raw !== 'string') continue;
      if (activeModalities.has(raw.trim())) ids.add(id);
    }
    return ids;
  }, [dagger, activeModalities]);

  // ── AA046: the two triplet filters COMPOSE, they do not fight ──────────────
  // Intersect the ID SETS and make ONE call to the walk. Running the walk twice
  // and merging its `rows` would keep a branch that only one of the two filters
  // wanted — the same family of mistake as B030, where a per-row test was asked
  // a question about reachability.
  //
  // null from both means neither filter is on and the walk is not called at all.
  const selectedTripletIds = useMemo<Set<string> | null>(() => {
    if (taggedTripletIds === null) return modalityTripletIds;
    if (modalityTripletIds === null) return taggedTripletIds;
    return new Set([...taggedTripletIds].filter(id => modalityTripletIds.has(id)));
  }, [taggedTripletIds, modalityTripletIds]);

  // Timeline span derived from node event dates. hasDates=false → no slider.
  const timeRange = useMemo(() => {
    if (!nodeData) return { min: 0, max: 0, hasDates: false };
    return computeTimeRange(nodeData, fadeWindowMs);
  }, [nodeData, fadeWindowMs]);

  const handleLoaded = (opts: DatasetOption[], fileName: string) => {
    setOptions(opts);
    setSourceFileName(fileName);
    const recommended = opts.find(o => o.recommended) ?? opts[0];
    setSelectedOptionId(recommended.id);
    // Force the picker open if there is a real choice to make
    setShowSourcePicker(opts.length > 1);
    setMapping(suggestMapping(recommended.dataset.fields));
    setFilters({});
    setSelectedNode(null);
    setShowMapper(true);
  };

  // When user switches between candidate arrays in the same file, reset mapping + filters
  // (different arrays have different fields, so the old mapping is meaningless)
  useEffect(() => {
    if (!dataset) return;
    setMapping(suggestMapping(dataset.fields));
    setFilters({});
    setSelectedNode(null);
    setKCore(0);
    setChainDepth(0);
    setSelectedChainIndex(null);
    setTimeCursor(null);
    setPlaying(false);
    // The handling controls belong to the file that is loaded. A tag selected in
    // one file usually does not exist in the next, and a stale selection would
    // silently hide every triplet; the reveal threshold goes back to 0.0 for the
    // same reason the default is 0.0 — a new file has not been looked at yet.
    setActiveWarningTags(new Set());
    setActiveModalities(new Set());
    setRevealThreshold(0);
    // AA048: and so does the override — a new file has not been looked at yet,
    // so neither "show me all of it" nor "hide all of it" is a decision this
    // viewer has made about THIS file.
    setContentOverride(null);
  }, [selectedOptionId]); // intentional: only re-run when the chosen option changes

  // Whenever the selection changes (or chain controls change), reset the
  // active chain index — old indexes don't map to the new chain list.
  useEffect(() => {
    setSelectedChainIndex(null);
  }, [selectedNode, chainDepth, chainDirection]);

  const filteredRows = useMemo(() => {
    if (!dataset) return [];
    return applyFilters(dataset.rows, filters);
  }, [dataset, filters]);

  // ── The triplet filters, pruned as one (AA045 + AA046) ─────────────────────
  // A positive selection: with no tag and no modality selected nothing is
  // narrowed, and this returns the SAME array it was given, so a non-DAGGER
  // dataset takes an identity path and behaves exactly as it did before.
  //
  // With a selection, the selected triplets go through the shared pruning
  // walk and what survives is those triplets, their clusters, and only the
  // categories reachable upward from them. A branch with no surviving triplet
  // under it disappears entirely.
  //
  // THE BUG THIS REPLACES (B030): this used to test each row's two endpoints in
  // isolation and keep any row without a triplet on either end — which is every
  // `CLUSTER_to_H000` and `H00n_to_H00n+1` row in the file. Rows dropped, but
  // the whole category tree stayed drawn. Rusty: "The entire trees and branches
  // are still shown."
  const subgraph = useMemo(() => {
    if (!mapping || !dagger || selectedTripletIds === null) return null;
    return daggerVisibleSubgraph(
      filteredRows, dagger, selectedTripletIds, mapping.sourceField, mapping.targetField,
    );
  }, [filteredRows, mapping, dagger, selectedTripletIds]);

  const visibleRows = useMemo(
    () => subgraph?.rows ?? filteredRows,
    [subgraph, filteredRows],
  );

  // Topology filter applied AFTER field filters so the user sees the cumulative effect
  const prunedRows = useMemo(() => {
    if (!mapping || kCore <= 0) return visibleRows;
    return applyKCore(visibleRows, mapping.sourceField, mapping.targetField, kCore);
  }, [visibleRows, mapping, kCore]);

  // ── AA047: node id → its tier, for the three-colour scheme ─────────────────
  // Read from the loader's index through the kind predicates, so "what is this
  // node" is answered the same way everywhere. null for a non-DAGGER file,
  // which keeps every other dataset's graph looking exactly as it did.
  const nodeKinds = useMemo<Map<string, DaggerNodeKind> | null>(() => {
    if (!dagger) return null;
    const kinds = new Map<string, DaggerNodeKind>();
    for (const [id, node] of dagger.nodesById) {
      if (isTripletNode(node)) kinds.set(id, 'triplet');
      else if (isClusterNode(node)) kinds.set(id, 'cluster');
      else if (isCategoryNode(node)) kinds.set(id, 'category');
    }
    return kinds;
  }, [dagger]);

  // ── AA047: what lights up when you click ───────────────────────────────────
  // The clicked node, plus every OTHER node that is the same thing — the same
  // `triplet_id` on a triplet, the same `cluster_id` on a cluster. That is the
  // point of the feature: the pipeline places one cluster once per category, so
  // `01M0H8ZR9GE4YMDWDYT09AFK3W` is seven nodes under seven categories, and
  // clicking any one of them lights all seven at once.
  //
  // "But this does not reflect on if the nodes are not visible. Only when they
  // are visible." — so when a filter is active, membership is intersected with
  // the walk's surviving node set. A node a filter pruned away is not lit and
  // does not come back to be lit. `subgraph` is null when no filter is on, which
  // is "everything in the file is visible".
  //
  // A node with no such id — every category node — still lights itself and
  // nothing else: clicking it must show what was clicked.
  //
  // The visibility test is applied per node, including to the clicked one. Turn
  // on a filter that prunes the node you had selected and its surviving
  // occurrences stay lit while it does not: the set is "the visible nodes that
  // are this thing", and nothing has to be special-cased to say so.
  const litNodes = useMemo<Set<string> | null>(() => {
    if (!dagger || !selectedNode) return null;
    const visible = subgraph?.nodes ?? null;
    const identity = nodeIdentity(dagger.nodesById.get(selectedNode));
    const lit = new Set<string>();
    for (const [id, node] of dagger.nodesById) {
      const isSameThing = identity !== null && nodeIdentity(node) === identity;
      if (id !== selectedNode && !isSameThing) continue;
      if (visible && !visible.has(id)) continue;
      lit.add(id);
    }
    return lit.size > 0 ? lit : null;
  }, [dagger, selectedNode, subgraph]);

  // Pull out details of the selected node (using rows that mention it)
  const selectionRows = useMemo(() => {
    if (!dataset || !mapping || !selectedNode) return [];
    return prunedRows.filter(r =>
      String(r[mapping.sourceField]) === selectedNode ||
      String(r[mapping.targetField]) === selectedNode
    );
  }, [prunedRows, mapping, dataset, selectedNode]);

  // Build directed adjacency once from the currently-visible rows; reused for
  // both chain enumeration and reachability dimming.
  const adjacency = useMemo(() => {
    if (!mapping) return { out: new Map<string, Set<string>>(), inc: new Map<string, Set<string>>() };
    const out = new Map<string, Set<string>>();
    const inc = new Map<string, Set<string>>();
    for (const r of prunedRows) {
      const sv = r[mapping.sourceField];
      const tv = r[mapping.targetField];
      if (sv === null || sv === undefined || sv === '') continue;
      if (tv === null || tv === undefined || tv === '') continue;
      const s = String(sv);
      const t = String(tv);
      if (!out.has(s)) out.set(s, new Set());
      out.get(s)!.add(t);
      if (!inc.has(t)) inc.set(t, new Set());
      inc.get(t)!.add(s);
    }
    return { out, inc };
  }, [prunedRows, mapping]);

  // Enumerate directed paths from the selected node up to chainDepth, in the
  // chosen direction. Returns array of node-id arrays sorted longest-first.
  const chains = useMemo<string[][]>(() => {
    if (!selectedNode || chainDepth <= 0) return [];
    const adj = chainDirection === 'downstream' ? adjacency.out : adjacency.inc;
    return enumerateChains(selectedNode, adj, chainDepth, CHAIN_MAX_PATHS);
  }, [selectedNode, chainDepth, chainDirection, adjacency]);

  // Set of node ids to display brightly. When a specific chain is selected,
  // only its nodes; otherwise the full reachable neighbourhood.
  const highlightedNodes = useMemo<Set<string> | null>(() => {
    if (!selectedNode || chainDepth <= 0) return null;
    if (selectedChainIndex !== null && chains[selectedChainIndex]) {
      return new Set(chains[selectedChainIndex]);
    }
    const adj = chainDirection === 'downstream' ? adjacency.out : adjacency.inc;
    return reachableWithin(selectedNode, adj, chainDepth);
  }, [selectedNode, chainDepth, chainDirection, chains, selectedChainIndex, adjacency]);

  // Cyan-highlight only the edges that belong to the active chain.
  const highlightedEdgeKeys = useMemo<Set<string> | null>(() => {
    if (selectedChainIndex === null || !chains[selectedChainIndex]) return null;
    return chainToEdgeKeys(chains[selectedChainIndex], chainDirection);
  }, [chains, selectedChainIndex, chainDirection]);

  // Per-node opacity for the current timeline cursor. null when timeline is
  // off or there are no dates — DirectedGraph treats null as "all visible".
  const nodeOpacity = useMemo<Map<string, number> | null>(() => {
    if (timeCursor === null || !nodeData || !timeRange.hasDates) return null;
    return buildOpacityMap(nodeData, timeCursor, fadeWindowMs);
  }, [timeCursor, nodeData, timeRange.hasDates, fadeWindowMs]);

  // Playback: advance the cursor ~1.5% of the span per frame (~throttled to a
  // step) until it reaches the end, then stop. Step granularity is one day so
  // the fade reads smoothly on month-to-year spans.
  useEffect(() => {
    if (!playing || timeRange.hasDates === false) return;
    const span = timeRange.max - timeRange.min;
    // ~480 frames end-to-end, but never coarser than 1/8 of the persistence
    // window (so even a short fade is sampled), floored at 1 minute.
    const step = Math.max(MS_PER_MINUTE, Math.min(span / 480, fadeWindowMs / 8));
    const tick = () => {
      setTimeCursor(prev => {
        const cur = prev === null ? timeRange.min : prev;
        const next = cur + step;
        if (next >= timeRange.max) {
          setPlaying(false);
          return timeRange.max;
        }
        return next;
      });
      playRef.current = window.setTimeout(tick, 40);
    };
    playRef.current = window.setTimeout(tick, 40);
    return () => {
      if (playRef.current !== null) window.clearTimeout(playRef.current);
    };
  }, [playing, timeRange, fadeWindowMs]);

  const enableTimeline = useCallback(() => {
    if (!timeRange.hasDates) return;
    setTimeCursor(timeRange.min);
  }, [timeRange]);

  const disableTimeline = useCallback(() => {
    setTimeCursor(null);
    setPlaying(false);
  }, []);

  // Update one field of the persistence duration (clamped to a non-negative int).
  const setFadePart = useCallback((key: keyof FadeDuration, value: number) => {
    setFadeDuration(prev => ({ ...prev, [key]: Math.max(0, Math.floor(Number(value) || 0)) }));
  }, []);

  if (!options || !dataset || !mapping || !selectedOptionId) {
    return (
      <div className="relative">
        <FileUpload onLoaded={handleLoaded} />
        {onSwitchMode && (
          <button
            onClick={onSwitchMode}
            className="absolute top-4 right-4 text-xs text-gray-400 hover:text-white px-3 py-1.5 border border-gray-700 rounded"
          >
            Open Epstein viewer →
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-900 text-white">
      {/* Left sidebar: dataset info + source picker + filters */}
      <aside className="w-72 shrink-0 border-r border-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-800">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-sm font-bold">Network Explorer</h1>
            {onSwitchMode && (
              <button
                onClick={onSwitchMode}
                className="text-[10px] text-gray-400 hover:text-white"
                title="Switch to original Epstein viewer"
              >
                Epstein →
              </button>
            )}
          </div>
          <div className="text-xs text-gray-400 truncate" title={sourceFileName}>
            📄 {sourceFileName}
          </div>
          <div className="text-[10px] text-gray-500 mt-1">
            {dataset.rows.length} rows · {dataset.fields.length} fields ·
            {' '}{visibleRows.length} after filters
            {kCore > 0 && ` · ${prunedRows.length} after k-core`}
          </div>
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={() => {
                setOptions(null);
                setSelectedOptionId(null);
                setMapping(null);
              }}
              className="text-[10px] text-blue-400 hover:text-blue-300"
            >
              ← Load a different file
            </button>
            {options.length > 1 && (
              <button
                onClick={() => setShowSourcePicker(s => !s)}
                className="text-[10px] text-blue-400 hover:text-blue-300"
              >
                {showSourcePicker ? 'Hide sources' : `Sources (${options.length})`}
              </button>
            )}
          </div>
        </div>

        {showSourcePicker && options.length > 1 && (
          <div className="p-3 border-b border-gray-800 bg-gray-950">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
              This file contains multiple arrays. Pick which to visualize:
            </div>
            <div className="space-y-1.5">
              {options.map(opt => {
                const isActive = opt.id === selectedOptionId;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setSelectedOptionId(opt.id)}
                    className={`w-full text-left p-2 rounded border text-xs transition-colors ${
                      isActive
                        ? 'bg-blue-900/40 border-blue-700'
                        : 'bg-gray-800/40 border-gray-700 hover:bg-gray-800'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`inline-block w-2 h-2 rounded-full ${isActive ? 'bg-blue-400' : 'bg-gray-600'}`} />
                      <span className="font-medium">{opt.label}</span>
                      {opt.recommended && (
                        <span className="text-[9px] uppercase tracking-wider text-emerald-400">default</span>
                      )}
                    </div>
                    <div className="text-[10px] text-gray-400 mt-0.5">{opt.description}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="overflow-y-auto p-3 flex-1 space-y-4">
          {/* Visual layout controls */}
          <div>
            <div className="flex items-center justify-between mb-3 border-b border-gray-700 pb-2">
              <h2 className="text-sm font-bold uppercase tracking-wider text-blue-400">Layout</h2>
              {spread !== 1.0 && (
                <button
                  onClick={() => setSpread(1.0)}
                  className="text-[10px] text-gray-400 hover:text-white"
                >
                  reset
                </button>
              )}
            </div>
            <div className={`rounded p-2 ${spread !== 1.0 ? 'bg-blue-950/30 border border-blue-900' : 'bg-gray-800/40'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-gray-300">Spread</span>
                <span className="text-[10px] text-gray-500">×{spread.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={0.3}
                max={16}
                step={0.1}
                value={spread}
                onChange={(e) => setSpread(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
              <div className="flex justify-between text-[9px] text-gray-500 mt-0.5">
                <span>compact</span>
                <span>spread out</span>
              </div>
            </div>
          </div>

          {/* Edge labels: auto (show below density cap) / on / off */}
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-blue-400 border-b border-gray-700 pb-2 mb-3">
              Edge labels
            </h2>
            <div className="flex rounded overflow-hidden border border-gray-700">
              {(['auto', 'on', 'off'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setEdgeLabelMode(mode)}
                  className={`flex-1 py-1 text-[11px] transition-colors ${
                    edgeLabelMode === mode
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* AA043: the Media base-URL control used to sit here. It is gone —
              the media roots are internal configuration in
              `src/lib/mediaConfig.ts`, not a viewer setting. */}

          {/* Handling: the reveal threshold and the warning-tag filter. Shown
              only for a DAGGER-shaped file, like the Media control above, so no
              other dataset's sidebar changes. */}
          {dagger && (
            <div>
              <div className="flex items-center justify-between mb-3 border-b border-gray-700 pb-2">
                <h2 className="text-sm font-bold uppercase tracking-wider text-blue-400">Handling</h2>
                {(revealThreshold > 0 || activeWarningTags.size > 0 || contentOverride !== null) && (
                  <button
                    onClick={() => { setRevealThreshold(0); setActiveWarningTags(new Set()); setContentOverride(null); }}
                    className="text-[10px] text-gray-400 hover:text-white"
                  >
                    reset
                  </button>
                )}
              </div>

              {/* The REVEAL THRESHOLD. Content whose sensitivity is at or below
                  it is shown; everything above it stays concealed until the
                  viewer reveals that one node. It is not a blur strength and it
                  is not the pipeline's `content_blur` — that is read, never
                  recomputed here. 0.00 is "only what is certainly safe". */}
              {/* AA048 — the slider DIMS while an override is in force. It is
                  still live, and touching it is how a viewer takes control back,
                  but it is not deciding anything right now and it should not
                  look as though it is. This, the banner below and the lit button
                  are the three places the state in force is legible. */}
              <div className={`rounded p-2 ${
                contentOverride !== null
                  ? 'bg-gray-800/40 opacity-60'
                  : revealThreshold > 0
                    ? 'bg-blue-950/30 border border-blue-900'
                    : 'bg-gray-800/40'
              }`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-gray-300">Reveal up to sensitivity</span>
                  <span className="text-[10px] text-gray-500">{revealThreshold.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={revealThreshold}
                  onChange={(e) => setThresholdFromSlider(Number(e.target.value))}
                  className="w-full accent-blue-500"
                />
                <div className="text-[10px] text-gray-500 mt-0.5">
                  {contentOverride !== null
                    ? 'not in force — move the slider to clear the override and hand control back to it'
                    : revealThreshold === 0
                      ? 'only content the pipeline scored 0.00 is shown; everything above it is concealed'
                      : `sensitivity ≤ ${revealThreshold.toFixed(2)} is shown; above it stays concealed`}
                </div>
              </div>

              {/* ── AA048: the two override buttons ────────────────────────────
                  Rusty: "Add a Hide All Content button and a Reveal all Content
                  Button. These will override the slider. But the slider with
                  auto unselect them upon movement."

                  They sit directly under the slider they override, because that
                  adjacency is half the explanation. Clicking the lit one turns
                  it off, so a viewer can leave an override the same way they
                  entered it without hunting for a reset. */}
              <div className="mt-2">
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => setContentOverride(prev => (prev === 'hide' ? null : 'hide'))}
                    aria-pressed={contentOverride === 'hide'}
                    title="Conceal every record, whatever its sensitivity. Moving the slider clears this."
                    className={`px-2 py-1.5 rounded text-[11px] font-semibold border transition-colors ${
                      contentOverride === 'hide'
                        ? 'bg-amber-700/70 border-amber-400 text-amber-50'
                        : 'bg-gray-800/60 border-gray-700 text-gray-300 hover:border-gray-500'
                    }`}
                  >
                    Hide All Content
                  </button>
                  <button
                    onClick={() => setContentOverride(prev => (prev === 'reveal' ? null : 'reveal'))}
                    aria-pressed={contentOverride === 'reveal'}
                    title="Show every record, whatever its sensitivity. Moving the slider clears this."
                    className={`px-2 py-1.5 rounded text-[11px] font-semibold border transition-colors ${
                      contentOverride === 'reveal'
                        ? 'bg-amber-700/70 border-amber-400 text-amber-50'
                        : 'bg-gray-800/60 border-gray-700 text-gray-300 hover:border-gray-500'
                    }`}
                  >
                    Reveal All Content
                  </button>
                </div>

                {/* One line that names the single state in force. It is always
                    present — the threshold is a state too, not the absence of
                    one — so "which of the three is driving this" is answered in
                    the same place whatever the answer is. */}
                <div className={`mt-1.5 rounded px-2 py-1 text-[10px] border ${
                  contentOverride !== null
                    ? 'bg-amber-950/50 border-amber-700/70 text-amber-200'
                    : 'bg-gray-800/40 border-gray-700 text-gray-400'
                }`}>
                  {contentOverride === 'hide'
                    ? 'In force: Hide All Content — every record is concealed, the slider is overridden'
                    : contentOverride === 'reveal'
                      ? 'In force: Reveal All Content — every record is shown, the slider is overridden'
                      : `In force: the reveal threshold (${revealThreshold.toFixed(2)}) — no override`}
                </div>
              </div>

              {/* Warning tags, straight from the loaded file. Selecting one or
                  more keeps only the triplets that carry them; with none
                  selected nothing is narrowed. Every chip is drawn the same way
                  — styling by meaning would hard-code a vocabulary that grows
                  upstream without this file. */}
              <div className="mt-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-gray-300">Warning tags</span>
                  <span className="text-[10px] text-gray-500">
                    {warningTagCounts.length === 0
                      ? 'none in this file'
                      : activeWarningTags.size === 0
                        ? `${warningTagCounts.length} in this file`
                        : `${activeWarningTags.size} of ${warningTagCounts.length} selected`}
                  </span>
                </div>
                {warningTagCounts.length === 0 ? (
                  <div className="text-[10px] text-gray-500">
                    no node in this file carries a warning tag
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {warningTagCounts.map(([tag, count]) => {
                      const on = activeWarningTags.has(tag);
                      return (
                        <button
                          key={tag}
                          onClick={() => toggleWarningTag(tag)}
                          title={`${count} node${count === 1 ? '' : 's'} carry “${tag}”`}
                          className={`px-1.5 py-0.5 rounded text-[10px] border ${
                            on
                              ? 'bg-amber-700/60 border-amber-500 text-amber-100'
                              : 'bg-amber-950/40 border-amber-900/70 text-amber-300 hover:border-amber-700'
                          }`}
                        >
                          {tag} <span className="text-amber-500/80">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {activeWarningTags.size > 0 && (
                  <div className="text-[10px] text-blue-300 mt-1">
                    showing only triplets carrying a selected tag and the branches above them · {filteredRows.length - visibleRows.length} edges hidden
                  </div>
                )}
              </div>
            </div>
          )}

          {/* AA046: the modality filter. Its own section rather than a third
              control under Handling — a modality is what a triplet IS, not how
              it must be handled. Shown only for a DAGGER-shaped file. */}
          {dagger && (
            <div>
              <div className="flex items-center justify-between mb-3 border-b border-gray-700 pb-2">
                <h2 className="text-sm font-bold uppercase tracking-wider text-blue-400">Modality</h2>
                {activeModalities.size > 0 && (
                  <button
                    onClick={() => setActiveModalities(new Set())}
                    className="text-[10px] text-gray-400 hover:text-white"
                  >
                    reset
                  </button>
                )}
              </div>

              {/* The values come from the loaded file, never from a list in this
                  component: the pipeline owns the vocabulary. Selecting one or
                  more keeps only the triplets of those modalities and the
                  branches above them; with none selected nothing is narrowed. */}
              <div className={`rounded p-2 ${activeModalities.size > 0 ? 'bg-blue-950/30 border border-blue-900' : 'bg-gray-800/40'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold text-gray-300">Triplet modality</span>
                  <span className="text-[10px] text-gray-500">
                    {modalityCounts.length === 0
                      ? 'none in this file'
                      : activeModalities.size === 0
                        ? `${modalityCounts.length} in this file`
                        : `${activeModalities.size} of ${modalityCounts.length} selected`}
                  </span>
                </div>
                {modalityCounts.length === 0 ? (
                  <div className="text-[10px] text-gray-500">
                    no triplet in this file states a modality
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {modalityCounts.map(([modality, count]) => {
                      const on = activeModalities.has(modality);
                      return (
                        <button
                          key={modality}
                          onClick={() => toggleModality(modality)}
                          title={`${count} triplet${count === 1 ? '' : 's'} carry “${modality}”`}
                          className={`px-1.5 py-0.5 rounded text-[10px] border ${
                            on
                              ? 'bg-violet-700/60 border-violet-500 text-violet-100'
                              : 'bg-violet-950/40 border-violet-900/70 text-violet-300 hover:border-violet-700'
                          }`}
                        >
                          {modality} <span className="text-violet-400/80">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                {activeModalities.size > 0 && (
                  <div className="text-[10px] text-blue-300 mt-1">
                    showing only triplets of a selected modality and the branches above them
                    {activeWarningTags.size > 0 && ', intersected with the warning tags'}
                    {' '}· {filteredRows.length - visibleRows.length} edges hidden in total
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Timeline: fade nodes in/out by event date (needs companion node data) */}
          {timeRange.hasDates && (
            <div>
              <div className="flex items-center justify-between mb-3 border-b border-gray-700 pb-2">
                <h2 className="text-sm font-bold uppercase tracking-wider text-blue-400">Timeline</h2>
                {timeCursor !== null && (
                  <button
                    onClick={disableTimeline}
                    className="text-[10px] text-gray-400 hover:text-white"
                  >
                    reset
                  </button>
                )}
              </div>
              <div className={`rounded p-2 ${timeCursor !== null ? 'bg-blue-950/30 border border-blue-900' : 'bg-gray-800/40'}`}>
                {timeCursor === null ? (
                  <button
                    onClick={enableTimeline}
                    className="w-full text-xs py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white font-medium"
                  >
                    ▶ Enable timeline
                  </button>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold text-gray-300">{formatCursor(timeCursor)}</span>
                      <button
                        onClick={() => setPlaying(p => !p)}
                        className="text-[10px] px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-white"
                      >
                        {playing ? '❚❚ pause' : '▶ play'}
                      </button>
                    </div>
                    <input
                      type="range"
                      min={timeRange.min}
                      max={timeRange.max}
                      step={Math.max(MS_PER_MINUTE, Math.min(MS_PER_DAY, fadeWindowMs / 20))}
                      value={timeCursor}
                      onChange={(e) => { setPlaying(false); setTimeCursor(Number(e.target.value)); }}
                      className="w-full accent-blue-500"
                    />
                    <div className="flex justify-between text-[9px] text-gray-500 mt-0.5">
                      <span>{formatCursor(timeRange.min)}</span>
                      <span>{formatCursor(timeRange.max)}</span>
                    </div>

                    {/* Persistence window: how long a node stays before it disappears */}
                    <div className="mt-3 pt-2 border-t border-gray-700/60">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 mb-1">
                        Disappears after
                      </div>
                      <div className="grid grid-cols-5 gap-1">
                        {([
                          ['years', 'y'],
                          ['months', 'mo'],
                          ['days', 'd'],
                          ['hours', 'h'],
                          ['minutes', 'm'],
                        ] as [keyof FadeDuration, string][]).map(([key, label]) => (
                          <label key={key} className="flex flex-col items-center">
                            <input
                              type="number"
                              min={0}
                              value={fadeDuration[key]}
                              onChange={(e) => setFadePart(key, Number(e.target.value))}
                              className="w-full text-center text-[11px] px-0.5 py-1 rounded bg-gray-900 border border-gray-700 text-gray-200 focus:border-blue-500 focus:outline-none"
                            />
                            <span className="text-[9px] text-gray-500 mt-0.5">{label}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div className="text-[10px] text-gray-500 mt-2">
                      nodes appear on their event date, stay for the window above, fade out, then their edges drop
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Topology filter: K-core decomposition */}
          <div>
            <div className="flex items-center justify-between mb-3 border-b border-gray-700 pb-2">
              <h2 className="text-sm font-bold uppercase tracking-wider text-blue-400">Topology</h2>
              {kCore > 0 && (
                <button
                  onClick={() => setKCore(0)}
                  className="text-[10px] text-gray-400 hover:text-white"
                >
                  reset
                </button>
              )}
            </div>
            <div className={`rounded p-2 ${kCore > 0 ? 'bg-blue-950/30 border border-blue-900' : 'bg-gray-800/40'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-gray-300">Min node degree (k-core)</span>
                <span className="text-[10px] text-gray-500">k = {kCore}</span>
              </div>
              <input
                type="range"
                min={0}
                max={5}
                step={1}
                value={kCore}
                onChange={(e) => setKCore(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
              <div className="text-[10px] text-gray-500 mt-0.5">
                {kCore === 0
                  ? 'no topology filter'
                  : `iteratively drops nodes with degree < ${kCore}`}
              </div>
              {kCore > 0 && (
                <div className="text-[10px] text-blue-300 mt-1">
                  {visibleRows.length - prunedRows.length} edges pruned
                </div>
              )}
            </div>
          </div>

          {/* Per-field filters */}
          <FilterPanel
            fields={dataset.fields}
            rows={dataset.rows}
            filters={filters}
            onChange={setFilters}
          />
        </div>
      </aside>

      {/* Center: graph */}
      <main className="flex-1 relative min-w-0">
        <DirectedGraph
          rows={prunedRows}
          fields={dataset.fields}
          mapping={mapping}
          selectedNode={selectedNode}
          onNodeClick={setSelectedNode}
          highlightedNodes={highlightedNodes}
          highlightedEdgeKeys={highlightedEdgeKeys}
          nodeOpacity={nodeOpacity}
          nodeLabels={nodeLabels}
          nodeKinds={nodeKinds}
          litNodes={litNodes}
          spread={spread}
          edgeLabelMode={edgeLabelMode}
        />
      </main>

      {/* Right sidebar: visual mapping + selection details */}
      <aside className="w-80 shrink-0 border-l border-gray-800 flex flex-col">
        <div className="border-b border-gray-800">
          <button
            onClick={() => setShowMapper(s => !s)}
            className="w-full text-left p-3 flex items-center justify-between hover:bg-gray-800/50"
          >
            <span className="text-sm font-bold uppercase tracking-wider text-blue-400">Mapping</span>
            <span className="text-gray-500">{showMapper ? '−' : '+'}</span>
          </button>
          {showMapper && (
            <div className="p-3 pt-0">
              <FieldMapper fields={dataset.fields} mapping={mapping} onChange={setMapping} />
            </div>
          )}
        </div>

        {selectedNode && (
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold truncate" title={selectedNode}>{selectedNode}</h2>
              <button
                onClick={() => setSelectedNode(null)}
                className="text-gray-500 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            {/* Rich node detail (all_info) from the companion node table */}
            {(() => {
              const rec = nodeData?.get(selectedNode);
              if (!rec) return null;
              const allInfo = rec.all_info ?? rec.info;
              const label = rec.label;
              const category = rec.category;
              return (
                <div className="rounded bg-gray-800/40 border border-gray-700 overflow-hidden">
                  {(label != null || category != null) && (
                    <div className="px-2 py-1.5 border-b border-gray-700 flex items-center gap-2">
                      {label != null && (
                        <span className="text-xs font-semibold text-gray-200 truncate">{String(label)}</span>
                      )}
                      {category != null && (
                        <span className="text-[9px] uppercase tracking-wider text-emerald-400">{String(category)}</span>
                      )}
                    </div>
                  )}
                  {typeof allInfo === 'string' && allInfo.trim() ? (
                    <div
                      className="node-all-info p-2 text-xs text-gray-300 max-h-[40vh] overflow-y-auto"
                      // all_info is pre-formatted HTML produced by the pipeline
                      // (bold/colored spans, lists, <img> thumbnails). It comes
                      // from the user's own data file, not a remote source.
                      dangerouslySetInnerHTML={{ __html: String(allInfo) }}
                    />
                  ) : (
                    <div className="p-2 text-[10px] text-gray-500">No additional info for this node.</div>
                  )}
                </div>
              );
            })()}

            {/* Media carried by this node. Read from the DAGGER index, never
                from `dataset.rows`: the generic loader flattens rows, which
                turns the media array into dotted strings and silently drops a
                second entry. Renders nothing when the node has no media, so
                cluster and category nodes are unaffected. */}
            {/* The `key` is what keeps a reveal PER NODE: selecting a different
                node remounts this component, so its reveal state starts closed
                again and cannot leak from one record to the next. `handling` is
                the pipeline's block untouched — `content_blur` is read there,
                never recomputed here.

                AA048 puts the override in the key as well, which is how "Hide
                All must not be defeated by a per-node reveal left over from
                before it was pressed" is satisfied even AFTER Hide All is
                cleared: crossing into or out of an override remounts the card
                and the per-node reveal starts closed. Reusing the remount that
                already exists beats a second mechanism that has to be kept in
                step with it. The cost is honest and small — the media element is
                re-created, so an override toggle re-requests the file (one
                cached request, on the one node that is open). */}
            {dagger && (
              <NodeMedia
                key={`${selectedNode}::${contentOverride ?? 'threshold'}`}
                media={daggerNodeMedia(dagger.nodesById.get(selectedNode))}
                baseUrls={MEDIA_BASE_URLS}
                handling={daggerNodeHandling(dagger.nodesById.get(selectedNode))}
                warningTags={daggerWarningTags(dagger.nodesById.get(selectedNode))}
                revealThreshold={revealThreshold}
                contentOverride={contentOverride}
              />
            )}

            {/* Chain controls */}
            <div className={`rounded p-2 ${chainDepth > 0 ? 'bg-blue-950/30 border border-blue-900' : 'bg-gray-800/40'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-gray-300">Chain depth</span>
                <span className="text-[10px] text-gray-500">{chainDepth === 0 ? 'off' : `${chainDepth} hop${chainDepth === 1 ? '' : 's'}`}</span>
              </div>
              <input
                type="range"
                min={0}
                max={5}
                step={1}
                value={chainDepth}
                onChange={(e) => setChainDepth(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
              {chainDepth > 0 && (
                <div className="mt-2 flex items-center gap-1 text-[10px]">
                  <span className="text-gray-500 mr-1">direction</span>
                  <button
                    onClick={() => setChainDirection('downstream')}
                    className={`px-2 py-0.5 rounded ${chainDirection === 'downstream' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}
                  >
                    downstream →
                  </button>
                  <button
                    onClick={() => setChainDirection('upstream')}
                    className={`px-2 py-0.5 rounded ${chainDirection === 'upstream' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}
                  >
                    ← upstream
                  </button>
                </div>
              )}
            </div>

            {/* Chain browser OR flat relationships list */}
            {chainDepth > 0 ? (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] uppercase tracking-wider text-gray-400">
                    {chains.length === 0
                      ? 'no chains found'
                      : `${chains.length} chain${chains.length === 1 ? '' : 's'}${chains.length >= CHAIN_MAX_PATHS ? '+' : ''}`}
                  </div>
                  {selectedChainIndex !== null && (
                    <button
                      onClick={() => setSelectedChainIndex(null)}
                      className="text-[10px] text-blue-400 hover:text-blue-300"
                    >
                      show all
                    </button>
                  )}
                </div>
                {chains.length > 0 && selectedChainIndex !== null && (
                  <div className="flex items-center gap-1 mb-2">
                    <button
                      onClick={() => setSelectedChainIndex(Math.max(0, selectedChainIndex - 1))}
                      disabled={selectedChainIndex === 0}
                      className="px-2 py-0.5 text-[10px] bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700"
                    >
                      ← prev
                    </button>
                    <button
                      onClick={() => setSelectedChainIndex(Math.min(chains.length - 1, selectedChainIndex + 1))}
                      disabled={selectedChainIndex >= chains.length - 1}
                      className="px-2 py-0.5 text-[10px] bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700"
                    >
                      next →
                    </button>
                    <span className="text-[10px] text-gray-500 ml-1">
                      {selectedChainIndex + 1} / {chains.length}
                    </span>
                  </div>
                )}
                <div className="space-y-1">
                  {chains.slice(0, 200).map((chain, i) => {
                    const isActive = i === selectedChainIndex;
                    const arrow = chainDirection === 'downstream' ? '→' : '←';
                    return (
                      <button
                        key={i}
                        onClick={() => setSelectedChainIndex(isActive ? null : i)}
                        className={`w-full text-left text-xs rounded p-2 transition-colors ${
                          isActive ? 'bg-blue-900/40 border border-blue-700' : 'bg-gray-800/50 hover:bg-gray-800'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="text-[9px] uppercase tracking-wider text-gray-500">
                            {chain.length - 1} hop{chain.length - 1 === 1 ? '' : 's'}
                          </span>
                          {isActive && <span className="text-[9px] text-cyan-400">active</span>}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                          {chain.map((n, j) => (
                            <span key={j} className="flex items-center gap-1">
                              <span className={`truncate ${n === selectedNode ? 'text-cyan-300 font-semibold' : 'text-gray-200'}`}>
                                {n}
                              </span>
                              {j < chain.length - 1 && (
                                <span className="text-gray-500">{arrow}</span>
                              )}
                            </span>
                          ))}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div>
                <div className="text-[10px] text-gray-500 mb-2">
                  {selectionRows.length} direct relationship{selectionRows.length === 1 ? '' : 's'}
                </div>
                <div className="space-y-1.5">
                  {selectionRows.slice(0, 100).map((r, i) => {
                    const s = String(r[mapping.sourceField]);
                    const t = String(r[mapping.targetField]);
                    const isOut = s === selectedNode;
                    const other = isOut ? t : s;
                    const label = mapping.edgeLabelField ? String(r[mapping.edgeLabelField] ?? '') : '';
                    return (
                      <div key={i} className="text-xs bg-gray-800/50 rounded p-2">
                        <div className="flex items-center gap-1.5">
                          <span className={isOut ? 'text-blue-400' : 'text-emerald-400'}>
                            {isOut ? '→' : '←'}
                          </span>
                          <span
                            className="font-medium cursor-pointer hover:underline truncate"
                            onClick={() => setSelectedNode(other)}
                          >
                            {other}
                          </span>
                        </div>
                        {label && <div className="text-gray-400 mt-0.5">{label}</div>}
                      </div>
                    );
                  })}
                  {selectionRows.length > 100 && (
                    <div className="text-[10px] text-gray-500 text-center pt-1">
                      …{selectionRows.length - 100} more
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
