/**
 * Service tests.
 *
 * NO LIVE MODEL CALL IS MADE BY ANY TEST IN THIS FILE. Every provider is
 * exercised through an injected fake transport, and the one assertion that
 * matters most about keys - that a key value never leaves the service on any
 * field of any response - is made against a fake key that exists only inside
 * the test environment object.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assemblePreprompt,
  PREPROMPT_CLAUSES,
  PREPROMPT_VERSION,
  REQUIRED_CLAUSE_IDS,
  WORKED_EXAMPLE,
  groupingSentenceFor,
} from '../preprompt.js';
import { resolveGrouping, messageTextKeyOf } from '../grouping.js';
import { KEY_ENV_VARS, keyEnvVarFor, keyPresent, readApiKey, redact, ollamaHost } from '../keys.js';
import { ADAPTERS, adapterFor, providerAvailability, isProviderId } from '../adapters/index.js';
import { makeRequest, DEFAULT_TEMPERATURE } from '../adapters/base.js';
import { AnswerStore } from '../store.js';
import { lookup, cacheLabel } from '../cache.js';
import { similarityOfQuestions, DEFAULT_SIMILARITY_THRESHOLD } from '../similarity.js';
import { graphKeyOf } from '../graphkey.js';
import { ask } from '../answer.js';
import { handle, API_BASE } from '../http.js';
import { renderUserMessage } from '../render.js';
import type { AskRequest, HttpPost, ModelProviderId } from '../types.js';
import type { MessageGroup, AggregateEvidence, RetrievalEvidence } from '../../engine/types.js';

const FAKE_KEY = 'sk-test-0000000000000000-not-a-real-key';

function envWith(provider: ModelProviderId): Record<string, string | undefined> {
  const name = keyEnvVarFor(provider);
  return name === null ? {} : { [name]: FAKE_KEY };
}

/**
 * Every key variable set at once - which is what the process environment
 * looks like in production, and what every adapter is handed there.
 *
 * It matters for the redaction test: `redact` can only remove key values it
 * can see in the environment it was given. An adapter handed a stripped
 * environment cannot redact a key it has no way to recognise, so the honest
 * test of the guarantee is the environment the service actually runs with.
 */
function envAll(): Record<string, string | undefined> {
  return {
    GEMINI_API_KEY: FAKE_KEY,
    OPENAI_API_KEY: FAKE_KEY,
    ANTHROPIC_API_KEY: FAKE_KEY,
  };
}

interface FakeCall { url: string; headers: Record<string, string>; body: string }

function fakePost(
  reply: { status: number; body: string } | (() => never),
): { post: HttpPost; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const post: HttpPost = async (url, headers, body) => {
    calls.push({ url, headers, body });
    if (typeof reply === 'function') reply();
    return reply as { status: number; body: string };
  };
  return { post, calls };
}

function bodyFor(provider: ModelProviderId, text: string): string {
  if (provider === 'gemini') {
    return JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      modelVersion: 'gemini-test',
    });
  }
  if (provider === 'openai') {
    return JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      model: 'openai-test',
    });
  }
  if (provider === 'claude') {
    return JSON.stringify({ content: [{ text }], stop_reason: 'end_turn', model: 'claude-test' });
  }
  return JSON.stringify({ message: { content: text }, done_reason: 'stop', model: 'ollama-test' });
}

function group(cluster_id: string | null, msg_text: string, ids: string[]): MessageGroup {
  return {
    cluster_id,
    key_source: cluster_id === null ? 'none' : 'cluster_id',
    triplet_ids: ids,
    msg_text,
    figures: [],
    note: null,
  };
}

function aggregateEvidence(groups: MessageGroup[]): AggregateEvidence & { kind: 'aggregate' } {
  return {
    kind: 'aggregate',
    matchedNodeCount: 10,
    matchedTripletCount: groups.reduce((n, g) => n + g.triplet_ids.length, 0),
    distinctMessageCount: null,
    tripletsWithFigures: 0,
    figures: [],
    unitlessFiguresSetAside: 0,
    messageGroups: groups,
    facets: [],
    sum: null,
    sumRefusalReason: 'these figures are not addable',
  };
}

function retrievalEvidence(matched: number): RetrievalEvidence & { kind: 'retrieval' } {
  return {
    kind: 'retrieval',
    candidateCount: matched,
    matchedTripletCount: matched,
    matchedNodeCount: matched,
    distinctMessageCount: null,
    hitsWithMedia: matched,
    hitsWithHandling: 0,
    clauseCounts: [],
    facets: [],
  };
}

