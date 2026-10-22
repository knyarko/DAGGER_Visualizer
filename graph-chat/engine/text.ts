// graph-chat/engine/text.ts
//
// Text normalisation, tokenising, and the FIGURE READER.
//
// Everything here is pure and deterministic: same string in, same output out,
// no clock, no locale, no randomness. That is a requirement rather than a
// style — a counted answer that changed between two runs over one unchanged
// file would be worthless, and a cached answer could never be trusted.

import type { FigureQualifier, StatedFigure, TripletTextField } from './types.js';

// ─────────────────────────────── normalise ──────────────────────────────────

/** Lower-case, strip accents, collapse whitespace. Punctuation is kept at this
 *  stage because the figure reader needs `2,000` and `~100` intact. */
export function normaliseText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/→/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Words too common to narrow anything. Deliberately SHORT: a long stop list
 * silently deletes query terms, and "all the triplets that have burning
 * buildings" only needs the grammar words gone.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from',
  'had', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its', 'me', 'of', 'on',
  'or', 'that', 'the', 'their', 'there', 'they', 'this', 'to', 'was', 'were',
  'what', 'which', 'with', 'give', 'show', 'all', 'any', 'get', 'list',
  'triplet', 'triplets',
]);

export function isStopWord(w: string): boolean {
  return STOP_WORDS.has(w);
}

/**
 * A deliberately small suffix stemmer — NOT Porter.
 *
 * It exists to make `buildings`/`building`, `burning`/`burned`/`burns` and
 * `collapsed`/`collapse` one term, which is the whole of what this corpus's
 * questions need. A full stemmer would also conflate pairs this corpus cares
 * about keeping apart, and would be a dependency.
 *
 * Order matters: longest suffix first. Words of 4 characters or fewer are left
 * alone, so `dies` does not become `di`.
 */
export function stem(word: string): string {
  /* Applied to a FIXED POINT, not once.
   *
   * A single pass strips one suffix and returns, so `bombings` lost only its
   * plural and stayed `bombing` while the indexed `bombing` became `bomb` -
   * two spellings of one word landing on different terms, and a query for the
   * plural matching nothing at all. Two passes settle every case this corpus
   * has (`bombings` -> `bombing` -> `bomb`, `buildings` -> `building` ->
   * `build`), and the loop stops as soon as a pass changes nothing. */
  if (word.length <= 4) return word;
  return stemFinalE(stemVerb(stemPlural(word)));
}

/** Drop a trailing `e` so `collapse` and `collapsed` land on one term, which
 *  is what this stemmer's own description promises and did not deliver. Kept
 *  last and guarded by length, so short words are untouched. */
function stemFinalE(w: string): string {
  if (w.length > 4 && w.endsWith('e') && !w.endsWith('ee')) return w.slice(0, -1);
  return w;
}

/** Plural only. Runs FIRST and exactly once. */
function stemPlural(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith('ies') && w.length > 5) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4 && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** `-ing` / `-ed` only. Runs SECOND and exactly once, so a plural that hid a
 *  verb ending is still reached (`bombings` -> `bombing` -> `bomb`) while a
 *  word that was never plural is not stripped twice (`collapsed` -> `collaps`,
 *  not `collap`). */
