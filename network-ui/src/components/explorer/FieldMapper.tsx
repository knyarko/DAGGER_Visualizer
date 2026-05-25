import type { FieldInfo } from '../../lib/parseData';
import type { VisualMapping } from '../../lib/mapping';
import { TYPE_LABELS, DEGREE_TOTAL, DEGREE_IN, DEGREE_OUT } from '../../lib/mapping';

interface Props {
  fields: FieldInfo[];
  mapping: VisualMapping;
  onChange: (mapping: VisualMapping) => void;
}

interface SpecialOption {
  value: string;
  label: string;
}

interface RowProps {
  label: string;
  hint: string;
  value: string | null;
  fields: FieldInfo[];
  required?: boolean;
  filter?: (f: FieldInfo) => boolean;
  onChange: (next: string | null) => void;
  /** Computed/synthetic options shown grouped above the real fields. */
  specialOptions?: SpecialOption[];
  specialGroupLabel?: string;
}

function MapRow({ label, hint, value, fields, required, filter, onChange, specialOptions, specialGroupLabel }: RowProps) {
  const filtered = filter ? fields.filter(filter) : fields;
  const hasSpecial = specialOptions && specialOptions.length > 0;
  return (
    <label className="block">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-300">
          {label}
          {required && <span className="text-red-400 ml-1">*</span>}
        </span>
        <span className="text-[10px] text-gray-500">{hint}</span>
      </div>
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
      >
        {!required && <option value="">(none)</option>}
        {hasSpecial && (
          <optgroup label={specialGroupLabel ?? 'Computed'}>
            {specialOptions!.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </optgroup>
        )}
        {hasSpecial ? (
          <optgroup label="Fields">
            {filtered.map(f => (
              <option key={f.name} value={f.name}>
                {f.name} · {TYPE_LABELS[f.type]} · {f.uniqueCount} unique
              </option>
            ))}
          </optgroup>
        ) : (
          filtered.map(f => (
            <option key={f.name} value={f.name}>
              {f.name} · {TYPE_LABELS[f.type]} · {f.uniqueCount} unique
            </option>
          ))
        )}
      </select>
    </label>
  );
}

export default function FieldMapper({ fields, mapping, onChange }: Props) {
  const set = <K extends keyof VisualMapping>(key: K, value: VisualMapping[K]) =>
    onChange({ ...mapping, [key]: value });

  const isNumeric = (f: FieldInfo) => f.type === 'number';

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-bold uppercase tracking-wider text-blue-400 border-b border-gray-700 pb-2">
        Visual mapping
      </h2>
      <MapRow
        label="Source (from)"
        hint="edge origin"
        value={mapping.sourceField}
        required
        fields={fields}
        onChange={(v) => v && set('sourceField', v)}
      />
      <MapRow
        label="Target (to)"
        hint="edge destination"
        value={mapping.targetField}
        required
        fields={fields}
        onChange={(v) => v && set('targetField', v)}
      />
      <MapRow
        label="Edge label"
        hint="hover text on link"
        value={mapping.edgeLabelField}
        fields={fields}
        onChange={(v) => set('edgeLabelField', v)}
      />
      <MapRow
        label="Node color by"
        hint="categorical → discrete palette"
        value={mapping.nodeColorField}
        fields={fields}
        onChange={(v) => set('nodeColorField', v)}
      />
      <MapRow
        label="Node size by"
        hint="centrality or numeric field"
        value={mapping.nodeSizeField}
        fields={fields}
        filter={isNumeric}
        specialGroupLabel="Centrality"
        specialOptions={[
          { value: DEGREE_TOTAL, label: 'Total connections (in + out degree)' },
          { value: DEGREE_IN, label: 'Incoming connections (in-degree)' },
          { value: DEGREE_OUT, label: 'Outgoing connections (out-degree)' },
        ]}
        onChange={(v) => set('nodeSizeField', v)}
      />
      <MapRow
        label="Edge weight by"
        hint="numeric → stroke width"
        value={mapping.edgeWeightField}
        fields={fields}
        filter={isNumeric}
        onChange={(v) => set('edgeWeightField', v)}
      />
    </div>
  );
}
