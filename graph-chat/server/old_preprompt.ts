/**
 * The standing pre-prompt.
 *
 * It is assembled here and prepended to EVERY model call, whichever provider
 * the dropdown selected. It is not optional, not per-model, and there is no
 * code path by which a caller can edit it away: `assemblePreprompt` takes no
 * argument that can remove a required clause, and the only variable part is
 * the grouping disclosure, which states a fact about the data rather than a
 * preference.
 *
 * It is DATA, not a string literal in a call site. Every adapter consumes this
 * one module. The test asserts each required clause reaches the assembled text.
 *
 * Six required points, from the sprint's Decision 11:
 *   1. what a triplet is
 *   2. node count is not triplet count
 *   3. triplets from one source message restate one fact
 *   4. figures are never added
 *   5. answer only from the supplied evidence
 *   6. brief, plain words
 *
 * Plus a seventh, assembled rather than fixed: which key the no-compounding
 * rule was actually able to group on for THIS answer. It must never claim a
 * grouping the data did not supply.
 */

export const PREPROMPT_VERSION = '2.0.0';

/**
 * The grouping key the no-compounding rule was actually applied on.
 *
 * `cluster_id` is the data dictionary’s id for the ORIGINATING MESSAGE,
 * shared by every row and every triplet out of it. It replaced `record_id`
 * here in pre-prompt 2.0.0: `record_id` is one per ROW, and a message with
 * two attachments has two of them, so keying on it split one message into two
 * groups and stated its figures twice.
 */
export type GroupingKeyUsed =
  | 'cluster_id'
  | 'record_id'
  | 'message_text'
  | 'none';

export type PrepromptClauseId =
  | 'what-a-triplet-is'
  | 'what-the-ids-mean'
  | 'what-the-channels-mean'
  | 'node-count-is-not-triplet-count'
  | 'one-message-one-fact'
  | 'never-add-figures'
  | 'evidence-only'
  | 'brief-plain-words'
  | 'grouping-disclosure';

export interface PrepromptClause {
  /** Stable id. The test asserts every one of these reaches the output. */
  id: PrepromptClauseId;
  heading: string;
  /** Fixed clauses carry their body here. The disclosure clause does not. */
  body: string | null;
  /** True for the six that are always identical. False for the assembled one. */
  fixed: boolean;
  /** Where this came from, named by decision rather than by file path. */
  source: string;
}

/**
 * The maintainer's own worked example. It is quoted verbatim into the
 * assembled text and the test asserts it survives byte-for-byte, because a
 * paraphrase of it is a different instruction.
 */
export const WORKED_EXAMPLE =
  '12 deaths should not be compounded. It should only be 12.';

