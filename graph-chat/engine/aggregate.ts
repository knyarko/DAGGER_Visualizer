// graph-chat/engine/aggregate.ts
//
// THE COUNTING PATH. "How many deaths occurred during Hurricane Harvey."
//
// This path returns a COUNTED EVIDENCE SET AND NEVER A SUM.
//
// ── WHY NOT A SUM ───────────────────────────────────────────────────────────
//   Measured on the real corpus, one record yields both
//       `strike -> killed -> 12 people`
//   and `strike -> caused -> 12 deaths and 33 injuries`
//   — one event, two triples, the same twelve people. Another yields two
//   triples both reporting the same ~100 children. A third states, inside one
//   record, `more than 2,000 civilians killed`, `at least 136 civilians
//   killed` and `death of at least 50 people`: a national running total, a
//   verified subset of it, and one incident inside that subset.
//
//   Add those and you get a number with nothing behind it, and no reader can
//   tell from the number that it is wrong. So the engine states how many
//   triplets matched, how many distinct records they came from, every figure
//   with the qualifier the text attached to it, and the rows grouped by the
//   record they came from — and it leaves the judgement with the person
//   looking at the rows. `AggregateEvidence.sum` is typed `null`, so adding
//   them is not something this module can be made to do by accident.
//
// ── WHY THE MATCH IS EXACT AND UNRANKED ─────────────────────────────────────
//   Membership of a COUNT must be explainable to the person reading it. A
//   triplet is in the set when one of the question's terms occurs in one of
//   its fields, full stop — no similarity threshold, no score floor, no fuzzy
//   rescue. Change a threshold and a ranked list reorders, which is survivable;
//   change it under a count and the number moves with no visible cause.
//
// ── WHY THE NODE NUMBER IS SHOWN AT ALL ─────────────────────────────────────
//   Because it is the number anyone counting the obvious way would have got.
//   Stating both — the nodes that matched and the distinct triplets they
//   collapse to — is how a reader can tell that the collapse happened.

import type {
  AggregateEvidence, AggregateResult, FacetField, MatcherDescriptor,
  MessageGroup, MessageKeySource, NormalisedCorpus, NormalisedTriplet,
  QueryDescriptor, QueryFilters, StatedFigure, TripletTextField,
} from './types.js';
import { LexicalIndex, fieldText } from './lexindex.js';
import { extractFigures, splitClauses, stem, tokenize } from './text.js';
import { messageKeyOf } from './ingest.js';
import { applyFilters, countFacets, nodeCountOf, messageCountOf } from './filter.js';
import { makeEnvelope } from './result.js';

export const AGGREGATE_MATCHER: MatcherDescriptor = {
  name: 'exact-term-membership',
  version: '1.0.0',
  params: { fuzzy: false, ranked: false },
};

/**
 * Words that ask the question rather than name what is being asked about.
 * Dropped before the term set is built, so "how many deaths" searches for
 * `death` and not for `many`.
 *
 * Kept separate from the general stop list because these are only noise in a
 * COUNTING question: a retrieval question may legitimately be about the word
 * "total".
 */
const QUESTION_WORDS = new Set([
  'how', 'many', 'much', 'number', 'numbers', 'count', 'counts', 'total',
  'totals', 'occur', 'occurred', 'occurs', 'happen', 'happened', 'during',
  'where', 'when', 'who', 'whom', 'whose', 'why', 'did', 'do', 'does',
  'tell', 'about', 'please', 'can', 'could', 'would', 'should',
].map(stem));

/** The fields a count reads. `label` is excluded: it is subject, predicate and
 *  object concatenated, so including it would double every match. */
const COUNTED_FIELDS: TripletTextField[] = [
  'subject', 'predicate', 'object', 'msg_text', 'justification',
  'media.description', 'attributes', 'event_name',
];

