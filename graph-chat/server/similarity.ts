/**
 * The near-duplicate question test.
 *
 * "On the backend it will store the question so that if someone else asks
 * close to it, its an easy pull." This module decides what "close to it"
 * means, and `bench/cache-bench.ts` measures the threshold rather than
 * asserting it.
 *
 * THE SHAPE OF THE TEST
 *
 * Two signals over the question's CONTENT tokens - the engine's own
 * `tokenize`, so stop words are gone and the rest is stemmed, which means the
 * boilerplate every question shares ("how many", "give me all the", "can you
 * tell me") cannot carry similarity on its own:
 *
 *   jaccard  - do the two questions talk about the same things at all
 *   trigram  - character overlap of the content stream, which rescues a typo
 *              and a morphology the stemmer does not reach
 *
 * Trigram is taken over the STEMMED CONTENT, never the raw question. Over the
 * raw question, "how many deaths occurred during Hurricane Harvey" and "how
 * many deaths occurred during the wildfires" score high on shared boilerplate
 * alone, which is the exact false hit this cache must not produce.
 *
 * WHY THE THRESHOLD IS SET FOR PRECISION, NOT RECALL
 *
 * The two errors do not cost the same. A miss costs one model call. A false
 * hit shows an answer built from a DIFFERENT question's evidence - and
 * although it is always labelled with the question it actually answers, it is
 * still an answer to something nobody asked. So the threshold is chosen at the
 * point where the labelled pair set has zero false hits, and the recall that
 * buys is reported as what it is rather than rounded up.
 */

import { tokenize, trigramSimilarity, normaliseText } from '../engine/text.js';
import type { SimilarityMethod } from './types.js';

export const SIMILARITY_METHOD: SimilarityMethod = 'stemmed-jaccard+trigram';

/**
 * Measured, not chosen. `bench/cache-bench.ts` sweeps a hand-labelled set of
 * 12 should-hit and 12 must-miss question pairs:
 *
 *   threshold 0.72 -> recall 0.917, precision 0.917, ONE false hit
 *   threshold 0.76 -> recall 0.750, precision 1.000, zero false hits
 *
 * The false hit at 0.72 is the pair that decided this value:
 * "how many deaths occurred during Hurricane Harvey" against
 * "how many injuries occurred during Hurricane Harvey" scores 0.749. Those
 * are different questions about the same event and reusing one answer for
 * the other would be wrong. The two classes are NOT linearly separable on
 * this set - the lowest should-hit pair scores 0.615, below that false hit -
 * so no threshold gets both, and this one is set where the wrong answers
 * stop rather than where the right ones peak.
 *
 * What that costs: three plural/singular pairs below it, all of the shape
 * "earthquake" / "earthquakes", which the stemmer does not collapse. They
 * are a cache miss and one extra model call, which is the cheap error.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.76;

export const JACCARD_WEIGHT = 0.6;
export const TRIGRAM_WEIGHT = 0.4;

export interface QuestionSignature {
  /** Stemmed content tokens, de-duplicated, sorted. */
  tokens: string[];
  /** The same tokens joined - what the trigram pass compares. */
  content: string;
  /** Normalised whole question, for the exact-match shortcut. */
  normalised: string;
}

export function signatureOf(question: string): QuestionSignature {
  const tokens = Array.from(new Set(tokenize(question))).sort();
  return {
    tokens,
    content: tokens.join(' '),
    normalised: normaliseText(question),
  };
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const B = new Set(b);
  let shared = 0;
  for (const t of a) if (B.has(t)) shared += 1;
  const union = a.length + b.length - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Similarity in [0, 1]. Symmetric. Identical normalised questions score
 * exactly 1 whether or not they carry any content token at all, which is what
 * makes a question of pure stop words ("what about it?") still cache against
 * itself and never against anything else.
 */
export function similarity(a: QuestionSignature, b: QuestionSignature): number {
  if (a.normalised === b.normalised) return 1;
  if (a.tokens.length === 0 || b.tokens.length === 0) {
    // No content either side: the only honest answer is the character test,
    // and it is not allowed to reach the threshold on boilerplate alone.
    return trigramSimilarity(a.normalised, b.normalised) * TRIGRAM_WEIGHT;
  }
  const j = jaccard(a.tokens, b.tokens);
  const t = trigramSimilarity(a.content, b.content);
  return JACCARD_WEIGHT * j + TRIGRAM_WEIGHT * t;
}

export function similarityOfQuestions(a: string, b: string): number {
  return similarity(signatureOf(a), signatureOf(b));
}

export interface ScoredCandidate<T> {
  candidate: T;
  score: number;
}

/**
 * Best match above the threshold, or null. Ties break toward the FIRST
 * candidate at that score, so a caller that supplies candidates newest-first
 * gets the newest of equally-good answers.
 */
export function bestMatch<T>(
  query: QuestionSignature,
  candidates: ReadonlyArray<{ item: T; signature: QuestionSignature }>,
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
): ScoredCandidate<T> | null {
  let best: ScoredCandidate<T> | null = null;
  for (const c of candidates) {
    const score = similarity(query, c.signature);
    if (score < threshold) continue;
    if (best === null || score > best.score) best = { candidate: c.item, score };
  }
  return best;
}
