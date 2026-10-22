/**
 * The stated-figures chart. One hue, one linear scale, no pie, no total.
 *
 * Everything load-bearing about WHAT is drawn lives in `chartModel.ts`; this
 * file is geometry. Three things in it are rules rather than styling:
 *
 *   1. EVERY BAR CARRIES ITS VALUE AT THE TIP. That is not decoration. The
 *      light-mode palette passes its validator with a contrast WARN, and the
 *      relief the validator requires for that WARN is that every value is
 *      reachable without seeing the mark. Drop the tip labels and the palette
 *      stops being legal.
 *   2. ONE HUE for every bar. Magnitude is carried by length and provenance by
 *      position in a labelled group, so hue has no job left; giving each bar
 *      its own hue would double-encode and burn the only free channel.
 *   3. THE FEATHER HAS A DIRECTION and it is the qualifier's own. Only an exact
 *      figure gets the rounded cap — a rounded data-end asserts a terminus, and
 *      `more than 2,000` has no terminus.
 *
 * No axis tick, label, title or aria-label anywhere in this file contains a sum
 * of stated figures. The axis maximum is the largest stated figure.
 */

import type { ReactNode } from 'react';
import type { FigureChartModel, FigureGroup } from './chartModel';
import { chartAriaLabel, formatValue, MIN_BAR_PX, qualifierWord } from './chartModel';

const VIEW_W = 920;
const BAR_X = 24;
const TRACK_W = 560;
const LABEL_X = BAR_X + TRACK_W + 16;

const BAND_H = 22;
const NOTE_H = 18;
const ROW_H = 26;
const BAR_H = 14; /* <= 24px, and the band's leftover is air */
const GROUP_GAP = 10;
const AXIS_H = 30;
const TOP_PAD = 4;

/** 4px rounded data-end, square at the baseline — exact figures only. */
function barPath(x: number, y: number, w: number, h: number, cap: number): string {
  const r = Math.min(cap, w, h / 2);
  if (r <= 0) return `M${x},${y} H${x + w} V${y + h} H${x} Z`;
  return (
    `M${x},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} ` +
    `V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x} Z`
  );
}

const FEATHER_OPACITY = [0.7, 0.45, 0.25];

function groupHeight(group: FigureGroup): number {
  return BAND_H + (group.note ? NOTE_H : 0) + group.bars.length * ROW_H + GROUP_GAP;
}

export interface FigureChartProps {
  model: FigureChartModel;
  /** The title says what is plotted, which is why a single series needs no
   *  legend box. */
  title: string;
  /** How these groups were keyed, in two or three words. The chart states its
   *  own grouping so it can never silently disagree with the line above it. */
  groupingWords: string;
  /** A bar stays highlighted while its evidence row is selected, and the other
   *  way round. */
  highlightTripletId?: string | null;
  onSelectTriplet?: (tripletId: string | null) => void;
}