function askRequest(over: Partial<AskRequest> = {}): AskRequest {
  return {
    graphKey: 'gk1:aaaa-bbbb',
    graphLabel: 'sample',
    question: 'how many deaths occurred during the hurricane',
    kind: 'aggregate',
    evidence: aggregateEvidence([
      group(null, 'a strike killed 12 people', ['t1']),
      group(null, 'a strike killed 12 people', ['t2']),
    ]),
    query: {
      kind: 'aggregate', text: 'q', clauses: [], terms: [], filters: {},
      matcher: { name: 'exact-term-membership', version: '1.0.0', params: {} },
      issuedAt: '2026-10-20T00:00:00.000Z',
    },
    engine: {
      contractVersion: '1.0.0', shape: 'legacy',
      matcher: { name: 'exact-term-membership', version: '1.0.0', params: {} },
    },
    shape: {
      shape: 'legacy', confidence: 0.99, nodeCount: 1689, edgeCount: 6866,
      hierarchyCounts: {}, tripletNodeCount: 0, clusterNodeCount: 0,
      categoryNodeCount: 0, tripleBearingCategoryNodeCount: 0,
      legacyFieldsSeen: [], signals: [], warnings: [],
    },
    total: 2,
    messageKeyAvailable: 'none',
    provider: 'ollama',
    ...over,
  };
}

async function freshStore(): Promise<AnswerStore> {
  return AnswerStore.open(':memory:');
}

/* ---------------- 1. the standing pre-prompt ---------------- */

test('pre-prompt: every required clause reaches the assembled text', () => {
  const p = assemblePreprompt({
    grouping: { keyUsed: 'cluster_id', groupCount: 3, tripletCount: 7, ungroupableTripletCount: 0 },
  });
  assert.equal(p.version, PREPROMPT_VERSION);
  assert.deepEqual(p.clauseIds, [...REQUIRED_CLAUSE_IDS]);
  for (const clause of PREPROMPT_CLAUSES) {
    assert.ok(
      p.text.includes(clause.heading.toUpperCase()),
      'clause heading missing from assembled pre-prompt: ' + clause.id,
    );
    if (clause.fixed && clause.body !== null) {
      assert.ok(p.text.includes(clause.body.slice(0, 48)), 'clause body missing: ' + clause.id);
    }
  }
  assert.equal(REQUIRED_CLAUSE_IDS.length, 9);
});

test('pre-prompt: each of the six required points is stated', () => {
  const p = assemblePreprompt({
    grouping: { keyUsed: 'record_id', groupCount: 1, tripletCount: 1, ungroupableTripletCount: 0 },
  });
  const t = p.text;
  assert.ok(t.includes('subject -> predicate -> object'), 'point 1: what a triplet is');
  assert.ok(t.includes('1,992 nodes collapse to 953 triplets'), 'point 2: node vs triplet count');
  assert.ok(t.includes(WORKED_EXAMPLE), 'point 3: the worked example, verbatim');
  assert.ok(t.includes('Do not sum'), 'point 4: never add figures');
  assert.ok(t.includes('No outside knowledge'), 'point 5: evidence only');
  assert.ok(t.includes('plain words'), 'point 6: brief and plain');
});

test('pre-prompt: the worked example is byte-for-byte what was asked for', () => {
  assert.equal(WORKED_EXAMPLE, '12 deaths should not be compounded. It should only be 12.');
});

test('pre-prompt: the disclosure never claims a grouping the data did not supply', () => {
  const byText = groupingSentenceFor({
    keyUsed: 'message_text', groupCount: 4, tripletCount: 9, ungroupableTripletCount: 0,
  });
  assert.ok(byText.includes('NO cluster id'));
  assert.ok(byText.includes('is NOT a cluster id'));
  assert.ok(byText.includes('do not state a number of either'));

  const none = groupingSentenceFor({
    keyUsed: 'none', groupCount: 3, tripletCount: 3, ungroupableTripletCount: 3,
  });
  assert.ok(none.includes('could NOT be grouped'));
  assert.ok(!none.includes('grouped into'), 'a failed grouping must not read as a grouping');

  const byId = groupingSentenceFor({
    keyUsed: 'cluster_id', groupCount: 2, tripletCount: 5, ungroupableTripletCount: 0,
  });
  assert.ok(byId.includes('cluster id'));
  assert.ok(byId.includes('however many attachments it had'));
  assert.ok(!byId.includes('NOT a cluster id'));

  // A row id standing in for a message id must never be described as one.
  const byRow = groupingSentenceFor({
    keyUsed: 'record_id', groupCount: 2, tripletCount: 2, ungroupableTripletCount: 0,
  });
  assert.ok(byRow.includes('NO cluster id'));
  assert.ok(byRow.includes('one per row'));
  assert.ok(byRow.includes('two groups'), 'the splitting risk must be stated');
  // It must PROHIBIT a message count rather than state one. Testing for the
  // absence of the phrase would fail on the prohibition itself.
  assert.ok(byRow.includes('do not call this a number of messages'));
  assert.ok(!byRow.includes('were grouped into 2 source messages'));
});

test('pre-prompt: the data dictionary definitions of the ids reach the text', () => {
  const p = assemblePreprompt({
    grouping: { keyUsed: 'cluster_id', groupCount: 2, tripletCount: 5, ungroupableTripletCount: 0 },
  });
  const t = p.text;
  // cluster_id, as the dictionary states it.
  assert.ok(t.includes('originating MESSAGE'), 'the cluster_id definition must reach the model');
  assert.ok(t.includes('shared by every triplet that came out of it'));
  // record_id, with the consequence that caused the bug this clause exists for.
  assert.ok(t.includes('two attachments gets two'));
  assert.ok(t.includes('ONE MESSAGE WITH TWO ATTACHMENTS IS'));
  // the other identity fields the dictionary names
  assert.ok(t.includes('reference_key'));
  assert.ok(t.includes('cluster:triplet:record:msg'));
  // the three category fields are distinguished, not conflated
  assert.ok(t.includes('cluster_categories'));
  // and the per-channel evidence rules
  assert.ok(t.includes('Not analysed. Generate nothing from it.'));
  assert.ok(t.includes('you are reading that analysis, not a caption'));
});