export interface AggregateOptions {
  filters?: QueryFilters;
  /**
   * The terms to count on, stated explicitly.
   *
   * Supplying them is the honest mode: "a death/casualty keyword set" is a
   * decision someone made, and writing it down is what makes the count
   * reproducible and arguable. When it is absent the terms are derived from
   * the question, and the derived set is reported on the result so a reader
   * can see what was actually searched for.
   */
  terms?: string[];
  /** Facets to break the matched set down by, for a chart. */
  groupBy?: FacetField[];
  /** Injected so a test is deterministic. */
  issuedAt?: string;
  /** Cap on figures reported per triplet. A sentence stating eleven numbers is
   *  not evidence, it is a wall. 0 means no cap. */
  maxFiguresPerTriplet?: number;
  /**
   * Keep numbers whose text does not say what they count. Default FALSE.
   *
   * Measured on the real corpus: a death-keyword question matched 236 triplets
   * and the reader found 1,317 numbers in their text — `25 kilometers`,
   * `15.5 miles`, `5 a.m.`, `2014`. Almost none of them were casualties. A
   * figure that does not name what it counts is not evidence for a count, so
   * it is set aside by default and reported as a number rather than dropped.
   */
  includeUnitlessFigures?: boolean;
}

/**
 * Run a counting question.
 *
 * Order of operations, and it is the whole correctness argument:
 *   1. filters narrow the corpus deterministically;
 *   2. membership is decided by exact term presence;
 *   3. the set is already one row per triplet, because the ingest collapsed
 *      the (triplet, category) node instances before any of this ran;
 *   4. figures are read out of the matched triplets' own text;
 *   5. the figures are grouped by the record they came from;
 *   6. nothing is added.
 */