export default function FigureChart({
  model,
  title,
  groupingWords,
  highlightTripletId = null,
  onSelectTriplet,
}: FigureChartProps) {
  if (model.groups.length === 0) {
    return (
      <div className="gc-chart" style={{ minHeight: 160, display: 'flex', alignItems: 'center' }}>
        <div className="gc-empty" style={{ width: '100%' }}>
          <b>Nothing to chart.</b>
          No triplet in this set states a figure. The counts above are still the answer.
        </div>
      </div>
    );
  }

  const bodyH = model.groups.reduce((sum, g) => sum + groupHeight(g), 0);
  const height = TOP_PAD + bodyH + AXIS_H;
  const scale = (value: number) =>
    model.axisMax <= 0 ? MIN_BAR_PX : Math.max(MIN_BAR_PX, (value / model.axisMax) * TRACK_W);

  let cursorY = TOP_PAD;
  const rows: ReactNode[] = [];

  for (const group of model.groups) {
    const bandY = cursorY;
    rows.push(
      <text key={group.key + '-band'} x={BAR_X} y={bandY + 14} className="gc-c-band">
        {(group.clusterId === null ? 'no source-message id' : group.clusterId) +
          ' ─ ' +
          group.bars.length +
          (group.bars.length === 1 ? ' figure' : ' figures') +
          ' from one source message'}
      </text>,
    );
    cursorY += BAND_H;

    if (group.note) {
      /* The engine's own words, verbatim. This sentence is the no-compounding
       * rule made visible at the exact place a reader would otherwise add two
       * bars together. */
      rows.push(
        <text key={group.key + '-note'} x={BAR_X + 8} y={cursorY + 12} className="gc-c-note">
          {group.note}
        </text>,
      );
      cursorY += NOTE_H;
    }

    const bracketTop = cursorY;
    for (const bar of group.bars) {
      const w = scale(bar.value);
      const y = cursorY + (ROW_H - BAR_H) / 2;
      const active = highlightTripletId !== null && highlightTripletId === bar.tripletId;
      rows.push(
        <g
          key={bar.key}
          onClick={onSelectTriplet ? () => onSelectTriplet(active ? null : bar.tripletId) : undefined}
          style={onSelectTriplet ? { cursor: 'pointer' } : undefined}
        >
          <title>{`${bar.label} — ${bar.raw} (${bar.tripletId})`}</title>
          {active && (
            <rect x={BAR_X - 4} y={cursorY} width={TRACK_W + 8} height={ROW_H} className="gc-c-active" />
          )}
          <path
            d={barPath(BAR_X, y, bar.feather === 'inward' ? Math.max(MIN_BAR_PX, w - 15) : w, BAR_H, bar.feather === 'none' ? 4 : 0)}
            className="gc-c-bar"
          />
          {bar.feather !== 'none' &&
            FEATHER_OPACITY.map((opacity, i) => {
              const fx =
                bar.feather === 'outward'
                  ? BAR_X + w + 2 + i * 5
                  : BAR_X + Math.max(MIN_BAR_PX, w - 15) + 2 + i * 5;
              return <rect key={i} x={fx} y={y} width={3} height={BAR_H} className="gc-c-bar" opacity={opacity} />;
            })}
          <text x={LABEL_X} y={y + BAR_H - 2} className="gc-c-value">
            {qualifierWord(bar.qualifier) !== '' && (
              <tspan className="gc-c-qual">{qualifierWord(bar.qualifier) + ' '}</tspan>
            )}
            <tspan className="gc-c-num">{formatValue(bar.value)}</tspan>
            {bar.unit ? <tspan className="gc-c-unit">{' ' + bar.unit}</tspan> : null}
          </text>
        </g>,
      );
      cursorY += ROW_H;
    }

    rows.push(
      <line
        key={group.key + '-bracket'}
        x1={BAR_X - 6}
        y1={bracketTop + 2}
        x2={BAR_X - 6}
        y2={cursorY - 2}
        className="gc-c-bracket"
      />,
    );
    cursorY += GROUP_GAP;
  }

  const axisY = TOP_PAD + bodyH + 2;

  return (
    <div className="gc-chart">
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        role="img"
        tabIndex={0}
        aria-label={chartAriaLabel(title, model)}
        style={{ maxHeight: 'none' }}
      >
        {/* Hairline, solid, one step off the surface, and recessive. */}
        {model.ticks.map(tick => {
          const x = model.axisMax <= 0 ? BAR_X : BAR_X + (tick / model.axisMax) * TRACK_W;
          return <line key={'t' + tick} x1={x} y1={TOP_PAD} x2={x} y2={axisY} className="gc-c-grid" />;
        })}
        {rows}
        <line x1={BAR_X} y1={axisY} x2={BAR_X + TRACK_W} y2={axisY} className="gc-c-axis" />
        {model.ticks.map(tick => {
          const x = model.axisMax <= 0 ? BAR_X : BAR_X + (tick / model.axisMax) * TRACK_W;
          return (
            <text key={'tl' + tick} x={x} y={axisY + 16} className="gc-c-tick" textAnchor="middle">
              {formatValue(tick)}
            </text>
          );
        })}
      </svg>
      <div className="gc-chart-sub" style={{ marginTop: 8 }}>
        {model.groupCount} source {model.groupCount === 1 ? 'message' : 'messages'} drawn,{' '}
        {groupingWords}. Bars are what each source states; they are never added together, and the
        axis stops at the largest stated figure.
      </div>
      {/* B067. The design draws a figure that one source states as a subset of
          another inset inside it. No containment relation reaches this view, so
          the bars are flat - and saying nothing about that would let a reader
          assume three bars from one message are three separate counts. */}
      {model.groups.some(group => group.bars.length > 1) && (
        <div className="gc-chart-sub" style={{ marginTop: 4 }}>
          Where one source states several figures they are drawn side by side, not nested: the
          evidence does not say which figure contains which. A smaller bar in a group may be part
          of the larger one rather than additional to it.
        </div>
      )}
      {model.groupsWithoutValue > 0 && (
        <div className="gc-chart-sub" style={{ marginTop: 4 }}>
          {model.groupsWithoutValue} further source{' '}
          {model.groupsWithoutValue === 1 ? 'message states' : 'messages state'} no number at all
          and {model.groupsWithoutValue === 1 ? 'is' : 'are'} not drawn here, which is why this
          chart shows fewer groups than the count above.
        </div>
      )}
      {model.withoutValue > 0 && (
        <div className="gc-chart-sub" style={{ marginTop: 8 }}>
          {model.withoutValue}{' '}
          {model.withoutValue === 1 ? 'figure states no number' : 'figures state no number'} and cannot be
          placed on an axis. They are in the evidence rows below.
        </div>
      )}
    </div>
  );
}
