// graph-chat/engine/__tests__/engine.test.ts
//
// Tests that pin THIS change and nothing else. They use hand-built fixtures
// rather than the sample corpora: a test that needs an 11 MB file to run is a
// test nobody runs, and the behaviours below are about shape and arithmetic,
// not about volume.
//
//   node --import tsx --test graph-chat/engine/__tests__/engine.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DISPLAY_CAP, detectShape, extractFigures, ingestGraph, loadGraph,
  splitClauses, toDisplayPage, type RawGraph,
} from '../index.js';

const AT = '2026-10-20T00:00:00.000Z';

// ── fixtures ────────────────────────────────────────────────────────────────

/** Contract shape. T1 is ONE triplet emitted as THREE nodes, one per category
 *  — the exact thing a node-level count would multiply. T1 and T2 share a
 *  record and both state twelve of something, which is the duplicate the
 *  evidence set has to show rather than add. */
function contractGraph(): RawGraph {
  const base = {
    hierarchy: 'TRIPLET',
    record_id: 'REC1',
    cluster_id: 'CLU1',
    msg_text: 'A Russian strike on the district killed 12 people and injured 33.',
    modality: 'text',
    event_name: 'Strike',
    confidence: 0.9,
    justification: 'stated in the message',
    triplet_categories: ['Casualties', 'Conflict', 'Infrastructure'],
    cluster_categories: ['Casualties'],
    relationship_category: [],
    attributes: { source: 'wire' },
    eti_message: { source: 'text' },
    year: '2024', month: '03', day: '07',
    media: [],
  };
  const t1 = (n: number, category: string) => ({
    ...base,
    node: `t1_000${n}`,
    triplet_id: 'T1',
    category,
    subject: 'Russian strike',
    predicate: 'killed',
    object: '12 people',
    label: 'Russian strike → killed → 12 people',
    media: [{
      channel: 'image', path: 'img/strike.jpg', media_type: 'image',
      filename: 'strike.jpg', conf: '0.95', model: 'describer',
      description: 'A burning building, partly collapsed, smoke rising.',
    }],
    handling: {
      sensitivity: 0.0, sensitivity_conf: 0.95, sensitivity_model: 'SIMULATED FIXTURE',
      content_blur: false, filter_reason: 'nothing sensitive present', warning_tags: ['None'],
    },
  });
  return {
    nodes: [
      t1(1, 'Casualties'), t1(2, 'Conflict'), t1(3, 'Infrastructure'),
      {
        ...base,
        node: 't2_0001', triplet_id: 'T2', category: 'Casualties',
        subject: 'Russian strike', predicate: 'caused',
        object: '12 deaths and 33 injuries',
        label: 'Russian strike → caused → 12 deaths and 33 injuries',
      },
      {
        ...base,
        node: 't3_0001', triplet_id: 'T3', cluster_id: 'CLU2', record_id: 'REC2',
        category: 'Casualties',
        subject: 'national tally', predicate: 'reports',
        object: 'more than 2,000 civilians killed',
        label: 'national tally → reports → more than 2,000 civilians killed',
        msg_text: 'The ministry reports more than 2,000 civilians killed, of whom at least 136 are verified.',
        // No handling key at all — the ordinary case in real output.
        handling: undefined,
      },
      { node: 'casualties_h000', hierarchy: 'H000', label: 'Casualties', category: 'Casualties', tier: 0 },
    ],
    edges: [
      { source: 't1_0001', target: 'clu1_0001', hierarchy_link: 'TRIPLET_to_CLUSTER', predicate: 'killed' },
    ],
  };
}

/** Legacy shape. ZERO TRIPLET and ZERO CLUSTER nodes; the triple's own fields
 *  hang on the H00x node, the message is `text_msg`, and the picture is an
 *  `<img>` inside a pre-rendered HTML blob. */
