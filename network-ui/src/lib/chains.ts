/**
 * Enumerate simple directed paths starting from `start`, walking `adjacency`
 * up to `maxDepth` edges. Each returned array is one path; the first element
 * is always `start`.
 *
 * - Simple: each node visited at most once per path (no cycles).
 * - Output is sorted longest-first so the most informative chains surface
 *   even when the cap clips the list.
 * - `maxPaths` is a hard cap to keep dense neighbourhoods (branching factor
 *   × depth) from blowing up enumeration time / memory.
 */
export function enumerateChains(
  start: string,
  adjacency: Map<string, Set<string>>,
  maxDepth: number,
  maxPaths: number,
): string[][] {
  if (maxDepth <= 0 || !adjacency.has(start)) {
    return adjacency.has(start) || maxDepth === 0 ? [] : [];
  }

  const paths: string[][] = [];
  const visited = new Set<string>([start]);
  const stack: string[] = [start];

  const dfs = (node: string, depth: number): boolean => {
    if (paths.length >= maxPaths) return true; // signal stop

    const neighbors = adjacency.get(node);
    const unvisited: string[] = [];
    if (neighbors) {
      for (const n of neighbors) {
        if (!visited.has(n)) unvisited.push(n);
      }
    }

    // If we can't extend further (depth cap or no unvisited neighbours),
    // record the current path (provided it covers more than just the start).
    if (depth >= maxDepth || unvisited.length === 0) {
      if (stack.length > 1) paths.push([...stack]);
      return false;
    }

    for (const n of unvisited) {
      visited.add(n);
      stack.push(n);
      const stop = dfs(n, depth + 1);
      stack.pop();
      visited.delete(n);
      if (stop) return true;
    }
    return false;
  };

  dfs(start, 0);

  // Longest first, then alphabetical-ish stable for determinism
  paths.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    for (let i = 1; i < a.length; i++) {
      if (a[i] < b[i]) return -1;
      if (a[i] > b[i]) return 1;
    }
    return 0;
  });

  return paths;
}

/**
 * BFS to find the set of all nodes reachable from `start` within `maxDepth`
 * directed hops via `adjacency`.
 *
 * Used for the dimming-mode "show everything reachable" view when no
 * specific chain is selected.
 */
export function reachableWithin(
  start: string,
  adjacency: Map<string, Set<string>>,
  maxDepth: number,
): Set<string> {
  const reached = new Set<string>([start]);
  if (maxDepth <= 0) return reached;

  let frontier: string[] = [start];
  for (let d = 0; d < maxDepth; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      const nbrs = adjacency.get(node);
      if (!nbrs) continue;
      for (const n of nbrs) {
        if (!reached.has(n)) {
          reached.add(n);
          next.push(n);
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return reached;
}

/**
 * Convert a chain (array of node IDs) into the set of directed edge keys
 * "source|||target" in the order edges actually exist in the graph.
 *
 * For downstream chains we walk chain[i] → chain[i+1]. For upstream chains
 * the chain is recorded as [start, predecessor1, predecessor2, ...], so the
 * actual directed edges run chain[i+1] → chain[i].
 */
export function chainToEdgeKeys(chain: string[], direction: 'downstream' | 'upstream'): Set<string> {
  const keys = new Set<string>();
  for (let i = 0; i < chain.length - 1; i++) {
    if (direction === 'downstream') keys.add(`${chain[i]}|||${chain[i + 1]}`);
    else keys.add(`${chain[i + 1]}|||${chain[i]}`);
  }
  return keys;
}
