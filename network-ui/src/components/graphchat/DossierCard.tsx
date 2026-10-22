/**
 * The dossier card — the piece this layout lives or dies on.
 *
 * ── COLLAPSE IS LOSSLESS AND FREE ───────────────────────────────────────────
 *   Nothing is recomputed, re-fetched or re-asked on expand. The whole answer —
 *   the full retained set, its evidence and its service half — stays in memory
 *   on the answer object, and collapsing changes one boolean on it. If
 *   expanding a card ever needed a round trip, that would be a bug in the
 *   retention and not a loading state to design, so there is deliberately no
 *   loading path on this component's expand.
 *
 * ── THE FIVE THINGS THAT SURVIVE COLLAPSE ───────────────────────────────────
 *   1. the class chip — aggregate and retrieval are different kinds of answer
 *      and the difference has to be visible in a stack of them;
 *   2. the question, one line, ellipsised, with the full text in `title` AND in
 *      the accessible name — never only in the tooltip;
 *   3. the headline result, which is the row's whole value;
 *   4. the grouping key, because an answer whose grouping you cannot see is an
 *      answer you cannot trust;
 *   5. the shape badge, ONLY on a legacy file — noise on a contract file, and
 *      the explanation for a zero on a legacy one.
 *
 *   The row is 56px in every state so the stack never reflows as answers
 *   arrive, and it is ONE tab stop: a single-purpose row that is itself the
 *   control is one stop, not two, so there is no separate Open button in it.
 *
 * ── A CARD WITH AN ERROR NEVER AUTO-COLLAPSES ───────────────────────────────
 *   An error you cannot see is an error you will repeat.
 */

import EvidenceTable from './EvidenceTable';
import FigureChart from './FigureChart';
import GroupingStrip from './GroupingStrip';
import MatchFunnel from './MatchFunnel';
import ResultSetHeader from './ResultSetHeader';
import TripletResultCard from './TripletResultCard';
import { buildFigureChart, buildFunnel, funnelNote } from './chartModel';
import type { ChartSourceGroup } from './chartModel';
import { groupingWords, headlineOf, isLegacyShape, type GraphChatAnswer } from './answerModel';
import type { ContentOverride } from '../../lib/contentBlur';
import type { MediaRoot } from '../../lib/mediaConfig';
import type { DaggerIndex, DaggerNode } from '../../types';
import type { NormalisedTriplet } from '../../../../graph-chat/engine/types.ts';

export interface DossierCardProps {
  answer: GraphChatAnswer;
  dagger: DaggerIndex | null;
  roots: readonly MediaRoot[];
  revealThreshold: number;
  contentOverride: ContentOverride | null;
  highlightTripletId: string | null;
  onHighlight: (tripletId: string | null) => void;
  onToggleExpanded: (id: string) => void;
  onTogglePinned: (id: string) => void;
  onShowMore: (id: string) => void;
}

function nodeFor(dagger: DaggerIndex | null, triplet: NormalisedTriplet): DaggerNode | null {
  if (!dagger) return null;
  for (const id of triplet.node_ids) {
    const node = dagger.nodesById.get(id);
    if (node) return node;
  }
  return null;
}

