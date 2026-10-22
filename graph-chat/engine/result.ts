// graph-chat/engine/result.ts
//
// THE RESULT EDGE.
//
// Two jobs, and a line between them that the rest of the system depends on.
//
//   1. `makeEnvelope` builds the thing every query returns: the FULL set, the
//      true total, the query that produced it, and the evidence behind every
//      figure. Those four are exactly what a later export needs, which is why
//      they are in the shape now rather than bolted on afterwards.
//
//   2. `toDisplayPage` is where — and the ONLY where — the cap of 25 exists.
//      It takes an envelope and returns a page. It does not modify the
//      envelope, it cannot, and the page it returns is explicitly labelled as
//      derived.
//
// ── WHY THE CAP IS NOT IN THE QUERY ─────────────────────────────────────────
//   "Top 25 if there's too much data, but we also have the entirety of the
//   answer." A cap applied during retrieval would make the count, the chart
//   and the export all agree with each other and all be wrong together, and
//   the error would be invisible because every surface would show the same
//   number. So the full set is resolved, the full set is retained, and the
//   truncation happens at the last possible moment, in the surface that is
//   about to draw.

import {
  DISPLAY_CAP,
  type DisplayPage,
  type EvidenceBundle,
  type MatcherDescriptor,
  type QueryDescriptor,
  type ResultEnvelope,
  type ShapeReport,
  ENGINE_CONTRACT_VERSION,
} from './types.js';

export interface EnvelopeInput<TItem> {
  query: QueryDescriptor;
  items: TItem[];
  evidence: EvidenceBundle;
  shape: ShapeReport;
  matcher: MatcherDescriptor;
  notes?: string[];
  elapsedMs: number;
}

/** Assemble an envelope. `total` is taken from the array that is actually
 *  being carried, so it cannot drift from it. */
export function makeEnvelope<TItem>(input: EnvelopeInput<TItem>): ResultEnvelope<TItem> {
  return {
    kind: input.query.kind,
    query: input.query,
    items: input.items,
    total: input.items.length,
    evidence: input.evidence,
    engine: {
      contractVersion: ENGINE_CONTRACT_VERSION,
      shape: input.shape.shape,
      matcher: input.matcher,
    },
    shape: input.shape,
    notes: input.notes ?? [],
    elapsedMs: Number(input.elapsedMs.toFixed(2)),
  };
}

/**
 * One page of an envelope, for rendering.
 *
 * `cap` defaults to 25 and a cap of 0 or less means "no cap" rather than "show
 * nothing", because a caller computing a cap from a layout can arrive at zero
 * and must not silently empty the screen.
 *
 * The envelope is READ, never written. A caller holding the envelope still
 * holds every row after this returns, which is what makes the export, the
 * chart and the count agree with each other rather than with the page.
 */
export function toDisplayPage<TItem>(
  envelope: ResultEnvelope<TItem>,
  cap: number = DISPLAY_CAP,
  offset = 0,
): DisplayPage<TItem> {
  const total = envelope.total;
  const start = Math.max(0, Math.min(offset, total));
  const effectiveCap = cap > 0 ? cap : total;
  const end = Math.min(total, start + effectiveCap);
  const shown = envelope.items.slice(start, end);
  const truncated = end < total || start > 0;
  return {
    shown,
    shownCount: shown.length,
    total,
    offset: start,
    truncated,
    capApplied: effectiveCap,
    caption: buildCaption(shown.length, total, start),
  };
}

/** `"25 of 412"`, or `"26-50 of 412"` past the first page, or `"412 of 412"`
 *  when nothing was cut. The caption is built from the envelope's own total so
 *  a surface cannot caption a page with a number it computed elsewhere. */
export function buildCaption(shownCount: number, total: number, offset: number): string {
  if (total === 0) return '0 of 0';
  if (offset === 0 && shownCount >= total) return `${total} of ${total}`;
  if (offset === 0) return `${shownCount} of ${total}`;
  return `${offset + 1}-${offset + shownCount} of ${total}`;
}
