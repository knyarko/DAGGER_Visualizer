// graph-chat/engine/lexindex.ts
//
// THE MATCHER. A field-weighted BM25 inverted index with query-time fuzzy
// expansion, over the normalised triplets.
//
// ── WHY LEXICAL AND NOT EMBEDDINGS ──────────────────────────────────────────
//   The question this has to answer is "give me all the triplets that have
//   burning buildings or collapsed buildings". Those are the corpus's own
//   words — `burning`, `collapsed`, `building` are what a describer writes
//   into a media description and what a triple's object says. Token overlap
//   with light stemming answers it directly, and the index that does so is
//   built from nothing but the file already in memory.
//
//   An embedding index would additionally reach `ablaze` and `engulfed`. It
//   would also need a model to embed the QUERY, every time a question is
//   asked. The product's own constraint is that retrieval does not reach the
//   internet, and an index that cannot answer without a model call is a
//   dependency on whatever runs that model being up. So the cheap machine is
//   the one built here, and the expensive one is left as a hook the service
//   can plug a LOCAL embedder into (`SemanticBooster` in `types.ts`) if the
//   recall turns out to matter. The measurement behind that choice is in the
//   bench harness beside this file.
//
// ── NO TRIGRAM INDEX, ON PURPOSE ────────────────────────────────────────────
//   Typo tolerance is done by scanning the vocabulary at QUERY time, filtered
//   by length and first letter before any similarity is computed. A stored
//   trigram index would multiply the index's memory for a feature used on a
//   handful of terms per question.

import type { NormalisedTriplet, TripletTextField } from './types.js';
import { stem, tokenize, tokenizeRaw, trigramSimilarity } from './text.js';

/** The fields that are indexed, in mask-bit order. */
export const INDEXED_FIELDS: TripletTextField[] = [
  'subject', 'predicate', 'object', 'label', 'msg_text',
  'justification', 'media.description', 'attributes', 'event_name',
];

/**
 * How much each field is worth.
 *
 * `media.description` is weighted level with the triple's own parts and ABOVE
 * `msg_text`, because a describer's reading of a picture is where "burning
 * building" is actually written; the message that carried the picture often
 * says something else entirely. `label` is down-weighted because it is
 * subject+predicate+object concatenated and would otherwise count them twice.
 */
export const DEFAULT_FIELD_WEIGHTS: Record<TripletTextField, number> = {
  subject: 3,
  predicate: 2,
  object: 3,
  label: 0.5,
  msg_text: 1.5,
  justification: 1,
  'media.description': 3,
  attributes: 0.5,
  event_name: 1,
};

export interface IndexOptions {
  fieldWeights?: Partial<Record<TripletTextField, number>>;
  /** BM25 term-frequency saturation. */
  k1?: number;
  /** BM25 length normalisation. 0 = off, 1 = full. */
  b?: number;
  /** Minimum trigram similarity for a query term to be rescued onto a
   *  vocabulary term it did not match exactly. 1 disables fuzzy matching. */
  fuzzyThreshold?: number;
}

export interface IndexStats {
  docCount: number;
  /** Distinct terms in the vocabulary. */
  termCount: number;
  /** Total (term, document) pairs stored. The real size driver. */
  postingCount: number;
  avgDocLength: number;
  /** Wall-clock milliseconds the build took. Measured by the build itself. */
  buildMs: number;
}

export interface TermHit {
  /** Position in the `triplets` array the index was built over. */
  doc: number;
  score: number;
  /** Bitmask over `INDEXED_FIELDS` of where this document matched. */
  fieldMask: number;
  /** The vocabulary terms that matched, which may differ from the query terms
   *  when a fuzzy rescue fired. */
  matchedTerms: string[];
}

interface Posting {
  docs: number[];
  /** Field-weighted term frequency, parallel to `docs`. */
  tfs: number[];
  masks: number[];
}

/** The text of one field of one triplet, as the index reads it. Exported so a
 *  caller can build the same snippet the matcher scored. */