function legacyGraph(): RawGraph {
  const common = {
    confidence: '0.8',
    weekday: 'Sunday',
    month_name: 'August',
    day: 27, month: 8, year: 2017,
    category_node: 'Infrastructure',
    info: '<ul><li>record</li></ul>',
  };
  return {
    nodes: [
      {
        ...common,
        node: 'infrastructure_h000', hierarchy: 'H000', label: 'Infrastructure',
        subject: 'floodwater', predicate: 'damaged', object: 'collapsed buildings',
        text_msg: 'Harvey floodwater damaged collapsed buildings downtown; nearly 50 homes lost.',
        triplet_justification: 'from the caption',
        all_info: '<br><img src="static/images/harvey_01.jpg"><span>Harvey</span>',
      },
      {
        ...common,
        node: 'damage_h001', hierarchy: 'H001', label: 'Damage',
        subject: 'floodwater', predicate: 'damaged', object: 'collapsed buildings',
        text_msg: 'Harvey floodwater damaged collapsed buildings downtown; nearly 50 homes lost.',
        all_info: '<br><img src="static/images/harvey_01.jpg">',
      },
      {
        ...common,
        node: 'fire_h000', hierarchy: 'H000', label: 'Fire', day: 'Unknown',
        subject: 'wildfire', predicate: 'destroyed', object: 'burning buildings',
        text_msg: 'A wildfire left burning buildings along the ridge.',
        all_info: '<img src="static/images/fire_02.jpg">',
      },
    ],
    edges: [{ source: 'damage_h001', target: 'infrastructure_h000', hierarchy_link: 'H000_to_H001' }],
  };
}

// ── shape detection ─────────────────────────────────────────────────────────

test('contract shape is detected from the nodes', () => {
  const r = detectShape(contractGraph());
  assert.equal(r.shape, 'contract');
  assert.equal(r.tripletNodeCount, 5);   // T1 is three nodes, plus T2 and T3
  assert.equal(r.categoryNodeCount, 1);
  assert.ok(r.confidence > 0.5);
});

test('legacy shape is detected: zero TRIPLET nodes, triple fields on H00x', () => {
  const r = detectShape(legacyGraph());
  assert.equal(r.shape, 'legacy');
  assert.equal(r.tripletNodeCount, 0);
  assert.equal(r.clusterNodeCount, 0);
  assert.equal(r.tripleBearingCategoryNodeCount, 3);
  assert.ok(r.legacyFieldsSeen.includes('text_msg'));
  assert.ok(r.legacyFieldsSeen.includes('all_info'));
  assert.ok(r.warnings.some(w => w.includes('synthesised')));
});

test('a graph of neither shape is reported as unknown rather than guessed at', () => {
  const r = detectShape({ nodes: [{ node: 'a', hierarchy: 'WHAT' }], edges: [{ source: 'a', target: 'a' }] });
  assert.equal(r.shape, 'unknown');
  assert.equal(r.confidence, 0);
});

// ── the collapse ────────────────────────────────────────────────────────────

test('one triplet emitted as three category nodes collapses to ONE record', () => {
  const c = ingestGraph(contractGraph());
  assert.equal(c.tripletNodeCount, 5);
  assert.equal(c.triplets.length, 3);
  const t1 = c.byTripletId.get('T1');
  assert.ok(t1);
  assert.equal(t1.node_ids.length, 3);
  assert.deepEqual(t1.categories, ['Casualties', 'Conflict', 'Infrastructure']);
  assert.equal(t1.id_synthesised, false);
});

test('legacy records collapse by content and get a stable synthesised id', () => {
  const c = ingestGraph(legacyGraph());
  // Two nodes carry the same triple at two tiers; they are one record.
  assert.equal(c.tripletNodeCount, 3);
  assert.equal(c.triplets.length, 2);
  assert.ok(c.triplets.every(t => t.id_synthesised));
  assert.ok(c.triplets.every(t => t.triplet_id.startsWith('lgc:')));
  // Stable across runs.
  const again = ingestGraph(legacyGraph());
  assert.deepEqual(again.triplets.map(t => t.triplet_id), c.triplets.map(t => t.triplet_id));
});

test('legacy field aliases and the "Unknown" sentinel are normalised', () => {
  const c = ingestGraph(legacyGraph());
  const fire = c.triplets.find(t => t.object === 'burning buildings');
  assert.ok(fire);
  assert.ok(fire.msg_text.startsWith('A wildfire'));   // text_msg -> msg_text
  assert.equal(fire.time.day, null);                   // "Unknown" -> null
  assert.equal(fire.time.year, '2017');                // number -> padded string form
  assert.equal(fire.confidence, 0.8);                  // "0.8" -> 0.8
  assert.ok('weekday' in fire.extras);                 // unrecognised keys preserved
  assert.ok('all_info' in fire.extras);
});

