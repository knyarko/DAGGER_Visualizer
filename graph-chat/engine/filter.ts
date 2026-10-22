// graph-chat/engine/filter.ts
//
// DETERMINISTIC NARROWING, shared by both question classes.
//
// Everything here is an exact field test. Nothing is fuzzy, nothing is ranked
// and nothing is a threshold on a score. A filter decides WHICH ROWS ARE IN
// SCOPE, and it has to give the same answer every time or no count taken after
// it can be reproduced.
//
// Filters are applied BEFORE matching, never to a ranked list afterwards. A
// top-25 taken first and filtered second is a different answer wearing the
// same caption.

import type {
  FacetCount, FacetField, MessageKeySource, NormalisedCorpus, NormalisedTriplet,
  QueryFilters,
} from './types.js';
import { messageKeyOf } from './ingest.js';

/** Case- and whitespace-insensitive equality, which is what a facet value
 *  picked out of a dropdown needs. The ladder is known to carry labels that
 *  differ only in capitalisation. */
function eqFold(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function anyMatch(values: string[], wanted: string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) return true;
  for (const w of wanted) for (const v of values) if (eqFold(v, w)) return true;
  return false;
}

function oneMatch(value: string | null, wanted: string[] | undefined): boolean {
  if (!wanted || wanted.length === 0) return true;
  if (value === null) return false;
  for (const w of wanted) if (eqFold(value, w)) return true;
  return false;
}

export interface FilterOutcome {
  /** Positions in `corpus.triplets` that survived. */
  docs: Set<number>;
  /** How many triplets the filters removed. */
  excludedCount: number;
  /** Removed solely because `minConfidence` was set and their confidence was
   *  null. Reported separately because "the file does not say" is not the same
   *  finding as "below the bar". */
  excludedForNullConfidence: number;
  /** Sentences safe to render verbatim. */
  notes: string[];
}

export function applyFilters(corpus: NormalisedCorpus, filters: QueryFilters): FilterOutcome {
  const docs = new Set<number>();
  let excludedCount = 0;
  let excludedForNullConfidence = 0;

  for (let i = 0; i < corpus.triplets.length; i++) {
    const t = corpus.triplets[i];
    if (!anyMatch(t.categories, filters.category)) { excludedCount++; continue; }
    if (!oneMatch(t.event_name, filters.event_name)) { excludedCount++; continue; }
    if (!oneMatch(t.modality, filters.modality)) { excludedCount++; continue; }
    if (!oneMatch(t.time.year, filters.year)) { excludedCount++; continue; }
    if (!oneMatch(t.time.month, filters.month)) { excludedCount++; continue; }
    if (!oneMatch(t.time.day, filters.day)) { excludedCount++; continue; }
    if (filters.minConfidence !== undefined) {
      if (t.confidence === null) {
        excludedCount++;
        excludedForNullConfidence++;
        continue;
      }
      if (t.confidence < filters.minConfidence) { excludedCount++; continue; }
    }
    docs.add(i);
  }

  const notes: string[] = [];
  if (excludedCount > 0) {
    notes.push(`${excludedCount} of ${corpus.triplets.length} triplets were excluded by the filters.`);
  }
  if (excludedForNullConfidence > 0) {
    notes.push(
      `${excludedForNullConfidence} of those state no confidence at all and were ` +
      'excluded because a minimum confidence was set. They are not low-confidence ' +
      'rows; the file does not say.',
    );
  }
  return { docs, excludedCount, excludedForNullConfidence, notes };
}

/** The values a triplet holds for one facet. `category` is multi-valued; the
 *  rest are single-valued and a null is simply not counted. */
export function facetValuesOf(t: NormalisedTriplet, field: FacetField): string[] {
  switch (field) {
    case 'category': return t.categories;
    case 'event_name': return t.event_name === null ? [] : [t.event_name];
    case 'modality': return t.modality === null ? [] : [t.modality];
    case 'year': return t.time.year === null ? [] : [t.time.year];
    case 'month': return t.time.month === null ? [] : [t.time.month];
    case 'day': return t.time.day === null ? [] : [t.time.day];
    default: return [];
  }
}

/**
 * Count a facet over a set of triplets.
 *
 * Counts are over DISTINCT TRIPLETS and distinct MESSAGES. There is no code
 * path here that can see a node, which is the point: a chart drawn from this
 * cannot be the chart that multiplied by category count.
 *
 * A triplet carrying three categories contributes one to each of three bars,
 * so the bars sum to more than the triplet total. That is correct and it is
 * why nothing downstream should total a facet breakdown.
 */
export function countFacets(
  triplets: NormalisedTriplet[],
  fields: FacetField[],
  keySource: MessageKeySource,
): FacetCount[] {
  const out: FacetCount[] = [];
  for (const field of fields) {
    const tripletCounts = new Map<string, number>();
    const messageSets = new Map<string, Set<string>>();
    for (const t of triplets) {
      for (const v of facetValuesOf(t, field)) {
        tripletCounts.set(v, (tripletCounts.get(v) ?? 0) + 1);
        const mk = messageKeyOf(t, keySource);
        if (mk !== null) {
          let s = messageSets.get(v);
          if (!s) { s = new Set(); messageSets.set(v, s); }
          s.add(mk);
        }
      }
    }
    const rows = [...tripletCounts.entries()].map(([value, tripletCount]) => ({
      field,
      value,
      tripletCount,
      messageCount: keySource === 'none' ? null : (messageSets.get(value)?.size ?? 0),
    }));
    rows.sort((a, b) => b.tripletCount - a.tripletCount || a.value.localeCompare(b.value));
    out.push(...rows);
  }
  return out;
}

/** How many graph nodes the given triplets were collapsed from. This is the
 *  number a node-level count would have produced, and it exists so the gap can
 *  be SHOWN rather than quietly avoided. */
export function nodeCountOf(triplets: NormalisedTriplet[]): number {
  let n = 0;
  for (const t of triplets) n += t.node_ids.length;
  return n;
}

/**
 * Distinct MESSAGES behind the given triplets, or null when the corpus
 * supplies no key for "same message". Null means "the file cannot answer
 * that", not zero.
 *
 * Counts over `cluster_id` where the file has one. It does NOT count rows:
 * one message with two attachments is two rows and one message, and this
 * number says messages.
 */
export function messageCountOf(
  triplets: NormalisedTriplet[],
  keySource: MessageKeySource,
): number | null {
  if (keySource === 'none') return null;
  const s = new Set<string>();
  for (const t of triplets) {
    const mk = messageKeyOf(t, keySource);
    if (mk !== null) s.add(mk);
  }
  return s.size;
}
