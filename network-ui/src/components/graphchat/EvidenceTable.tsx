/**
 * The evidence table — the chart's table-view twin, and the keyboard path to
 * every value in it. It ships with every chart; it is not an optional extra.
 * It is also half of what pays for the light palette's contrast WARN: every
 * value in the chart is reachable here without seeing a mark.
 *
 * THE FOURTH COLUMN is the one that matters and it is never empty by accident.
 * If the engine collapsed or declined to add something, this column says so in
 * the engine's own words. An em-dash means "nothing to say" and is set in muted
 * ink rather than the qualifier colour, so a reader can tell the two apart at a
 * glance.
 *
 * No column, header, cell or caption here holds a sum.
 */

import type { AggregateEvidence, StatedFigure } from '../../../../graph-chat/engine/types.ts';
import type { ChartSourceGroup } from './chartModel';
import { formatValue, qualifierWord } from './chartModel';

export interface EvidenceTableProps {
  evidence: AggregateEvidence;
  /** The SAME resolved groups the chart was built from. The table is the
   *  chart's table-view twin; twins that group differently are two answers. */
  groups: readonly ChartSourceGroup[];
  highlightTripletId?: string | null;
  onSelectTriplet?: (tripletId: string | null) => void;
}

interface Row {
  key: string;
  figure: StatedFigure;
  note: string | null;
  msgText: string;
}

export default function EvidenceTable({
  evidence,
  groups,
  highlightTripletId = null,
  onSelectTriplet,
}: EvidenceTableProps) {
  const rows: Row[] = [];
  groups.forEach((group, gi) => {
    group.figures.forEach((figure, fi) => {
      rows.push({ key: `${gi}-${fi}`, figure, note: group.note, msgText: group.msg_text });
    });
  });

  if (rows.length === 0) {
    return (
      <div className="gc-empty">
        <b>No triplet in this file states a figure for that.</b>
        {formatValue(evidence.matchedNodeCount)} nodes matched the words,{' '}
        {formatValue(evidence.matchedTripletCount)} distinct triplets, none of them carrying a
        number.
      </div>
    );
  }

  return (
    <table className="gc-table">
      <thead>
        <tr>
          <th scope="col">triplet</th>
          <th scope="col">figure as stated</th>
          <th scope="col">record</th>
          <th scope="col">why it is not added</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => {
          const active = highlightTripletId !== null && highlightTripletId === row.figure.triplet_id;
          const word = qualifierWord(row.figure.qualifier);
          return (
            <tr
              key={row.key}
              style={{
                background: active ? 'var(--gc-raised2)' : undefined,
                boxShadow: active ? 'inset 3px 0 0 var(--gc-accent)' : undefined,
                cursor: onSelectTriplet ? 'pointer' : undefined,
              }}
              onClick={
                onSelectTriplet
                  ? () => onSelectTriplet(active ? null : row.figure.triplet_id)
                  : undefined
              }
            >
              <td className="gc-td-triplet">{row.figure.raw}</td>
              <td className="gc-td-figure">
                {word !== '' && <span className="gc-qual">{word}</span>}
                {row.figure.value === null ? 'no number stated' : formatValue(row.figure.value)}
                {row.figure.unit ? ' ' + row.figure.unit : ''}
              </td>
              <td className="gc-td-record">
                {row.figure.cluster_id === null
                  ? 'no source-message id'
                  : row.figure.cluster_id}
              </td>
              {row.note ? (
                <td className="gc-td-why">{row.note}</td>
              ) : (
                <td className="gc-td-why-none">{'—'}</td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
