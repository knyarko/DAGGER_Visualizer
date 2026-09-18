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
//   1. explicit year/month/day fields (month is 1-based as in the source data),
//      now WITH hour/minute/second/timezone when the record carries them
//   2. a parseable date string in a timestamp-like field
// We deliberately prefer year/month/day because in the DAGGER data the
// `timestamp` field records WHEN A NODE WAS ACCESSED, not when the underlying
// event occurred — the event date lives in day/month/year.
//
// B007 (VT004): step 1 previously read ONLY day/month/year and threw the clock
// away, so every node in a day landed on the same instant and the timeline
// could not separate them. It now reads all seven clock fields —
// day/month/year/hour/minute/second/timezone — into ONE sortable instant.
// What did NOT change, on purpose:
//   · `timestamp` is still not promoted over day/month/year. The comment above
//     is the reason and it still holds; the fix was the missing clock, not the
//     precedence.
//   · a record with no hour/minute/second still resolves to local midnight,
//     exactly as before, so every dataset without a clock is untouched.
//   · a record with no `timezone` is still built in LOCAL time, as before. Only
//     a record that states its zone is built in that zone.

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
 * The seven clock fields of a record, read and coerced. The pipeline emits them
 * as zero-padded STRINGS ("08", "2017"), so everything here goes through toInt.
 */
export interface ClockParts {
  year: number;
  /** 1-based, as in the source data. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Minutes east of UTC, or null when the record states no zone (or states one
   *  this code cannot resolve) — null means "build in local time". */
  offsetMinutes: number | null;
  /** True when at least one of hour/minute/second was actually present. Lets a
   *  caller tell "midnight because the data says midnight" from "midnight
   *  because the data has no clock". */
  hasTimeOfDay: boolean;
}

/**
 * Resolve a `timezone` field to minutes east of UTC.
 *
 * Handles UTC / GMT / Z and numeric offsets (`+05:30`, `-0700`, `UTC+2`).
 * A named zone the browser would need a tz database for (`EST`,
 * `America/New_York`) returns null rather than a guess — a wrong offset is
 * worse than falling back to local time, and it would be invisible once the
 * instant is a number.
 */
export function timezoneOffsetMinutes(tz: unknown): number | null {
  if (typeof tz !== 'string') return null;
  const s = tz.trim();
  if (!s) return null;
  if (/^(utc|gmt|z|utc\+?0{1,2}(:?00)?|gmt\+?0{1,2}(:?00)?)$/i.test(s)) return 0;
  const m = /^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(s);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const hours = Number(m[2]);
  const mins = m[3] ? Number(m[3]) : 0;
  if (!Number.isFinite(hours) || hours > 14 || mins > 59) return null;
  return sign * (hours * 60 + mins);
}

/**
 * Read the clock fields off a record, or null when there is no usable `year`.
 * Out-of-range parts fall back to the same defaults the original day/month/year
 * code used (month → January, day → 1) so an odd record degrades the same way
 * it always did instead of dropping out of the timeline.
 */
export function nodeClock(record: Record<string, unknown>): ClockParts | null {
  const y = toInt(record.year);
  if (y === null) return null;

  const m = toInt(record.month);
  const d = toInt(record.day);
  const hh = toInt(record.hour);
  const mm = toInt(record.minute);
  const ss = toInt(record.second);

  const inRange = (v: number | null, lo: number, hi: number): number | null =>
    v !== null && v >= lo && v <= hi ? v : null;

  const hour = inRange(hh, 0, 23);
  const minute = inRange(mm, 0, 59);
  // 60 accepted: a leap second rolls into the next minute rather than being
  // discarded, which is what Date.UTC does with it anyway.
  const second = inRange(ss, 0, 60);

  return {
    year: y,
    month: inRange(m, 1, 12) ?? 1,
    day: inRange(d, 1, 31) ?? 1,
    hour: hour ?? 0,
    minute: minute ?? 0,
    second: second ?? 0,
    offsetMinutes: timezoneOffsetMinutes(record.timezone),
    hasTimeOfDay: hour !== null || minute !== null || second !== null,
  };
}

/** Turn read clock parts into one epoch-ms instant, or null if not finite. */
export function clockToInstant(c: ClockParts): number | null {
  const t = c.offsetMinutes === null
    // No stated zone → local time, exactly as this function behaved before.
    ? new Date(c.year, c.month - 1, c.day, c.hour, c.minute, c.second).getTime()
    // Stated zone → the wall clock is in THAT zone, so convert to UTC by
    // subtracting the offset.
    : Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - c.offsetMinutes * 60_000;
  return Number.isFinite(t) ? t : null;
}

/**
 * Resolve a node record to ONE sortable instant in epoch ms, or null if
 * undeterminable. `record` is the UNFLATTENED node object from companionNodes
 * (or a DaggerIndex node — same object).
 *
 * This is the single instant the whole timeline sorts, ranges and fades on.
 * There is no second date anywhere.
 */
export function nodeEventDate(record: Record<string, unknown>): number | null {
  // 1. The structured clock fields — all seven when present.
  const clock = nodeClock(record);
  if (clock) {
    const t = clockToInstant(clock);
    if (t !== null) return t;
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

/**
 * For datasets where the event date lives on each ROW (e.g. a node/triple
 * array whose graph is drawn from subject→object) rather than in a companion
 * node lookup, build a Map<graphNodeId, record> suitable for computeTimeRange
 * and buildOpacityMap.
 *
 * `idFields` are the fields whose values are the graph's node ids — normally
 * the current mapping's source and target fields. Each id is associated with
 * the EARLIEST-dated row that mentions it, so an entity "appears" the first
 * time it shows up and fades from there. Rows with no resolvable date are
 * skipped; ids that only ever appear in undated rows are omitted (and so stay
 * always-visible, matching the null-date convention elsewhere).
 */
export function buildRowDateLookup(
  rows: Record<string, unknown>[],
  idFields: string[],
): Map<string, Record<string, unknown>> {
  const best = new Map<string, { rec: Record<string, unknown>; t: number }>();
  for (const row of rows) {
    const t = nodeEventDate(row);
    if (t === null) continue;
    for (const f of idFields) {
      const v = row[f];
      if (v === null || v === undefined || v === '') continue;
      const id = String(v);
      const cur = best.get(id);
      if (!cur || t < cur.t) best.set(id, { rec: row, t });
    }
  }
  const out = new Map<string, Record<string, unknown>>();
  for (const [id, entry] of best) out.set(id, entry.rec);
  return out;
}

/**
 * A human label for a cursor time, e.g. "Sep 20, 2017, 15:03:47".
 *
 * VT004: the time of day is ALWAYS shown, to the second. It used to appear only
 * when the persistence window was under a day, which meant that on a file whose
 * records carry a real clock — every DAGGER Graph_Viz — the slider read
 * "Oct 10, 2017" and the clock the timeline had just parsed was invisible.
 * The old `fadeWindowMs` parameter existed only to gate that and is gone; the
 * three call sites in DataExplorer were updated with it.
 *
 * Hour is forced to 24h (`hourCycle: 'h23'`) so the readout is monotonic with
 * the slider in every locale — a 12h clock makes 00:xx sort visually after 11:xx.
 */
export function formatCursor(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}
