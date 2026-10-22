/**
 * The engine, run in the browser.
 *
 * The engine is dependency-free TypeScript with no DOM, no network and no node
 * builtin, so the same build runs here and in the service. Nothing in this file
 * re-implements any part of it: the ingest, the matcher, the aggregation and
 * the display cap all stay where they are, and this module only decides WHEN to
 * build the index and WHICH of the two query classes a question belongs to.
 *
 * WHEN. The index costs roughly 1.7 s and 70 MB at the production corpus size
 * the engine seat measured, which is a visible stall on the main thread. The
 * graph is already drawn by the time anyone presses "Ask about this graph", so
 * the index is built on that press and never during the Visualizer's own load,
 * and `loadGraph` hands back real `loadMs` numbers so the view can show a
 * measured figure instead of a spinner that claims nothing. A Web Worker is the
 * next step if that is still too slow; it is NOT built here — see the handover.
 */

import { loadGraph, toDisplayPage } from '../../../../graph-chat/engine/index.ts';
import { graphKeyOf } from '../../../../graph-chat/server/graphkey.ts';
import type { GraphChatEngine } from '../../../../graph-chat/engine/index.ts';
import type {
  AggregateResult,
  DisplayPage,
  NormalisedTriplet,
  QueryKind,
  RawGraph,
  ResultEnvelope,
  RetrievalHit,
  RetrievalResult,
} from '../../../../graph-chat/engine/types.ts';
import type { DaggerIndex } from '../../types';

export type {
  AggregateResult,
  DisplayPage,
  NormalisedTriplet,
  QueryKind,
  ResultEnvelope,
  RetrievalHit,
  RetrievalResult,
};

export interface LoadedEngine {
  engine: GraphChatEngine;
  /** Derived from CONTENT, not from a filename. Two viewers who load the same
   *  file get the same key, which is what makes the service cache shared. */
  graphKey: string;
  ingestMs: number;
  indexMs: number;
  totalMs: number;
  tripletCount: number;
}

/**
 * The parsed file, handed to the engine with no conversion and no second parse.
 *
 * `DaggerIndex` is what the Visualizer already holds for the loaded graph, and
 * a `DaggerNode` IS a `RawNode` and a `DaggerEdge` IS a `RawEdge` structurally —
 * that is the engine seat's first design decision and it is why nothing is
 * reshaped here. The node map is the file's nodes keyed by id, so the values of
 * that map are the node array.
 */
export function rawGraphFromDaggerIndex(index: DaggerIndex): RawGraph {
  return { nodes: Array.from(index.nodesById.values()), edges: index.edges };
}

export function buildEngine(graph: RawGraph): LoadedEngine {
  const engine = loadGraph(graph);
  const graphKey = graphKeyOf({
    shape: engine.shape,
    tripletIds: engine.corpus.triplets.map(t => t.triplet_id),
    messageKeyAvailable: engine.corpus.messageKeyAvailable,
  });
  return {
    engine,
    graphKey,
    ingestMs: engine.loadMs.ingestMs,
    indexMs: engine.loadMs.indexMs,
    totalMs: engine.loadMs.totalMs,
    tripletCount: engine.corpus.triplets.length,
  };
}

/**
 * Which of the two question classes this is.
 *
 * THIS IS A VIEW-LAYER DECISION AND THE CONTRACT DID NOT MAKE IT. The engine
 * exposes `aggregate()` and `retrieve()` as two entry points and sets
 * `QueryDescriptor.kind` from whichever one was called; nothing upstream
 * classifies a sentence. Something has to, or the ask box cannot work, so the
 * rule is here, in one place, written out rather than buried in a condition —
 * and the class it chose is printed on the answer card as a chip, so a wrong
 * call is visible on screen rather than silent. It is listed in the handover as
 * a decision to overrule.
 *
 * A counting question asks HOW MANY. Everything else is a request for rows.
 */
export const AGGREGATE_OPENERS: readonly string[] = [
  'how many',
  'how much',
  'how often',
  'count of',
  'number of',
  'total number',
  'what number',
  'how many times',
];

export const AGGREGATE_WORDS: readonly string[] = ['count', 'counts', 'tally', 'statistics'];

export function classifyQuestion(question: string): QueryKind {
  const q = question.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const opener of AGGREGATE_OPENERS) {
    if (q.includes(opener)) return 'aggregate';
  }
  const words = q.split(/[^a-z]+/);
  for (const w of AGGREGATE_WORDS) {
    if (words.includes(w)) return 'aggregate';
  }
  return 'retrieval';
}

/**
 * Run a question. No `terms` are supplied to the aggregate path on purpose: the
 * engine derives them from the question, and a term list invented here would be
 * a second matcher competing with the one that was measured.
 */
export function runAggregate(engine: GraphChatEngine, question: string): AggregateResult {
  return engine.aggregate(question);
}

export function runRetrieval(engine: GraphChatEngine, question: string): RetrievalResult {
  return engine.retrieve(question);
}

/**
 * The display cap, applied at the edge and nowhere else. `envelope.items` still
 * holds the whole set; every count, every chart and every export is computed
 * from that and never from the page.
 */
export function pageOf<TItem>(envelope: ResultEnvelope<TItem>, offset: number): DisplayPage<TItem> {
  return toDisplayPage(envelope, undefined, offset);
}