test('pre-prompt: ungroupable rows are declared, not hidden', () => {
  const s = groupingSentenceFor({
    keyUsed: 'message_text', groupCount: 2, tripletCount: 5, ungroupableTripletCount: 3,
  });
  assert.ok(s.includes('3 of them carried no value for that key'));
});

/* ---------------- 2. grouping - the B065 resolution ---------------- */

test('grouping: the cluster id is used when the file supplies one', () => {
  const r = resolveGrouping(
    [group('c1', 'one', ['t1']), group('c1', 'one', ['t2']), group('c2', 'two', ['t3'])],
    'cluster_id',
  );
  assert.equal(r.keyUsed, 'cluster_id');
  assert.equal(r.groupsBefore, 3);
  assert.equal(r.groupsAfter, 2);
  assert.equal(r.tripletCount, 3);
  assert.equal(r.ungroupableTripletCount, 0);
});

test('grouping: a null cluster id is never merged with another null', () => {
  const r = resolveGrouping([group(null, 'a', ['t1']), group(null, 'b', ['t2'])], 'cluster_id');
  assert.equal(r.keyUsed, 'cluster_id');
  assert.equal(r.groupsAfter, 2, 'absent ids are not a shared id');
  assert.equal(r.ungroupableTripletCount, 2);
});

test('grouping: the fallback collapses identical message text', () => {
  const r = resolveGrouping(
    [
      group(null, 'A strike killed 12 people.', ['t1']),
      group(null, 'a strike  killed 12 PEOPLE.', ['t2']),
      group(null, 'a different message entirely', ['t3']),
    ],
    'none',
  );
  assert.equal(r.keyUsed, 'message_text');
  assert.equal(r.groupsBefore, 3);
  assert.equal(r.groupsAfter, 2, 'the two restatements of one message became one group');
  assert.equal(r.ungroupableTripletCount, 0);
  assert.ok(r.note.includes('no cluster id'));
  assert.ok(r.note.includes('not a cluster id'));
});

test('grouping: the fallback never invents an id', () => {
  const r = resolveGrouping([group(null, 'same', ['t1']), group(null, 'same', ['t2'])], 'none');
  for (const g of r.groups) {
    assert.equal(g.cluster_id, null, 'no group may carry an id the file did not supply');
  }
});

test('grouping: a file with rows but no cluster id is labelled record_id, not cluster_id', () => {
  // The dictionary: record_id is one per ROW, "a message with two attachments
  // gets two". So this grouping may split one message, and it must say so
  // rather than borrow the cluster id's name.
  const r = resolveGrouping(
    [group('row1', 'one message, two attachments', ['t1']),
     group('row2', 'one message, two attachments', ['t2'])],
    'record_id',
  );
  assert.equal(r.keyUsed, 'record_id');
  assert.equal(r.groupsAfter, 2, 'two rows of one message are two groups on this key');
  assert.ok(r.note.includes('one per row'));
  assert.ok(r.note.includes('must not be reported as a number of messages'));
});

test('grouping: empty message text is ungroupable, not one big group', () => {
  const r = resolveGrouping(
    [group(null, '', ['t1']), group(null, '', ['t2']), group(null, 'real text', ['t3'])],
    'none',
  );
  assert.equal(r.keyUsed, 'message_text');
  assert.equal(r.groupsAfter, 3, 'two empty-text rows must not merge into one');
  assert.equal(r.ungroupableTripletCount, 2);
});

test('grouping: nothing to key on at all reports "none"', () => {
  const r = resolveGrouping([group(null, '', ['t1']), group(null, '   ', ['t2'])], 'none');
  assert.equal(r.keyUsed, 'none');
  assert.equal(r.ungroupableTripletCount, 2);
  assert.ok(r.note.includes('could not be grouped'));
});

test('grouping: messageTextKeyOf is null for text with no content', () => {
  assert.equal(messageTextKeyOf(group(null, '', ['t'])), null);
  assert.equal(messageTextKeyOf(group(null, '   ', ['t'])), null);
  assert.notEqual(messageTextKeyOf(group(null, 'something', ['t'])), null);
});

/* ---------------- 3. keys - by name only ---------------- */

test('keys: every cloud provider names an env var and the local one does not', () => {
  assert.equal(KEY_ENV_VARS.gemini, 'GEMINI_API_KEY');
  assert.equal(KEY_ENV_VARS.openai, 'OPENAI_API_KEY');
  assert.equal(KEY_ENV_VARS.claude, 'ANTHROPIC_API_KEY');
  assert.equal(KEY_ENV_VARS.ollama, null);
});

test('keys: an unset variable yields null, never a default', () => {
  assert.equal(readApiKey('gemini', {}), null);
  assert.equal(readApiKey('openai', { OPENAI_API_KEY: '   ' }), null);
  assert.equal(keyPresent('openai', {}), false);
  assert.equal(keyPresent('ollama', {}), true, 'the local provider needs no key');
});