export function aggregate(
  corpus: NormalisedCorpus,
  index: LexicalIndex,
  question: string,
  options: AggregateOptions = {},
): AggregateResult {
  const t0 = Date.now();
  const filters = options.filters ?? {};
  const groupBy: FacetField[] = options.groupBy ?? ['category', 'event_name', 'year'];
  const maxFigures = options.maxFiguresPerTriplet ?? 8;
  const keepUnitless = options.includeUnitlessFigures === true;

  const filtered = applyFilters(corpus, filters);
  const clauses = splitClauses(question);

  const supplied = options.terms;
  const derived = supplied === undefined;
  const terms = supplied === undefined
    ? [...new Set(tokenize(question).filter(t => !QUESTION_WORDS.has(t)))].sort()
    : [...new Set(supplied.flatMap(t => tokenize(t)))].sort();

  // MEMBERSHIP. Exact, unranked, fuzzy off. The score the index returns is
  // ignored on purpose — it is used to find the documents, never to admit or
  // exclude one.
  const hits = terms.length === 0 ? [] : index.search(terms, filtered.docs, false);
  const matched: NormalisedTriplet[] = [];
  const matchedTermsByDoc = new Map<number, string[]>();
  for (const h of hits) {
    matched.push(corpus.triplets[h.doc]);
    matchedTermsByDoc.set(h.doc, h.matchedTerms);
  }
  // Stable order: by triplet id, so two runs agree row for row.
  matched.sort((a, b) => a.triplet_id.localeCompare(b.triplet_id));

  // FIGURES. Read from the matched triplets' own text, field by field, so
  // every number keeps the name of the field it was stated in.
  const figures: StatedFigure[] = [];
  let tripletsWithFigures = 0;
  let unitlessFiguresSetAside = 0;
  for (const t of matched) {
    const mine: StatedFigure[] = [];
    for (const field of COUNTED_FIELDS) {
      const text = fieldText(t, field);
      if (text === '') continue;
      mine.push(...extractFigures(text, field, t.triplet_id,
        messageKeyOf(t, corpus.messageKeyAvailable)));
    }
    const deduped = dedupeFigures(mine);
    const kept = keepUnitless ? deduped : deduped.filter(f => f.unit !== null);
    unitlessFiguresSetAside += deduped.length - kept.length;
    if (kept.length > 0) tripletsWithFigures++;
    figures.push(...(maxFigures > 0 ? kept.slice(0, maxFigures) : kept));
  }

  /* Deduplicate ONCE MORE, per message.
   *
   * The loop above dedupes within a single triplet, which is not enough: seven
   * triplets extracted from one message each restate the same figure, so the
   * message ends up carrying seven identical bars. That is the compounding the
   * whole aggregate path exists to prevent, surviving into the picture because
   * the collapse happened at the wrong level. A figure is identified by what it
   * says - value, qualifier and unit - so the same statement from a second
   * triplet of the same message is the same statement, not a second sighting. */
  const byMessage = new Map<string, StatedFigure[]>();
  for (const f of figures) {
    const key = f.cluster_id ?? f.triplet_id;
    const bucket = byMessage.get(key);
    if (bucket === undefined) byMessage.set(key, [f]);
    else bucket.push(f);
  }
  const figuresPerMessageDeduped: StatedFigure[] = [];
  let figuresCollapsedAsRestatements = 0;
  for (const bucket of byMessage.values()) {
    const kept = dedupeFigures(bucket);
    figuresCollapsedAsRestatements += bucket.length - kept.length;
    figuresPerMessageDeduped.push(...kept);
  }
  figures.length = 0;
  figures.push(...figuresPerMessageDeduped);

  const messageGroups = groupByMessage(matched, figures, corpus.messageKeyAvailable);

  const evidence: AggregateEvidence & { kind: 'aggregate' } = {
    kind: 'aggregate',
    matchedNodeCount: nodeCountOf(matched),
    matchedTripletCount: matched.length,
    distinctMessageCount: messageCountOf(matched, corpus.messageKeyAvailable),
    tripletsWithFigures,
    figures,
    unitlessFiguresSetAside,
    figuresCollapsedAsRestatements,
    messageGroups,
    facets: countFacets(matched, groupBy, corpus.messageKeyAvailable),
    sum: null,
    sumRefusalReason:
      'These figures are not addable. Two triplets extracted from one record ' +
      'routinely state the same event, and one record can state a running ' +
      'total, a verified subset of it and a single incident inside that subset ' +
      'at the same time. The rows below are the evidence; the total is a ' +
      'judgement about which of them are the same event, and it is not the ' +
      'engine\'s to make.',
  };

  const notes = [...filtered.notes];
  notes.push(
    `${evidence.matchedTripletCount} distinct triplets matched, collapsed from ` +
    `${evidence.matchedNodeCount} graph nodes. The triplet count is the count; ` +
    'the node count is what counting nodes would have given.',
  );
  if (evidence.distinctMessageCount !== null) {
    const keyed = corpus.messageKeyAvailable === 'cluster_id'
      ? 'distinct source messages'
      : 'distinct rows, which stand in for messages because this file carries no ' +
        'cluster id — a message with two attachments is counted twice here';
    notes.push(`They come from ${evidence.distinctMessageCount} ${keyed}.`);
  } else {
    notes.push(
      'This file carries neither a cluster id nor a record id, so the number of ' +
      'distinct source messages behind these triplets cannot be stated and ' +
      'duplicates cannot be collapsed by message.',
    );
  }
  notes.push(
    `${tripletsWithFigures} of ${matched.length} matched triplets state a figure ` +
    'that names what it counts.',
  );
  if (unitlessFiguresSetAside > 0) {
    notes.push(
      `${unitlessFiguresSetAside} further numbers were found in the matched text ` +
      'but set aside because it does not say what they count — distances, clock ' +
      'times and years read the same as casualties to a reader that only sees digits.',
    );
  }
  if (derived) {
    notes.push(`Terms searched, derived from the question: ${terms.join(', ') || '(none)'}.`);
  } else {
    notes.push(`Terms searched, supplied by the caller: ${terms.join(', ') || '(none)'}.`);
  }
  if (terms.length === 0) {
    notes.push('No searchable term was left after the question words were removed, so nothing matched.');
  }

  const matcher: MatcherDescriptor = { ...AGGREGATE_MATCHER, params: { ...AGGREGATE_MATCHER.params } };
  const query: QueryDescriptor = {
    kind: 'aggregate',
    text: question,
    clauses,
    terms,
    filters,
    matcher,
    issuedAt: options.issuedAt ?? new Date().toISOString(),
  };

  return makeEnvelope<NormalisedTriplet>({
    query,
    items: matched,
    evidence,
    shape: corpus.shape,
    matcher,
    notes,
    elapsedMs: Date.now() - t0,
  });
}

