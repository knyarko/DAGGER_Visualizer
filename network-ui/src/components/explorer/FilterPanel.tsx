import { useMemo, useState } from 'react';
import type { FieldInfo } from '../../lib/parseData';
import type { FilterMap, FilterValue } from '../../lib/mapping';
import { isCategorical } from '../../lib/mapping';

interface Props {
  fields: FieldInfo[];
  rows: Record<string, unknown>[];
  filters: FilterMap;
  onChange: (next: FilterMap) => void;
}

function CategoricalFilter({
  field,
  rows,
  value,
  onChange,
}: {
  field: FieldInfo;
  rows: Record<string, unknown>[];
  value: Extract<FilterValue, { type: 'categorical' }> | undefined;
  onChange: (next: FilterValue | undefined) => void;
}) {
  // Count uses of each value (relative to current full row set — cheap, bounded by uniqueCount)
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const v = r[field.name];
      if (v === null || v === undefined || v === '') continue;
      const s = String(v);
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [rows, field.name]);

  // Default = all enabled if no explicit filter set
  const allowed = value?.allowed ?? new Set(counts.map(([v]) => v));
  const allOn = allowed.size === counts.length;

  const toggle = (key: string) => {
    const next = new Set(allowed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    if (next.size === counts.length) {
      onChange(undefined); // remove filter — equivalent to "all"
    } else {
      onChange({ type: 'categorical', allowed: next });
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-gray-300">{field.name}</span>
        <button
          onClick={() => {
            if (allOn) onChange({ type: 'categorical', allowed: new Set() });
            else onChange(undefined);
          }}
          className="text-[10px] text-blue-400 hover:text-blue-300"
        >
          {allOn ? 'none' : 'all'}
        </button>
      </div>
      <div className="max-h-40 overflow-y-auto space-y-0.5 pr-1">
        {counts.map(([v, c]) => (
          <label key={v} className="flex items-center text-xs gap-2 cursor-pointer hover:bg-gray-800 px-1 rounded">
            <input
              type="checkbox"
              checked={allowed.has(v)}
              onChange={() => toggle(v)}
              className="accent-blue-500"
            />
            <span className="truncate flex-1">{v}</span>
            <span className="text-gray-500">{c}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function NumericFilter({
  field,
  value,
  onChange,
}: {
  field: FieldInfo;
  value: Extract<FilterValue, { type: 'numeric' }> | undefined;
  onChange: (next: FilterValue | undefined) => void;
}) {
  const lo = field.min ?? 0;
  const hi = field.max ?? 1;
  const current = value ?? { type: 'numeric' as const, min: lo, max: hi };
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-gray-300">{field.name}</span>
        <span className="text-[10px] text-gray-500">{current.min} – {current.max}</span>
      </div>
      <div className="space-y-1">
        <input
          type="range"
          min={lo}
          max={hi}
          step={(hi - lo) / 100 || 1}
          value={current.min}
          onChange={(e) => {
            const nextMin = Number(e.target.value);
            const next = { type: 'numeric' as const, min: nextMin, max: Math.max(nextMin, current.max) };
            if (next.min === lo && next.max === hi) onChange(undefined);
            else onChange(next);
          }}
          className="w-full accent-blue-500"
        />
        <input
          type="range"
          min={lo}
          max={hi}
          step={(hi - lo) / 100 || 1}
          value={current.max}
          onChange={(e) => {
            const nextMax = Number(e.target.value);
            const next = { type: 'numeric' as const, min: Math.min(current.min, nextMax), max: nextMax };
            if (next.min === lo && next.max === hi) onChange(undefined);
            else onChange(next);
          }}
          className="w-full accent-blue-500"
        />
      </div>
    </div>
  );
}

function DateFilter({
  field,
  value,
  onChange,
}: {
  field: FieldInfo;
  value: Extract<FilterValue, { type: 'date' }> | undefined;
  onChange: (next: FilterValue | undefined) => void;
}) {
  if (!field.minDate || !field.maxDate) return null;
  const loMs = new Date(field.minDate).getTime();
  const hiMs = new Date(field.maxDate).getTime();
  const current = value ?? { type: 'date' as const, min: loMs, max: hiMs };
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-gray-300">{field.name}</span>
        <span className="text-[10px] text-gray-500">{fmt(current.min)} – {fmt(current.max)}</span>
      </div>
      <div className="grid grid-cols-2 gap-1">
        <input
          type="date"
          value={fmt(current.min)}
          min={fmt(loMs)}
          max={fmt(hiMs)}
          onChange={(e) => {
            const t = new Date(e.target.value).getTime();
            if (!Number.isFinite(t)) return;
            const next = { type: 'date' as const, min: t, max: Math.max(t, current.max) };
            if (next.min === loMs && next.max === hiMs) onChange(undefined);
            else onChange(next);
          }}
          className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs"
        />
        <input
          type="date"
          value={fmt(current.max)}
          min={fmt(loMs)}
          max={fmt(hiMs)}
          onChange={(e) => {
            const t = new Date(e.target.value).getTime();
            if (!Number.isFinite(t)) return;
            const next = { type: 'date' as const, min: Math.min(current.min, t), max: t };
            if (next.min === loMs && next.max === hiMs) onChange(undefined);
            else onChange(next);
          }}
          className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs"
        />
      </div>
    </div>
  );
}

function TextFilter({
  field,
  value,
  onChange,
}: {
  field: FieldInfo;
  value: Extract<FilterValue, { type: 'text' }> | undefined;
  onChange: (next: FilterValue | undefined) => void;
}) {
  return (
    <div>
      <div className="text-xs font-semibold text-gray-300 mb-1">{field.name}</div>
      <input
        type="text"
        placeholder={`substring · ${field.uniqueCount} unique`}
        value={value?.query ?? ''}
        onChange={(e) => {
          const q = e.target.value;
          if (!q) onChange(undefined);
          else onChange({ type: 'text', query: q });
        }}
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500"
      />
    </div>
  );
}

export default function FilterPanel({ fields, rows, filters, onChange }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const setFilter = (name: string, v: FilterValue | undefined) => {
    const next = { ...filters };
    if (v === undefined) delete next[name];
    else next[name] = v;
    onChange(next);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3 border-b border-gray-700 pb-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-blue-400">
          Filters
        </h2>
        <button
          onClick={() => onChange({})}
          className="text-[10px] text-gray-400 hover:text-white"
          disabled={Object.keys(filters).length === 0}
        >
          reset all
        </button>
      </div>
      <div className="space-y-3">
        {fields.map(field => {
          const isOpen = !collapsed[field.name];
          let body: React.ReactNode = null;
          if (isCategorical(field)) {
            body = (
              <CategoricalFilter
                field={field}
                rows={rows}
                value={filters[field.name] as Extract<FilterValue, { type: 'categorical' }> | undefined}
                onChange={(v) => setFilter(field.name, v)}
              />
            );
          } else if (field.type === 'number') {
            body = (
              <NumericFilter
                field={field}
                value={filters[field.name] as Extract<FilterValue, { type: 'numeric' }> | undefined}
                onChange={(v) => setFilter(field.name, v)}
              />
            );
          } else if (field.type === 'date') {
            body = (
              <DateFilter
                field={field}
                value={filters[field.name] as Extract<FilterValue, { type: 'date' }> | undefined}
                onChange={(v) => setFilter(field.name, v)}
              />
            );
          } else {
            // Free text or high-cardinality string → substring filter
            body = (
              <TextFilter
                field={field}
                value={filters[field.name] as Extract<FilterValue, { type: 'text' }> | undefined}
                onChange={(v) => setFilter(field.name, v)}
              />
            );
          }

          const active = filters[field.name] !== undefined;
          return (
            <div key={field.name} className={`rounded p-2 ${active ? 'bg-blue-950/30 border border-blue-900' : 'bg-gray-800/40'}`}>
              <button
                onClick={() => setCollapsed(c => ({ ...c, [field.name]: isOpen }))}
                className="w-full flex items-center justify-between text-left mb-1"
              >
                <span className="text-[10px] uppercase tracking-wider text-gray-500">{field.name}</span>
                <span className="text-[10px] text-gray-500">{isOpen ? '−' : '+'}</span>
              </button>
              {isOpen && body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