test('legacy images are recovered from the HTML blob and marked derived', () => {
  const c = ingestGraph(legacyGraph());
  const fire = c.triplets.find(t => t.object === 'burning buildings');
  assert.ok(fire);
  assert.equal(fire.media.length, 1);
  assert.equal(fire.media[0].path, 'static/images/fire_02.jpg');
  assert.equal(fire.media[0].derived, true);
});

test('a legacy label is rebuilt to the triple, keeping the file\'s own string', () => {
  const c = ingestGraph(legacyGraph());
  const fire = c.triplets.find(t => t.object === 'burning buildings');
  assert.ok(fire);
  assert.equal(fire.label, 'wildfire \u2192 destroyed \u2192 burning buildings');
  assert.equal(fire.extras.source_label, 'Fire');
  // The contract shape's own label is used as it stands, never rebuilt.
  const cc = ingestGraph(contractGraph());
  assert.equal(cc.byTripletId.get('T1')?.label, 'Russian strike \u2192 killed \u2192 12 people');
  assert.equal('source_label' in (cc.byTripletId.get('T1')?.extras ?? {}), false);
});

test('the message key is cluster_id on the contract file and none on the legacy one', () => {
  assert.equal(ingestGraph(contractGraph()).messageKeyAvailable, 'cluster_id');
  assert.equal(ingestGraph(legacyGraph()).messageKeyAvailable, 'none');
});

test('a file with rows but no cluster id falls back to record_id AND SAYS SO', () => {
  const g = contractGraph();
  for (const n of g.nodes) delete (n as Record<string, unknown>).cluster_id;
  const c = ingestGraph(g);
  assert.equal(c.messageKeyAvailable, 'record_id');
  assert.ok(c.warnings.some(w => w.includes('two attachments is two rows')));
});

// ── handling passthrough ────────────────────────────────────────────────────

test('handling is carried verbatim, and absent means absent — not cleared', () => {
  const c = ingestGraph(contractGraph());
  const t1 = c.byTripletId.get('T1');
  const t3 = c.byTripletId.get('T3');
  assert.ok(t1 && t3);
  assert.equal(t1.handling?.content_blur, false);
  assert.deepEqual(t1.handling?.warning_tags, ['None']);  // not filtered, not rewritten
  assert.equal(t3.handling, null);
});

// ── figures ─────────────────────────────────────────────────────────────────

test('figures are read with the qualifier the text attached to them', () => {
  const f = extractFigures(
    'The ministry reports more than 2,000 civilians killed, of whom at least 136 are verified, and nearly 50 homes lost.',
    'msg_text', 'T', 'R',
  );
  const byValue = new Map(f.map(x => [x.value, x]));
  assert.equal(byValue.get(2000)?.qualifier, 'more than');
  assert.equal(byValue.get(136)?.qualifier, 'at least');
  assert.equal(byValue.get(50)?.qualifier, 'nearly');
  assert.equal(byValue.get(2000)?.unit, 'civilians');
});

test('a figure names what it counts, from either side of the number', () => {
  const f = extractFigures('A strike killed 12 people and injured 33.', 'msg_text', 'T', 'R');
  const byValue = new Map(f.map(x => [x.value, x]));
  assert.equal(byValue.get(12)?.unit, 'people');   // read forward
  assert.equal(byValue.get(33)?.unit, 'injured');  // read backward
});

test('a number the text does not say what it counts has no unit', () => {
  const f = extractFigures(
    'Forces were 25 kilometers from the centre at 5 a.m., as they have been since 2014.',
    'msg_text', 'T', 'R',
  );
  assert.ok(f.length >= 3);
  assert.ok(f.every(x => x.unit === null));
});

test('the counting path sets aside numbers that name nothing, and says how many', () => {
  const e = loadGraph({
    nodes: [{
      node: 'n1', hierarchy: 'TRIPLET', triplet_id: 'T1', record_id: 'R1', category: 'Casualties',
      subject: 'strike', predicate: 'killed', object: '12 people',
      label: 'strike \u2192 killed \u2192 12 people',
      msg_text: 'A strike killed 12 people 25 kilometers from the centre at 5 a.m. in 2014.',
    }],
    edges: [{ source: 'n1', target: 'n1', hierarchy_link: 'TRIPLET_to_CLUSTER' }],
  });
  const r = e.aggregate('how many died', { terms: ['killed'], issuedAt: AT });
  if (r.evidence.kind !== 'aggregate') return;
  assert.ok(r.evidence.figures.every(f => f.unit !== null));
  assert.ok(r.evidence.unitlessFiguresSetAside > 0);
  assert.ok(r.notes.some(n => n.includes('set aside')));

  // Opting back in returns them, so the rule is a default and not a deletion.
  const all = e.aggregate('how many died', { terms: ['killed'], includeUnitlessFigures: true, issuedAt: AT });
  if (all.evidence.kind !== 'aggregate') return;
  assert.ok(all.evidence.figures.length > r.evidence.figures.length);
  assert.equal(all.evidence.unitlessFiguresSetAside, 0);
});

