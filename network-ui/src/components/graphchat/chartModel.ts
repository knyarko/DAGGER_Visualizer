/**
 * The stated-figures chart, as data. Rendering is next door; the rules are here
 * so they can be read in one place and argued with.
 *
 * ── WHAT IS PLOTTED, AND WHAT IS NOT ────────────────────────────────────────
 *   One horizontal bar per STATED FIGURE, on one shared linear scale, grouped
 *   under its source message. The chart is a picture of what the corpus says,
 *   never of a computed number.
 *
 *   NO PIE. NO TOTAL. A pie says "these are the parts of one whole", and these
 *   figures are not parts of one whole: one source was measured stating a
 *   national running total, a verified subset of it, and one incident inside
 *   the subset. Drawn as three slices they occupy 92% / 6% / 2% of a ring that
 *   totals a number nobody stated, and nothing on the chart says so — the pie
 *   does the compounding the pre-prompt exists to forbid, silently, in the
 *   picture, where no caveat text can reach it. Bars on a shared scale make no
 *   whole-claim at all, so the arithmetic the data cannot support is never
 *   implied.
 *
 *   `axisMax` is therefore the largest STATED figure and is never a sum. There
 *   is no variable in this file that holds a total, and the evidence bundle the
 *   figures arrive on has no field that could carry one — `sum` is typed as the
 *   literal `null` upstream, on purpose.
 *
 * ── A LINEAR SCALE, DELIBERATELY ────────────────────────────────────────────
 *   A linear axis is what makes 12 render as 0.6% of 2,000, which is true and
 *   is the point. A log axis would make twelve people and two thousand people
 *   look like neighbours. The floor below keeps a non-zero figure from being
 *   drawn as nothing.
 */

import type {
  AggregateEvidence,
  FigureQualifier,
  ShapeReport,
  StatedFigure,
} from '../../../../graph-chat/engine/types.ts';

/** Minimum rendered length, so a non-zero figure is never drawn as nothing. */
export const MIN_BAR_PX = 2;

/** How the bar's end is drawn, and it is the QUALIFIER'S OWN DIRECTION.
 *
 *  `nearly 100` drawn with an outward feather would say "100 or more", which is
 *  the opposite of what the source said. One glyph for "qualified" would have
 *  been simpler and wrong in half the cases. */
export type FeatherDirection = 'outward' | 'inward' | 'none';

export function featherOf(qualifier: FigureQualifier): FeatherDirection {
  switch (qualifier) {
    case 'at least':
    case 'more than':
      return 'outward';
    case 'nearly':
    case 'about':
    case 'up to':
    case 'fewer than':
      return 'inward';
    default:
      return 'none';
  }
}

const NUMBER = new Intl.NumberFormat('en-US');

export function formatValue(value: number): string {
  return NUMBER.format(value);
}

/** The qualifier rides every label, at the label's own size, never smaller and
 *  never tidied away. `exact` and `unquantified` contribute no word. */
export function qualifierWord(qualifier: FigureQualifier): string {
  return qualifier === 'exact' || qualifier === 'unquantified' ? '' : qualifier;
}

export interface FigureBar {
  /** Stable within one chart. */
  key: string;
  value: number;
  qualifier: FigureQualifier;
  feather: FeatherDirection;
  unit: string | null;
  /** The source text the figure was read out of. Shown in the table and the
   *  tooltip, never rewritten. */
  raw: string;
  tripletId: string;
  clusterId: string | null;
  /** qualifier + number + unit, in that order. */
  label: string;
}

export interface FigureGroup {
  key: string;
  clusterId: string | null;
  msgText: string;
  /** The engine's own sentence about this group, when it has one — e.g. that
   *  two rows are the same twelve people. Rendered verbatim, never paraphrased:
   *  it is the no-compounding rule made visible at the exact place a reader
   *  would otherwise add two bars together. */
  note: string | null;
  bars: FigureBar[];
  largest: number;
}

/**
 * What the chart groups by.
 *
 * B069. The ENGINE's `messageGroups` are NOT this. On a file with no message key
 * the engine keys every group on the triplet's own id and so collapses
 * nothing - correctly, because it refuses to guess a key the file did not
 * supply. The service then runs a second pass that collapses by identical
 * message text, and THAT is the grouping the answer is reported with.
 *
 * Feeding the engine's groups to the chart while reporting the service's
 * counts beside it drew two triplets restating ONE message as two independent
 * bars - the exact "12 deaths should not be compounded" case - in the one
 * surface no caveat text reaches. So the chart takes resolved groups, and
 * both shapes of group satisfy this structural type.
 */
export interface ChartSourceGroup {
  /** The source MESSAGE this group is, where the file supplies an id for one.
   *  Null when it does not — never a row id wearing a message id's name. */
  cluster_id: string | null;
  msg_text: string;
  figures: StatedFigure[];
  note: string | null;
}

export interface FigureChartModel {
  groups: FigureGroup[];
  /** The largest STATED figure. Never a sum. */
  axisMax: number;
  ticks: number[];
  figureCount: number;
  groupCount: number;
  /** Groups dropped because not one of their figures carries a number. The
   *  chart cannot place them, and a reader counting groups against the strip
   *  is owed the difference rather than left to find it. */
  groupsWithoutValue: number;
  /** Figures the engine stated without a number — they cannot be placed on an
   *  axis, so they are reported as a count rather than silently dropped. */
  withoutValue: number;
}

