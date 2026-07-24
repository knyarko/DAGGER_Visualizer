import { useRef, useState } from 'react';
import { parseFileToOptions, parseURLToOptions, type DatasetOption } from '../../lib/parseData';
import { buildLabel, BUILD_SHA_FULL, BUILD_TIME } from '../../lib/buildInfo';
import { SAMPLE_PASSWORDS } from '../../lib/lockConfig';

interface SampleDataset {
  label: string;
  url: string;
  description: string;
}

// BASE_URL is '/' in dev and '/<repo>/' under GitHub Pages, so samples resolve in both
const BASE = import.meta.env.BASE_URL;

const SAMPLES: SampleDataset[] = [
  {
    label: 'Crisis MD Causal Triplets (JSON)',
    url: `${BASE}samples/Causal_Relationship_Graph_Viz.json`,
    description: 'Sample of Crisis MMD causal relationships by triplets ( Subject → Predicate → Object ). · The CrisisMMD multimodal Twitter dataset consists of several thousands of manually annotated tweets and images collected during seven major natural disasters including earthquakes, hurricanes, wildfires, and floods that happened in the year 2017 across different parts of the World.',
  },
  {
    label: `Synthetic Data for Timeline View (JSON)`,
    url: `${BASE}samples/Timeline_Demo_Viz.json`,
    description: 'This dataset is a synthetic dataset that is used to demonstrate the timeline view of the network explorer.',
  },
];

// Locks are defined per-file in lockConfig.ts, keyed by the sample's path
// relative to BASE (so it works in both dev and GitHub Pages).
const relKey = (url: string) => (url.startsWith(BASE) ? url.slice(BASE.length) : url);
const passwordFor = (sample: SampleDataset): string | undefined => SAMPLE_PASSWORDS[relKey(sample.url)];
const isSampleLocked = (sample: SampleDataset): boolean => passwordFor(sample) !== undefined;

interface Props {
  onLoaded: (options: DatasetOption[], fileName: string) => void;
}

export default function FileUpload({ onLoaded }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which locked samples have been unlocked this session, plus the pending prompt.
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [pendingSample, setPendingSample] = useState<SampleDataset | null>(null);
  const [pwInput, setPwInput] = useState('');
  const [pwError, setPwError] = useState(false);

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

  // Clicking a sample: if locked and not yet unlocked this session, prompt.
  const handleSampleClick = (sample: SampleDataset) => {
    if (isSampleLocked(sample) && !unlocked.has(sample.url)) {
      setPendingSample(sample);
      setPwInput('');
      setPwError(false);
      return;
    }
    loadSample(sample);
  };

  const submitPassword = () => {
    if (!pendingSample) return;
    const expected = passwordFor(pendingSample);
    if (expected !== undefined && pwInput === expected) {
      setUnlocked(prev => new Set(prev).add(pendingSample.url));
      const s = pendingSample;
      setPendingSample(null);
      setPwInput('');
      setPwError(false);
      loadSample(s);
    } else {
      setPwError(true);
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
            {SAMPLES.map((s) => {
              const locked = isSampleLocked(s);
              const isLocked = locked && !unlocked.has(s.url);
              const isUnlocked = locked && unlocked.has(s.url);
              return (
                <button
                  key={s.url}
                  onClick={() => handleSampleClick(s)}
                  disabled={loading !== null}
                  className="relative text-left p-3 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded border border-gray-700 transition-colors"
                >
                  {isLocked && (
                    <svg className="absolute top-2 right-2 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M12 11v3m-6 6h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  )}
                  {isUnlocked && (
                    <svg className="absolute top-2 right-2 h-4 w-4 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M12 11v3m-6 6h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0" />
                    </svg>
                  )}
                  <div className="font-medium pr-5">{s.label}</div>
                  <div className="text-xs text-gray-400 mt-1">{s.description}</div>
                </button>
              );
            })}
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

      {pendingSample && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setPendingSample(null)}
        >
          <div
            className="w-full max-w-sm mx-4 rounded-lg border border-gray-700 bg-gray-800 p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-1">
              <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 11v3m-6 6h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <h3 className="font-semibold">Locked sample</h3>
            </div>
            <p className="text-sm text-gray-400 mb-4">
              Enter the password to open “{pendingSample.label}”.
            </p>
            <input
              type="password"
              autoFocus
              value={pwInput}
              onChange={(e) => { setPwInput(e.target.value); setPwError(false); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitPassword();
                if (e.key === 'Escape') setPendingSample(null);
              }}
              placeholder="Password"
              className="w-full px-3 py-2 rounded bg-gray-900 border border-gray-700 text-white text-sm focus:outline-none focus:border-blue-500"
            />
            {pwError && (
              <div className="mt-2 text-xs text-red-400">Incorrect password.</div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setPendingSample(null)}
                className="px-3 py-1.5 text-sm rounded border border-gray-700 text-gray-300 hover:bg-gray-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitPassword}
                className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
              >
                Unlock
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className="fixed bottom-2 right-3 text-[10px] text-gray-600 font-mono select-text"
        title={BUILD_TIME ? `${BUILD_SHA_FULL}\n${BUILD_TIME}` : BUILD_SHA_FULL}
      >
        {buildLabel()}
      </div>
    </div>
  );
}