export default function DossierCard(props: DossierCardProps) {
  const { answer } = props;
  const legacy = isLegacyShape(answer);
  const headline = headlineOf(answer);
  const grouping = groupingWords(answer);

  if (!answer.expanded && answer.error === null) {
    const name = `${answer.kind} answer. ${answer.question}. ${headline}. ${grouping}.${legacy ? ' legacy shape.' : ''}`;
    return (
      <div
        role="button"
        tabIndex={0}
        aria-expanded="false"
        aria-label={name}
        className="gc-collapsed"
        onClick={() => props.onToggleExpanded(answer.id)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            props.onToggleExpanded(answer.id);
          }
        }}
      >
        <span className="gc-chip">{answer.kind}</span>
        <span className="gc-collapsed-q" title={answer.question}>
          {answer.question}
        </span>
        <span className="gc-collapsed-head">{headline}</span>
        <span className="gc-collapsed-group">{grouping}</span>
        {legacy && <span className="gc-chip">legacy shape</span>}
      </div>
    );
  }

  const aggregateEvidence =
    answer.aggregate && answer.aggregate.evidence.kind === 'aggregate' ? answer.aggregate.evidence : null;
  const retrievalEvidence =
    answer.retrieval && answer.retrieval.evidence.kind === 'retrieval' ? answer.retrieval.evidence : null;

  const triplets: NormalisedTriplet[] = answer.aggregate
    ? answer.aggregate.items
    : answer.retrieval
      ? answer.retrieval.items.map(hit => hit.triplet)
      : [];
  const total = answer.aggregate?.total ?? answer.retrieval?.total ?? 0;
  const page = triplets.slice(answer.offset, answer.offset + 25);

  const matchedTriplets =
    aggregateEvidence?.matchedTripletCount ?? retrievalEvidence?.matchedTripletCount ?? total;
  const distinctMessageCount =
    aggregateEvidence?.distinctMessageCount ?? retrievalEvidence?.distinctMessageCount ?? null;

  /* B069. One grouping, resolved when the answer was made, feeding the chart,
   * the evidence table and the strip alike. Falling back to the engine's own
   * groups only if the resolution is somehow absent keeps this render total
   * rather than conditional, and the strip then reports whichever one was
   * used because it is handed the same object. */
  const chartGroups: readonly ChartSourceGroup[] = answer.grouping
    ? answer.grouping.groups
    : (aggregateEvidence?.messageGroups ?? []);
  const chart = aggregateEvidence ? buildFigureChart(chartGroups) : null;

  return (
    <section className="gc-card" aria-label={`${answer.kind} answer: ${answer.question}`}>
      <div className="gc-card-head">
        <span className="gc-chip">{answer.kind}</span>
        <h2 className="gc-card-q">{answer.question}</h2>
        {legacy && <span className="gc-chip">legacy shape</span>}
        <button
          type="button"
          className="gc-btn gc-btn-quiet"
          aria-pressed={answer.pinned}
          onClick={() => props.onTogglePinned(answer.id)}
        >
          {answer.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button
          type="button"
          className="gc-btn gc-btn-quiet"
          disabled
          title="AA063, pinned — not built this sprint"
        >
          Export
        </button>
        <button type="button" className="gc-btn gc-btn-quiet" onClick={() => props.onToggleExpanded(answer.id)}>
          Collapse
        </button>
      </div>

      {answer.error !== null && <div className="gc-danger-block">{answer.error}</div>}

      <div className="gc-count">
        <b>{matchedTriplets}</b> triplets matched{' '}
        {aggregateEvidence && (
          <>
            {'· '}
            <b>{aggregateEvidence.tripletsWithFigures}</b> of them state a figure
          </>
        )}
      </div>

      <GroupingStrip
        tripletCount={matchedTriplets}
        resolved={answer.grouping}
        service={answer.service?.grouping ?? null}
        groupingSentence={answer.service?.preprompt.groupingSentence ?? null}
        distinctMessageCount={distinctMessageCount}
      />

      {answer.service && answer.service.ok && answer.service.answer !== '' && (
        <p className="gc-answer">{answer.service.answer}</p>
      )}
      {answer.service && !answer.service.ok && (
        <div className="gc-danger-block">
          {answer.service.reason ??
            'the model did not answer. The counts, the evidence and the rows below are unaffected.'}
        </div>
      )}
      {answer.service === null && answer.serviceReason !== null && (
        <div className="gc-degraded" style={{ marginTop: 'var(--gc-sp-4)', marginBottom: 0 }}>
          <b>No written answer:</b> {answer.serviceReason}. Everything below was computed in this
          browser and is unaffected &mdash; the counting, the grouping, the figures and the rows are
          the engine&rsquo;s, and the model only ever writes the sentence, never the figure.
        </div>
      )}
      {answer.service && answer.service.cache.hit && (
        <div className="gc-grouping" style={{ marginTop: 'var(--gc-sp-2)' }}>
          Answer reused from an earlier question
          {answer.service.cache.originalQuestion
            ? `, asked as: “${answer.service.cache.originalQuestion}”`
            : ''}
          . Match {answer.service.cache.similarity.toFixed(2)} against a threshold of{' '}
          {answer.service.cache.threshold.toFixed(2)}.
        </div>
      )}

      {aggregateEvidence && (
        <>
          <div className="gc-section-label">how the match narrowed</div>
          <MatchFunnel
            stages={buildFunnel(aggregateEvidence, answer.aggregate!.shape)}
            note={funnelNote(answer.aggregate!.shape)}
          />

          <div className="gc-section-label">what each source states</div>
          {chart && (
            <FigureChart
              model={chart}
              title="Stated figures, one bar per figure, grouped by source message"
              groupingWords={grouping}
              highlightTripletId={props.highlightTripletId}
              onSelectTriplet={props.onHighlight}
            />
          )}

          <div className="gc-section-label">the evidence</div>
          <EvidenceTable
            evidence={aggregateEvidence}
            groups={chartGroups}
            highlightTripletId={props.highlightTripletId}
            onSelectTriplet={props.onHighlight}
          />
        </>
      )}

      <div className="gc-section-label">the triplets</div>
      <ResultSetHeader
        shownCount={Math.min(answer.offset + page.length, total)}
        total={total}
        onShowMore={() => props.onShowMore(answer.id)}
      />
      {page.length === 0 ? (
        <div className="gc-empty" style={{ marginTop: 'var(--gc-sp-3)' }}>
          <b>No triplets matched that.</b>
          Tried subject, predicate, object, label, msg_text and the media description.
        </div>
      ) : (
        <div className="gc-grid">
          {page.map((triplet, i) => (
            <TripletResultCard
              key={triplet.triplet_id + ':' + String(answer.offset + i)}
              triplet={triplet}
              node={nodeFor(props.dagger, triplet)}
              roots={props.roots}
              revealThreshold={props.revealThreshold}
              contentOverride={props.contentOverride}
              position={answer.offset + i + 1}
              shownCount={total}
            />
          ))}
        </div>
      )}

      {answer.service && answer.service.notes.length > 0 && (
        <ul className="gc-grouping" style={{ marginTop: 'var(--gc-sp-4)' }}>
          {answer.service.notes.map(note => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
