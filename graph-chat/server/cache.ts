/**
 * The near-duplicate question cache.
 *
 * "On the backend it will store the question so that if someone else asks
 * close to it, its an easy pull."
 *
 * SOMEONE ELSE is the load-bearing word, and it is what decides everything
 * here: the store is one file on the service, not one per browser, so a
 * question answered for the first viewer is available to the second. Nothing
 * in this module reads or writes browser storage, and there is no per-session
 * key anywhere in the scope.
 *
 * SCOPE
 *
 * A hit must be against the SAME loaded graph. The same question asked of a
 * different file is a different question: "how many deaths" over the Ukraine
 * corpus and over the hurricane corpus share every word and no evidence. The
 * scope is `graphKey` and it is applied in the SQL, not after it, so a graph's
 * answers are never even scored against another's.
 *
 * LABELLING
 *
 * A cached answer is always returned as one, carrying the question that was
 * actually asked, when it was asked and how close the match was. Nothing in
 * this service can hand back a stored answer that reads as fresh.
 */

import type { AnswerStore, CandidateRow } from './store.js';
import type { CacheMatch, StoredAnswer } from './types.js';
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  SIMILARITY_METHOD,
  signatureOf,
  similarity,
  type QuestionSignature,
} from './similarity.js';

export interface CacheLookupOptions {
  threshold?: number;
  /** How many stored questions to score. Newest first. */
  maxCandidates?: number;
}

export interface CacheLookup {
  match: CacheMatch;
  /** The stored answer when `match.hit` is true. */
  answer: StoredAnswer | null;
}

function missed(candidatesConsidered: number, threshold: number): CacheMatch {
  return {
    hit: false,
    answerId: null,
    originalQuestion: null,
    originalAskedAt: null,
    similarity: 0,
    threshold,
    method: SIMILARITY_METHOD,
    candidatesConsidered,
  };
}

/** Rebuild a stored question's signature from the columns the store keeps. */
function signatureOfRow(row: CandidateRow): QuestionSignature {
  const tokens = row.questionContent === '' ? [] : row.questionContent.split(' ');
  return {
    tokens,
    content: row.questionContent,
    normalised: row.questionNormalised,
  };
}

/**
 * Look for a near-duplicate of `question` among the answers already stored
 * for `graphKey`.
 *
 * Returns a miss rather than throwing if anything goes wrong reading the
 * store: a cache that cannot be read costs a model call, and that is the
 * cheaper failure. The caller is told through a note.
 */
export function lookup(
  store: AnswerStore,
  graphKey: string,
  question: string,
  options: CacheLookupOptions = {},
): CacheLookup {
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const rows = store.candidates(graphKey, options.maxCandidates ?? 500);
  if (rows.length === 0) return { match: missed(0, threshold), answer: null };

  const query = signatureOf(question);
  let bestRow: CandidateRow | null = null;
  let bestScore = 0;

  for (const row of rows) {
    const score = similarity(query, signatureOfRow(row));
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }

  if (bestRow === null || bestScore < threshold) {
    return { match: missed(rows.length, threshold), answer: null };
  }

  const stored = store.get(bestRow.answerId);
  if (stored === null) {
    // The row was listed and then could not be read. Treat it as a miss.
    return { match: missed(rows.length, threshold), answer: null };
  }

  return {
    answer: stored,
    match: {
      hit: true,
      answerId: bestRow.answerId,
      originalQuestion: bestRow.question,
      originalAskedAt: bestRow.askedAt,
      similarity: bestScore,
      threshold,
      method: SIMILARITY_METHOD,
      candidatesConsidered: rows.length,
    },
  };
}

/**
 * One sentence a view can print above a cached answer. The view is free to
 * lay it out differently, but it may not drop it: an unlabelled cached answer
 * reads as a fresh one.
 */
export function cacheLabel(match: CacheMatch): string | null {
  if (!match.hit || match.originalQuestion === null) return null;
  const when = match.originalAskedAt === null ? 'earlier' : 'on ' + match.originalAskedAt;
  return (
    'Answer reused from an earlier question. It was asked ' + when +
    ' as: "' + match.originalQuestion + '". Match ' +
    match.similarity.toFixed(2) + ' against a threshold of ' +
    match.threshold.toFixed(2) + '.'
  );
}
