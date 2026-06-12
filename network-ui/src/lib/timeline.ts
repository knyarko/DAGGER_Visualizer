// Timeline support for the network explorer.
//
// A node "exists" from its event date onward, stays at full opacity for that
// day, then fades linearly to zero over the following FADE_WINDOW_DAYS. Once
// fully faded it is treated as gone, and any edge touching a gone node is also
// hidden. The slider drives a single "current time" cursor (epoch ms) and we
// derive each node's opacity from (cursor − eventDate).
//
// Event date precedence:
//   1. explicit year/month/day fields (month is 1-based as in the source data)
//   2. a parseable date string in a timestamp-like field
// We deliberately prefer year/month/day because in the DAGGER data the
// `timestamp` field records WHEN A NODE WAS ACCESSED, not when the underlying
// event occurred — the event date lives in day/month/year.

export const FADE_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const TIMESTAMP_FIELD_CANDIDATES = [
  'event_date', 'date', 'timestamp', 'time', 'created_at', 'datetime',
];

/**
 * Resolve a node record's event date to epoch ms, or null if undeterminable.
 * `record` is the UNFLATTENED node object from companionNodes.
 */
export function nodeEventDate(record: Record<string, unknown>): number | null {
  // 1. Structured year/month/day (month is 1-based in source data)
  const y = toInt(record.year);
  if (y !== null) {
    const m = toInt(record.month);
    const d = toInt(record.day);
    const month = m !== null && m >= 1 && m <= 12 ? m - 1 : 0;
    const day = d !== null && d >= 1 && d <= 31 ? d : 1;
    const t = new Date(y, month, day).getTime();
    if (Number.isFinite(t)) return t;
  }

  // 2. A parseable timestamp-ish string. Strip a trailing timezone token like
  //    "GT" that Date.parse chokes on (e.g. "2017-09-20 15:03 GT").
  for (const f of TIMESTAMP_FIELD_CANDIDATES) {
    const v = record[f];
    if (typeof v !== 'string' || !v.trim()) continue;
    const cleaned = v.trim().replace(/\s+[A-Za-z]{1,4}$/, '');
    const t = Date.parse(cleaned);
    if (Number.isFinite(t)) return t;
  }

  return null;
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isInteger(n) ? n : (Number.isFinite(n) ? Math.trunc(n) : null);
}

export interface TimeRange {
  min: number;  // epoch ms — earliest node event date
  max: number;  // epoch ms — latest node event date
  hasDates: boolean;
}

/**
 * Compute the [min, max] event-date span across all node records. The max is
 * padded by FADE_WINDOW_DAYS so the slider can reach a point where even the
 * last-appearing node has fully faded.
 */
export function computeTimeRange(byId: Map<string, Record<string, unknown>>): TimeRange {
  let min = Infinity;
  let max = -Infinity;
  for (const rec of byId.values()) {
    const t = nodeEventDate(rec);
    if (t === null) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 0, hasDates: false };
  }
  return { min, max: max + FADE_WINDOW_DAYS * MS_PER_DAY, hasDates: true };
}

/**
 * Opacity of a node at a given cursor time.
 *   · cursor < eventDate                → 0   (not yet appeared)
 *   · cursor within [eventDate, +1 day) → 1   (fully present)
 *   · cursor in fade window             → linear 1 → 0
 *   · cursor past fade window           → 0   (gone)
 * Nodes with no resolvable date are always visible (opacity 1) so an undated
 * dataset isn't silently emptied.
 */
export function nodeOpacityAt(eventDate: number | null, cursor: number): number {
  if (eventDate === null) return 1;
  if (cursor < eventDate) return 0;
  const ageDays = (cursor - eventDate) / MS_PER_DAY;
  if (ageDays <= 1) return 1;
  if (ageDays >= FADE_WINDOW_DAYS) return 0;
  // Linear fade from day 1 → day FADE_WINDOW_DAYS
  return 1 - (ageDays - 1) / (FADE_WINDOW_DAYS - 1);
}

/**
 * Build a Map<nodeId, opacity> for the current cursor. Pre-resolves each
 * node's event date once. Node ids not present in `byId` (e.g. an edge
 * endpoint with no node record) default to opacity 1 — caller decides whether
 * to treat missing-date endpoints as always-on.
 */
export function buildOpacityMap(
  byId: Map<string, Record<string, unknown>>,
  cursor: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, rec] of byId.entries()) {
    out.set(id, nodeOpacityAt(nodeEventDate(rec), cursor));
  }
  return out;
}

// A short human label for a cursor time, e.g. "Sep 20, 2017".
export function formatCursor(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