test('a magnitude word is recorded without inventing a number', () => {
  const f = extractFigures('Dozens of people were killed.', 'msg_text', 'T', 'R');
  assert.equal(f.length, 1);
  assert.equal(f[0].value, null);
  assert.equal(f[0].qualifier, 'unquantified');
});

// ── the aggregate path ──────────────────────────────────────────────────────

test('aggregate counts triplets, reports the node count it collapsed, and never sums', () => {
  const e = loadGraph(contractGraph());
  const r = e.aggregate('how many deaths occurred', { terms: ['killed', 'deaths'], issuedAt: AT });
  assert.equal(r.evidence.kind, 'aggregate');
  if (r.evidence.kind !== 'aggregate') return;

  // T1 (3 nodes), T2 (1 node) and T3 (1 node) all say "killed" or "deaths".
  // THE COUNT IS 3. Counting nodes would have said 5.
  assert.equal(r.evidence.matchedTripletCount, 3);
  assert.equal(r.evidence.matchedNodeCount, 5);
  assert.equal(r.total, 3);

  // The refusal is structural.
  assert.equal(r.evidence.sum, null);
  assert.ok(r.evidence.sumRefusalReason.length > 0);

  // Three triplets, but only TWO messages: T1 and T2 are one event seen twice.
  assert.equal(r.evidence.distinctMessageCount, 2);
  assert.equal(r.evidence.messageGroups.length, 2);
  const rec1 = r.evidence.messageGroups.find(g => g.cluster_id === 'CLU1');
  assert.equal(r.evidence.messageGroups.every(g => g.key_source === 'cluster_id'), true);
  assert.ok(rec1);
  assert.deepEqual(rec1.triplet_ids, ['T1', 'T2']);
  assert.ok(rec1.note?.includes('must not be added'));

  // And the figures that message states are the same twelve people twice.
  const twelves = rec1.figures.filter(f => f.value === 12);
  assert.ok(twelves.length >= 2);
  assert.ok(twelves.every(f => f.qualifier === 'exact'));
});

test('aggregate membership is exact: a term the corpus lacks matches nothing', () => {
  const e = loadGraph(contractGraph());
  const r = e.aggregate('x', { terms: ['kilked'], issuedAt: AT });   // one letter wrong
  assert.equal(r.total, 0);
});

test('aggregate over a legacy corpus says it cannot state a message count', () => {
  const e = loadGraph(legacyGraph());
  const r = e.aggregate('how many homes were lost', { terms: ['homes'], issuedAt: AT });
  if (r.evidence.kind !== 'aggregate') return;
  assert.equal(r.evidence.distinctMessageCount, null);
  assert.ok(r.notes.some(n => n.includes('neither a cluster id nor a record id')));
  assert.ok(r.evidence.messageGroups.every(g => g.key_source === 'none'));
});

// ── THE DIVERGENCE: one message, two attachments ────────────────────────────
//
// Neither sample corpus contains one, so this case is proved on a fixture
// built for it rather than on real data. The data dictionary states the rule
// it encodes: `record_id` is one per ROW, "a message with two attachments
// gets two", while `cluster_id` is the message, shared by every row out of it.

/** ONE message (CLU9) delivered as TWO rows (ROW1, ROW2), because it carried
 *  two attachments. Both rows restate the same twelve dead. */
