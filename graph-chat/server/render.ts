/**
 * Rendering the evidence for the model.
 *
 * Everything the model is allowed to use is assembled here, so there is one
 * place to read to know what it saw. Two rules hold throughout:
 *
 *   - no number is computed in this file. Every figure printed is a figure
 *     the engine extracted, with the qualifier it was written with. There is
 *     no addition anywhere below, which is the point;
 *   - the grouping is printed with the key that produced it, so the model
 *     cannot read a message-text group as a record.
 */

import type { AggregateEvidence, RetrievalEvidence } from '../engine/types.js';
import type { AskRequest, GroupingResult, ServiceMessageGroup } from './types.js';
import { MAX_SAMPLE_ITEMS } from './types.js';

function trim(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
}

function renderGroup(g: ServiceMessageGroup, index: number, keyUsed: string): string[] {
  const out: string[] = [];
  // The head names the key that was ACTUALLY used. A group keyed on a row id
  // says so, because on such a file one message can be two groups.
  const head =
    keyUsed === 'cluster_id' && g.cluster_id !== null
      ? 'GROUP ' + String(index + 1) + ' (source message ' + g.cluster_id + ')'
      : keyUsed === 'record_id' && g.cluster_id !== null
        ? 'GROUP ' + String(index + 1) + ' (row ' + g.cluster_id +
          '; this file has no cluster id, so one message may appear as two rows)'
        : 'GROUP ' + String(index + 1) +
          ' (grouped by message text; this is NOT a cluster id)';
  out.push(head);
  out.push('  triplets in this group: ' + String(g.triplet_ids.length));
  if (g.msg_text !== '') out.push('  message: ' + trim(g.msg_text, 300));
  if (g.figures.length === 0) {
    out.push('  figures stated: none');
  } else {
    out.push('  figures stated (do not add these together):');
    for (const f of g.figures) {
      const value = f.value === null ? '(no number)' : String(f.value);
      const unit = f.unit === null ? '' : ' ' + f.unit;
      out.push(
        '    - ' + f.qualifier + ' ' + value + unit +
        '  [from ' + f.field + ' of ' + f.triplet_id + ']  as written: "' +
        trim(f.raw, 120) + '"',
      );
    }
  }
  if (g.note !== null) out.push('  note: ' + g.note);
  return out;
}

function renderAggregate(
  evidence: AggregateEvidence,
  grouping: GroupingResult,
): string[] {
  const out: string[] = [];
  out.push('EVIDENCE - a counting question.');
  out.push('');
  out.push('Counts:');
  out.push('  matched triplets (THE count): ' + String(evidence.matchedTripletCount));
  out.push(
    '  matched graph nodes (what counting nodes would have given, NOT a fact count): ' +
    String(evidence.matchedNodeCount),
  );
  out.push(
    '  distinct source messages: ' +
    (evidence.distinctMessageCount === null
      ? 'not available - this file carries no cluster id and no record id'
      : String(evidence.distinctMessageCount)),
  );
  out.push(
    '  triplets stating a figure that names what it counts: ' +
    String(evidence.tripletsWithFigures),
  );
  if (evidence.unitlessFiguresSetAside > 0) {
    out.push(
      '  numbers set aside because the text does not say what they count: ' +
      String(evidence.unitlessFiguresSetAside) +
      ' (distances, clock times and years read the same as casualties to ' +
      'anything that only sees digits)',
    );
  }
  out.push('');
  out.push('Grouping actually applied: ' + grouping.note);
  out.push('');
  out.push(
    'There is NO total in this evidence, and that is deliberate. ' +
    evidence.sumRefusalReason,
  );
  out.push('');
  out.push(
    'SOURCE GROUPS - ' + String(grouping.groups.length) +
    '. Every triplet inside one group is a restatement of the same source, ' +
    'so its figures are one fact stated more than once.',
  );
  out.push('');
  grouping.groups.forEach((g, i) => {
    out.push(...renderGroup(g, i, grouping.keyUsed));
    out.push('');
  });

  if (evidence.facets.length > 0) {
    out.push('Facets of the matched set:');
    for (const f of evidence.facets) {
      out.push(
        '  ' + f.field + ' = ' + f.value + ': ' + String(f.tripletCount) +
        ' triplets' +
        (f.messageCount === null ? '' : ', ' + String(f.messageCount) + ' source messages'),
      );
    }
  }
  return out;
}

function renderRetrieval(
  evidence: RetrievalEvidence,
  grouping: GroupingResult,
  sample: AskRequest['sample'],
): string[] {
  const out: string[] = [];
  out.push('EVIDENCE - a retrieval question. The rows themselves are the answer.');
  out.push('');
  out.push('  matched triplets: ' + String(evidence.matchedTripletCount));
  out.push('  matched graph nodes (NOT a fact count): ' + String(evidence.matchedNodeCount));
  out.push(
    '  distinct source messages: ' +
    (evidence.distinctMessageCount === null
      ? 'not available - this file carries no cluster id and no record id'
      : String(evidence.distinctMessageCount)),
  );
  out.push('  of the matched rows, ones carrying media: ' + String(evidence.hitsWithMedia));
  out.push('');
  out.push('Grouping actually applied: ' + grouping.note);
  out.push('');
  if (evidence.clauseCounts.length > 0) {
    out.push('What each part of the question matched:');
    for (const c of evidence.clauseCounts) {
      out.push('  "' + trim(c.clause, 120) + '": ' + String(c.tripletCount) + ' triplets');
    }
    out.push('');
  }

  const rows = (sample ?? []).slice(0, MAX_SAMPLE_ITEMS);
  if (rows.length === 0) {
    out.push(
      'No rows were supplied to you. Say how many matched and that the rows ' +
      'are shown beside this answer; do not describe rows you were not given.',
    );
  } else {
    out.push(
      'THE ROWS YOU MAY DESCRIBE - ' + String(rows.length) + ' of ' +
      String(evidence.matchedTripletCount) +
      '. These are the ones on screen. Do not generalise beyond them; if you ' +
      'describe the whole set, say you are describing the ones shown.',
    );
    out.push('');
    for (const r of rows) {
      out.push('  - ' + trim(r.label, 200) + (r.hasMedia ? '  [has an image]' : ''));
      if (r.msg_text !== '') out.push('      message: ' + trim(r.msg_text, 220));
    }
  }

  if (evidence.facets.length > 0) {
    out.push('');
    out.push('Facets of the matched set:');
    for (const f of evidence.facets) {
      out.push('  ' + f.field + ' = ' + f.value + ': ' + String(f.tripletCount) + ' triplets');
    }
  }
  return out;
}

/**
 * The user message. The standing pre-prompt is the system message and is
 * assembled separately; nothing here can remove or weaken it.
 */
export function renderUserMessage(
  request: AskRequest,
  grouping: GroupingResult,
): string {
  const parts: string[] = [];
  parts.push('QUESTION: ' + request.question.trim());
  parts.push('');
  parts.push(
    'The file loaded is of the "' + request.shape.shape + '" shape, holding ' +
    String(request.shape.nodeCount) + ' nodes.',
  );
  if (request.total > 0) {
    parts.push('The full result set holds ' + String(request.total) + ' rows.');
  }
  parts.push('');

  if (request.evidence.kind === 'aggregate') {
    parts.push(...renderAggregate(request.evidence, grouping));
  } else {
    parts.push(...renderRetrieval(request.evidence, grouping, request.sample));
  }

  parts.push('');
  parts.push(
    'Answer the question now, briefly and in plain words, using only what is ' +
    'above.',
  );
  return parts.join('\n');
}
