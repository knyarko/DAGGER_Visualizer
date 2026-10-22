/**
 * One triplet of a retrieval answer, with its media.
 *
 * ── THE CONCEAL RULE IS NOT RE-IMPLEMENTED HERE, ANYWHERE ───────────────────
 *   A chat answer that renders 25 thumbnails is exactly where a concealed image
 *   reaches someone who did not click for it, so this card reuses the two
 *   things that already answer that question and adds nothing of its own:
 *
 *     - `NodeMedia` renders the media and OWNS the cover, the blur, the
 *       `aria-hidden` on the underlying element, the `filter_reason`, the
 *       warning tags and the per-record reveal. This file wraps its call site
 *       and never reaches inside it.
 *     - `isRecordConcealed` / `isBlurredByPipeline` from the shared conceal
 *       module decide the WORDS on the source line, which is the same thing the
 *       media card's own status line does. They are called, never copied.
 *
 *   `handling.content_blur` is DERIVED IN THE PIPELINE and is read, never
 *   recomputed, defaulted or inferred from `sensitivity`. `warning_tags` comes
 *   from a living vocabulary on the pipeline side and is normalised by the
 *   viewer's own `daggerWarningTags` — the `["None"]` no-warning answer reduced
 *   to `[]` in exactly one place in this application, which is the whole reason
 *   that helper exists.
 *
 * ── THE THREE HANDLING STATES, AND THE THIRD IS NOT A ROUNDING ──────────────
 *   cleared      — a handling block is present and the record is not concealed.
 *   concealed    — the cover, drawn by `NodeMedia`.
 *   not screened — NO handling block at all. Neither concealed nor cleared, and
 *                  it must not be drawn as either, so it carries the only
 *                  DASHED chip in the system and a plain sentence underneath.
 *                  Concealing it would be wrong for the reason already written
 *                  into the conceal module: with no `sensitivity` there is
 *                  nothing for the reveal threshold to compare against, so a
 *                  concealed unscored record would be a state the slider could
 *                  never open.
 *
 * ── WHERE THE MEDIA COMES FROM, AND WHY FROM TWO PLACES ─────────────────────
 *   The media LIST comes off the engine's normalised record, because on the
 *   legacy corpus the pictures are recovered from an HTML blob and are not on
 *   the node at all — reading the node there would return a result set with no
 *   pictures, which is the one thing that class of question is for. The
 *   HANDLING and the TAGS come off the original node through the viewer's own
 *   helpers, so the conceal decision and the tag normalisation keep their
 *   single implementation.
 */

import NodeMedia from '../explorer/NodeMedia';
import { daggerNodeHandling, daggerWarningTags } from '../../lib/parseData';
import { isBlurredByPipeline, isRecordConcealed, type ContentOverride } from '../../lib/contentBlur';
import type { MediaRoot } from '../../lib/mediaConfig';
import type { DaggerMedia, DaggerNode } from '../../types';
import type { NormalisedTriplet } from '../../../../graph-chat/engine/types.ts';

export interface TripletResultCardProps {
  triplet: NormalisedTriplet;
  /** The node the triplet came from, resolved through the loaded graph's index.
   *  Null when the row has no node behind it. */
  node: DaggerNode | null;
  roots: readonly MediaRoot[];
  /** The viewer's reveal threshold, carried across from the graph they came
   *  from. A conceal setting that does not survive the mode switch is a conceal
   *  setting that is off. */
  revealThreshold: number;
  contentOverride: ContentOverride | null;
  position: number;
  shownCount: number;
}

export default function TripletResultCard({
  triplet,
  node,
  roots,
  revealThreshold,
  contentOverride,
  position,
  shownCount,
}: TripletResultCardProps) {
  const handling = daggerNodeHandling(node);
  const warningTags = daggerWarningTags(node);
  const media = triplet.media as unknown as DaggerMedia[];

  const notScreened = handling === null;
  const concealed = isRecordConcealed(handling, revealThreshold, contentOverride, false);
  const cleared = handling !== null && !concealed;

  return (
    <article className="gc-tcard">
      {media.length > 0 && (
        <div className="gc-media">
          <NodeMedia
            media={media}
            roots={roots}
            handling={handling}
            revealThreshold={revealThreshold}
            warningTags={warningTags}
            contentOverride={contentOverride}
          />
        </div>
      )}

      {notScreened && (
        <div className="gc-media-note">
          no handling block on this record &mdash; the pipeline did not score it.
        </div>
      )}

      <div className="gc-triple">
        <span>{triplet.subject}</span>
        <span className="gc-arrow"> &rarr; </span>
        <span className="gc-triple-pred">{triplet.predicate}</span>
        <span className="gc-arrow"> &rarr; </span>
        <span>{triplet.object}</span>
      </div>

      {triplet.msg_text !== '' && <p className="gc-msg gc-msg-clamp">{triplet.msg_text}</p>}

      <div className="gc-source">
        <span>
          result {position} of {shownCount}
        </span>
        {triplet.cluster_id !== null ? (
          <span style={{ fontFamily: 'var(--gc-mono)' }}>message {triplet.cluster_id}</span>
        ) : triplet.record_id !== null ? (
          <span style={{ fontFamily: 'var(--gc-mono)' }}>row {triplet.record_id}</span>
        ) : null}
        {notScreened && <span className="gc-chip gc-chip-unscored">not screened</span>}
        {cleared && <span className="gc-cleared">cleared</span>}
        {!notScreened && !cleared && isBlurredByPipeline(handling) && (
          <span className="gc-chip">screened</span>
        )}
      </div>
    </article>
  );
}