function twoAttachmentGraph(): RawGraph {
  const row = (row_id: string, n: number) => ({
    node: `tw${n}_0001`,
    hierarchy: 'TRIPLET',
    triplet_id: `TW${n}`,
    cluster_id: 'CLU9',
    record_id: row_id,
    category: 'Casualties',
    subject: 'the blast', predicate: 'killed', object: '12 people',
    label: 'the blast \u2192 killed \u2192 12 people',
    msg_text: 'The blast killed 12 people.',
    media: [{ channel: 'image', path: `img/${row_id}.jpg`, description: 'rubble' }],
  });
  return {
    nodes: [row('ROW1', 1), row('ROW2', 2)],
    edges: [{ source: 'tw1_0001', target: 'c_0001', hierarchy_link: 'TRIPLET_to_CLUSTER' }],
  };
}

test('DIVERGENCE: a two-attachment message is ONE group, not two', () => {
  const e = loadGraph(twoAttachmentGraph());
  assert.equal(e.corpus.messageKeyAvailable, 'cluster_id');
  const r = e.aggregate('how many died', { terms: ['killed'], issuedAt: AT });
  if (r.evidence.kind !== 'aggregate') return;

  assert.equal(r.evidence.matchedTripletCount, 2);
  // ONE message. Two rows, because two attachments. One group.
  assert.equal(r.evidence.distinctMessageCount, 1);
  assert.equal(r.evidence.messageGroups.length, 1);
  assert.equal(r.evidence.messageGroups[0].cluster_id, 'CLU9');
  assert.deepEqual(r.evidence.messageGroups[0].triplet_ids, ['TW1', 'TW2']);
  // Both twelves land in one group, where a reader can see they are one fact.
  assert.ok(r.evidence.messageGroups[0].note?.includes('must not be added'));
  assert.equal(r.evidence.sum, null);
});

test('DIVERGENCE: the same data keyed on record_id compounds — two groups', () => {
  // Strip the cluster id and nothing else. This is what the old key did, and
  // it is also what a file genuinely lacking a cluster id forces.
  const g = twoAttachmentGraph();
  for (const n of g.nodes) delete (n as Record<string, unknown>).cluster_id;
  const e = loadGraph(g);
  assert.equal(e.corpus.messageKeyAvailable, 'record_id');
  const r = e.aggregate('how many died', { terms: ['killed'], issuedAt: AT });
  if (r.evidence.kind !== 'aggregate') return;

  // TWO groups for ONE message: the twelve dead are now stated twice, and a
  // reader counting groups would see two independent observations.
  assert.equal(r.evidence.distinctMessageCount, 2);
  assert.equal(r.evidence.messageGroups.length, 2);
  assert.ok(r.evidence.messageGroups.every(gr => gr.key_source === 'record_id'));
  // And the engine does not pretend otherwise: the approximation is declared.
  assert.ok(r.notes.some(n => n.includes('counted twice here')));
});

test('facet counts are over triplets, never over nodes', () => {
  const e = loadGraph(contractGraph());
  const r = e.aggregate('x', { terms: ['killed', 'deaths'], groupBy: ['category'], issuedAt: AT });
  if (r.evidence.kind !== 'aggregate') return;
  const cas = r.evidence.facets.find(f => f.value === 'Casualties');
  assert.equal(cas?.tripletCount, 3);     // T1, T2, T3 — not T1's three nodes
  assert.equal(cas?.messageCount, 2);     // CLU1 twice over, and CLU2
  // T1 alone carries Conflict, and it is ONE triplet there, not one node.
  const conf = r.evidence.facets.find(f => f.value === 'Conflict');
  assert.equal(conf?.tripletCount, 1);
});

// ── the retrieval path ──────────────────────────────────────────────────────

test('retrieval answers an OR question and reports each clause separately', () => {
  const e = loadGraph(legacyGraph());
  const r = e.retrieve('give me all the triplets that have burning buildings or collapsed buildings', { issuedAt: AT });
  assert.equal(r.evidence.kind, 'retrieval');
  if (r.evidence.kind !== 'retrieval') return;
  assert.equal(r.query.clauses.length, 2);
  assert.equal(r.total, 2);
  assert.equal(r.evidence.clauseCounts.length, 2);
  assert.ok(r.evidence.clauseCounts.every(c => c.tripletCount > 0));
});

test('retrieval matches the media description, not only the triple', () => {
  const e = loadGraph(contractGraph());
  const r = e.retrieve('burning building', { issuedAt: AT });
  assert.ok(r.total >= 1);
  const top = r.items[0];
  assert.equal(top.triplet.triplet_id, 'T1');
  assert.ok(top.matchedFields.includes('media.description'));
  assert.ok(top.snippets.some(s => s.field === 'media.description'));
});