export function fieldText(t: NormalisedTriplet, field: TripletTextField): string {
  switch (field) {
    case 'subject': return t.subject;
    case 'predicate': return t.predicate;
    case 'object': return t.object;
    case 'label': return t.label;
    case 'msg_text': return t.msg_text;
    case 'justification': return t.justification;
    case 'event_name': return t.event_name ?? '';
    case 'media.description':
      return t.media.map(m => (typeof m.description === 'string' ? m.description : '')).join(' — ');
    case 'attributes':
      return Object.values(t.attributes)
        .map(v => (typeof v === 'string' ? v : ''))
        .join(' ');
    default: return '';
  }
}

export class LexicalIndex {
  readonly stats: IndexStats;
  private readonly postings: Map<string, Posting>;
  private readonly docLengths: number[];
  private readonly avgDocLength: number;
  private readonly k1: number;
  private readonly b: number;
  private readonly fuzzyThreshold: number;
  /** Vocabulary, sorted, for the query-time fuzzy scan. */
  private readonly vocab: string[];

  private constructor(
    postings: Map<string, Posting>,
    docLengths: number[],
    opts: Required<Omit<IndexOptions, 'fieldWeights'>>,
    buildMs: number,
  ) {
    this.postings = postings;
    this.docLengths = docLengths;
    const total = docLengths.reduce((a, c) => a + c, 0);
    this.avgDocLength = docLengths.length > 0 ? total / docLengths.length : 0;
    this.k1 = opts.k1;
    this.b = opts.b;
    this.fuzzyThreshold = opts.fuzzyThreshold;
    this.vocab = [...postings.keys()].sort();
    let postingCount = 0;
    for (const p of postings.values()) postingCount += p.docs.length;
    this.stats = {
      docCount: docLengths.length,
      termCount: postings.size,
      postingCount,
      avgDocLength: Number(this.avgDocLength.toFixed(2)),
      buildMs: Number(buildMs.toFixed(2)),
    };
  }

  /**
   * Build the index. One pass over the corpus; nothing is kept but the
   * postings, the per-document length and the vocabulary — in particular NOT
   * a copy of the text, which the caller already holds.
   */
  static build(triplets: NormalisedTriplet[], options: IndexOptions = {}): LexicalIndex {
    const t0 = Date.now();
    const weights = { ...DEFAULT_FIELD_WEIGHTS, ...(options.fieldWeights ?? {}) };
    const postings = new Map<string, Posting>();
    const docLengths: number[] = new Array(triplets.length).fill(0);

    // Reused per document so the inner loop does not allocate a Map per field.
    const acc = new Map<string, { tf: number; mask: number }>();

    for (let d = 0; d < triplets.length; d++) {
      acc.clear();
      let length = 0;
      for (let f = 0; f < INDEXED_FIELDS.length; f++) {
        const field = INDEXED_FIELDS[f];
        const text = fieldText(triplets[d], field);
        if (text === '') continue;
        const w = weights[field] ?? 0;
        if (w === 0) continue;
        const bit = 1 << f;
        for (const term of tokenize(text)) {
          length++;
          const cur = acc.get(term);
          if (cur) {
            cur.tf += w;
            cur.mask |= bit;
          } else {
            acc.set(term, { tf: w, mask: bit });
          }
        }
      }
      docLengths[d] = length;
      for (const [term, v] of acc) {
        let p = postings.get(term);
        if (!p) {
          p = { docs: [], tfs: [], masks: [] };
          postings.set(term, p);
        }
        p.docs.push(d);
        p.tfs.push(v.tf);
        p.masks.push(v.mask);
      }
    }

    const opts = {
      k1: options.k1 ?? 1.2,
      b: options.b ?? 0.75,
      fuzzyThreshold: options.fuzzyThreshold ?? 0.72,
    };
    return new LexicalIndex(postings, docLengths, opts, Date.now() - t0);
  }

  /** Terms the index actually holds. Exposed for diagnostics and for the
   *  bench; a caller should not need it to ask a question. */
  vocabularySize(): number {
    return this.vocab.length;
  }

