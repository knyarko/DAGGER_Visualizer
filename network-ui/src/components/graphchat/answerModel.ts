/**
 * One answer in the stack, as data.
 *
 * An answer has TWO halves and they fail independently, which is the whole
 * shape of the degradation gate:
 *
 *   - the ENGINE half — the counts, the groups, the figures, the evidence and
 *     the rows — runs in this browser and is always present;
 *   - the SERVICE half — the model's sentence, the grouping sentence, the cache
 *     label — is absent whenever the service is not reachable.
 *
 * Nothing in the view treats a missing service half as a missing answer.
 */

import type {
  AggregateResult,
  QueryKind,
  RetrievalResult,
} from '../../../../graph-chat/engine/types.ts';
import type { GroupingResult } from '../../../../graph-chat/server/types.ts';
import type { AskResponse } from './serviceClient';

export interface GraphChatAnswer {
  id: string;
  question: string;
  kind: QueryKind;
  askedAt: string;
  aggregate: AggregateResult | null;
  retrieval: RetrievalResult | null;
  /**
   * The grouping the answer is REPORTED with, resolved once when the answer is
   * made and then never recomputed - collapse stays lossless and free.
   *
   * It is produced by the service's own `resolveGrouping`, imported and
   * called rather than copied, so the chart, the evidence table, the grouping
   * strip and the service agree by construction instead of by coincidence.
   * Null only when the answer is not an aggregate one.
   */
  grouping: GroupingResult | null;
  /** How far down the retained set the display cap has been walked. The cap is
   *  a display cap; the full set never moves. */
  offset: number;
  service: AskResponse | null;
  /** Why the service did not answer. Null when it did. */
  serviceReason: string | null;
  /** Set only when the ENGINE failed, which is a real failure of the answer. */
  error: string | null;
  pinned: boolean;
  expanded: boolean;
}

/** Two or three words. Collapse must not hide how an answer was grouped. */
export function groupingWords(answer: GraphChatAnswer): string {
  /* The locally resolved key is the one the chart was actually built with, so
   * it answers first. The service runs the same function on the same input and
   * must agree; when it has not answered at all, this is still true. */
  const used = answer.grouping?.keyUsed ?? answer.service?.grouping.keyUsed ?? null;
  if (used === 'cluster_id') return 'by source message';
  // A row id is NOT a message id. Two rows of one message group separately on
  // this key, so the collapsed label must not read 'by source message'.
  if (used === 'record_id') return 'by row id';
  if (used === 'message_text') return 'by message text';
  if (used === 'none') return 'not grouped';
  return 'grouping not available';
}

/**
 * The headline result — survivor 3 of the five, and the collapsed row's whole
 * value. A collapsed answer that shows only its question is a filing label,
 * not an answer. The largest stated figure keeps its qualifier; a bare number
 * would be the one place the qualifier got tidied away.
 */
export function headlineOf(answer: GraphChatAnswer): string {
  if (answer.error !== null) return answer.error;
  if (answer.aggregate) {
    const evidence = answer.aggregate.evidence;
    if (evidence.kind !== 'aggregate') return '';
    let largest: { value: number; qualifier: string } | null = null;
    for (const figure of evidence.figures) {
      if (figure.value === null) continue;
      if (largest === null || figure.value > largest.value) {
        largest = { value: figure.value, qualifier: figure.qualifier };
      }
    }
    const count = `${evidence.figures.length} ${evidence.figures.length === 1 ? 'figure' : 'figures'}`;
    if (largest === null) return `${count} · none states a number`;
    const word = largest.qualifier === 'exact' || largest.qualifier === 'unquantified' ? '' : largest.qualifier + ' ';
    return `${count} · largest ${word}${largest.value.toLocaleString('en-US')}`;
  }
  if (answer.retrieval) {
    const shown = Math.min(25, Math.max(0, answer.retrieval.total - answer.offset));
    return `${answer.offset + shown} of ${answer.retrieval.total} shown`;
  }
  return '';
}

export function isLegacyShape(answer: GraphChatAnswer): boolean {
  const shape = answer.aggregate?.shape ?? answer.retrieval?.shape ?? null;
  return shape !== null && shape.shape === 'legacy';
}