export const PREPROMPT_CLAUSES: readonly PrepromptClause[] = Object.freeze([
  {
    id: 'what-a-triplet-is',
    heading: 'What a triplet is',
    body:
      'A triplet is one fact that an earlier extraction pipeline pulled out of ' +
      'one source message, written as subject -> predicate -> object. It ' +
      'carries its own justification, its own confidence, its own categories ' +
      'and any media that came with the message. It is evidence.',
    fixed: true,
    source: 'Decision 11, point 1',
  },
  {
    id: 'what-the-ids-mean',
    heading: 'What the id fields mean',
    body:
      'These are the data dictionary’s own definitions of the id fields: ' +
      'record_id: "internal unique id for each attachment to a MESSAGE. So a message with two attachments gets two different ids." ' +
      'cluster_id: "internal id for the originating MESSAGE, shared by every triplet that came out of it." ' +
      'msg_id: "The source-native identifier for the message/record. Replaces the old CrisisMMD-only \'tweet_id\'. Not unique: several rows share it. The LLM never sees it - it is attached to triplets after generation." ' +
      'In short, as the pipeline attaches them: ' +
      'triplet_id is the unique id for the triplet; ' +
      'reference_key is the four joined, `cluster:triplet:record:msg`. ' +
      'The consequence you must hold on to: ONE MESSAGE WITH TWO ATTACHMENTS IS ' +
      'TWO record_id AND ONE cluster_id. A group in the evidence below is a ' +
      'cluster_id wherever the file supplies one, so a group is one message. Never ' +
      'treat two triplets of one message as two independent reports, and never call a ' +
      'group a record. It is a collection of triplets derived from a single message.' +
      'The three category fields are also distinct and are not synonyms: ' +
      'triplet_categories: "written once at generation, never rewritten"; ' +
      'cluster_categories: "the union across the cluster, identical on every member" ' +
      '- so it is the whole set for the message, carried on each of its triplets, ' +
      'and it must never be read as that one triplet\'s own categories; ' +
      'relationship_category: "the over-arching categories the triplet shares.".',
    fixed: true,
    source: 'the data dictionary\'s identity definitions, quoted rather than described',
  },
  {
    id: 'what-the-channels-mean',
    heading: 'What each evidence channel is worth',
    body:
      'The evidence may come from more than one channel, and what a channel is ' +
      'worth differs. These are the data dictionary’s own rules, quoted. ' +
      'Text: Quote verbatim; hashtags and URLs are attributes, not subjects; a link\'s presence is not a claim about its contents. ' +
      'Image: A vision model was shown the image and analysed it; you are reading that analysis, not a caption attached to the picture. What it asserts about the scene is usable evidence. Text visible *in* the image is transcribed verbatim in quotation marks — quote it back and treat it as read; unquoted wording is the analysing model\'s own summary. Hedged phrasing (“appears to be”) must be marked uncertain or dropped. ' +
      'Audio: `audio_duration_sec` (measured, not declared), `sample_rate`, `channels`, `bit_depth`, `filesize_bytes`, `probe_method` ' +
      'Video: Not analysed. Generate nothing from it. ' +
      'Mixed: The channels describe the same record, so they are correlated by construction; that is not causation. Extract each channel separately first. A claim that genuinely needs two channels at once, where neither alone supports it, is worth making — name both in `justification`. On disagreement, do not average — record the conflict. ' +
      'A media description in the evidence is therefore a model’s reading of the ' +
      'attachment, not a human caption, and it is usable evidence — but say that ' +
      'it came from the image or the audio when you lean on it.',
    fixed: true,
    source: 'the data dictionary\'s per-modality evidence rules, quoted',
  },
  {
    id: 'node-count-is-not-triplet-count',
    heading: 'Node count is not triplet count',
    body:
      'The graph holds one node per (triplet, category) pair, so the same fact ' +
      'appears once for every category it carries. Counting nodes multiplies ' +
      'the answer by the number of categories. On the sprint reference corpus ' +
      '1,992 nodes collapse to 953 triplets. The evidence you are given has ' +
      'already been collapsed to triplets; both numbers are stated so you can ' +
      'see the difference, and the triplet count is the count. Never report ' +
      'the node count as a number of facts.',
    fixed: true,
    source: 'Decision 11, point 2',
  },
  {
    id: 'one-message-one-fact',
    heading: 'Triplets from one source message restate one fact',
    body:
      'Two triplets drawn from the same source message are two phrasings of ' +
      'one fact, not two facts. A strike reported as "killed 12 people" and ' +
      'again as "caused 12 deaths and 33 injuries" is twelve people, once. ' +
      'The rule, in the words it was given in: "' + WORKED_EXAMPLE + '" ' +
      'The evidence groups the triplets for you. Treat every group as one ' +
      'event unless the text inside it plainly describes separate events, and ' +
      'say which group a figure came from.',
    fixed: true,
    source: 'Decision 11, point 3',
  },
  {
    id: 'never-add-figures',
    heading: 'Never add figures together',
    body:
      'Do not sum, average, extrapolate or otherwise compute a new number. ' +
      'Report what each source states, keeping its qualifier exactly as it is ' +
      'written - "at least", "more than", "nearly", "up to" - and name the ' +
      'triplet it came from. One source can state a running total, a verified ' +
      'subset of that total and a single incident inside the subset all in one ' +
      'sentence; adding those gives a number with nothing behind it. A total ' +
      'appears only where the evidence itself supplies one. The evidence ' +
      'carries no total field, and that is deliberate.',
    fixed: true,
    source: 'Decision 11, point 4',
  },
  {
    id: 'evidence-only',
    heading: 'Answer only from the supplied evidence',
    body:
      'Everything you say must be traceable to the evidence below. No outside ' +
      'knowledge, no internet, nothing recalled from training - not even when ' +
      'you are confident and the evidence is thin. If the evidence does not ' +
      'answer the question, say that it does not and say what is missing. An ' +
      'admitted gap is correct; a filled one is not.',
    fixed: true,
    source: 'Decision 11, point 5',
  },
  {
    id: 'brief-plain-words',
    heading: 'Brief, plain words',
    body:
      'Answer briefly, in plain words, the way you would explain it to someone ' +
      'who has not seen the data. No preamble, no restating the question, no ' +
      'list of caveats before the answer. Short sentences. If a number belongs ' +
      'in the answer, put it with the qualifier and the source it came from.',
    fixed: true,
    source: 'Decision 11, point 6, and the standing ask for a brief concise simple-worded answer',
  },
  {
    id: 'grouping-disclosure',
    heading: 'How these triplets were grouped',
    body: null,
    fixed: false,
    source: 'B065 - the grouping key the loaded file actually supplied',
  },
]);

/** Ids every assembled pre-prompt must contain. The test reads this. */
export const REQUIRED_CLAUSE_IDS: readonly PrepromptClauseId[] = Object.freeze(
  PREPROMPT_CLAUSES.map((c) => c.id),
);