function stemVerb(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith('ing') && w.length > 5) {
    w = w.slice(0, -3);
    // `burnning` never happens, but `running` -> `runn` -> `run`.
    if (/([bdfglmnprt])\1$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  if (w.endsWith('ed') && w.length > 4) {
    w = w.slice(0, -2);
    if (/([bdfglmnprt])\1$/.test(w)) w = w.slice(0, -1);
    return w;
  }
  return w;
}

/** Split normalised text into raw word tokens. No stemming, no stop removal. */
export function tokenizeRaw(s: string): string[] {
  const out: string[] = [];
  const re = /[a-z0-9][a-z0-9'-]*/g;
  let m: RegExpExecArray | null;
  const n = normaliseText(s);
  while ((m = re.exec(n)) !== null) out.push(m[0]);
  return out;
}

/** The indexing / querying token stream: stop words dropped, rest stemmed. */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  for (const t of tokenizeRaw(s)) {
    if (t.length < 2) continue;
    if (STOP_WORDS.has(t)) continue;
    out.push(stem(t));
  }
  return out;
}

/** Character trigrams of a single token, used for typo tolerance. The token is
 *  padded so a 3-letter word still yields trigrams and so word boundaries
 *  participate in the match. */
export function trigrams(token: string): string[] {
  const p = `  ${token} `;
  const out: string[] = [];
  for (let i = 0; i + 3 <= p.length; i++) out.push(p.slice(i, i + 3));
  return out;
}

/** Dice coefficient over trigram sets. 1.0 identical, 0.0 disjoint. Used only
 *  to rescue a near-miss token, never to generate candidates on its own. */
export function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = new Set(trigrams(a));
  const B = new Set(trigrams(b));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/**
 * FNV-1a, 32-bit, as 8 lower-case hex characters.
 *
 * Used for ONE thing: giving a legacy-shape record a stable identity when the
 * file carries no `triplet_id`. It is not a security hash and is not claimed
 * to be collision-free; it is claimed to be deterministic, dependency-free and
 * identical in a browser and in node, which is what an id needs to be.
 */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ────────────────────────── query clause splitting ──────────────────────────

/**
 * Split a question into OR-clauses.
 *
 * "give me all the triplets that have burning buildings or collapsed
 * buildings" is TWO things being asked for, and a matcher that merges them
 * into one bag of terms will rank a triplet containing `building` twice above
 * one that actually shows a collapsed building.
 *
 * Split points: ` or `, ` / `, `;`, and a comma that is NOT inside a number.
 * The leading request verb ("give me all the triplets that have") contributes
 * only stop words and falls out in `tokenize`.
 */
export function splitClauses(question: string): string[] {
  const protectedText = question.replace(/(\d),(\d)/g, '$1\u0000$2');
  const parts = protectedText
    .split(/\s+or\s+|\s*\/\s*|\s*;\s*|\s*,\s*/i)
    .map(p => p.replace(/\u0000/g, ',').trim())
    .filter(p => p.length > 0);
  const kept = parts.filter(p => tokenize(p).length > 0);
  return kept.length > 0 ? kept : (question.trim() ? [question.trim()] : []);
}

// ─────────────────────────────── the figures ────────────────────────────────

/**
 * Qualifier phrases, longest first so `at least` wins over `least` and
 * `more than` over `than`. The qualifier is read from the text IMMEDIATELY
 * before the number and nowhere else — a qualifier at the far end of a
 * sentence is not known to be about this number.
 */
const QUALIFIER_PHRASES: Array<[RegExp, FigureQualifier]> = [
  [/\b(?:at\s+least|no\s+fewer\s+than|a\s+minimum\s+of|minimum\s+of)\s*$/, 'at least'],
  [/\b(?:more\s+than|over|upwards\s+of|in\s+excess\s+of|above)\s*$/, 'more than'],
  [/\b(?:nearly|almost|close\s+to|just\s+under)\s*$/, 'nearly'],
  [/\b(?:about|around|approximately|approx\.?|roughly|some|an\s+estimated|estimated)\s*$/, 'about'],
  [/~\s*$/, 'about'],
  [/\b(?:up\s+to|as\s+many\s+as|no\s+more\s+than|at\s+most)\s*$/, 'up to'],
  [/\b(?:fewer\s+than|less\s+than|under|below)\s*$/, 'fewer than'],
];

/** Magnitude words that assert a quantity without stating one. They are
 *  recorded as `unquantified` with a NULL value, never turned into a number. */
const UNQUANTIFIED = /\b(?:dozens|scores|hundreds|thousands|millions|several|many|numerous|countless|multiple)\b(?:\s+of)?/g;

/** Spelled-out small integers. Stopping at twenty is deliberate: beyond that
 *  the forms are compound ("twenty-three") and reading them wrong is worse
 *  than not reading them. */
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20,
};

/** Scale words that multiply the number before them. */
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };

/**
 * The nouns a figure is allowed to be "of". Read from the words AFTER the
 * number. This is a vocabulary of what the corpus counts, not a filter on what
 * it may count — an unrecognised noun yields a NULL unit and the figure is
 * still reported, with its raw text.
 */
const UNIT_WORDS = new Set([
  'people', 'person', 'persons', 'civilian', 'civilians', 'child', 'children',
  'death', 'deaths', 'casualty', 'casualties', 'injury', 'injuries', 'injured',
  'killed', 'dead', 'wounded', 'victim', 'victims', 'fatality', 'fatalities',
  'missing', 'displaced', 'evacuated', 'home', 'homes', 'house', 'houses',
  'building', 'buildings', 'structure', 'structures', 'acre', 'acres',
  'hectare', 'hectares', 'soldier', 'soldiers', 'troop', 'troops',
  'resident', 'residents', 'family', 'families', 'student', 'students',
]);

function readQualifier(before: string): FigureQualifier {
  const tail = before.slice(-28);
  for (const [re, q] of QUALIFIER_PHRASES) if (re.test(tail)) return q;
  return 'exact';
}

function readUnit(after: string): string | null {
  // Allow one intervening word: "12 civilians killed", "50 people were killed".
  const words = after.trim().split(/\s+/).slice(0, 3);
  for (const w of words) {
    const bare = w.replace(/[^a-z]/g, '');
    if (!bare) continue;
    if (UNIT_WORDS.has(bare)) return bare;
  }
  return null;
}

