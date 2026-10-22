/**
 * Two measurements, both printed with the command that produced them.
 *
 *   1. the near-duplicate threshold, swept over a labelled pair set
 *   2. the B065 grouping collapse, over a real file
 *
 *   npx tsx graph-chat/server/bench/cache-bench.ts
 *   npx tsx graph-chat/server/bench/cache-bench.ts --file <path to a graph json>
 *
 * The pair set is hand-labelled and is stated in full below so anyone can
 * disagree with a label rather than with a number. SHOULD_HIT pairs are ones
 * a person would be annoyed to pay a model call for twice. MUST_MISS pairs
 * are ones where reusing the first answer would be wrong.
 */

import { readFileSync } from 'node:fs';
import { similarityOfQuestions } from '../similarity.js';
import { resolveGrouping } from '../grouping.js';
import { loadGraph } from '../../engine/index.js';
import type { RawGraph } from '../../engine/types.js';

const SHOULD_HIT: Array<[string, string]> = [
  ['how many deaths occurred during Hurricane Harvey', 'how many deaths occured during Hurricane Harvey'],
  ['how many deaths occurred during Hurricane Harvey', 'How many deaths occurred during Hurricane Harvey?'],
  ['how many deaths occurred during Hurricane Harvey', 'how many deaths occurred during hurricane harvey'],
  ['give me all the triplets that have burning buildings', 'give me all of the triplets that have burning buildings'],
  ['give me all the triplets with collapsed buildings', 'give me the triplets with collapsed buildings'],
  ['show me triplets about flooding', 'show me the triplets about flooding'],
  ['how many people were injured in the earthquake', 'how many people were injured in the earthquakes'],
  ['what damage did the wildfire cause', 'what damage did the wildfires cause'],
  ['triplets with images of damaged buildings', 'triplets with images of damaged building'],
  ['how many casualties in the flood', 'how many casualties in the floods'],
  ['deaths during Hurricane Harvey', 'Hurricane Harvey deaths'],
  ['list triplets mentioning rescue operations', 'list the triplets mentioning rescue operations'],
];

const MUST_MISS: Array<[string, string]> = [
  ['how many deaths occurred during Hurricane Harvey', 'how many deaths occurred during the wildfires'],
  ['how many deaths occurred during Hurricane Harvey', 'how many injuries occurred during Hurricane Harvey'],
  ['how many deaths occurred during Hurricane Harvey', 'how many buildings collapsed during Hurricane Harvey'],
  ['give me all the triplets that have burning buildings', 'give me all the triplets that have collapsed buildings'],
  ['give me all the triplets that have burning buildings', 'give me all the triplets that have flooded streets'],
  ['how many people died in the earthquake', 'how many people died in the flood'],
  ['show me triplets about flooding', 'show me triplets about looting'],
  ['what damage did the wildfire cause', 'what damage did the hurricane cause'],
  ['how many casualties in the flood', 'how many rescues in the flood'],
  ['triplets with images of damaged buildings', 'triplets with images of rescue workers'],
  ['deaths during Hurricane Harvey', 'deaths during Hurricane Irma'],
  ['how many deaths in 2017', 'how many deaths in 2018'],
];

function sweep(): void {
  console.log('=== near-duplicate threshold sweep ===');
  console.log('labelled pairs: ' + String(SHOULD_HIT.length) + ' should hit, ' +
    String(MUST_MISS.length) + ' must miss');
  console.log('');

  const hitScores = SHOULD_HIT.map(([a, b]) => similarityOfQuestions(a, b));
  const missScores = MUST_MISS.map(([a, b]) => similarityOfQuestions(a, b));

  console.log('should-hit scores, ascending:');
  SHOULD_HIT.map((p, i) => ({ p, s: hitScores[i] as number }))
    .sort((x, y) => x.s - y.s)
    .forEach((r) => console.log('  ' + r.s.toFixed(3) + '  ' + r.p[0] + '  ||  ' + r.p[1]));
  console.log('');
  console.log('must-miss scores, descending:');
  MUST_MISS.map((p, i) => ({ p, s: missScores[i] as number }))
    .sort((x, y) => y.s - x.s)
    .forEach((r) => console.log('  ' + r.s.toFixed(3) + '  ' + r.p[0] + '  ||  ' + r.p[1]));
  console.log('');

  console.log('threshold  hits  false-hits  recall  precision');
  const thresholds: number[] = [];
  for (let t = 0.50; t <= 0.96; t += 0.02) thresholds.push(Math.round(t * 100) / 100);
  let bestSafe = 0;
  for (const t of thresholds) {
    const tp = hitScores.filter((s) => s >= t).length;
    const fp = missScores.filter((s) => s >= t).length;
    const recall = tp / SHOULD_HIT.length;
    const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
    if (fp === 0 && tp > 0 && bestSafe === 0) bestSafe = t;
    console.log(
      '  ' + t.toFixed(2) + '     ' + String(tp).padStart(3) + '   ' +
      String(fp).padStart(8) + '   ' + recall.toFixed(3) + '    ' + precision.toFixed(3),
    );
  }
  console.log('');
  const highestMiss = Math.max(...missScores);
  const lowestHit = Math.min(...hitScores);
  console.log('highest must-miss score : ' + highestMiss.toFixed(3));
  console.log('lowest  should-hit score: ' + lowestHit.toFixed(3));
  console.log('separated: ' + String(lowestHit > highestMiss));
  console.log('lowest threshold with ZERO false hits: ' + bestSafe.toFixed(2));
}

function grouping(file: string): void {
  console.log('');
  console.log('=== B065 grouping collapse, on a real file ===');
  console.log('file: ' + file);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RawGraph;
  const engine = loadGraph(raw);
  console.log('shape: ' + engine.shape.shape +
    '   messageKeyAvailable: ' + engine.corpus.messageKeyAvailable);

  const question = 'how many deaths occurred during Hurricane Harvey';
  const result = engine.aggregate(question, {
    terms: ['death', 'deaths', 'killed', 'casualty', 'casualties', 'died', 'fatalities'],
  });
  if (result.evidence.kind !== 'aggregate') return;

  const engineGroups = result.evidence.messageGroups;
  const resolved = resolveGrouping(engineGroups, engine.corpus.messageKeyAvailable);

  console.log('question: ' + question);
  console.log('matched triplets          : ' + String(result.evidence.matchedTripletCount));
  console.log('groups the ENGINE returned: ' + String(engineGroups.length));
  console.log('groups AFTER the fallback : ' + String(resolved.groupsAfter));
  console.log('key actually used         : ' + resolved.keyUsed);
  console.log('ungroupable triplets      : ' + String(resolved.ungroupableTripletCount));
  const collapsed = engineGroups.length - resolved.groupsAfter;
  console.log('groups collapsed by the fallback: ' + String(collapsed));
  console.log('');
  console.log('largest groups after the fallback:');
  [...resolved.groups]
    .sort((a, b) => b.triplet_ids.length - a.triplet_ids.length)
    .slice(0, 5)
    .forEach((g) => {
      console.log('  ' + String(g.triplet_ids.length) + ' triplets  ' +
        g.msg_text.replace(/\s+/g, ' ').slice(0, 90));
    });
}

const args = process.argv.slice(2);
sweep();
const fileIndex = args.indexOf('--file');
if (fileIndex !== -1 && args[fileIndex + 1] !== undefined) {
  grouping(args[fileIndex + 1] as string);
}
