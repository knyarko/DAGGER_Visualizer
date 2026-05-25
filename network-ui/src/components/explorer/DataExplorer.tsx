import { useEffect, useMemo, useState } from 'react';
import FileUpload from './FileUpload';
import FieldMapper from './FieldMapper';
import FilterPanel from './FilterPanel';
import DirectedGraph from './DirectedGraph';
import type { DatasetOption } from '../../lib/parseData';
import { suggestMapping, type FilterMap, type VisualMapping } from '../../lib/mapping';
import { enumerateChains, reachableWithin, chainToEdgeKeys } from '../../lib/chains';

const CHAIN_MAX_PATHS = 200;

interface Props {
  onSwitchMode?: () => void;
}

/**
 * Iteratively prune nodes whose undirected degree (in + out) falls below `k`,
 * recompute, repeat until convergence. Returns the surviving edge rows.
 *
 * Standard k-core decomposition. k=2 is the natural answer to "show only
 * multi-hop chains" — a node survives iff it's interior to the remaining
 * graph after all dangling leaves have been peeled off.
 */
function applyKCore(
  rows: Record<string, unknown>[],
  srcField: string,
  tgtField: string,
  k: number,
): Record<string, unknown>[] {
  if (k <= 0 || rows.length === 0) return rows;

  // Index edges + initial degrees
  type Edge = { s: string; t: string; row: Record<string, unknown> };
  const edges: Edge[] = [];
  const degree = new Map<string, number>();
  for (const r of rows) {
    const sv = r[srcField];
    const tv = r[tgtField];
    if (sv === null || sv === undefined || sv === '') continue;
    if (tv === null || tv === undefined || tv === '') continue;
    const s = String(sv);
    const t = String(tv);
    edges.push({ s, t, row: r });
    degree.set(s, (degree.get(s) ?? 0) + 1);
    degree.set(t, (degree.get(t) ?? 0) + 1);
  }

  const removed = new Set<string>();
  // Repeat until no more nodes drop below k
  let changed = true;
  while (changed) {
    changed = false;
    for (const [node, deg] of degree.entries()) {
      if (removed.has(node)) continue;
      if (deg < k) {
        removed.add(node);
        changed = true;
      }
    }
    if (!changed) break;
    // Recompute degrees on the surviving subgraph
    degree.clear();
    for (const e of edges) {
      if (removed.has(e.s) || removed.has(e.t)) continue;
      degree.set(e.s, (degree.get(e.s) ?? 0) + 1);
      degree.set(e.t, (degree.get(e.t) ?? 0) + 1);
    }
  }

  return edges.filter(e => !removed.has(e.s) && !removed.has(e.t)).map(e => e.row);
}

function applyFilters(
  rows: Record<string, unknown>[],
  filters: FilterMap,
): Record<string, unknown>[] {
  const entries = Object.entries(filters);
  if (entries.length === 0) return rows;
  return rows.filter(row => {
    for (const [field, f] of entries) {
      const v = row[field];
      if (f.type === 'categorical') {
        if (v === null || v === undefined || v === '') return false;
        if (!f.allowed.has(String(v))) return false;
      } else if (f.type === 'numeric') {
        if (v === null || v === undefined || v === '') return false;
        const n = Number(v);
        if (!Number.isFinite(n)) return false;
        if (n < f.min || n > f.max) return false;
      } else if (f.type === 'date') {
        if (v === null || v === undefined || v === '') return false;
        const t = Date.parse(String(v));
        if (!Number.isFinite(t)) return false;
        if (t < f.min || t > f.max) return false;
      } else if (f.type === 'text') {
        if (v === null || v === undefined || v === '') return false;
        if (!String(v).toLowerCase().includes(f.query.toLowerCase())) return false;
      }
    }
    return true;
  });
}

