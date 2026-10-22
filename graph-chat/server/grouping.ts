/**
 * Grouping triplets by their source message.
 *
 * WHY THIS FILE EXISTS
 *
 * The no-compounding rule - two triplets from one message are one fact, not
 * two - needs a key that says "these came from the same message". In the
 * contract shape that key is `cluster_id`: the data dictionary defines it as
 * the id of the originating MESSAGE, shared by every row and every triplet
 * that came out of it.
 *
 * It is NOT `record_id`. A record id is one per ROW, and the dictionary spells
 * out the consequence: "a message with two attachments gets two". Keyed on the
 * row, such a message becomes two groups and the casualty figure it states is
 * handed to the model twice. This module was written against `record_id` and
 * that was wrong; the two keys agree only on a corpus where no message carries
 * two attachments, which is why the mistake survived a green test suite.
 *
 * The legacy corpus carries neither id, and it is the hurricane / wildfire /
 * flood set that the example question is about.
 *
 * The engine is right not to guess. When it has no key it reports
 * `messageKeyAvailable: 'none'`, keys every group on the triplet's own id -
 * which means it does not collapse at all - and returns
 * `distinctMessageCount: null` rather than counting synthesised ids under a
 * real id's name. That is correct of the engine and it leaves the last step to
 * the caller. This is the caller.
 *
 * The fallback is the message text itself: two triplets pulled from one
 * message repeat that message word for word. It is a real key. It is also a
 * DIFFERENT key, and the whole point of this module is that the difference
 * reaches the model and the screen instead of being smoothed over:
 *
 *   - two distinct messages worded identically collapse into one group;
 *   - one message stored with any difference at all stays as two;
 *   - a triplet with no message text has no key and is never silently merged.
 *
 * So `keyUsed` is carried out of here, into the pre-prompt, into the stored
 * answer and onto the screen. Nothing in this service may state a number of
 * MESSAGES when the key was message text or a row id, and nothing may call a
 * group a record whatever the key was.
 *
 * No engine file is edited by any of this. The engine's own grouping is the
 * input; this is a second pass over its output.
 */

import type { MessageGroup, MessageKeySource } from '../engine/types.js';
import { fnv1a32, normaliseText } from '../engine/text.js';
import type { GroupingKeyUsed } from './old_preprompt.js';
import type { GroupingResult, ServiceMessageGroup } from './types.js';

/**
 * The key a single engine group can be collapsed on, or null when it has none.
 * `normaliseText` is the engine's, so the service and the engine agree on what
 * "the same text" means.
 */
export function messageTextKeyOf(group: MessageGroup): string | null {
  const normalised = normaliseText(group.msg_text ?? '');
  if (normalised === '') return null;
  return 'msg:' + fnv1a32(normalised);
}

function emptyGroup(source: MessageGroup, key: string, clusterId: string | null): ServiceMessageGroup {
  return {
    cluster_id: clusterId,
    group_key: key,
    triplet_ids: [],
    msg_text: source.msg_text,
    figures: [],
    note: source.note,
  };
}

function mergeInto(target: ServiceMessageGroup, source: MessageGroup): void {
  for (const id of source.triplet_ids) {
    if (!target.triplet_ids.includes(id)) target.triplet_ids.push(id);
  }
  target.figures.push(...source.figures);
  if (target.msg_text === '' && source.msg_text !== '') target.msg_text = source.msg_text;
  if (target.note === null && source.note !== null) target.note = source.note;
}

function tripletCountOf(groups: readonly MessageGroup[]): number {
  const seen = new Set<string>();
  for (const g of groups) for (const id of g.triplet_ids) seen.add(id);
  return seen.size;
}