test('keys: redact removes a configured key value from any message', () => {
  const env = { OPENAI_API_KEY: FAKE_KEY };
  const clean = redact('the provider said: invalid key ' + FAKE_KEY + ' for this account', env);
  assert.ok(!clean.includes(FAKE_KEY));
  assert.ok(clean.includes('[redacted]'));
});

test('keys: the local host comes from a variable name with a loopback default', () => {
  assert.equal(ollamaHost({}), 'http://127.0.0.1:11434');
  assert.equal(ollamaHost({ OLLAMA_HOST: 'http://elsewhere:9999/' }), 'http://elsewhere:9999');
});

/* ---------------- 4. the adapter layer ---------------- */

const PROVIDERS: ModelProviderId[] = ['gemini', 'openai', 'claude', 'ollama'];

for (const provider of PROVIDERS) {
  test('adapter ' + provider + ': answers through an injected fake', async () => {
    const adapter = adapterFor(provider);
    const { post, calls } = fakePost({ status: 200, body: bodyFor(provider, 'twelve people, once.') });
    const res = await adapter.complete(
      makeRequest('SYSTEM-PREPROMPT-MARKER', 'USER-EVIDENCE-MARKER', adapter.defaultModel),
      { post, env: envWith(provider) },
    );
    assert.equal(res.ok, true);
    assert.equal(res.text, 'twelve people, once.');
    assert.equal(res.reason, null);
    assert.equal(res.provider, provider);
    assert.equal(res.temperature, DEFAULT_TEMPERATURE);
    assert.equal(calls.length, 1);
    assert.ok(
      (calls[0] as FakeCall).body.includes('SYSTEM-PREPROMPT-MARKER'),
      'the pre-prompt must reach every provider',
    );
  });

  test('adapter ' + provider + ': a non-2xx is a blank and a reason, not a throw', async () => {
    const adapter = adapterFor(provider);
    const { post } = fakePost({ status: 500, body: 'upstream exploded' });
    const res = await adapter.complete(makeRequest('sys', 'usr', adapter.defaultModel),
      { post, env: envWith(provider) });
    assert.equal(res.ok, false);
    assert.equal(res.text, '');
    assert.ok(typeof res.reason === 'string' && res.reason.length > 0);
  });

  test('adapter ' + provider + ': a body that is not JSON is a blank and a reason', async () => {
    const adapter = adapterFor(provider);
    const { post } = fakePost({ status: 200, body: '<html>nope</html>' });
    const res = await adapter.complete(makeRequest('sys', 'usr', adapter.defaultModel),
      { post, env: envWith(provider) });
    assert.equal(res.ok, false);
    assert.equal(res.text, '');
    assert.ok((res.reason ?? '').includes('not JSON'));
  });

  test('adapter ' + provider + ': a transport that throws does not escape', async () => {
    const adapter = adapterFor(provider);
    const { post } = fakePost(() => { throw new Error('socket hang up'); });
    const res = await adapter.complete(makeRequest('sys', 'usr', adapter.defaultModel),
      { post, env: envWith(provider) });
    assert.equal(res.ok, false);
    assert.equal(res.text, '');
    assert.ok((res.reason ?? '').includes('socket hang up'));
  });

  test('adapter ' + provider + ': no key value appears on any returned field', async () => {
    const adapter = adapterFor(provider);
    const { post } = fakePost({ status: 401, body: 'bad key: ' + FAKE_KEY });
    const res = await adapter.complete(makeRequest('sys', 'usr', adapter.defaultModel),
      { post, env: envAll() });
    assert.ok(!JSON.stringify(res).includes(FAKE_KEY), 'a key reached a response field');
    assert.ok((res.reason ?? '').includes('[redacted]'), 'the key was not replaced');
  });
}

test('adapter: a cloud provider with no key set makes no call at all', async () => {
  for (const provider of ['gemini', 'openai', 'claude'] as ModelProviderId[]) {
    const adapter = adapterFor(provider);
    const { post, calls } = fakePost({ status: 200, body: bodyFor(provider, 'x') });
    const res = await adapter.complete(makeRequest('s', 'u', adapter.defaultModel), { post, env: {} });
    assert.equal(res.ok, false);
    assert.equal(res.text, '');
    assert.equal(calls.length, 0, provider + ' attempted a call with no key');
    assert.ok((res.reason ?? '').includes(String(keyEnvVarFor(provider))));
  }
});

test('adapter: the local provider needs no key and no env at all', async () => {
  const { post, calls } = fakePost({ status: 200, body: bodyFor('ollama', 'local answer') });
  const res = await ADAPTERS.ollama.complete(makeRequest('s', 'u', 'llama3.1'), { post, env: {} });
  assert.equal(res.ok, true);
  assert.equal(res.text, 'local answer');
  assert.equal(calls.length, 1);
  assert.ok((calls[0] as FakeCall).url.startsWith('http://127.0.0.1:11434'));
  assert.deepEqual((calls[0] as FakeCall).headers, { 'content-type': 'application/json' });
});

