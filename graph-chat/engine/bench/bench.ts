// graph-chat/engine/bench/bench.ts
//
// THE MEASUREMENT BEHIND THE MATCHER CHOICE.
//
// Answers three questions with numbers rather than with an opinion:
//   1. how long does indexing N triplets take;
//   2. how much memory does the index hold;
//   3. what does that do to first paint if it runs on the browser's main
//      thread.
//
// It is a script rather than a shell one-liner so that anyone can re-run it
// and get the same numbers, including the person who has to decide whether
// the answer is good enough.
//
//   node --expose-gc --import tsx graph-chat/engine/bench/bench.ts \
//        --file <path to a Graph_Viz json> [--scale 13638] [--question "..."]
//
// `--scale N` REPLICATES the ingested records until there are N of them,
// giving each copy a fresh id and leaving its text alone. It is used because
// the largest corpus on this machine holds fewer triplets than the production
// run does, and an extrapolated number is not a measurement. Replicated text
// keeps the real vocabulary, the real field lengths and the real duplication
// rate; what it does NOT reproduce is vocabulary GROWTH, so a replicated run
// understates the vocabulary size of a genuinely larger corpus. That caveat is
// printed with the result rather than left to a reader to remember.
//
// This script READS. It never writes to the file it is pointed at.

import { readFileSync } from 'node:fs';
import { ingestGraph } from '../ingest.js';
import { LexicalIndex } from '../lexindex.js';
import { retrieve } from '../retrieve.js';
import { aggregate } from '../aggregate.js';
import { toDisplayPage } from '../result.js';
import type { NormalisedCorpus, NormalisedTriplet, RawGraph } from '../types.js';

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;

/** Heap in bytes after a best-effort collection. Needs `--expose-gc` to be
 *  meaningful; without it the number is reported as unreliable. */
function heap(): number {
  const g = (globalThis as { gc?: () => void }).gc;
  if (g) { g(); g(); }
  return process.memoryUsage().heapUsed;
}
const GC_AVAILABLE = typeof (globalThis as { gc?: () => void }).gc === 'function';

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Replicate the corpus up to `target` records. Ids are made unique; text is
 *  untouched. */
function scaleCorpus(corpus: NormalisedCorpus, target: number): NormalisedTriplet[] {
  const base = corpus.triplets;
  if (base.length === 0 || base.length >= target) return base.slice(0, target || base.length);
  const out: NormalisedTriplet[] = [];
  let copy = 0;
  while (out.length < target) {
    for (const t of base) {
      if (out.length >= target) break;
      out.push(copy === 0 ? t : {
        ...t,
        triplet_id: `${t.triplet_id}#${copy}`,
        cluster_id: t.cluster_id === null ? null : `${t.cluster_id}#${copy}`,
        record_id: t.record_id === null ? null : `${t.record_id}#${copy}`,
        node_ids: t.node_ids.map(n => `${n}#${copy}`),
      });
    }
    copy++;
  }
  return out;
}

