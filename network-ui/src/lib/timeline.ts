export const FADE_WINDOW_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TIMESTAMP_FIELD_CANDIDATES = ['event_date','date','timestamp','time','created_at','datetime'];
export function nodeEventDate(record: Record<string, unknown>): number | null {
  const y = toInt(record.year);
  if (y !== null) {
    const m = toInt(record.month); const d = toInt(record.day);
    const month = m !== null && m >= 1 && m <= 12 ? m - 1 : 0;
    const day = d !== null && d >= 1 && d <= 31 ? d : 1;
    const t = new Date(y, month, day).getTime();
    if (Number.isFinite(t)) return t;
  }
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
export interface TimeRange { min: number; max: number; hasDates: boolean; }
export function computeTimeRange(byId: Map<string, Record<string, unknown>>): TimeRange {
  let min = Infinity, max = -Infinity;
  for (const rec of byId.values()) {
    const t = nodeEventDate(rec);
    if (t === null) continue;
    if (t < min) min = t; if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0, hasDates: false };
  return { min, max: max + FADE_WINDOW_DAYS * MS_PER_DAY, hasDates: true };
}
export function nodeOpacityAt(eventDate: number | null, cursor: number): number {
  if (eventDate === null) return 1;
  if (cursor < eventDate) return 0;
  const ageDays = (cursor - eventDate) / MS_PER_DAY;
  if (ageDays <= 1) return 1;
  if (ageDays >= FADE_WINDOW_DAYS) return 0;
  return 1 - (ageDays - 1) / (FADE_WINDOW_DAYS - 1);
}
/**
 * Build a Map<graphNodeId, opacity>. The graph's node ids come from whatever
 * field is currently mapped to source/target. That field may be the backend id
 * (`node`) or a human label (`label`, surfaced on edges as source_label /
 * target_label). Node records only carry the node-side field names, so we emit
 * an opacity entry under EVERY candidate id field present on the record
 * (`node`, `label`, `id`, plus any explicitly passed keyFields). This makes the
 * lookup match regardless of which field the user mapped to source/target.
 * When a key collides (e.g. two nodes share a label) we keep the highest
 * opacity so the shared node stays visible while any underlying record is live.
 */
const DEFAULT_ID_FIELDS = ['node', 'label', 'id', 'name'];

export function buildOpacityMap(
  byId: Map<string, Record<string, unknown>>,
  cursor: number,
  extraKeyFields: (string | null | undefined)[] = [],
): Map<string, number> {
  const out = new Map<string, number>();
  const fields = [...DEFAULT_ID_FIELDS, ...extraKeyFields.filter(Boolean) as string[]];
  const put = (key: string, op: number) => {
    const prev = out.get(key);
    out.set(key, prev === undefined ? op : Math.max(prev, op));
  };
  for (const [id, rec] of byId.entries()) {
    const op = nodeOpacityAt(nodeEventDate(rec), cursor);
    put(id, op); // the record's own map key (the backend node id)
    for (const f of fields) {
      const v = rec[f];
      if (v !== null && v !== undefined && v !== '') put(String(v), op);
    }
  }
  return out;
}
export function formatCursor(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}