function noteFor(
  keyUsed: GroupingKeyUsed,
  before: number,
  after: number,
  ungroupable: number,
): string {
  const tail =
    ungroupable > 0
      ? ' ' + String(ungroupable) +
        ' triplet' + (ungroupable === 1 ? '' : 's') +
        ' carried no value for that key and stayed ungrouped.'
      : '';
  if (keyUsed === 'cluster_id') {
    return (
      'Grouped by cluster id, the id of the originating message that the file ' +
      'carries, shared by every row out of it: ' +
      String(before) + ' group' + (before === 1 ? '' : 's') + ' in, ' +
      String(after) + ' out.' + tail
    );
  }
  if (keyUsed === 'record_id') {
    return (
      'This file carries no cluster id. Grouped by record id instead, which is ' +
      'one per row: ' + String(before) + ' group' + (before === 1 ? '' : 's') +
      ' in, ' + String(after) + ' out. A message that carried two attachments ' +
      'is two rows and therefore two groups here, so these are row counts and ' +
      'must not be reported as a number of messages.' + tail
    );
  }
  if (keyUsed === 'message_text') {
    return (
      'This file carries no cluster id. Grouped by identical message text ' +
      'instead: ' + String(before) + ' group' + (before === 1 ? '' : 's') +
      ' in, ' + String(after) + ' out. Message text is a real key but it is ' +
      'not a cluster id, so these are not message counts and must not be ' +
      'reported as such.' + tail
    );
  }
  return (
    'This file carries no cluster id, no record id and no usable message ' +
    'text, so these ' +
    String(before) + ' triplet' + (before === 1 ? '' : 's') + ' could not be ' +
    'grouped by source message at all. The no-compounding rule has nothing to ' +
    'key on here and no grouping is claimed.' + tail
  );
}

/**
 * Resolve the grouping for one answer.
 *
 * `engineGroups` is `AggregateEvidence.messageGroups` exactly as the engine
 * returned it. `keySource` is `NormalisedCorpus.messageKeyAvailable` - which
 * key the loaded file actually supplied.
 *
 * The returned `keyUsed` is the key that was ACTUALLY applied, never the one
 * that was wanted.
 */
export function resolveGrouping(
  engineGroups: readonly MessageGroup[],
  keySource: MessageKeySource,
): GroupingResult {
  const before = engineGroups.length;
  const tripletCount = tripletCountOf(engineGroups);

  /* ---- the file supplied a key: cluster id, or a row id standing in ---- */
  if (keySource !== 'none') {
    const out: ServiceMessageGroup[] = [];
    const byKey = new Map<string, ServiceMessageGroup>();
    let ungroupable = 0;

    for (const g of engineGroups) {
      if (g.cluster_id === null || g.cluster_id === '') {
        // The corpus says this key exists but this group has no value for it.
        // It is not merged with anything: an absent id is not a shared id.
        const solo = emptyGroup(g, 'trp:' + (g.triplet_ids[0] ?? String(out.length)), null);
        mergeInto(solo, g);
        out.push(solo);
        ungroupable += g.triplet_ids.length;
        continue;
      }
      const key = 'msg:' + g.cluster_id;
      let target = byKey.get(key);
      if (!target) {
        target = emptyGroup(g, key, g.cluster_id);
        byKey.set(key, target);
        out.push(target);
      }
      mergeInto(target, g);
    }

    // The engine already grouped on this key, so this pass is a merge that
    // normally changes nothing. It is kept because it is what makes the two
    // paths produce one shape, and because an engine group with no value for
    // the key must still be isolated rather than quietly folded in.
    const keyUsed: GroupingKeyUsed = keySource === 'cluster_id' ? 'cluster_id' : 'record_id';
    return {
      keyUsed,
      groups: out,
      groupsBefore: before,
      groupsAfter: out.length,
      tripletCount,
      ungroupableTripletCount: ungroupable,
      note: noteFor(keyUsed, before, out.length, ungroupable),
    };
  }

  /* ---- the fallback: identical message text ---- */
  const out: ServiceMessageGroup[] = [];
  const byKey = new Map<string, ServiceMessageGroup>();
  let ungroupable = 0;
  let keyedAtLeastOnce = false;

  for (const g of engineGroups) {
    const key = messageTextKeyOf(g);
    if (key === null) {
      const solo = emptyGroup(g, 'trp:' + (g.triplet_ids[0] ?? String(out.length)), null);
      mergeInto(solo, g);
      out.push(solo);
      ungroupable += g.triplet_ids.length;
      continue;
    }
    keyedAtLeastOnce = true;
    let target = byKey.get(key);
    if (!target) {
      // cluster_id stays NULL on every group this branch makes. Nothing
      // downstream may print an id that the file did not supply.
      target = emptyGroup(g, key, null);
      byKey.set(key, target);
      out.push(target);
    }
    mergeInto(target, g);
  }

  const keyUsed: GroupingKeyUsed = keyedAtLeastOnce ? 'message_text' : 'none';

  return {
    keyUsed,
    groups: out,
    groupsBefore: before,
    groupsAfter: out.length,
    tripletCount,
    ungroupableTripletCount: ungroupable,
    note: noteFor(keyUsed, before, out.length, ungroupable),
  };
}