  /**
   * Expand a query term onto vocabulary terms.
   *
   * An exact hit short-circuits: a term the corpus really uses is never
   * diluted by its near-neighbours. Only a term with NO exact posting is
   * rescued, and only onto terms of similar length starting with the same
   * letter, which is what keeps this a scan of a few hundred candidates
   * rather than the whole vocabulary.
   */
  expandTerm(term: string): string[] {
    if (this.postings.has(term)) return [term];
    if (this.fuzzyThreshold >= 1) return [];
    const out: Array<{ t: string; s: number }> = [];
    const first = term.charCodeAt(0);
    for (const v of this.vocab) {
      if (v.charCodeAt(0) !== first) continue;
      if (Math.abs(v.length - term.length) > 2) continue;
      const s = trigramSimilarity(term, v);
      if (s >= this.fuzzyThreshold) out.push({ t: v, s });
    }
    out.sort((a, b) => b.s - a.s);
    return out.slice(0, 3).map(x => x.t);
  }

  /**
   * Score every document that contains at least one of `terms`.
   *
   * BM25 with the standard parameters, over the field-weighted term frequency
   * built at index time. Documents are returned unsorted; ordering is the
   * caller's, because the caller may be combining several clauses.
   *
   * `restrictTo`, when given, is the set of document positions that survived
   * the deterministic filters. Scoring is confined to it, so a filter is
   * never something applied to a ranked list afterwards.
   *
   * `fuzzy` false turns OFF the near-miss rescue, so a term either is in the
   * corpus or is not. The counting path uses that: a count whose membership
   * depended on a similarity threshold could not be explained to the person
   * reading it, and could change under a change to that threshold.
   */
  search(terms: string[], restrictTo?: Set<number> | null, fuzzy = true): TermHit[] {
    const n = this.docLengths.length;
    if (n === 0 || terms.length === 0) return [];
    const scores = new Map<number, { score: number; mask: number; terms: Set<string> }>();

    for (const raw of terms) {
      const expanded = fuzzy ? this.expandTerm(raw) : (this.postings.has(raw) ? [raw] : []);
      for (const term of expanded) {
        const p = this.postings.get(term);
        if (!p) continue;
        const df = p.docs.length;
        // BM25 IDF, the Robertson/Sparck-Jones form with the +0.5 guards, and
        // a floor so a term in every document contributes nothing rather than
        // a negative score.
        const idf = Math.max(0, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
        if (idf === 0) continue;
        for (let i = 0; i < df; i++) {
          const d = p.docs[i];
          if (restrictTo && !restrictTo.has(d)) continue;
          const tf = p.tfs[i];
          const dl = this.docLengths[d];
          const denom = tf + this.k1 * (1 - this.b + (this.b * dl) / (this.avgDocLength || 1));
          const contrib = idf * ((tf * (this.k1 + 1)) / (denom || 1));
          const cur = scores.get(d);
          if (cur) {
            cur.score += contrib;
            cur.mask |= p.masks[i];
            cur.terms.add(term);
          } else {
            scores.set(d, { score: contrib, mask: p.masks[i], terms: new Set([term]) });
          }
        }
      }
    }

    const out: TermHit[] = [];
    for (const [doc, v] of scores) {
      out.push({ doc, score: v.score, fieldMask: v.mask, matchedTerms: [...v.terms].sort() });
    }
    return out;
  }

  /** Which fields a mask names. */
  static fieldsFromMask(mask: number): TripletTextField[] {
    const out: TripletTextField[] = [];
    for (let f = 0; f < INDEXED_FIELDS.length; f++) {
      if (mask & (1 << f)) out.push(INDEXED_FIELDS[f]);
    }
    return out;
  }
}

/**
 * Does `text` contain the query's words ADJACENTLY, in order?
 *
 * "burning buildings" scoring the same on a triplet that says "burning" in one
 * field and "buildings" in another as on one that says "a burning building" is
 * the failure this exists to stop. It is a BONUS applied after BM25, never a
 * filter — a triplet that only says "the building burned" still ranks.
 */
export function hasPhrase(text: string, phraseTerms: string[]): boolean {
  if (phraseTerms.length < 2) return false;
  const toks = tokenizeRaw(text).map(stem);
  outer: for (let i = 0; i + phraseTerms.length <= toks.length; i++) {
    for (let j = 0; j < phraseTerms.length; j++) {
      if (toks[i + j] !== phraseTerms[j]) continue outer;
    }
    return true;
  }
  return false;
}
