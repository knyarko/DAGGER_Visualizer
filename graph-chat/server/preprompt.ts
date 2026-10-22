
/**
 * The standing pre-prompt.
 *
 * It is assembled here and prepended to model calls. The graph JSON is
 * supplied alongside it and provides the data used to answer questions.
 *
 * The pre-prompt provides general context for understanding the graph.
 * It does not prescribe a specific type of question or restrict the model
 * to a fixed set of operations.
 */

export const PREPROMPT_VERSION = '3.0.0';

export type GroupingKeyUsed =
  | 'cluster_id'
  | 'record_id'
  | 'message_text'
  | 'none';

export type PrepromptClauseId = 'graph-context';

export interface PrepromptClause {
  id: PrepromptClauseId;
  heading: string;
  body: string | null;
  fixed: boolean;
  source: string;
}

export const PREPROMPT_CLAUSES: readonly PrepromptClause[] = Object.freeze([
  {
    id: 'graph-context',
    heading: 'Understanding the graph',
    body:
      'You are answering questions about a graph represented in the supplied JSON. ' +
      'Use the JSON to understand the graph structure, fields, identifiers, nodes, ' +
      'edges, and relationships. Interpret each field according to its meaning and ' +
      'cross-reference related entries when relevant. Answer questions using the ' +
      'supplied graph as evidence. Draw connections when supported by the data, ' +
      'distinguish explicit facts from inferences, and explain uncertainty when ' +
      'the evidence is insufficient. Respond directly, clearly, and concisely. ' +
      'Adapt your reasoning to the question being asked.',
    fixed: true,
    source: 'General graph context',
  },
]);

export const REQUIRED_CLAUSE_IDS: readonly PrepromptClauseId[] = Object.freeze(
  PREPROMPT_CLAUSES.map((c) => c.id),
);

export interface GroupingDisclosure {
  keyUsed: GroupingKeyUsed;
  groupCount: number;
  tripletCount: number;
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
  groupingSentence: string;
}

/**
 * Keep the grouping summary available to the application for display.
 * It is not added to the standing pre-prompt because grouping details
 * are not necessary context for every graph question.
 */
export function groupingSentenceFor(g: GroupingDisclosure): string {
  return (
    'Grouping metadata: key=' +
    g.keyUsed +
    ', groups=' +
    String(g.groupCount) +
    ', triplets=' +
    String(g.tripletCount) +
    ', ungroupable triplets=' +
    String(g.ungroupableTripletCount) +
    '.'
  );
}

/**
 * Assemble the standing pre-prompt.
 *
 * The grouping metadata remains available in the returned object, but the
 * prompt itself stays focused on understanding and querying the graph.
 */
export function assemblePreprompt(input: PrepromptInput): AssembledPreprompt {
  const clauseIds: PrepromptClauseId[] = [];
  const parts: string[] = [];

  for (const clause of PREPROMPT_CLAUSES) {
    if (clause.body === null) {
      throw new Error('preprompt clause ' + clause.id + ' has no body');
    }

    parts.push(clause.body);
    clauseIds.push(clause.id);
  }

  return {
    version: PREPROMPT_VERSION,
    text: parts.join('\n\n'),
    clauseIds,
    keyUsed: input.grouping.keyUsed,
    groupingSentence: groupingSentenceFor(input.grouping),
  };
}
