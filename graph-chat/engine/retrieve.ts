// graph-chat/engine/retrieve.ts
//
// THE RETRIEVAL PATH. "Give me all the triplets that have burning buildings or
// collapsed buildings."
//
// This is NOT the counting path and shares no function with it. A retrieval
// answer is a RESULT SET — the triplets themselves, with their media attached
// — and a counting answer is a counted evidence set. One function that tried
// to be both would have to guess which one it had been asked for, and would
// guess wrong exactly when the question was interesting.
//
// ── WHAT "OR" MEANS HERE ────────────────────────────────────────────────────
//   Two things were asked for, not one. Each clause is scored on its own and a
//   triplet's score is the BEST clause it answered, not the sum. Summing would
//   rank a triplet mentioning both halves of the word "building" above one
//   that actually shows a collapsed building, and the per-clause counts would
//   be unavailable — which matters, because "collapsed buildings: 0 hits" is a
//   finding and a merged total hides it.
//
// ── WHAT COMES BACK WITH A HIT ──────────────────────────────────────────────
//   The whole normalised triplet, which carries its media and its `handling`
//   block exactly as the file had them. `handling` null means the file had no
//   such key — which is the ordinary case — and it means NEITHER concealed NOR
//   cleared. The decision about what a viewer sees belongs to the viewer's own
//   conceal module and is not taken, not pre-empted and not duplicated here.

import type {
  MatcherDescriptor, NormalisedCorpus, NormalisedTriplet, QueryDescriptor,
  QueryFilters, RetrievalEvidence, RetrievalHit, RetrievalResult,
  SemanticBooster, Snippet, TripletTextField,
} from './types.js';
import { LexicalIndex, fieldText, hasPhrase } from './lexindex.js';
import { buildSnippet, splitClauses, tokenize } from './text.js';
import { applyFilters, countFacets, nodeCountOf, messageCountOf } from './filter.js';
import { makeEnvelope } from './result.js';

export const RETRIEVAL_MATCHER: MatcherDescriptor = {
  name: 'bm25-fieldweighted+phrase',
  version: '1.0.0',
  params: { k1: 1.2, b: 0.75, fuzzyThreshold: 0.72, phraseBonus: 0.5, minScore: 0 },
};

export interface RetrievalOptions {
  filters?: QueryFilters;
  /** Score floor. Default 0 — every document that contains a query term is a
   *  hit. The question asks for ALL of them, and a floor chosen to make a
   *  screen look tidy would silently drop rows the export then lacks. */
  minScore?: number;
  /** Multiplier applied when a clause's words appear adjacently and in order.
   *  A bonus, never a filter. */
  phraseBonus?: number;
  /** Facets to break the hits down by, for a chart. */
  groupBy?: Array<'category' | 'event_name' | 'modality' | 'year'>;
  /** Injected so a test is deterministic. */
  issuedAt?: string;
  /** The ONE place a model could enter. The engine does not call it unless the
   *  caller hands it in, and the caller is then named on the result. */
  booster?: SemanticBooster;
  boosterName?: string;
  /** How many snippets to build per hit. Snippets cost text scanning, so a
   *  caller rendering a compact list can turn them down. */
  maxSnippets?: number;
}

interface ClauseHit {
  score: number;
  fieldMask: number;
  terms: Set<string>;
}

/**
 * Run a retrieval question.
 *
 * The index is passed in rather than built here: it is built once per loaded
 * file and reused for every question, and a function that built it per query
 * would turn a 13,000-triplet corpus into a stall on every keystroke.
 */
