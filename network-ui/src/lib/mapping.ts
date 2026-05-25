import type { FieldInfo, FieldType } from './parseData';

// Sentinel values used in `nodeSizeField` to request centrality-based sizing
// instead of a real data field. The Node size dropdown renders these as a
// grouped section above the actual fields.
export const DEGREE_TOTAL = '__degree_total__';
export const DEGREE_IN = '__degree_in__';
export const DEGREE_OUT = '__degree_out__';
export const DEGREE_SENTINELS = [DEGREE_TOTAL, DEGREE_IN, DEGREE_OUT] as const;
export type DegreeSentinel = typeof DEGREE_SENTINELS[number];

export function isDegreeSentinel(value: string | null | undefined): value is DegreeSentinel {
  return value === DEGREE_TOTAL || value === DEGREE_IN || value === DEGREE_OUT;
}

export interface VisualMapping {
  sourceField: string;
  targetField: string;
  edgeLabelField: string | null;
  nodeColorField: string | null;     // applied to source node
  // applied to nodes:
  //  · DEGREE_TOTAL / DEGREE_IN / DEGREE_OUT → centrality
  //  · numeric field name → summed for that node
  //  · null → all nodes get the default size
  nodeSizeField: string | null;
  edgeWeightField: string | null;    // numeric → stroke width
  edgeColorField: string | null;
}

export type FilterValue =
  | { type: 'categorical'; allowed: Set<string> }   // empty => none allowed; null absent in map => no filter
  | { type: 'numeric'; min: number; max: number }
  | { type: 'date'; min: number; max: number }      // epoch ms
  | { type: 'text'; query: string };

export type FilterMap = Record<string, FilterValue>;

export function suggestMapping(fields: FieldInfo[]): VisualMapping {
  // Heuristics: look for common source/target column names
  const byName = new Map(fields.map(f => [f.name.toLowerCase(), f]));
  const find = (...keys: string[]): FieldInfo | undefined => {
    for (const k of keys) {
      const f = byName.get(k);
      if (f) return f;
    }
    return undefined;
  };

  const stringFields = fields.filter(f => f.type === 'string');
  const numericFields = fields.filter(f => f.type === 'number');

  const src =
    find('source', 'src', 'from', 'subject', 'actor', 'sender', 'attacker', 'origin') ??
    stringFields[0] ??
    fields[0];
  const tgt =
    find('target', 'dst', 'destination', 'to', 'object', 'recipient', 'defender') ??
    stringFields.find(f => f.name !== src?.name) ??
    fields.find(f => f.name !== src?.name) ??
    fields[1] ??
    fields[0];

  const edgeLabel = find('predicate', 'action', 'verb', 'interaction', 'type', 'relationship', 'label', 'battle_type');
  const colorField = find('category', 'group', 'type', 'department', 'region', 'cluster');

  return {
    sourceField: src?.name ?? '',
    targetField: tgt?.name ?? '',
    edgeLabelField: edgeLabel?.name ?? null,
    nodeColorField: colorField?.name ?? null,
    // Centrality is the most useful default for arbitrary graphs — it tells
    // you which nodes are most connected at a glance. User can switch to a
    // specific numeric field via the dropdown.
    nodeSizeField: DEGREE_TOTAL,
    edgeWeightField: numericFields[0]?.name ?? null,
    edgeColorField: null,
  };
}

// Treat a string field as "categorical" for filter UX when it has a small, bounded set of values.
export function isCategorical(field: FieldInfo): boolean {
  return (
    (field.type === 'string' || field.type === 'boolean') &&
    field.uniqueCount > 0 &&
    field.uniqueCount <= 50
  );
}

export const TYPE_LABELS: Record<FieldType, string> = {
  string: 'text',
  number: 'numeric',
  date: 'date',
  boolean: 'boolean',
};
