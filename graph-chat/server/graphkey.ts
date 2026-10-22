/**
 * The graph key - what scopes the cache.
 *
 * Two viewers who load the same file must produce the same key, or the shared
 * cache is not shared. Two different files must produce different keys, or an
 * answer about one corpus is served for a question about the other.
 *
 * So it is derived from the file's CONTENT, not from its name: a filename is
 * not an identity, and "Graph_Viz.json" is the name of several different
 * files in this project already. The ingredients are the shape report's counts
 * and the sorted triplet ids, hashed with the engine's own `fnv1a32`.
 *
 * It is not a security hash and is not claimed to be one. It is a cache scope.
 */

import { fnv1a32 } from '../engine/text.js';
import type { MessageKeySource, ShapeReport } from '../engine/types.js';

export interface GraphKeyInput {
  shape: ShapeReport;
  /** Every `triplet_id` in the normalised corpus. Order does not matter. */
  tripletIds: readonly string[];
  /** Which key the file supplies for "same source message". It is part of
   *  the key on purpose: an answer grouped by rows is a DIFFERENT answer from
   *  one grouped by messages, so the two must never share a cache entry. */
  messageKeyAvailable: MessageKeySource;
}

export function graphKeyOf(input: GraphKeyInput): string {
  const ids = Array.from(input.tripletIds).sort();
  const header = [
    input.shape.shape,
    String(input.shape.nodeCount),
    String(input.shape.edgeCount),
    String(input.shape.tripletNodeCount),
    String(ids.length),
    'mk=' + input.messageKeyAvailable,
  ].join('|');
  // Hashed in two passes so a very large id list does not have to be held as
  // one string: the running hash is folded into the next chunk.
  let running = fnv1a32(header);
  const CHUNK = 512;
  for (let i = 0; i < ids.length; i += CHUNK) {
    running = fnv1a32(running + '|' + ids.slice(i, i + CHUNK).join(','));
  }
  return 'gk1:' + fnv1a32(header) + '-' + running;
}
