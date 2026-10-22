/**
 * Orchestration: question in, stored and labelled answer out.
 *
 * The order is fixed and every step is here rather than spread across call
 * sites, because the standing pre-prompt must be on EVERY model call and the
 * only way to be sure of that is for there to be one path to a model.
 *
 *   1. work out which key the no-compounding rule can actually use
 *   2. look in the shared cache, scoped to this graph
 *   3. assemble the standing pre-prompt, with that key stated in it
 *   4. render the evidence
 *   5. call the chosen provider - which cannot throw
 *   6. store the answer, whether it succeeded or not
 *
 * A provider failure is an answer of '' with a reason. The request still
 * returns 200 with a response the view can render, because a model being down
 * is not a reason for the question to vanish.
 */

import type { MessageGroup } from '../engine/types.js';
import { adapterFor } from './adapters/index.js';
import { DEFAULT_TEMPERATURE, makeRequest } from './adapters/base.js';
import { cacheLabel, lookup } from './cache.js';
import { resolveGrouping } from './grouping.js';
import { assemblePreprompt } from './old_preprompt.js';
import { renderUserMessage } from './render.js';
import { DEFAULT_SIMILARITY_THRESHOLD, signatureOf } from './similarity.js';
import type { AnswerStore } from './store.js';
import type {
  AskRequest,
  AskResponse,
  CacheMatch,
  GroupingResult,
  HttpPost,
} from './types.js';
import { MAX_SAMPLE_ITEMS } from './types.js';

export interface AskDeps {
  store: AnswerStore;
  /** Injected transport. The tests pass a fake; this sprint ships no real one. */
  post: HttpPost;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Injected so a test gets a stable id. */
  newId?: () => string;
  /** Injected so a test gets a stable timestamp. */
  clockIso?: () => string;
  threshold?: number;
}

function defaultId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/**
 * Retrieval evidence carries no record groups - the engine builds those on the
 * counting path only. So the disclosure for a retrieval answer is derived from
 * what IS there, and it says which rows it covers rather than implying it
 * covers the whole matched set.
 */
function groupingForRetrieval(request: AskRequest): GroupingResult {
  const evidence = request.evidence;
  if (evidence.kind !== 'retrieval') throw new Error('not a retrieval bundle');

  if (request.messageKeyAvailable !== 'none') {
    const groups = evidence.distinctMessageCount ?? 0;
    return {
      keyUsed: request.messageKeyAvailable === 'cluster_id' ? 'cluster_id' : 'record_id',
      groups: [],
      groupsBefore: evidence.matchedTripletCount,
      groupsAfter: groups,
      tripletCount: evidence.matchedTripletCount,
      ungroupableTripletCount: 0,
      note:
        'Grouped by record id, the per-message key the file carries: ' +
        String(evidence.matchedTripletCount) + ' matched triplets come from ' +
        String(groups) + ' source records.',
    };
  }

  // No key at all. Group the rows that were actually sent, by message text.
  const rows = (request.sample ?? []).slice(0, MAX_SAMPLE_ITEMS);
  const pseudo: MessageGroup[] = rows.map((r) => ({
    cluster_id: null,
    key_source: 'none',
    triplet_ids: [r.triplet_id],
    msg_text: r.msg_text,
    figures: [],
    note: null,
  }));
  const resolved = resolveGrouping(pseudo, 'none');
  return {
    ...resolved,
    note:
      resolved.note +
      ' This covers the ' + String(rows.length) + ' rows supplied with this ' +
      'question, not the whole matched set of ' +
      String(evidence.matchedTripletCount) + '.',
  };
}

export function groupingFor(request: AskRequest): GroupingResult {
  if (request.evidence.kind === 'aggregate') {
    return resolveGrouping(request.evidence.messageGroups, request.messageKeyAvailable);
  }
  return groupingForRetrieval(request);
}

