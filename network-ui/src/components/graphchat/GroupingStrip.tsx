/**
 * The grouping strip — provenance without alarm.
 *
 * IT RENDERS ON EVERY AGGREGATE ANSWER, on both corpus shapes, whether or not
 * anything is unusual. That is the design decision and it is the opposite of a
 * warning banner: a caveat that only appears when something is wrong teaches
 * people to read its absence as an all-clear, so the one time it appears it
 * reads as an alarm and gets dismissed. A line that is always there, always in
 * the same place, always in muted ink at meta size, is read the way a byline is
 * read. It costs one line per answer and it is the line that makes the answer
 * auditable.
 *
 * FOUR RULES, and they are the service seat's display requirements rather than
 * suggestions:
 *
 *   1. `groupingSentence` is rendered VERBATIM. Not paraphrased, not re-worded
 *      for tone, not truncated. It is the same string the pre-prompt sent to
 *      the model, so the screen and the model cannot disagree about how the
 *      data was grouped. If it is long it wraps; it does not ellipsis.
 *   2. The word `records` is forbidden unless the grouping key really was the
 *      record id. WHERE RULES 1 AND 2 COLLIDE, RULE 1 WINS: rule 2 binds the
 *      count clause this component COMPOSES, never the service's sentence. A
 *      sentence that reads "grouped by the text of their source message,
 *      because this file carries no record id" says `record` and is correct to
 *      — it is naming the field that is absent, which is its whole point.
 *   3. `ungroupableTripletCount` is rendered whenever it is above zero, as its
 *      own clause, never rolled into another number and never behind a
 *      disclosure.
 *   4. A null record count is NEVER rendered as `0`. Null means this corpus
 *      does not carry the field; zero means it carries it and nothing matched.
 *      When it is null the record clause is omitted ENTIRELY — no `0`, no
 *      em-dash, no `unknown`, because each of those is a reader inventing a
 *      different wrong meaning.
 */

import type { GroupingResult } from '../../../../graph-chat/server/types.ts';
import type { AskResponse } from './serviceClient';

export interface GroupingStripProps {
  /** `evidence.matchedTripletCount` - triplets, never nodes. */
  tripletCount: number;
  /**
   * The grouping the answer was actually built with, resolved in this browser
   * by the service's own `resolveGrouping`. B069: the strip and the chart used
   * to be fed from two different passes and quoted two different numbers for
   * one answer. They are now fed from this one object.
   */
  resolved: GroupingResult | null;
  /** What the service reported, when it answered at all. */
  service: AskResponse['grouping'] | null;
  /** `preprompt.groupingSentence`, rendered verbatim. Null without a service. */
  groupingSentence: string | null;
  /** `evidence.distinctMessageCount`. Null is a real and different answer. */
  distinctMessageCount: number | null;
}

export default function GroupingStrip({
  tripletCount,
  resolved,
  service,
  groupingSentence,
  distinctMessageCount,
}: GroupingStripProps) {
  const clauses: string[] = [];

  const keyUsed = resolved?.keyUsed ?? service?.keyUsed ?? null;
  const groupsAfter = resolved?.groupsAfter ?? service?.groupsAfter ?? null;
  const ungroupable = resolved?.ungroupableTripletCount ?? service?.ungroupableTripletCount ?? null;

  /* The count clause.
   *
   * `source messages` is emitted ONLY where the key really was the cluster id,
   * which is the id of the originating message. Where the key was the RECORD
   * id the clause says `rows` instead and says why, because a record id is one
   * per row and a message with two attachments is two of them — calling those
   * two messages is the error this whole correction is about. Where the key
   * was message text the groups are source messages by a different route, and
   * the sentence that follows names that route. */
  if (keyUsed === 'cluster_id' && distinctMessageCount !== null) {
    clauses.push(`${tripletCount} triplets, ${distinctMessageCount} source messages`);
  } else if (keyUsed === 'cluster_id' && groupsAfter !== null) {
    clauses.push(`${tripletCount} triplets, ${groupsAfter} source messages`);
  } else if (keyUsed === 'record_id' && groupsAfter !== null) {
    clauses.push(
      `${tripletCount} triplets, ${groupsAfter} rows (this file carries no source-message id)`,
    );
  } else if (keyUsed === 'message_text' && groupsAfter !== null) {
    clauses.push(`${tripletCount} triplets, ${groupsAfter} source messages`);
  } else if (keyUsed === 'none') {
    clauses.push(`${tripletCount} triplets, not grouped by source message`);
  } else {
    /* Rule 4: the grouping clause is omitted ENTIRELY rather than rendered as
     * a zero the file never supplied. */
    clauses.push(`${tripletCount} triplets`);
  }

  /* Rule 1 beats rule 2: the service's sentence is reproduced byte for byte,
   * even where it says the word `record` or `cluster`, because naming the
   * field that is ABSENT is the whole point of that sentence. Without a service the
   * grouping module's own note is printed instead - still not this view's
   * words, and still the sentence describing the pass that actually ran. */
  if (groupingSentence !== null && groupingSentence !== '') {
    clauses.push(groupingSentence);
  } else if (resolved !== null) {
    clauses.push(resolved.note);
    clauses.push(
      'grouped in this browser; the written answer and the shared question list need the query service',
    );
  }

  if (ungroupable !== null && ungroupable > 0) {
    clauses.push(
      `${ungroupable} ${ungroupable === 1 ? 'triplet' : 'triplets'} could not be grouped`,
    );
  }

  return <div className="gc-grouping">{clauses.join(' \u00b7 ')}</div>;
}