function labelOf(figure: StatedFigure, value: number): string {
  const word = qualifierWord(figure.qualifier);
  const unit = figure.unit === null || figure.unit === '' ? '' : ' ' + figure.unit;
  return (word === '' ? '' : word + ' ') + formatValue(value) + unit;
}

/** Clean rounds, 1 / 2 / 5 x a power of ten, origin always at zero. No tick is
 *  ever labelled `total`. */
export function niceTicks(max: number, target = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const rough = max / Math.max(1, target);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const normalised = rough / magnitude;
  const step = (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10) * magnitude;
  const ticks: number[] = [];
  for (let t = 0; t <= max + step * 0.0001; t += step) ticks.push(Number(t.toFixed(10)));
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toFixed(10)));
  return ticks;
}

/**
 * Build the chart from the evidence bundle.
 *
 * GROUPS ARE FLAT, and that is a decision rather than an omission. The design
 * calls for a figure the same message states as a subset of another to be drawn
 * INSET inside it — the `at least 200 people, including 21 children` case. The
 * engine's result shape carries no containment relation: `StatedFigure` has a
 * value, a qualifier, a unit, the raw text and the ids, and nothing that says
 * one figure sits inside another. Inferring containment from "smaller number in
 * the same group" would be the view asserting a subset relationship the data
 * never stated, which is the same class of mistake as the pie. So the flat
 * grouped form is rendered — which the design names as the fallback — and the
 * relation is carried by the engine's own `note` on the group and by the
 * evidence table's fourth column, in words. Raised for the engine seat.
 */
export function buildFigureChart(source: readonly ChartSourceGroup[]): FigureChartModel {
  const groups: FigureGroup[] = [];
  let withoutValue = 0;
  let groupsWithoutValue = 0;

  source.forEach((group, index) => {
    const bars: FigureBar[] = [];
    group.figures.forEach((figure, i) => {
      // A figure with no number cannot be placed on an axis. It is counted and
      // reported, never dropped in silence.
      if (figure.value === null || !Number.isFinite(figure.value)) {
        withoutValue += 1;
        return;
      }
      const value = figure.value;
      bars.push({
        key: `${index}:${i}:${figure.triplet_id}`,
        value,
        qualifier: figure.qualifier,
        feather: featherOf(figure.qualifier),
        unit: figure.unit,
        raw: figure.raw,
        tripletId: figure.triplet_id,
        clusterId: figure.cluster_id,
        label: labelOf(figure, value),
      });
    });
    if (bars.length === 0) {
      groupsWithoutValue += 1;
      return;
    }
    bars.sort((a, b) => b.value - a.value);
    groups.push({
      key: `g${index}`,
      clusterId: group.cluster_id,
      msgText: group.msg_text,
      note: group.note,
      bars,
      largest: bars[0].value,
    });
  });

  groups.sort((a, b) => b.largest - a.largest);

  let axisMax = 0;
  let figureCount = 0;
  for (const group of groups) {
    figureCount += group.bars.length;
    if (group.largest > axisMax) axisMax = group.largest;
  }

  return {
    groups,
    axisMax,
    ticks: niceTicks(axisMax),
    figureCount,
    groupCount: groups.length,
    groupsWithoutValue,
    withoutValue,
  };
}

/** The accessible name: every group, every figure and every qualifier, in the
 *  order they are drawn. The chart is ONE tab stop; the bars are not individual
 *  stops, because the evidence table is the keyboard path to the same values. */
export function chartAriaLabel(title: string, model: FigureChartModel): string {
  const parts: string[] = [
    `${title}. ${model.figureCount} stated figures from ${model.groupCount} source messages, as a bar chart on one linear scale. No total is shown.`,
  ];
  for (const group of model.groups) {
    const head = group.clusterId === null ? 'Source message' : `Source message ${group.clusterId}`;
    parts.push(`${head}: ${group.bars.length} figures.${group.note ? ' ' + group.note : ''}`);
    for (const bar of group.bars) parts.push(bar.label + '.');
  }
  return parts.join(' ');
}

/** The match funnel: how the match narrowed. Ordered magnitude on one hue, so
 *  it takes the ordinal ramp and not the categorical one. */
export interface FunnelStage {
  value: number;
  label: string;
  token: string;
}

export function buildFunnel(evidence: AggregateEvidence, shape: ShapeReport): FunnelStage[] {
  /* B070. The first stage counts the nodes the match hit BEFORE they collapse
   * to triplets. On the contract shape those really are TRIPLET nodes and
   * naming them is the whole point of the funnel. The legacy shape carries
   * ZERO TRIPLET nodes, so that label named a node type the file does not
   * have - on the chart whose job is to argue the engine counted correctly.
   * The value was always right; only the word was wrong. */
  const first = shape.shape === 'contract' ? 'TRIPLET nodes matched' : 'source nodes matched';
  return [
    { value: evidence.matchedNodeCount, label: first, token: 'var(--gc-o1)' },
    { value: evidence.matchedTripletCount, label: 'distinct triplets', token: 'var(--gc-o2)' },
    { value: evidence.tripletsWithFigures, label: 'state a figure', token: 'var(--gc-o3)' },
  ];
}

/** The sentence under the funnel, which carries the single most load-bearing
 *  fact in the answer and so must be true of the file actually loaded. */
export function funnelNote(shape: ShapeReport): string {
  if (shape.shape === 'contract') {
    return 'one TRIPLET node exists per (triplet, category) pair, so the first number is nodes and the second is triplets';
  }
  return 'this file carries no TRIPLET nodes - the first number is the source nodes the match hit and the second is the triplets they collapse to';
}