export interface GroupingDisclosure {
  /** The key the no-compounding rule was actually applied on. */
  keyUsed: GroupingKeyUsed;
  /** Groups after grouping. */
  groupCount: number;
  /** Triplets that went into them. */
  tripletCount: number;
  /** Triplets that could not be grouped at all (no key value on the record). */
  ungroupableTripletCount: number;
}

export interface PrepromptInput {
  grouping: GroupingDisclosure;
}

export interface AssembledPreprompt {
  version: string;
  text: string;
  clauseIds: PrepromptClauseId[];
  keyUsed: GroupingKeyUsed;
  /** The disclosure sentence on its own, so a view can show it beside the answer. */
  groupingSentence: string;
}

/**
 * The disclosure clause. This is the one that must never overclaim.
 *
 * `cluster_id`    - the file carried the real per-MESSAGE id and it was used.
 * `message_text`  - the file carried no cluster id; identical message text was
 *                   used instead. A real key, but a DIFFERENT key, and it is
 *                   named as such.
 * `none`          - nothing to group on. The rule could not be applied and the
 *                   model is told so rather than being allowed to assume it was.
 */
export function groupingSentenceFor(g: GroupingDisclosure): string {
  const tail =
    g.ungroupableTripletCount > 0
      ? ' ' + String(g.ungroupableTripletCount) +
        ' of them carried no value for that key and could not be grouped with ' +
        'anything; treat each of those as its own source and do not assume it ' +
        'is a restatement of another row.'
      : '';

  if (g.keyUsed === 'cluster_id') {
    return (
      'These ' + String(g.tripletCount) + ' triplets were grouped into ' +
      String(g.groupCount) + ' source messages by the cluster id the file ' +
      'carries. That is the id of the originating message, shared by every row ' +
      'and every triplet that came out of it, so a group is one message ' +
      'however many ' +
      'attachments it had.' + tail
    );
  }
  if (g.keyUsed === 'record_id') {
    return (
      'This file carries NO cluster id. These ' + String(g.tripletCount) +
      ' triplets were grouped into ' + String(g.groupCount) +
      ' groups by RECORD id instead, which is one per row. A message that ' +
      'carried two attachments is two rows, so such a message appears here as ' +
      'two groups and its figures are stated twice. Do not treat two groups ' +
      'as two independent reports without reading their text, and do not call ' +
      'this a number of messages.' + tail
    );
  }
  if (g.keyUsed === 'message_text') {
    return (
      'This file carries NO cluster id. These ' + String(g.tripletCount) +
      ' triplets were grouped into ' + String(g.groupCount) +
      ' groups by identical message text instead, because two triplets pulled ' +
      'from one message repeat that message word for word. This is a real key ' +
      'but it is NOT a cluster id: two different messages that happen to be ' +
      'worded identically land in one group, and a message stored with any ' +
      'difference at all lands in two. Do not describe these groups as ' +
      'records or as messages, and do not state a number of either.' + tail
    );
  }
  return (
    'This file carries no cluster id and no usable message text, so these ' +
    String(g.tripletCount) + ' triplets could NOT be grouped by source ' +
    'message at all. The no-compounding rule has nothing to key on here. ' +
    'Treat every triplet as a separate statement, say plainly that you cannot ' +
    'tell which of them came from the same message, and do not claim any ' +
    'grouping.' + tail
  );
}

/**
 * Assemble the standing pre-prompt. Every model call goes through here.
 *
 * There is no option to drop a clause. The only input is a statement of fact
 * about the loaded data.
 */
export function assemblePreprompt(input: PrepromptInput): AssembledPreprompt {
  const groupingSentence = groupingSentenceFor(input.grouping);
  const parts: string[] = [
    'You are answering questions about a graph of extracted facts. Follow ' +
      'every rule below. They are not style preferences; each one exists ' +
      'because breaking it produced a wrong answer.',
    '',
  ];
  const clauseIds: PrepromptClauseId[] = [];

  let n = 0;
  for (const clause of PREPROMPT_CLAUSES) {
    n += 1;
    const body = clause.fixed ? clause.body : groupingSentence;
    if (body === null) {
      throw new Error('preprompt clause ' + clause.id + ' has no body');
    }
    parts.push(String(n) + '. ' + clause.heading.toUpperCase());
    parts.push(body);
    parts.push('');
    clauseIds.push(clause.id);
  }

  parts.push(
    'If you cannot follow a rule above and still answer, say which rule ' +
      'stopped you and stop there.',
  );

  return {
    version: PREPROMPT_VERSION,
    text: parts.join('\n'),
    clauseIds,
    keyUsed: input.grouping.keyUsed,
    groupingSentence,
  };
}