export default function DataExplorer({ onSwitchMode }: Props) {
  const [options, setOptions] = useState<DatasetOption[] | null>(null);
  const [sourceFileName, setSourceFileName] = useState<string>('');
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<VisualMapping | null>(null);
  const [filters, setFilters] = useState<FilterMap>({});
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [showMapper, setShowMapper] = useState(true);
  const [showSourcePicker, setShowSourcePicker] = useState(false);
  const [kCore, setKCore] = useState(0);
  const [chainDepth, setChainDepth] = useState(0);
  const [chainDirection, setChainDirection] = useState<'downstream' | 'upstream'>('downstream');
  const [selectedChainIndex, setSelectedChainIndex] = useState<number | null>(null);
  // Visual layout: spread is a multiplier on link distance + charge repulsion.
  // 1.0 = packed default; higher values pull dense clusters apart.
  const [spread, setSpread] = useState(1.0);

  const dataset = useMemo(() => {
    if (!options || !selectedOptionId) return null;
    return options.find(o => o.id === selectedOptionId)?.dataset ?? null;
  }, [options, selectedOptionId]);

  const handleLoaded = (opts: DatasetOption[], fileName: string) => {
    setOptions(opts);
    setSourceFileName(fileName);
    const recommended = opts.find(o => o.recommended) ?? opts[0];
    setSelectedOptionId(recommended.id);
    // Force the picker open if there is a real choice to make
    setShowSourcePicker(opts.length > 1);
    setMapping(suggestMapping(recommended.dataset.fields));
    setFilters({});
    setSelectedNode(null);
    setShowMapper(true);
  };

  // When user switches between candidate arrays in the same file, reset mapping + filters
  // (different arrays have different fields, so the old mapping is meaningless)
  useEffect(() => {
    if (!dataset) return;
    setMapping(suggestMapping(dataset.fields));
    setFilters({});
    setSelectedNode(null);
    setKCore(0);
    setChainDepth(0);
    setSelectedChainIndex(null);
  }, [selectedOptionId]); // intentional: only re-run when the chosen option changes

  // Whenever the selection changes (or chain controls change), reset the
  // active chain index — old indexes don't map to the new chain list.
  useEffect(() => {
    setSelectedChainIndex(null);
  }, [selectedNode, chainDepth, chainDirection]);

  const filteredRows = useMemo(() => {
    if (!dataset) return [];
    return applyFilters(dataset.rows, filters);
  }, [dataset, filters]);

  // Topology filter applied AFTER field filters so the user sees the cumulative effect
  const prunedRows = useMemo(() => {
    if (!mapping || kCore <= 0) return filteredRows;
    return applyKCore(filteredRows, mapping.sourceField, mapping.targetField, kCore);
  }, [filteredRows, mapping, kCore]);

  // Pull out details of the selected node (using rows that mention it)
  const selectionRows = useMemo(() => {
    if (!dataset || !mapping || !selectedNode) return [];
    return prunedRows.filter(r =>
      String(r[mapping.sourceField]) === selectedNode ||
      String(r[mapping.targetField]) === selectedNode
    );
  }, [prunedRows, mapping, dataset, selectedNode]);

  // Build directed adjacency once from the currently-visible rows; reused for
  // both chain enumeration and reachability dimming.
  const adjacency = useMemo(() => {
    if (!mapping) return { out: new Map<string, Set<string>>(), inc: new Map<string, Set<string>>() };
    const out = new Map<string, Set<string>>();
    const inc = new Map<string, Set<string>>();
    for (const r of prunedRows) {
      const sv = r[mapping.sourceField];
      const tv = r[mapping.targetField];
      if (sv === null || sv === undefined || sv === '') continue;
      if (tv === null || tv === undefined || tv === '') continue;
      const s = String(sv);
      const t = String(tv);
      if (!out.has(s)) out.set(s, new Set());
      out.get(s)!.add(t);
      if (!inc.has(t)) inc.set(t, new Set());
      inc.get(t)!.add(s);
    }
    return { out, inc };
  }, [prunedRows, mapping]);

  // Enumerate directed paths from the selected node up to chainDepth, in the
  // chosen direction. Returns array of node-id arrays sorted longest-first.
  const chains = useMemo<string[][]>(() => {
    if (!selectedNode || chainDepth <= 0) return [];
    const adj = chainDirection === 'downstream' ? adjacency.out : adjacency.inc;
    return enumerateChains(selectedNode, adj, chainDepth, CHAIN_MAX_PATHS);
  }, [selectedNode, chainDepth, chainDirection, adjacency]);

  // Set of node ids to display brightly. When a specific chain is selected,
  // only its nodes; otherwise the full reachable neighbourhood.
  const highlightedNodes = useMemo<Set<string> | null>(() => {
    if (!selectedNode || chainDepth <= 0) return null;
    if (selectedChainIndex !== null && chains[selectedChainIndex]) {
      return new Set(chains[selectedChainIndex]);
    }
    const adj = chainDirection === 'downstream' ? adjacency.out : adjacency.inc;
    return reachableWithin(selectedNode, adj, chainDepth);
  }, [selectedNode, chainDepth, chainDirection, chains, selectedChainIndex, adjacency]);

  // Cyan-highlight only the edges that belong to the active chain.
  const highlightedEdgeKeys = useMemo<Set<string> | null>(() => {
    if (selectedChainIndex === null || !chains[selectedChainIndex]) return null;
    return chainToEdgeKeys(chains[selectedChainIndex], chainDirection);
  }, [chains, selectedChainIndex, chainDirection]);

  if (!options || !dataset || !mapping || !selectedOptionId) {
    return (
      <div className="relative">
        <FileUpload onLoaded={handleLoaded} />
        {onSwitchMode && (
          <button
            onClick={onSwitchMode}
            className="absolute top-4 right-4 text-xs text-gray-400 hover:text-white px-3 py-1.5 border border-gray-700 rounded"
          >
            Open Epstein viewer →
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-900 text-white">
      {/* Left sidebar: dataset info + source picker + filters */}
      <aside className="w-72 shrink-0 border-r border-gray-800 flex flex-col">
        <div className="p-3 border-b border-gray-800">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-sm font-bold">Network Explorer</h1>
            {onSwitchMode && (
              <button
                onClick={onSwitchMode}
                className="text-[10px] text-gray-400 hover:text-white"
                title="Switch to original Epstein viewer"
              >
                Epstein →
              </button>
            )}
          </div>
          <div className="text-xs text-gray-400 truncate" title={sourceFileName}>
            📄 {sourceFileName}
          </div>
          <div className="text-[10px] text-gray-500 mt-1">
            {dataset.rows.length} rows · {dataset.fields.length} fields ·
            {' '}{filteredRows.length} after filters
            {kCore > 0 && ` · ${prunedRows.length} after k-core`}
          </div>
          <div className="flex items-center gap-3 mt-2">
            <button
              onClick={() => {
                setOptions(null);
                setSelectedOptionId(null);
                setMapping(null);
              }}
              className="text-[10px] text-blue-400 hover:text-blue-300"
            >
              ← Load a different file
            </button>
            {options.length > 1 && (
              <button
                onClick={() => setShowSourcePicker(s => !s)}
                className="text-[10px] text-blue-400 hover:text-blue-300"
              >
                {showSourcePicker ? 'Hide sources' : `Sources (${options.length})`}
              </button>
            )}
          </div>
        </div>

        {showSourcePicker && options.length > 1 && (
          <div className="p-3 border-b border-gray-800 bg-gray-950">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
              This file contains multiple arrays. Pick which to visualize:
            </div>
            <div className="space-y-1.5">
              {options.map(opt => {
                const isActive = opt.id === selectedOptionId;
                return (
                  <button
                    key={opt.id}
                    onClick={() => setSelectedOptionId(opt.id)}
                    className={`w-full text-left p-2 rounded border text-xs transition-colors ${
                      isActive
                        ? 'bg-blue-900/40 border-blue-700'
                        : 'bg-gray-800/40 border-gray-700 hover:bg-gray-800'
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`inline-block w-2 h-2 rounded-full ${isActive ? 'bg-blue-400' : 'bg-gray-600'}`} />
                      <span className="font-medium">{opt.label}</span>
                      {opt.recommended && (
                        <span className="text-[9px] uppercase tracking-wider text-emerald-400">default</span>
                      )}
                    </div>
                    <div className="text-[10px] text-gray-400 mt-0.5">{opt.description}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="overflow-y-auto p-3 flex-1 space-y-4">
          {/* Visual layout controls */}
          <div>
            <div className="flex items-center justify-between mb-3 border-b border-gray-700 pb-2">
              <h2 className="text-sm font-bold uppercase tracking-wider text-blue-400">Layout</h2>
              {spread !== 1.0 && (
                <button
                  onClick={() => setSpread(1.0)}
                  className="text-[10px] text-gray-400 hover:text-white"
                >
                  reset
                </button>
              )}
            </div>
            <div className={`rounded p-2 ${spread !== 1.0 ? 'bg-blue-950/30 border border-blue-900' : 'bg-gray-800/40'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-gray-300">Spread</span>
                <span className="text-[10px] text-gray-500">×{spread.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={0.3}
                max={16}
                step={0.1}
                value={spread}
                onChange={(e) => setSpread(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
              <div className="flex justify-between text-[9px] text-gray-500 mt-0.5">
                <span>compact</span>
                <span>spread out</span>
              </div>
            </div>
          </div>

          {/* Topology filter: K-core decomposition */}
          <div>
            <div className="flex items-center justify-between mb-3 border-b border-gray-700 pb-2">
              <h2 className="text-sm font-bold uppercase tracking-wider text-blue-400">Topology</h2>
              {kCore > 0 && (
                <button
                  onClick={() => setKCore(0)}
                  className="text-[10px] text-gray-400 hover:text-white"
                >
                  reset
                </button>
              )}
            </div>
            <div className={`rounded p-2 ${kCore > 0 ? 'bg-blue-950/30 border border-blue-900' : 'bg-gray-800/40'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-gray-300">Min node degree (k-core)</span>
                <span className="text-[10px] text-gray-500">k = {kCore}</span>
              </div>
              <input
                type="range"
                min={0}
                max={5}
                step={1}
                value={kCore}
                onChange={(e) => setKCore(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
              <div className="text-[10px] text-gray-500 mt-0.5">
                {kCore === 0
                  ? 'no topology filter'
                  : `iteratively drops nodes with degree < ${kCore}`}
              </div>
              {kCore > 0 && (
                <div className="text-[10px] text-blue-300 mt-1">
                  {filteredRows.length - prunedRows.length} edges pruned
                </div>
              )}
            </div>
          </div>

          {/* Per-field filters */}
          <FilterPanel
            fields={dataset.fields}
            rows={dataset.rows}
            filters={filters}
            onChange={setFilters}
          />
        </div>
      </aside>

      {/* Center: graph */}
      <main className="flex-1 relative min-w-0">
        <DirectedGraph
          rows={prunedRows}
          fields={dataset.fields}
          mapping={mapping}
          selectedNode={selectedNode}
          onNodeClick={setSelectedNode}
          highlightedNodes={highlightedNodes}
          highlightedEdgeKeys={highlightedEdgeKeys}
          spread={spread}
        />
      </main>

      {/* Right sidebar: visual mapping + selection details */}
      <aside className="w-80 shrink-0 border-l border-gray-800 flex flex-col">
        <div className="border-b border-gray-800">
          <button
            onClick={() => setShowMapper(s => !s)}
            className="w-full text-left p-3 flex items-center justify-between hover:bg-gray-800/50"
          >
            <span className="text-sm font-bold uppercase tracking-wider text-blue-400">Mapping</span>
            <span className="text-gray-500">{showMapper ? '−' : '+'}</span>
          </button>
          {showMapper && (
            <div className="p-3 pt-0">
              <FieldMapper fields={dataset.fields} mapping={mapping} onChange={setMapping} />
            </div>
          )}
        </div>

        {selectedNode && (
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold truncate" title={selectedNode}>{selectedNode}</h2>
              <button
                onClick={() => setSelectedNode(null)}
                className="text-gray-500 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            {/* Chain controls */}
            <div className={`rounded p-2 ${chainDepth > 0 ? 'bg-blue-950/30 border border-blue-900' : 'bg-gray-800/40'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold text-gray-300">Chain depth</span>
                <span className="text-[10px] text-gray-500">{chainDepth === 0 ? 'off' : `${chainDepth} hop${chainDepth === 1 ? '' : 's'}`}</span>
              </div>
              <input
                type="range"
                min={0}
                max={5}
                step={1}
                value={chainDepth}
                onChange={(e) => setChainDepth(Number(e.target.value))}
                className="w-full accent-blue-500"
              />
              {chainDepth > 0 && (
                <div className="mt-2 flex items-center gap-1 text-[10px]">
                  <span className="text-gray-500 mr-1">direction</span>
                  <button
                    onClick={() => setChainDirection('downstream')}
                    className={`px-2 py-0.5 rounded ${chainDirection === 'downstream' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}
                  >
                    downstream →
                  </button>
                  <button
                    onClick={() => setChainDirection('upstream')}
                    className={`px-2 py-0.5 rounded ${chainDirection === 'upstream' ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}
                  >
                    ← upstream
                  </button>
                </div>
              )}
            </div>

            {/* Chain browser OR flat relationships list */}
            {chainDepth > 0 ? (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] uppercase tracking-wider text-gray-400">
                    {chains.length === 0
                      ? 'no chains found'
                      : `${chains.length} chain${chains.length === 1 ? '' : 's'}${chains.length >= CHAIN_MAX_PATHS ? '+' : ''}`}
                  </div>
                  {selectedChainIndex !== null && (
                    <button
                      onClick={() => setSelectedChainIndex(null)}
                      className="text-[10px] text-blue-400 hover:text-blue-300"
                    >
                      show all
                    </button>
                  )}
                </div>
                {chains.length > 0 && selectedChainIndex !== null && (
                  <div className="flex items-center gap-1 mb-2">
                    <button
                      onClick={() => setSelectedChainIndex(Math.max(0, selectedChainIndex - 1))}
                      disabled={selectedChainIndex === 0}
                      className="px-2 py-0.5 text-[10px] bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700"
                    >
                      ← prev
                    </button>
                    <button
                      onClick={() => setSelectedChainIndex(Math.min(chains.length - 1, selectedChainIndex + 1))}
                      disabled={selectedChainIndex >= chains.length - 1}
                      className="px-2 py-0.5 text-[10px] bg-gray-800 rounded disabled:opacity-30 hover:bg-gray-700"
                    >
                      next →
                    </button>
                    <span className="text-[10px] text-gray-500 ml-1">
                      {selectedChainIndex + 1} / {chains.length}
                    </span>
                  </div>
                )}
                <div className="space-y-1">
                  {chains.slice(0, 200).map((chain, i) => {
                    const isActive = i === selectedChainIndex;
                    const arrow = chainDirection === 'downstream' ? '→' : '←';
                    return (
                      <button
                        key={i}
                        onClick={() => setSelectedChainIndex(isActive ? null : i)}
                        className={`w-full text-left text-xs rounded p-2 transition-colors ${
                          isActive ? 'bg-blue-900/40 border border-blue-700' : 'bg-gray-800/50 hover:bg-gray-800'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="text-[9px] uppercase tracking-wider text-gray-500">
                            {chain.length - 1} hop{chain.length - 1 === 1 ? '' : 's'}
                          </span>
                          {isActive && <span className="text-[9px] text-cyan-400">active</span>}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                          {chain.map((n, j) => (
                            <span key={j} className="flex items-center gap-1">
                              <span className={`truncate ${n === selectedNode ? 'text-cyan-300 font-semibold' : 'text-gray-200'}`}>
                                {n}
                              </span>
                              {j < chain.length - 1 && (
                                <span className="text-gray-500">{arrow}</span>
                              )}
                            </span>
                          ))}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div>
                <div className="text-[10px] text-gray-500 mb-2">
                  {selectionRows.length} direct relationship{selectionRows.length === 1 ? '' : 's'}
                </div>
                <div className="space-y-1.5">
                  {selectionRows.slice(0, 100).map((r, i) => {
                    const s = String(r[mapping.sourceField]);
                    const t = String(r[mapping.targetField]);
                    const isOut = s === selectedNode;
                    const other = isOut ? t : s;
                    const label = mapping.edgeLabelField ? String(r[mapping.edgeLabelField] ?? '') : '';
                    return (
                      <div key={i} className="text-xs bg-gray-800/50 rounded p-2">
                        <div className="flex items-center gap-1.5">
                          <span className={isOut ? 'text-blue-400' : 'text-emerald-400'}>
                            {isOut ? '→' : '←'}
                          </span>
                          <span
                            className="font-medium cursor-pointer hover:underline truncate"
                            onClick={() => setSelectedNode(other)}
                          >
                            {other}
                          </span>
                        </div>
                        {label && <div className="text-gray-400 mt-0.5">{label}</div>}
                      </div>
                    );
                  })}
                  {selectionRows.length > 100 && (
                    <div className="text-[10px] text-gray-500 text-center pt-1">
                      …{selectionRows.length - 100} more
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