test('a retrieval hit carries its media and its handling block', () => {
  const e = loadGraph(contractGraph());
  const r = e.retrieve('burning building', { issuedAt: AT });
  if (r.evidence.kind !== 'retrieval') return;
  assert.equal(r.evidence.hitsWithMedia, r.total);
  assert.equal(r.items[0].triplet.media[0].path, 'img/strike.jpg');
  assert.equal(r.items[0].triplet.handling?.content_blur, false);
});

test('retrieval says how many hits the conceal rule has nothing to read for', () => {
  const e = loadGraph(contractGraph());
  const r = e.retrieve('civilians killed', { issuedAt: AT });
  if (r.evidence.kind !== 'retrieval') return;
  assert.ok(r.evidence.hitsWithHandling < r.total);
  assert.ok(r.notes.some(n => n.includes('neither marked for concealment nor cleared')));
});

test('retrieval ordering is deterministic across runs', () => {
  const a = loadGraph(contractGraph()).retrieve('killed civilians building', { issuedAt: AT });
  const b = loadGraph(contractGraph()).retrieve('killed civilians building', { issuedAt: AT });
  assert.deepEqual(a.items.map(i => i.triplet.triplet_id), b.items.map(i => i.triplet.triplet_id));
});

test('filters are applied before matching, not to a ranked list', () => {
  const e = loadGraph(contractGraph());
  const all = e.retrieve('strike', { issuedAt: AT });
  const narrowed = e.retrieve('strike', { filters: { category: ['Conflict'] }, issuedAt: AT });
  assert.ok(narrowed.total < all.total);
  assert.ok(narrowed.items.every(i => i.triplet.categories.includes('Conflict')));
});

// ── the result edge ─────────────────────────────────────────────────────────

test('the display cap truncates the page and never the envelope', () => {
  const nodes = [];
  for (let i = 0; i < 40; i++) {
    nodes.push({
      node: `n${i}`, hierarchy: 'TRIPLET', triplet_id: `T${i}`, record_id: `R${i}`,
      category: 'Fire', subject: 'fire', predicate: 'destroyed', object: 'a burning building',
      label: `fire → destroyed → building ${i}`, msg_text: 'a burning building collapsed',
    });
  }
  const e = loadGraph({ nodes, edges: [{ source: 'n0', target: 'n1', hierarchy_link: 'TRIPLET_to_CLUSTER' }] });
  const r = e.retrieve('burning building', { issuedAt: AT });
  assert.equal(r.total, 40);

  const page = toDisplayPage(r);
  assert.equal(DISPLAY_CAP, 25);
  assert.equal(page.shownCount, 25);
  assert.equal(page.total, 40);
  assert.equal(page.truncated, true);
  assert.equal(page.caption, '25 of 40');

  // The envelope is untouched: everything downstream still sees all 40.
  assert.equal(r.items.length, 40);
  assert.equal(r.total, 40);

  const page2 = toDisplayPage(r, 25, 25);
  assert.equal(page2.shownCount, 15);
  assert.equal(page2.caption, '26-40 of 40');

  // cap <= 0 means no cap, never an empty screen.
  assert.equal(toDisplayPage(r, 0).shownCount, 40);
});

test('the envelope carries what a later export needs', () => {
  const e = loadGraph(contractGraph());
  const r = e.aggregate('how many deaths', { terms: ['killed'], issuedAt: AT });
  assert.equal(r.query.text, 'how many deaths');
  assert.equal(r.query.issuedAt, AT);
  assert.equal(r.engine.shape, 'contract');
  assert.equal(r.engine.matcher.name, 'exact-term-membership');
  assert.equal(r.total, r.items.length);
  // It survives a round trip through JSON, which is what an export is.
  const round = JSON.parse(JSON.stringify(r));
  assert.equal(round.total, r.total);
  assert.equal(round.evidence.sum, null);
});

// ── clause splitting ────────────────────────────────────────────────────────

test('clauses split on "or" but not inside a number', () => {
  assert.deepEqual(
    splitClauses('give me all the triplets that have burning buildings or collapsed buildings'),
    ['give me all the triplets that have burning buildings', 'collapsed buildings'],
  );
  assert.deepEqual(splitClauses('more than 2,000 civilians'), ['more than 2,000 civilians']);
});
