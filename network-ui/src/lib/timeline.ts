// Timeline support for the network explorer.
//
// A node "exists" from its event date onward. It then stays visible for a
// configurable PERSISTENCE WINDOW before disappearing. Within that window the
// opacity curve is controlled by HOLD_FRACTION (see below): it can fade the
// whole time (original behaviour), stay solid then vanish, or anything between.
// Once a node has fully faded it is treated as gone, and any edge touching a
// gone node is also hidden. The slider drives a single "current time" cursor
// (epoch ms) and we derive each node's opacity from (cursor − eventDate).
//
// Event date precedence:
//   1. explicit year/month/day fields (month is 1-based as in the source data)
//   2. a parseable date string in a timestamp-like field
// We deliberately prefer year/month/day because in the DAGGER data the
// `timestamp` field records WHEN A NODE WAS ACCESSED, not when the underlying
// event occurred — the event date lives in day/month/year.

export const MS_PER_MINUTE = 60 * 1000;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
// Average-length month/year. Fine for a persistence window — this is not
// calendar arithmetic, just "roughly this long".
export const MS_PER_MONTH = 30.4375 * MS_PER_DAY;
export const MS_PER_YEAR = 365.25 * MS_PER_DAY;

// Default persistence window when the UI has not set one yet: 30 days.
export const FADE_WINDOW_DAYS = 30;
export const DEFAULT_FADE_WINDOW_MS = FADE_WINDOW_DAYS * MS_PER_DAY;

// How long a node stays at FULL opacity, as a fraction of the persistence
// window, before it begins fading:
//   0    → fades the entire window (a node starts dimming the instant it
//          appears — this matches the original look).
//   1    → stays fully visible for the whole window, then vanishes instantly
//          ("visible for N days, then gone").
//   0.8  → visible for most of the window, with a fade-out over the last 20%.
// Change this single number to pick the behaviour you want.
export const HOLD_FRACTION = 0;

// A node is "gone" (fully faded) below this opacity; its edges are then hidden.
export const GONE_OPACITY = 0.02;

// A broken-out persistence duration, as edited in the timeline UI.
export interface FadeDuration {
  years: number;
  months: number;
  days: number;
  hours: number;
  minutes: number;
}

export const DEFAULT_FADE_DURATION: FadeDuration = {
  years: 0,
  months: 0,
  days: FADE_WINDOW_DAYS,
  hours: 0,
  minutes: 0,
};

/**
 * Convert a broken-out duration to milliseconds. Clamped to a 1-minute floor
 * so the fade math never divides by zero — a zero-length window would make
 * every node vanish the instant it appears.
 */
export function fadeDurationToMs(d: FadeDuration): number {
  const ms =
    (d.years   || 0) * MS_PER_YEAR +
    (d.months  || 0) * MS_PER_MONTH +
    (d.days    || 0) * MS_PER_DAY +
    (d.hours   || 0) * MS_PER_HOUR +
    (d.minutes || 0) * MS_PER_MINUTE;
  return Math.max(MS_PER_MINUTE, ms);
}

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

const TIMESTAMP_FIELD_CANDIDATES = [
  'event_date', 'date', 'timestamp', 'time', 'created_at', 'datetime',
];

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
 * padded by the persistence window so the slider can reach a point where even
 * the last-appearing node has fully faded.
 */
export function computeTimeRange(
  byId: Map<string, Record<string, unknown>>,
  fadeWindowMs: number = DEFAULT_FADE_WINDOW_MS,
): TimeRange {
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
  return { min, max: max + fadeWindowMs, hasDates: true };
}

/**
 * Opacity of a node at a given cursor time, over a persistence window of
 * `fadeWindowMs`. The window is split into a "hold" portion (full opacity) and
 * a "fade" portion by HOLD_FRACTION:
 *   · cursor < eventDate            → 0   (not yet appeared)
 *   · age within hold portion       → 1   (fully present)
 *   · age within fade portion       → linear 1 → 0
 *   · age past the window           → 0   (gone)
 * Nodes with no resolvable date are always visible (opacity 1) so an undated
 * dataset isn't silently emptied.
 */
export function nodeOpacityAt(
  eventDate: number | null,
  cursor: number,
  fadeWindowMs: number = DEFAULT_FADE_WINDOW_MS,
): number {
  if (eventDate === null) return 1;
  if (cursor < eventDate) return 0;
  const age = cursor - eventDate;
  if (age >= fadeWindowMs) return 0;
  const holdMs = HOLD_FRACTION * fadeWindowMs;
  if (age <= holdMs) return 1;
  const fadeSpan = fadeWindowMs - holdMs;
  if (fadeSpan <= 0) return 1; // pure-hold window; age<window guaranteed above
  return 1 - (age - holdMs) / fadeSpan;
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
  fadeWindowMs: number = DEFAULT_FADE_WINDOW_MS,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, rec] of byId.entries()) {
    out.set(id, nodeOpacityAt(nodeEventDate(rec), cursor, fadeWindowMs));
  }
  return out;
}

// A short human label for a cursor time, e.g. "Sep 20, 2017". When the
// persistence window is under a day, the time of day is appended so short
// fades read meaningfully on the slider.
export function formatCursor(ms: number, fadeWindowMs?: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const showTime = fadeWindowMs !== undefined && fadeWindowMs < MS_PER_DAY;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(showTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
}