test('adapter: availability reports key presence by name, never by value', () => {
  const list = providerAvailability({ GEMINI_API_KEY: FAKE_KEY });
  assert.ok(!JSON.stringify(list).includes(FAKE_KEY));
  assert.equal(list.find((p) => p.id === 'gemini')?.keyPresent, true);
  assert.equal(list.find((p) => p.id === 'gemini')?.keyEnvVar, 'GEMINI_API_KEY');
  assert.equal(list.find((p) => p.id === 'openai')?.keyPresent, false);
  assert.equal(list.find((p) => p.id === 'openai')?.usable, false);
  assert.equal(list.find((p) => p.id === 'ollama')?.usable, true);
  assert.equal(list.find((p) => p.id === 'ollama')?.worksOffline, true);
});

test('adapter: the registry covers exactly the four providers', () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), ['claude', 'gemini', 'ollama', 'openai']);
  assert.ok(isProviderId('ollama'));
  assert.ok(!isProviderId('llama'));
});

/* ---------------- 5. similarity and the graph key ---------------- */

test('similarity: identical questions score 1', () => {
  assert.equal(similarityOfQuestions('how many deaths in the flood', 'how many deaths in the flood'), 1);
});

test('similarity: boilerplate alone does not reach the threshold', () => {
  const s = similarityOfQuestions(
    'how many deaths occurred during Hurricane Harvey',
    'how many deaths occurred during the wildfires',
  );
  assert.ok(s < DEFAULT_SIMILARITY_THRESHOLD,
    'two different events scored ' + s.toFixed(3) + ', at or above the threshold');
});

test('similarity: a typo in an ordinary word still matches', () => {
  const s = similarityOfQuestions(
    'how many deaths occurred during Hurricane Harvey',
    'how many deaths occured during Hurricane Harvey');
  assert.ok(s >= DEFAULT_SIMILARITY_THRESHOLD, 'typo scored ' + s.toFixed(3));
});

test('similarity: a typo in the ENTITY does not match, and that is deliberate', () => {
  // "Harvy" for "Harvey" is one dropped letter and scores 0.724, under the
  // threshold. That is a real recall loss and it is accepted, because the
  // edit that makes "Harvy" into "Harvey" is the same size as the one that
  // makes "Irma" into a near-neighbour of it: a character test cannot tell a
  // misspelled storm from a different storm. The cost of the miss is one
  // model call; the cost of the hit would be an answer about another event.
  const typo = similarityOfQuestions(
    'how many deaths in Hurricane Harvey', 'how many deaths in Hurricane Harvy');
  const other = similarityOfQuestions(
    'deaths during Hurricane Harvey', 'deaths during Hurricane Irma');
  assert.ok(typo < DEFAULT_SIMILARITY_THRESHOLD, 'typo scored ' + typo.toFixed(3));
  assert.ok(other < DEFAULT_SIMILARITY_THRESHOLD,
    'two different storms scored ' + other.toFixed(3) + ' - this one must never hit');
});

test('similarity: different measures of the same event do not match', () => {
  // The pair that set the threshold. Deaths and injuries are different
  // questions and reusing one answer for the other would be wrong.
  const s = similarityOfQuestions(
    'how many deaths occurred during Hurricane Harvey',
    'how many injuries occurred during Hurricane Harvey');
  assert.ok(s < DEFAULT_SIMILARITY_THRESHOLD,
    'deaths vs injuries scored ' + s.toFixed(3) + ', at or above the threshold');
});

test('similarity: word order does not matter', () => {
  assert.equal(similarityOfQuestions(
    'burning buildings and collapsed buildings',
    'collapsed buildings and burning buildings'), 1);
});

test('graph key: same content gives the same key, different content does not', () => {
  const shape = askRequest().shape;
  const a = graphKeyOf({ shape, tripletIds: ['t1', 't2', 't3'], messageKeyAvailable: 'none' });
  const b = graphKeyOf({ shape, tripletIds: ['t3', 't1', 't2'], messageKeyAvailable: 'none' });
  const c = graphKeyOf({ shape, tripletIds: ['t1', 't2', 't4'], messageKeyAvailable: 'none' });
  assert.equal(a, b, 'order must not change the key');
  assert.notEqual(a, c);
});

/* ---------------- 6. the store ---------------- */

test('store: schema migrates and reports its version', async () => {
  const store = await freshStore();
  assert.equal(store.schemaVersion(), 1);
  assert.equal(store.countAnswers(), 0);
  store.close();
});

test('store: an answer survives a restart and a SECOND reader sees it', async () => {
  // A real file, so this proves durability rather than process memory. It is
  // written to the OS temp directory, never into the repository.
  const path = join(tmpdir(), 'graph-chat-restart-test-' + String(Date.now()) + '.db');

  const first = await AnswerStore.open(path);
  const { post } = fakePost({ status: 200, body: bodyFor('ollama', 'stored answer') });
  const response = await ask(askRequest(), {
    store: first, post, env: {},
    newId: () => 'answer-1', clockIso: () => '2026-10-20T10:00:00.000Z',
  });
  assert.equal(response.ok, true);
  first.close();

  // A different AnswerStore over the same file: a second viewer, after a restart.
  const second = await AnswerStore.open(path);
  const readBack = second.get('answer-1');
  assert.notEqual(readBack, null);
  assert.equal(readBack?.answer, 'stored answer');
  assert.equal(readBack?.question, askRequest().question);
  assert.equal(second.history(askRequest().graphKey).length, 1);
  second.close();
});