export async function ask(request: AskRequest, deps: AskDeps): Promise<AskResponse> {
  const nowMs = deps.now ?? (() => Date.now());
  const nowIso = deps.clockIso ?? (() => new Date().toISOString());
  const newId = deps.newId ?? defaultId;
  const startedAt = nowMs();
  const notes: string[] = [];

  // Reported on a miss so the view can show what was compared and how close
  // the nearest stored question actually got. A miss is a measurement too.
  let outcome: CacheMatch = {
    hit: false,
    answerId: null,
    originalQuestion: null,
    originalAskedAt: null,
    similarity: 0,
    threshold: deps.threshold ?? DEFAULT_SIMILARITY_THRESHOLD,
    method: 'stemmed-jaccard+trigram',
    candidatesConsidered: 0,
  };

  const grouping = groupingFor(request);

  /* ---- 2. the shared cache, scoped to this graph ---- */
  const allowCache = request.allowCache !== false;
  if (allowCache) {
    let found = null as ReturnType<typeof lookup> | null;
    try {
      found = lookup(deps.store, request.graphKey, request.question, {
        threshold: deps.threshold,
      });
    } catch (err) {
      notes.push(
        'The stored questions could not be read, so this was answered fresh: ' +
        (err instanceof Error ? err.message : String(err)),
      );
    }
    if (found !== null && found.match.hit && found.answer !== null) {
      const at = nowIso();
      try {
        deps.store.recordHit(
          found.match.answerId as string,
          request.question,
          found.match.similarity,
          at,
        );
      } catch {
        notes.push('The cache hit could not be counted, but the answer below is the stored one.');
      }
      const label = cacheLabel(found.match);
      if (label !== null) notes.push(label);
      const stored = found.answer;
      return {
        answerId: stored.answerId,
        graphKey: stored.graphKey,
        question: request.question,
        kind: stored.kind,
        answer: stored.answer,
        reason: stored.reason,
        ok: stored.ok,
        provider: stored.provider,
        model: stored.model,
        grouping: {
          keyUsed: stored.grouping.keyUsed,
          groupsBefore: stored.grouping.groupsBefore,
          groupsAfter: stored.grouping.groupsAfter,
          ungroupableTripletCount: stored.grouping.ungroupableTripletCount,
          note: stored.grouping.note,
        },
        preprompt: {
          version: stored.prepromptVersion,
          groupingSentence: stored.groupingSentence,
        },
        cache: found.match,
        askedAt: at,
        elapsedMs: nowMs() - startedAt,
        notes,
      };
    }
    if (found !== null) {
      outcome = found.match;
      notes.push(
        'No stored question was close enough to reuse (' +
        String(found.match.candidatesConsidered) +
        ' compared, threshold ' + found.match.threshold.toFixed(2) + ').',
      );
    }
  } else {
    notes.push('The cache was skipped for this question; the answer below is fresh.');
  }

  /* ---- 3. the standing pre-prompt. Every call. ---- */
  const preprompt = assemblePreprompt({
    grouping: {
      keyUsed: grouping.keyUsed,
      groupCount: grouping.groupsAfter,
      tripletCount: grouping.tripletCount,
      ungroupableTripletCount: grouping.ungroupableTripletCount,
    },
  });

  /* ---- 4 and 5. render, then call ---- */
  const adapter = adapterFor(request.provider);
  const model = request.model && request.model.trim() !== ''
    ? request.model.trim()
    : adapter.defaultModel;
  const user = renderUserMessage(request, grouping);
  const modelRequest = makeRequest(preprompt.text, user, model, {
    temperature: DEFAULT_TEMPERATURE,
  });

  const response = await adapter.complete(modelRequest, {
    post: deps.post,
    env: deps.env,
    now: deps.now,
  });

  if (!response.ok && response.reason !== null) notes.push(response.reason);

  /* ---- 6. store it, whether it worked or not ---- */
  const answerId = newId();
  const askedAt = nowIso();
  const signature = signatureOf(request.question);

  try {
    deps.store.insert({
      answerId,
      graphKey: request.graphKey,
      graphLabel: request.graphLabel ?? null,
      question: request.question,
      questionContent: signature.content,
      questionNormalised: signature.normalised,
      kind: request.kind,
      provider: request.provider,
      model: response.model,
      ok: response.ok,
      answer: response.text,
      reason: response.reason,
      evidence: request.evidence,
      query: request.query,
      engine: request.engine,
      shape: request.shape,
      grouping,
      groupingSentence: preprompt.groupingSentence,
      prepromptVersion: preprompt.version,
      total: request.total,
      askedAt,
    });
  } catch (err) {
    notes.push(
      'This answer could not be saved, so nobody else will be able to reuse it: ' +
      (err instanceof Error ? err.message : String(err)),
    );
  }

  return {
    answerId,
    graphKey: request.graphKey,
    question: request.question,
    kind: request.kind,
    answer: response.text,
    reason: response.reason,
    ok: response.ok,
    provider: response.provider,
    model: response.model,
    grouping: {
      keyUsed: grouping.keyUsed,
      groupsBefore: grouping.groupsBefore,
      groupsAfter: grouping.groupsAfter,
      ungroupableTripletCount: grouping.ungroupableTripletCount,
      note: grouping.note,
    },
    preprompt: {
      version: preprompt.version,
      groupingSentence: preprompt.groupingSentence,
    },
    cache: outcome,
    askedAt,
    elapsedMs: nowMs() - startedAt,
    notes,
  };
}