export function retrieve(
  corpus: NormalisedCorpus,
  index: LexicalIndex,
  question: string,
  options: RetrievalOptions = {},
): RetrievalResult {
  const t0 = Date.now();
  const filters = options.filters ?? {};
  const phraseBonus = options.phraseBonus ?? 0.5;
  const minScore = options.minScore ?? 0;
  const maxSnippets = options.maxSnippets ?? 3;
  const groupBy = options.groupBy ?? ['category', 'event_name'];

  const filtered = applyFilters(corpus, filters);
  const clauses = splitClauses(question);
  const clauseTerms = clauses.map(c => tokenize(c));
  const allTerms = [...new Set(clauseTerms.flat())].sort();

  // Per-document, per-clause scores. OR semantics: best clause wins.
  const best = new Map<number, { score: number; mask: number; terms: Set<string>; clauses: string[] }>();
  const clauseCounts: Array<{ clause: string; tripletCount: number }> = [];

  for (let c = 0; c < clauses.length; c++) {
    const terms = clauseTerms[c];
    if (terms.length === 0) {
      clauseCounts.push({ clause: clauses[c], tripletCount: 0 });
      continue;
    }
    const hits = index.search(terms, filtered.docs, true);
    const perClause = new Map<number, ClauseHit>();
    for (const h of hits) {
      perClause.set(h.doc, { score: h.score, fieldMask: h.fieldMask, terms: new Set(h.matchedTerms) });
    }

    // Phrase bonus, applied only over the fields the document actually matched
    // in, so a multi-word clause does not cost a scan of every field.
    if (terms.length >= 2 && phraseBonus > 0) {
      for (const [doc, ch] of perClause) {
        const fields = LexicalIndex.fieldsFromMask(ch.fieldMask);
        for (const f of fields) {
          if (hasPhrase(fieldText(corpus.triplets[doc], f), terms)) {
            ch.score *= 1 + phraseBonus;
            break;
          }
        }
      }
    }

    let kept = 0;
    for (const [doc, ch] of perClause) {
      if (ch.score <= minScore && minScore > 0) continue;
      kept++;
      const cur = best.get(doc);
      if (!cur) {
        best.set(doc, {
          score: ch.score, mask: ch.fieldMask, terms: new Set(ch.terms), clauses: [clauses[c]],
        });
      } else {
        if (ch.score > cur.score) cur.score = ch.score;
        cur.mask |= ch.fieldMask;
        for (const t of ch.terms) cur.terms.add(t);
        cur.clauses.push(clauses[c]);
      }
    }
    clauseCounts.push({ clause: clauses[c], tripletCount: kept });
  }

  let items: RetrievalHit[] = [];
  for (const [doc, v] of best) {
    const triplet = corpus.triplets[doc];
    const matchedFields = LexicalIndex.fieldsFromMask(v.mask);
    const matchedTerms = [...v.terms].sort();
    items.push({
      triplet,
      score: Number(v.score.toFixed(6)),
      matchedClauses: v.clauses,
      matchedFields,
      matchedTerms,
      snippets: buildSnippets(triplet, matchedFields, matchedTerms, maxSnippets),
    });
  }

  // Deterministic ordering. Score descending, then triplet id, so two runs
  // over one unchanged file produce the same list in the same order — which a
  // cached answer and a re-export both depend on.
  items.sort((a, b) => b.score - a.score || a.triplet.triplet_id.localeCompare(b.triplet.triplet_id));

  const matcher: MatcherDescriptor = {
    ...RETRIEVAL_MATCHER,
    params: { ...RETRIEVAL_MATCHER.params, phraseBonus, minScore },
  };
  if (options.booster) {
    items = options.booster(
      buildDescriptor(question, clauses, allTerms, filters, matcher, options.issuedAt),
      items,
    );
    matcher.rerankedBy = options.boosterName ?? 'unnamed caller-supplied booster';
  }

  const hitTriplets = items.map(h => h.triplet);
  const evidence: RetrievalEvidence & { kind: 'retrieval' } = {
    kind: 'retrieval',
    candidateCount: filtered.docs.size,
    matchedTripletCount: items.length,
    matchedNodeCount: nodeCountOf(hitTriplets),
    distinctMessageCount: messageCountOf(hitTriplets, corpus.messageKeyAvailable),
    hitsWithMedia: hitTriplets.filter(t => t.media.length > 0).length,
    hitsWithHandling: hitTriplets.filter(t => t.handling !== null).length,
    clauseCounts,
    facets: countFacets(hitTriplets, groupBy, corpus.messageKeyAvailable),
  };

  const notes = [...filtered.notes];
  for (const cc of clauseCounts) {
    if (cc.tripletCount === 0) notes.push(`"${cc.clause}" matched nothing in this file.`);
  }
  if (evidence.matchedNodeCount !== items.length && items.length > 0) {
    notes.push(
      `${items.length} triplets, collapsed from ${evidence.matchedNodeCount} graph nodes.`,
    );
  }
  const noHandling = items.length - evidence.hitsWithHandling;
  if (noHandling > 0) {
    notes.push(
      `${noHandling} of ${items.length} results carry no handling block, so the ` +
      'conceal rule has nothing to read for them. They are neither marked for ' +
      'concealment nor cleared.',
    );
  }

  return makeEnvelope<RetrievalHit>({
    query: buildDescriptor(question, clauses, allTerms, filters, matcher, options.issuedAt),
    items,
    evidence,
    shape: corpus.shape,
    matcher,
    notes,
    elapsedMs: Date.now() - t0,
  });
}

function buildDescriptor(
  text: string,
  clauses: string[],
  terms: string[],
  filters: QueryFilters,
  matcher: MatcherDescriptor,
  issuedAt?: string,
): QueryDescriptor {
  return {
    kind: 'retrieval',
    text,
    clauses,
    terms,
    filters,
    matcher,
    issuedAt: issuedAt ?? new Date().toISOString(),
  };
}

/** Build display snippets for the fields that matched, highest-value field
 *  first. `media.description` leads: on a question about what is in a picture,
 *  the describer's sentence is the answer and the message often is not. */
const SNIPPET_ORDER: TripletTextField[] = [
  'media.description', 'object', 'subject', 'msg_text', 'predicate',
  'justification', 'label', 'attributes', 'event_name',
];

function buildSnippets(
  t: NormalisedTriplet,
  matchedFields: TripletTextField[],
  terms: string[],
  max: number,
): Snippet[] {
  const want = new Set(matchedFields);
  const out: Snippet[] = [];
  for (const field of SNIPPET_ORDER) {
    if (out.length >= max) break;
    if (!want.has(field)) continue;
    const text = fieldText(t, field);
    if (text === '') continue;
    const s = buildSnippet(text, terms);
    if (s) out.push({ field, text: s.text, spans: s.spans });
  }
  return out;
}