test('store: history is scoped to one graph', async () => {
  const store = await freshStore();
  const { post } = fakePost({ status: 200, body: bodyFor('ollama', 'a') });
  const base = { store, post, env: {}, clockIso: () => '2026-10-20T10:00:00.000Z' };
  await ask(askRequest({ graphKey: 'gk1:one' }), { ...base, newId: () => 'a1' });
  await ask(askRequest({ graphKey: 'gk1:two' }), { ...base, newId: () => 'a2' });
  assert.equal(store.history('gk1:one').length, 1);
  assert.equal(store.history('gk1:two').length, 1);
  assert.equal(store.history('gk1:three').length, 0);
  store.close();
});

/* ---------------- 7. the cache ---------------- */

test('cache: a near-duplicate on the SAME graph is a hit, and is labelled', async () => {
  const store = await freshStore();
  const { post, calls } = fakePost({ status: 200, body: bodyFor('ollama', 'twelve, once') });
  const deps = { store, post, env: {}, clockIso: () => '2026-10-20T10:00:00.000Z' };

  const first = await ask(
    askRequest({ question: 'how many deaths occurred during the hurricane' }),
    { ...deps, newId: () => 'answer-1' });
  assert.equal(first.cache.hit, false);
  assert.equal(calls.length, 1);

  const second = await ask(
    askRequest({ question: 'how many deaths occured during the hurricane' }),
    { ...deps, newId: () => 'answer-2' });
  assert.equal(second.cache.hit, true, 'a one-letter typo should reuse the stored answer');
  assert.equal(second.answerId, 'answer-1');
  assert.equal(second.answer, 'twelve, once');
  assert.equal(calls.length, 1, 'a cache hit must not call a model');
  assert.equal(second.cache.originalQuestion, 'how many deaths occurred during the hurricane');
  assert.equal(second.cache.originalAskedAt, '2026-10-20T10:00:00.000Z');
  const label = cacheLabel(second.cache);
  assert.ok(label !== null && label.includes('reused'));
  assert.ok(second.notes.some((n) => n.includes('reused')), 'the response must say it is reused');
  store.close();
});

test('cache: the same question against a DIFFERENT graph is a different question', async () => {
  const store = await freshStore();
  const { post, calls } = fakePost({ status: 200, body: bodyFor('ollama', 'x') });
  const deps = { store, post, env: {}, clockIso: () => '2026-10-20T10:00:00.000Z' };
  await ask(askRequest({ graphKey: 'gk1:file-a' }), { ...deps, newId: () => 'a1' });
  const second = await ask(askRequest({ graphKey: 'gk1:file-b' }), { ...deps, newId: () => 'a2' });
  assert.equal(second.cache.hit, false, 'a different graph must never hit');
  assert.equal(calls.length, 2);
  store.close();
});

test('cache: a stored FAILURE is never served as a hit', async () => {
  const store = await freshStore();
  const failing = fakePost({ status: 500, body: 'down' });
  const deps = { store, env: {}, clockIso: () => '2026-10-20T10:00:00.000Z' };
  const first = await ask(askRequest(), { ...deps, post: failing.post, newId: () => 'a1' });
  assert.equal(first.ok, false);

  const working = fakePost({ status: 200, body: bodyFor('ollama', 'real answer') });
  const second = await ask(askRequest(), { ...deps, post: working.post, newId: () => 'a2' });
  assert.equal(second.cache.hit, false, 'a failure must not be reused');
  assert.equal(second.answer, 'real answer');
  store.close();
});

test('cache: allowCache false forces a fresh call and still stores it', async () => {
  const store = await freshStore();
  const { post, calls } = fakePost({ status: 200, body: bodyFor('ollama', 'fresh') });
  const deps = { store, post, env: {}, clockIso: () => '2026-10-20T10:00:00.000Z' };
  await ask(askRequest(), { ...deps, newId: () => 'a1' });
  const second = await ask(askRequest({ allowCache: false }), { ...deps, newId: () => 'a2' });
  assert.equal(second.cache.hit, false);
  assert.equal(calls.length, 2);
  assert.equal(store.countAnswers(), 2);
  store.close();
});

test('cache: a hit is counted against the answer it reused', async () => {
  const store = await freshStore();
  const { post } = fakePost({ status: 200, body: bodyFor('ollama', 'y') });
  const deps = { store, post, env: {}, clockIso: () => '2026-10-20T10:00:00.000Z' };
  await ask(askRequest(), { ...deps, newId: () => 'a1' });
  await ask(askRequest(), { ...deps, newId: () => 'a2' });
  assert.equal(store.history(askRequest().graphKey)[0]?.hitCount, 1);
  store.close();
});

test('cache: lookup on an empty store is a clean miss', async () => {
  const store = await freshStore();
  const result = lookup(store, 'gk1:nothing', 'anything at all');
  assert.equal(result.match.hit, false);
  assert.equal(result.match.candidatesConsidered, 0);
  assert.equal(result.answer, null);
  store.close();
});