/**
 * Drop figures that are the same number said twice inside one triplet —
 * typically because the triple's `object` text is also quoted in `msg_text`.
 *
 * This is a WITHIN-TRIPLET dedupe only. It does not touch two triplets saying
 * the same thing; that is the record grouping's business and it is shown
 * rather than silently resolved.
 */
export function dedupeFigures(figures: StatedFigure[]): StatedFigure[] {
  const seen = new Set<string>();
  const out: StatedFigure[] = [];
  for (const f of figures) {
    const key = `${f.value ?? 'null'}|${f.qualifier}|${f.unit ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Group the matched triplets by THE MESSAGE they were extracted from, and
 * hang each message's figures off it.
 *
 * ── WHY THE KEY IS `cluster_id` AND NOT `record_id` ─────────────────────────
 *   The data dictionary is explicit. `cluster_id` is the id of the
 *   originating MESSAGE, "shared by every row and every triplet that came out
 *   of it". `record_id` is the id of a ROW — "one per row, so a message with
 *   two attachments gets two".
 *
 *   So a message carrying two pictures is ONE cluster id and TWO record ids.
 *   Keyed on the record id it becomes two groups, and the casualty figure it
 *   states is drawn, counted and handed to the model twice. That is exactly
 *   the compounding this whole module exists to prevent, and it is invisible
 *   on a corpus where no message has two attachments — which is why it
 *   survived a green test suite.
 *
 * This is the collapse that stops one event being counted twice. It does NOT
 * decide that two figures in one message are the same event — it puts them
 * next to each other and says so in `note`, which is as far as anything
 * automatic should go.
 *
 * When the file carries no key at all every triplet is its own group, the
 * group's `cluster_id` is null and its `key_source` is `'none'`, so nothing
 * can mistake a synthesised id for a real one or read the group count as a
 * message count.
 */
export function groupByMessage(
  matched: NormalisedTriplet[],
  figures: StatedFigure[],
  keySource: MessageKeySource,
): MessageGroup[] {
  const figuresByTriplet = new Map<string, StatedFigure[]>();
  for (const f of figures) {
    const list = figuresByTriplet.get(f.triplet_id);
    if (list) list.push(f);
    else figuresByTriplet.set(f.triplet_id, [f]);
  }

  const groups = new Map<string, MessageGroup>();
  for (const t of matched) {
    // cluster first, row only as a declared fallback, then the triplet alone.
    const mk = messageKeyOf(t, keySource);
    const key = mk !== null ? `msg:${mk}` : `trp:${t.triplet_id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        cluster_id: mk,
        key_source: mk !== null ? keySource : 'none',
        triplet_ids: [],
        msg_text: t.msg_text,
        figures: [],
        note: null,
      };
      groups.set(key, g);
    }
    g.triplet_ids.push(t.triplet_id);
    if (g.msg_text === '' && t.msg_text !== '') g.msg_text = t.msg_text;
    g.figures.push(...(figuresByTriplet.get(t.triplet_id) ?? []));
  }

  const out = [...groups.values()];
  for (const g of out) {
    g.triplet_ids.sort();
    /* The warning is about the MESSAGE having been extracted into several
     * triplets, not about how many distinct figures survived. Identical
     * restatements are collapsed upstream, so keying this on the surviving
     * figure count would silence the note exactly where the restatement was
     * most complete - the case it exists for. */
    const withFigures = new Set(g.figures.map(f => f.triplet_id));
    if (g.triplet_ids.length > 1 && g.figures.length > 0) {
      g.note =
        `${g.triplet_ids.length} triplets were extracted from this one source ` +
        'message. They may be describing one event more than once; they are not ' +
        'independent observations and must not be added.';
    } else if (g.figures.length > 1 && withFigures.size === 1) {
      g.note =
        'This message states more than one figure. A running total, a verified ' +
        'subset of it and a single incident inside it can all appear together.';
    }
  }
  out.sort((a, b) => (a.cluster_id ?? '').localeCompare(b.cluster_id ?? '') ||
    (a.triplet_ids[0] ?? '').localeCompare(b.triplet_ids[0] ?? ''));
  return out;
}