/**
 * The noun BEFORE the number, for "injured 33" and "killed 12", where English
 * puts the verb first and the counted thing never appears after the digits.
 *
 * Checked only AFTER the forward read has failed, so "killed 12 people" still
 * reports `people` rather than `killed`. Two words back at most: further than
 * that and the word is no longer about this number.
 */
function readUnitBefore(before: string): string | null {
  const words = before.trim().split(/\s+/).slice(-2).reverse();
  for (const w of words) {
    const bare = w.replace(/[^a-z]/g, '');
    if (!bare) continue;
    if (UNIT_WORDS.has(bare)) return bare;
  }
  return null;
}

/**
 * Read every figure a piece of text states.
 *
 * What this does NOT do, on purpose: decide what a figure means, pick a
 * best one, or reconcile two. It reports what the text says, with the
 * qualifier that was attached to it and the span it came from, and leaves the
 * judgement to a person looking at the rows.
 */
export function extractFigures(
  text: string,
  field: TripletTextField,
  triplet_id: string,
  cluster_id: string | null,
): StatedFigure[] {
  if (!text) return [];
  const n = normaliseText(text);
  const out: StatedFigure[] = [];

  // Digit-led figures, with thousands separators and decimals.
  const num = /(?<![a-z0-9.,])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?![\d.,]*\d*[a-z])/g;
  let m: RegExpExecArray | null;
  while ((m = num.exec(n)) !== null) {
    const literal = m[1];
    let value = Number(literal.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const before = n.slice(0, m.index);
    let after = n.slice(m.index + literal.length);
    // `2.5 million`
    const scale = /^\s+(hundred|thousand|million|billion)\b/.exec(after);
    let consumed = literal;
    if (scale) {
      value *= SCALES[scale[1]];
      consumed = `${literal}${scale[0]}`;
      after = after.slice(scale[0].length);
    }
    const start = Math.max(0, m.index - 28);
    out.push({
      value,
      qualifier: readQualifier(before),
      unit: readUnit(after) ?? readUnitBefore(before),
      raw: n.slice(start, m.index + consumed.length + 24).trim(),
      field,
      triplet_id,
      cluster_id,
    });
  }

  // Spelled-out small integers.
  const wordRe = new RegExp(`\\b(${Object.keys(WORD_NUMBERS).join('|')})\\b`, 'g');
  while ((m = wordRe.exec(n)) !== null) {
    const before = n.slice(0, m.index);
    const after = n.slice(m.index + m[0].length);
    const start = Math.max(0, m.index - 28);
    out.push({
      value: WORD_NUMBERS[m[1]],
      qualifier: readQualifier(before),
      unit: readUnit(after) ?? readUnitBefore(before),
      raw: n.slice(start, m.index + m[0].length + 24).trim(),
      field,
      triplet_id,
      cluster_id,
    });
  }

  // Magnitude words. Value stays NULL.
  UNQUANTIFIED.lastIndex = 0;
  while ((m = UNQUANTIFIED.exec(n)) !== null) {
    const after = n.slice(m.index + m[0].length);
    const start = Math.max(0, m.index - 28);
    out.push({
      value: null,
      qualifier: 'unquantified',
      unit: readUnit(after),
      raw: n.slice(start, m.index + m[0].length + 24).trim(),
      field,
      triplet_id,
      cluster_id,
    });
  }

  out.sort((a, b) => a.raw.localeCompare(b.raw) || (a.value ?? -1) - (b.value ?? -1));
  return out;
}

// ──────────────────────────── snippet building ──────────────────────────────

/** A short window of `text` around the first match of any of `terms`, with the
 *  matched spans marked. Never returns the whole message. */
export function buildSnippet(
  text: string,
  terms: string[],
  windowChars = 180,
): { text: string; spans: Array<{ start: number; end: number }> } | null {
  if (!text) return null;
  const n = normaliseText(text);
  const hits: Array<{ start: number; end: number }> = [];
  const wordRe = /[a-z0-9][a-z0-9'-]*/g;
  const wanted = new Set(terms);
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(n)) !== null) {
    if (wanted.has(stem(m[0]))) hits.push({ start: m.index, end: m.index + m[0].length });
  }
  if (hits.length === 0) {
    return { text: n.slice(0, windowChars), spans: [] };
  }
  const first = hits[0].start;
  const start = Math.max(0, first - Math.floor(windowChars / 3));
  const end = Math.min(n.length, start + windowChars);
  const spans = hits
    .filter(h => h.start >= start && h.end <= end)
    .map(h => ({ start: h.start - start, end: h.end - start }));
  return { text: n.slice(start, end), spans };
}