/* ---------------- 8. orchestration ---------------- */

test('ask: the standing pre-prompt is on the call, and states the key actually used', async () => {
  const store = await freshStore();
  const { post, calls } = fakePost({ status: 200, body: bodyFor('ollama', 'ok') });
  const res = await ask(askRequest(), {
    store, post, env: {}, newId: () => 'a1', clockIso: () => '2026-10-20T10:00:00.000Z',
  });
  const sent = JSON.parse((calls[0] as FakeCall).body) as {
    messages: Array<{ role: string; content: string }>;
  };
  const system = sent.messages.find((m) => m.role === 'system')?.content ?? '';
  assert.ok(system.includes(WORKED_EXAMPLE), 'the worked example must be on the call');
  assert.ok(system.includes('NO cluster id'), 'the call must say the file carried no cluster id');
  assert.equal(res.grouping.keyUsed, 'message_text');
  assert.equal(res.preprompt.version, PREPROMPT_VERSION);
  assert.ok(res.preprompt.groupingSentence.includes('is NOT a cluster id'));
  store.close();
});

test('ask: the fallback collapses the two restatements before the model sees them', async () => {
  const store = await freshStore();
  const { post } = fakePost({ status: 200, body: bodyFor('ollama', 'ok') });
  const res = await ask(askRequest(), {
    store, post, env: {}, newId: () => 'a1', clockIso: () => '2026-10-20T10:00:00.000Z',
  });
  assert.equal(res.grouping.groupsBefore, 2);
  assert.equal(res.grouping.groupsAfter, 1, 'one message, one group');
  store.close();
});

test('ask: a provider failure returns a blank and a reason, and the request survives', async () => {
  const store = await freshStore();
  const { post } = fakePost(() => { throw new Error('no route to host'); });
  const res = await ask(askRequest(), {
    store, post, env: {}, newId: () => 'a1', clockIso: () => '2026-10-20T10:00:00.000Z',
  });
  assert.equal(res.ok, false);
  assert.equal(res.answer, '');
  assert.ok((res.reason ?? '').includes('no route to host'));
  assert.equal(store.countAnswers(), 1, 'a failure is still history');
  store.close();
});

test('render: the user message carries no total and adds nothing', () => {
  const text = renderUserMessage(askRequest(), {
    keyUsed: 'message_text', groups: [], groupsBefore: 2, groupsAfter: 1,
    tripletCount: 2, ungroupableTripletCount: 0, note: 'grouped by message text',
  });
  assert.ok(text.includes('There is NO total in this evidence'));
  assert.ok(text.includes('matched graph nodes'));
  assert.ok(text.includes('THE count'));
});

test('render: a retrieval answer is told which rows it may describe', () => {
  const request = askRequest({
    kind: 'retrieval',
    evidence: retrievalEvidence(54),
    sample: [{
      triplet_id: 't1', label: 'Earthquake -> caused -> Building Collapse',
      msg_text: 'a message', hasMedia: true,
    }],
  });
  const text = renderUserMessage(request, {
    keyUsed: 'message_text', groups: [], groupsBefore: 1, groupsAfter: 1,
    tripletCount: 1, ungroupableTripletCount: 0, note: 'n',
  });
  assert.ok(text.includes('THE ROWS YOU MAY DESCRIBE - 1 of 54'));
  assert.ok(text.includes('[has an image]'));
});

/* ---------------- 9. the HTTP surface ---------------- */

test('http: health reports the versions without touching a key', async () => {
  const store = await freshStore();
  const { post } = fakePost({ status: 200, body: '{}' });
  const res = await handle('GET', API_BASE + '/health', '',
    { store, post, env: { OPENAI_API_KEY: FAKE_KEY } });
  assert.equal(res.status, 200);
  assert.ok(!res.body.includes(FAKE_KEY));
  const parsed = JSON.parse(res.body) as { prepromptVersion: string; schemaVersion: number };
  assert.equal(parsed.prepromptVersion, PREPROMPT_VERSION);
  assert.equal(parsed.schemaVersion, 1);
  store.close();
});

test('http: providers lists key NAMES and presence, never values', async () => {
  const store = await freshStore();
  const { post } = fakePost({ status: 200, body: '{}' });
  const res = await handle('GET', API_BASE + '/providers', '',
    { store, post, env: { GEMINI_API_KEY: FAKE_KEY } });
  assert.equal(res.status, 200);
  assert.ok(!res.body.includes(FAKE_KEY));
  assert.ok(res.body.includes('GEMINI_API_KEY'));
  store.close();
});

test('http: the pre-prompt is readable and there is no route that writes it', async () => {
  const store = await freshStore();
  const { post } = fakePost({ status: 200, body: '{}' });
  const res = await handle('GET', API_BASE + '/preprompt', '', { store, post, env: {} });
  const parsed = JSON.parse(res.body) as { editable: boolean; clauses: unknown[]; exampleText: string };
  assert.equal(parsed.editable, false);
  assert.equal(parsed.clauses.length, REQUIRED_CLAUSE_IDS.length);
  assert.ok(parsed.exampleText.includes(WORKED_EXAMPLE));

  const write = await handle('POST', API_BASE + '/preprompt', '{}', { store, post, env: {} });
  assert.equal(write.status, 404, 'there must be no way to edit the pre-prompt');
  store.close();
});

