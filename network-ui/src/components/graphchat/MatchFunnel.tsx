/**
 * The match funnel — how the match narrowed, in three segments.
 *
 * Ordered magnitude on one hue, so it takes the ORDINAL ramp and not the
 * categorical one. The line under it is not a caption: the node-versus-triplet
 * distinction is the single most load-bearing fact in the whole answer, because
 * one TRIPLET node exists per (triplet, category) pair and a count over nodes
 * multiplies by category count.
 *
 * The strip renders even when nothing states a figure — "561 matched, none with
 * a number" is an answer, and a dead end is not.
 */

import type { FunnelStage } from './chartModel';
import { formatValue } from './chartModel';

export interface MatchFunnelProps {
  stages: FunnelStage[];
  /** Shape-dependent, so it cannot name a node type the loaded file lacks. */
  note: string;
}

export default function MatchFunnel({ stages, note }: MatchFunnelProps) {
  const widest = stages.reduce((max, s) => (s.value > max ? s.value : max), 0);
  return (
    <div>
      <div className="gc-funnel">
        {stages.map(stage => (
          <div
            key={stage.label}
            className="gc-funnel-seg"
            style={{
              background: stage.token,
              flexGrow: Math.max(1, widest === 0 ? 1 : (stage.value / widest) * 100),
            }}
          >
            <div className="gc-funnel-n" style={{ color: 'var(--gc-canvas)' }}>
              {formatValue(stage.value)}
            </div>
            <div className="gc-funnel-t" style={{ color: 'var(--gc-canvas)' }}>
              {stage.label}
            </div>
          </div>
        ))}
      </div>
      <div className="gc-funnel-note">{note}</div>
    </div>
  );
}
