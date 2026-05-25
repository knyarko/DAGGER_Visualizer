import { useRef, useState } from 'react';
import { parseFileToOptions, parseURLToOptions, type DatasetOption } from '../../lib/parseData';

interface SampleDataset {
  label: string;
  url: string;
  description: string;
}

// BASE_URL is '/' in dev and '/<repo>/' under GitHub Pages, so samples resolve in both
const BASE = import.meta.env.BASE_URL;

const SAMPLES: SampleDataset[] = [
  {
    label: 'GoT Battles (CSV)',
    url: `${BASE}samples/got_battles.csv`,
    description: '20 battles · attacker → defender · 9 fields',
  },
  {
    label: 'Email Traffic (CSV)',
    url: `${BASE}samples/email_traffic.csv`,
    description: '20 emails · sender → recipient · 7 fields',
  },
  {
    label: 'LotR Interactions (JSON)',
    url: `${BASE}samples/character_interactions.json`,
    description: '25 interactions · from → to · 6 fields',
  },
];

interface Props {
  onLoaded: (options: DatasetOption[], fileName: string) => void;
}

export default function FileUpload({ onLoaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (files: FileList | File[]) => {
    const file = Array.from(files)[0];
    if (!file) return;
    setError(null);
    setLoading(file.name);
    try {
      const options = await parseFileToOptions(file);
      if (options.length === 0 || options.every(o => o.dataset.rows.length === 0)) {
        throw new Error('No rows found in file');
      }
      onLoaded(options, file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  };

  const loadSample = async (sample: SampleDataset) => {
    setError(null);
    setLoading(sample.label);
    try {
      const options = await parseURLToOptions(sample.url, sample.label);
      onLoaded(options, sample.label);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen px-6 py-12 bg-gray-900 text-white">
      <div className="w-full max-w-2xl">
        <h1 className="text-3xl font-bold mb-2 text-center">Network Explorer</h1>
        <p className="text-gray-400 text-center mb-10">
          Upload a CSV or JSON file. Pick which columns become source/target nodes,
          which drive color and size, and which act as filters. The graph renders as a directed network.
        </p>

        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
          }}
          className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors ${
            dragOver ? 'border-blue-500 bg-blue-500/10' : 'border-gray-700 hover:border-gray-500'
          }`}
        >
          <svg className="mx-auto h-12 w-12 text-gray-500 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M7 16a4 4 0 01-.88-7.9 5 5 0 019.9-1A5.5 5.5 0 0118 16.5M12 12v8m0 0l-3-3m3 3l3-3" />
          </svg>
          <p className="text-lg mb-1">
            {loading ? `Loading ${loading}…` : 'Drop a CSV or JSON file here'}
          </p>
          <p className="text-sm text-gray-500">or click to browse</p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            className="hidden"
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-900/50 border border-red-700 rounded text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400 mb-3">
            Or try a sample
          </h2>
          <div className="grid gap-2 sm:grid-cols-3">
            {SAMPLES.map((s) => (
              <button
                key={s.url}
                onClick={() => loadSample(s)}
                disabled={loading !== null}
                className="text-left p-3 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded border border-gray-700 transition-colors"
              >
                <div className="font-medium">{s.label}</div>
                <div className="text-xs text-gray-400 mt-1">{s.description}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-12 text-xs text-gray-500 space-y-1">
          <div className="font-semibold text-gray-400 mb-1">Accepted formats</div>
          <div>· CSV with a header row (quoted fields and escaped quotes supported)</div>
          <div>· JSON array of flat objects, e.g. <code className="text-gray-400">[{`{"src":"A","dst":"B",...}`}]</code></div>
          <div>· JSON wrapper objects with a <code className="text-gray-400">data</code>, <code className="text-gray-400">rows</code>, <code className="text-gray-400">items</code>, or <code className="text-gray-400">links</code> array</div>
          <div>· JSON objects with multiple arrays (e.g. <code className="text-gray-400">{`{"nodes":[...],"edges":[...]}`}</code>) — you'll be asked which to visualize</div>
        </div>
      </div>
    </div>
  );
}