test('http: ask refuses a request it cannot answer honestly', async () => {
  const store = await freshStore();
  const { post } = fakePost({ status: 200, body: '{}' });
  const deps = { store, post, env: {} };

  const noKey = await handle('POST', API_BASE + '/ask', JSON.stringify({ question: 'x' }), deps);
  assert.equal(noKey.status, 400);
  assert.ok(noKey.body.includes('graphKey'));

  const noFlag = await handle('POST', API_BASE + '/ask', JSON.stringify({
    graphKey: 'g', question: 'q', provider: 'ollama', evidence: { kind: 'aggregate' },
  }), deps);
  assert.equal(noFlag.status, 400);
  assert.ok(noFlag.body.includes('messageKeyAvailable'));

  assert.equal((await handle('POST', API_BASE + '/ask', 'not json', deps)).status, 400);
  store.close();
});

test('http: a cloud provider with no key gets an answer-shaped refusal, not a 500', async () => {
  const store = await freshStore();
  const { post, calls } = fakePost({ status: 200, body: '{}' });
  const res = await handle('POST', API_BASE + '/ask',
    JSON.stringify(askRequest({ provider: 'openai' })), { store, post, env: {} });
  assert.equal(res.status, 200);
  const parsed = JSON.parse(res.body) as { ok: boolean; answer: string; reason: string };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.answer, '');
  assert.ok(parsed.reason.includes('OPENAI_API_KEY'));
  assert.equal(calls.length, 0);
  store.close();
});

test('http: ask, then history, then the full answer', async () => {
  const store = await freshStore();
  const { post } = fakePost({ status: 200, body: bodyFor('ollama', 'an answer') });
  const deps = { store, post, env: {}, newId: () => 'a1', clockIso: () => '2026-10-20T10:00:00.000Z' };

  assert.equal((await handle('POST', API_BASE + '/ask', JSON.stringify(askRequest()), deps)).status, 200);

  const history = await handle('GET',
    API_BASE + '/history?graphKey=' + encodeURIComponent('gk1:aaaa-bbbb'), '', deps);
  const entries = (JSON.parse(history.body) as {
    entries: Array<{ answerId: string; groupingKeyUsed: string }>;
  }).entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.groupingKeyUsed, 'message_text');

  const full = await handle('GET', API_BASE + '/answer/a1', '', deps);
  assert.equal(full.status, 200);
  const stored = JSON.parse(full.body) as { answer: string; evidence: { kind: string } };
  assert.equal(stored.answer, 'an answer');
  assert.equal(stored.evidence.kind, 'aggregate', 'the evidence bundle is stored with the answer');

  assert.equal((await handle('GET', API_BASE + '/answer/nope', '', deps)).status, 404);
  store.close();
});

test('http: history requires a graph key', async () => {
  const store = await freshStore();
  const { post } = fakePost({ status: 200, body: '{}' });
  assert.equal((await handle('GET', API_BASE + '/history', '', { store, post, env: {} })).status, 400);
  store.close();
});

test('http: an unknown route is a 404 and CORS is answered', async () => {
  const store = await freshStore();
  const { post } = fakePost({ status: 200, body: '{}' });
  assert.equal((await handle('GET', '/nope', '', { store, post, env: {} })).status, 404);
  assert.equal((await handle('OPTIONS', API_BASE + '/ask', '', { store, post, env: {} })).status, 204);
  store.close();
});

/* ---------------- 10. end to end, no key and no internet ---------------- */

test('end to end: local provider, no key, no network - ask, store, reuse', async () => {
  const store = await freshStore();
  const { post, calls } = fakePost({
    status: 200, body: bodyFor('ollama', 'Twelve people, stated twice in one message.'),
  });
  const deps = { store, post, env: {}, clockIso: () => '2026-10-20T10:00:00.000Z' };

  const first = await handle('POST', API_BASE + '/ask', JSON.stringify(askRequest()),
    { ...deps, newId: () => 'e2e-1' });
  const a = JSON.parse(first.body) as {
    ok: boolean; grouping: { keyUsed: string; groupsAfter: number };
  };
  assert.equal(a.ok, true);
  assert.equal(a.grouping.keyUsed, 'message_text');
  assert.equal(a.grouping.groupsAfter, 1);

  const second = await handle('POST', API_BASE + '/ask',
    JSON.stringify(askRequest({ question: 'how many deaths happened during the hurricane' })),
    { ...deps, newId: () => 'e2e-2' });
  const b = JSON.parse(second.body) as { cache: { hit: boolean; originalQuestion: string } };

  // Whether this one is close enough is the threshold's business; what must
  // hold either way is that a hit is labelled and a miss calls a model.
  if (b.cache.hit) {
    assert.equal(b.cache.originalQuestion, askRequest().question);
    assert.equal(calls.length, 1);
  } else {
    assert.equal(calls.length, 2);
  }
  assert.ok(store.countAnswers() >= 1);
  store.close();
});