function main(): void {
  const file = arg('file');
  if (!file) {
    console.error('usage: bench.ts --file <graph json> [--scale N] [--question "..."]');
    process.exit(2);
  }
  const scale = Number(arg('scale', '0'));
  const question = arg('question',
    'give me all the triplets that have burning buildings or collapsed buildings')!;
  const countQuestion = arg('count-question', 'how many deaths occurred')!;

  console.log(`file            ${file}`);
  const bytes = readFileSync(file).byteLength;
  console.log(`file size       ${mb(bytes)} (${bytes} bytes)`);

  let t = process.hrtime.bigint();
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RawGraph;
  const parseMs = ms(t);

  t = process.hrtime.bigint();
  const corpus = ingestGraph(raw);
  const ingestMs = ms(t);

  console.log('');
  console.log('── shape ────────────────────────────────────────────────');
  console.log(`detected        ${corpus.shape.shape}  (confidence ${corpus.shape.confidence})`);
  console.log(`nodes / edges   ${corpus.nodeCount} / ${corpus.edgeCount}`);
  console.log(`hierarchies     ${JSON.stringify(corpus.shape.hierarchyCounts)}`);
  console.log(`TRIPLET nodes   ${corpus.shape.tripletNodeCount}`);
  console.log(`CLUSTER nodes   ${corpus.shape.clusterNodeCount}`);
  console.log(`H00x nodes      ${corpus.shape.categoryNodeCount} (${corpus.shape.tripleBearingCategoryNodeCount} carry a triple)`);
  console.log(`legacy fields   ${corpus.shape.legacyFieldsSeen.join(', ') || '(none)'}`);
  console.log(`source nodes    ${corpus.tripletNodeCount}`);
  console.log(`DISTINCT TRIPLETS ${corpus.triplets.length}`);
  if (corpus.tripletNodeCount > 0) {
    console.log(`collapse ratio  ${(corpus.tripletNodeCount / Math.max(1, corpus.triplets.length)).toFixed(3)} nodes per triplet`);
  }
  console.log(`message key     ${corpus.messageKeyAvailable}` +
    (corpus.messageKeyAvailable === 'record_id'
      ? '   <- ROWS standing in for messages; a 2-attachment message counts twice'
      : corpus.messageKeyAvailable === 'none' ? '   <- NO key: nothing can be collapsed' : ''));
  console.log(`with media      ${corpus.triplets.filter(x => x.media.length > 0).length}`);
  console.log(`with handling   ${corpus.triplets.filter(x => x.handling !== null).length}`);
  console.log(`categories      ${corpus.facetValues.category.length}`);
  console.log(`event_name      ${corpus.facetValues.event_name.length} distinct` +
    (corpus.facetValues.event_name.length > 0
      ? `: ${corpus.facetValues.event_name.slice(0, 8).join(' | ')}`
      : '   <- NO EVENT FIELD: an event-scoped question cannot be filtered on this file'));
  console.log(`modality        ${corpus.facetValues.modality.join(', ') || '(none)'}`);
  console.log(`years           ${corpus.facetValues.year.join(', ') || '(none)'}`);
  for (const w of corpus.warnings) console.log(`WARNING         ${w}`);

  const triplets = scale > 0 ? scaleCorpus(corpus, scale) : corpus.triplets;
  const scaled = triplets.length !== corpus.triplets.length;

  console.log('');
  console.log('── index ────────────────────────────────────────────────');
  console.log(`triplets        ${triplets.length}${scaled ? `  (REPLICATED from ${corpus.triplets.length} real records)` : ''}`);
  const before = heap();
  t = process.hrtime.bigint();
  const index = LexicalIndex.build(triplets);
  const buildMs = ms(t);
  const after = heap();
  console.log(`build           ${buildMs.toFixed(1)} ms`);
  console.log(`vocabulary      ${index.stats.termCount} terms`);
  console.log(`postings        ${index.stats.postingCount} (term, document) pairs`);
  console.log(`avg doc length  ${index.stats.avgDocLength} tokens`);
  console.log(`heap delta      ${mb(after - before)}${GC_AVAILABLE ? '' : '   [UNRELIABLE: run with --expose-gc]'}`);
  console.log(`parse + ingest  ${parseMs.toFixed(1)} ms + ${ingestMs.toFixed(1)} ms`);
  console.log(`TOTAL TO READY  ${(parseMs + ingestMs + buildMs).toFixed(1)} ms` +
    (scaled ? '   (parse+ingest measured on the real file, build on the replicated corpus)' : ''));

  const scaledCorpus: NormalisedCorpus = { ...corpus, triplets };

  console.log('');
  console.log('── retrieval ────────────────────────────────────────────');
  console.log(`question        ${question}`);
  t = process.hrtime.bigint();
  const r = retrieve(scaledCorpus, index, question);
  const retrieveMs = ms(t);
  console.log(`query           ${retrieveMs.toFixed(1)} ms`);
  console.log(`clauses         ${JSON.stringify(r.query.clauses)}`);
  console.log(`terms           ${JSON.stringify(r.query.terms)}`);
  if (r.evidence.kind === 'retrieval') {
    for (const c of r.evidence.clauseCounts) console.log(`  clause        ${c.tripletCount.toString().padStart(6)}  ${c.clause}`);
    console.log(`hits            ${r.total}`);
    console.log(`with media      ${r.evidence.hitsWithMedia}`);
    console.log(`with handling   ${r.evidence.hitsWithHandling}`);
  }
  const page = toDisplayPage(r);
  console.log(`page            ${page.caption}  (envelope still holds ${r.items.length})`);
  for (const h of r.items.slice(0, 5)) {
    const snip = h.snippets[0];
    console.log(`  ${h.score.toFixed(3).padStart(8)}  ${h.triplet.label.slice(0, 70)}`);
    if (snip) console.log(`            [${snip.field}] ${snip.text.slice(0, 90)}`);
  }

  console.log('');
  console.log('── aggregate ────────────────────────────────────────────');
  console.log(`question        ${countQuestion}`);
  t = process.hrtime.bigint();
  const a = aggregate(scaledCorpus, index, countQuestion, {
    terms: ['death', 'deaths', 'killed', 'casualty', 'casualties', 'died', 'fatalities'],
  });
  const aggMs = ms(t);
  console.log(`query           ${aggMs.toFixed(1)} ms`);
  if (a.evidence.kind === 'aggregate') {
    console.log(`matched nodes   ${a.evidence.matchedNodeCount}`);
    console.log(`MATCHED TRIPLETS ${a.evidence.matchedTripletCount}`);
    console.log(`distinct messages ${a.evidence.distinctMessageCount ?? 'n/a (file carries no message key)'}`);
    console.log(`state a figure  ${a.evidence.tripletsWithFigures}`);
    console.log(`figures         ${a.evidence.figures.length}`);
    console.log(`message groups  ${a.evidence.messageGroups.length}`);
    console.log(`sum             ${String(a.evidence.sum)}`);
    const q = new Map<string, number>();
    for (const f of a.evidence.figures) q.set(f.qualifier, (q.get(f.qualifier) ?? 0) + 1);
    console.log(`qualifiers      ${JSON.stringify(Object.fromEntries([...q].sort()))}`);
    const multi = a.evidence.messageGroups.filter(g => g.note !== null);
    console.log(`messages whose rows must not be added: ${multi.length}`);
    for (const g of multi.slice(0, 3)) {
      console.log(`  ${g.cluster_id ?? '(no message key)'} [${g.key_source}]  triplets ${g.triplet_ids.join(', ')}`);
      for (const f of g.figures.slice(0, 4)) {
        console.log(`      ${f.qualifier} ${f.value ?? '?'} ${f.unit ?? ''}  <- ${f.raw.slice(0, 60)}`);
      }
    }
  }
  console.log('');
}

main();
