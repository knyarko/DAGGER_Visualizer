// graph-chat/engine/index.ts
//
// THE PUBLIC SURFACE. Everything outside this folder imports from here and
// from nowhere deeper, so the internals can move without a caller changing.
//
// No framework, no DOM, no network, no model call. The same build runs inside
// a browser bundle and inside a node service.

export * from './types.js';
export { detectShape, ingestGraph, messageKeyOf, type IngestOptions } from './ingest.js';
export {
  LexicalIndex, DEFAULT_FIELD_WEIGHTS, INDEXED_FIELDS, fieldText, hasPhrase,
  type IndexOptions, type IndexStats, type TermHit,
} from './lexindex.js';
export { applyFilters, countFacets, facetValuesOf, nodeCountOf, messageCountOf, type FilterOutcome } from './filter.js';
export { retrieve, RETRIEVAL_MATCHER, type RetrievalOptions } from './retrieve.js';
export { aggregate, AGGREGATE_MATCHER, dedupeFigures, groupByMessage, type AggregateOptions } from './aggregate.js';
export { makeEnvelope, toDisplayPage, buildCaption, type EnvelopeInput } from './result.js';
export {
  normaliseText, tokenize, tokenizeRaw, stem, trigrams, trigramSimilarity,
  splitClauses, extractFigures, buildSnippet, fnv1a32, isStopWord,
} from './text.js';

import type {
  AggregateResult, NormalisedCorpus, RawGraph, RetrievalResult, ShapeReport,
} from './types.js';
import { ingestGraph, type IngestOptions } from './ingest.js';
import { LexicalIndex, type IndexOptions } from './lexindex.js';
import { retrieve, type RetrievalOptions } from './retrieve.js';
import { aggregate, type AggregateOptions } from './aggregate.js';

/**
 * A loaded corpus with its index, ready to answer questions.
 *
 * Built ONCE per loaded file. The index is the expensive part and it is
 * deliberately not hidden inside the query functions, because a question asked
 * per keystroke must not rebuild it.
 */
export interface GraphChatEngine {
  corpus: NormalisedCorpus;
  index: LexicalIndex;
  shape: ShapeReport;
  /** Milliseconds spent ingesting and indexing. Measured here, not estimated,
   *  so a caller can put a real number on screen or in a log. */
  loadMs: { ingestMs: number; indexMs: number; totalMs: number };
  /** The counting path. Returns a counted evidence set and never a sum. */
  aggregate(question: string, options?: AggregateOptions): AggregateResult;
  /** The retrieval path. Returns the triplets themselves with their media. */
  retrieve(question: string, options?: RetrievalOptions): RetrievalResult;
}

export interface LoadOptions {
  ingest?: IngestOptions;
  index?: IndexOptions;
}

/**
 * Load a parsed `{ nodes, edges }` graph of either shape.
 *
 * The argument is ALREADY-PARSED JSON, never a path and never a URL. That is
 * what lets one implementation serve a browser file picker and a service
 * reading from disk, and it is why this module needs no file system and no
 * network.
 */
export function loadGraph(graph: RawGraph, options: LoadOptions = {}): GraphChatEngine {
  const t0 = Date.now();
  const corpus = ingestGraph(graph, options.ingest);
  const t1 = Date.now();
  const index = LexicalIndex.build(corpus.triplets, options.index);
  const t2 = Date.now();

  return {
    corpus,
    index,
    shape: corpus.shape,
    loadMs: { ingestMs: t1 - t0, indexMs: t2 - t1, totalMs: t2 - t0 },
    aggregate(question, opts) { return aggregate(corpus, index, question, opts); },
    retrieve(question, opts) { return retrieve(corpus, index, question, opts); },
  };
}
