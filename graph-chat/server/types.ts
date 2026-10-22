/**
 * The service contract.
 *
 * The front end codes against this file and against `http.ts`. Everything the
 * service returns is declared here; nothing below is inferred at a call site.
 *
 * The engine's types are imported, never restated. A service type that
 * duplicated `EvidenceBundle` would drift from it on the next contract change.
 */

import type {
  EngineStamp,
  EvidenceBundle,
  QueryDescriptor,
  QueryKind,
  MessageGroup,
  MessageKeySource,
  ShapeReport,
} from '../engine/types.js';

import type { GroupingKeyUsed } from './old_preprompt.js';

export const SERVICE_CONTRACT_VERSION = '1.0.0';

/* ------------------------------------------------------------------ *
 * Providers
 * ------------------------------------------------------------------ */

export type ModelProviderId = 'gemini' | 'openai' | 'claude' | 'ollama';

export const PROVIDER_IDS: readonly ModelProviderId[] = Object.freeze([
  'gemini',
  'openai',
  'claude',
  'ollama',
]);

/**
 * Why a provider cannot be used right now. Never carries a key value, and
 * never carries the key's contents in any form.
 */
export interface ProviderAvailability {
  id: ModelProviderId;
  label: string;
  /** False for the local provider. */
  requiresKey: boolean;
  /** The NAME of the environment variable. Never its value. */
  keyEnvVar: string | null;
  /** Whether that variable is set to a non-empty value. The value is not read out. */
  keyPresent: boolean;
  /** True only for the provider that needs no internet. */
  worksOffline: boolean;
  /** Whether a call can be attempted at all. */
  usable: boolean;
  /** Plain sentence for the dropdown when `usable` is false. */
  reason: string | null;
  defaultModel: string;
}

/* ------------------------------------------------------------------ *
 * The model call
 * ------------------------------------------------------------------ */

export interface ModelRequest {
  /** The assembled standing pre-prompt. Always present. */
  system: string;
  /** The question, the evidence and the grouping, rendered for the model. */
  user: string;
  /** Provider-specific model id. */
  model: string;
  /** Upper bound on the answer. The pre-prompt asks for brief; this enforces it. */
  maxOutputTokens: number;
  /** Near-zero by contract, and never a literal at a call site. */
  temperature: number;
  /** Abort budget in ms. */
  timeoutMs: number;
}

/**
 * A model call NEVER throws out of the adapter layer. A provider that fails
 * returns `ok: false`, `text: ''` and a reason. The request survives.
 */
export interface ModelResponse {
  ok: boolean;
  /** Empty string on any failure. Never null, never undefined. */
  text: string;
  /** Null on success. A plain sentence on failure. Never contains a key. */
  reason: string | null;
  provider: ModelProviderId;
  /** The model that actually answered, as the provider reported it. */
  model: string;
  /** The temperature actually used, carried back rather than assumed. */
  temperature: number;
  elapsedMs: number;
  /** Provider-reported stop reason where one exists. */
  stopReason: string | null;
}

/**
 * Injected transport. Every adapter takes one. The tests pass a fake; nothing
 * in this repo passes a real one, because this sprint makes no live call.
 */
export type HttpPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
) => Promise<{ status: number; body: string }>;

export interface AdapterDeps {
  post: HttpPost;
  /** Environment to read the key NAME from. Defaults to the process env. */
  env?: Record<string, string | undefined>;
  now?: () => number;
}

export interface ModelAdapter {
  readonly id: ModelProviderId;
  readonly label: string;
  readonly requiresKey: boolean;
  /** The NAME of the env var holding the key. Null for the local provider. */
  readonly keyEnvVar: string | null;
  readonly worksOffline: boolean;
  readonly defaultModel: string;
  availability(env?: Record<string, string | undefined>): ProviderAvailability;
  complete(request: ModelRequest, deps: AdapterDeps): Promise<ModelResponse>;
}

/* ------------------------------------------------------------------ *
 * Grouping - the B065 resolution
 * ------------------------------------------------------------------ */

export interface ServiceMessageGroup {
  /** The value the group was keyed on. Null when the key was message text or
   *  when there was no key at all. Named `cluster_id` because that is what it
   *  holds whenever the file supplies one: the id of the ORIGINATING MESSAGE,
   *  shared by every row out of it. A row id only stands in for it on a file
   *  that has no cluster id, and `keyUsed` says when that happened. */
  cluster_id: string | null;
  /** A stable id for the group, whichever key produced it. */
  group_key: string;
  triplet_ids: string[];
  msg_text: string;
  figures: MessageGroup['figures'];
  note: string | null;
}

export interface GroupingResult {
  keyUsed: GroupingKeyUsed;
  groups: ServiceMessageGroup[];
  /** Groups the engine handed in, before this pass. */
  groupsBefore: number;
  /** Groups after this pass. Equal to `groups.length`. */
  groupsAfter: number;
  tripletCount: number;
  /** Triplets with no value for the chosen key. Each stays on its own. */
  ungroupableTripletCount: number;
  /** One plain sentence a view can print. */
  note: string;
}

/* ------------------------------------------------------------------ *
 * The cache
 * ------------------------------------------------------------------ */

export type SimilarityMethod = 'stemmed-jaccard+trigram';

export interface CacheMatch {
  hit: boolean;
  /** The stored answer's id when `hit`. */
  answerId: string | null;
  /** The question as it was originally asked. */
  originalQuestion: string | null;
  /** ISO-8601, UTC. When the original was asked. */
  originalAskedAt: string | null;
  similarity: number;
  threshold: number;
  method: SimilarityMethod;
  /** Number of stored questions compared against. */
  candidatesConsidered: number;
}

/* ------------------------------------------------------------------ *
 * Ask
 * ------------------------------------------------------------------ */

/**
 * One matched triplet, trimmed to what a model can narrate from.
 *
 * A retrieval answer is a result set and the view renders it. The model gets
 * this so its one or two sentences are about the rows that are actually on
 * screen, and nothing else: no media paths, no handling block, no justification
 * blob. What is sent is exactly this and the caller can see it.
 */
export interface AskSampleItem {
  triplet_id: string;
  /** subject -> predicate -> object, as the engine assembled it. */
  label: string;
  /** The source message, trimmed by the caller. */
  msg_text: string;
  /** Whether this row carries media. Not the media itself. */
  hasMedia: boolean;
}

/**
 * What the front end posts. The service does NOT need the graph: the engine
 * runs in the caller and the evidence bundle comes in already built. That is
 * what lets a cache hit answer a viewer who has loaded nothing.
 */
export interface AskRequest {
  /** Scopes the cache. Same question against a different graph is a different question. */
  graphKey: string;
  /** Human label for the loaded file, for the history strip. Never a path. */
  graphLabel?: string;
  question: string;
  kind: QueryKind;
  evidence: EvidenceBundle;
  query: QueryDescriptor;
  engine: EngineStamp;
  shape: ShapeReport;
  /** The true total behind the display cap. */
  total: number;
  /** Which key for "same source message" the corpus actually supplied:
   *  `cluster_id` (the message id), `record_id` (a row id standing in, on a
   *  file with no cluster id), or `none`. Drives the message-text fallback. */
  messageKeyAvailable: MessageKeySource;
  provider: ModelProviderId;
  model?: string;
  /** Default true. False forces a fresh call and still stores the result. */
  allowCache?: boolean;
  /**
   * The rows the model may narrate, for a retrieval question. Optional, and
   * capped by `MAX_SAMPLE_ITEMS` on the way in. An aggregate question needs
   * none: its figures are in the evidence.
   */
  sample?: AskSampleItem[];
}

/** The service will not forward more rows than this to a model. */
export const MAX_SAMPLE_ITEMS = 25;

export interface AskResponse {
  answerId: string;
  graphKey: string;
  question: string;
  kind: QueryKind;
  /** Empty string when the provider failed. Never null. */
  answer: string;
  /** Null on success, a plain sentence on failure. */
  reason: string | null;
  ok: boolean;
  provider: ModelProviderId;
  model: string;
  /** Always populated. The view shows the key used beside the answer. */
  grouping: {
    keyUsed: GroupingKeyUsed;
    groupsBefore: number;
    groupsAfter: number;
    ungroupableTripletCount: number;
    note: string;
  };
  preprompt: {
    version: string;
    /** The disclosure sentence, for display beside the answer. */
    groupingSentence: string;
  };
  /** A cached answer is ALWAYS labelled as one. */
  cache: CacheMatch;
  askedAt: string;
  elapsedMs: number;
  /** Non-fatal things the view should show. */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * History and stored answers
 * ------------------------------------------------------------------ */

export interface HistoryEntry {
  answerId: string;
  graphKey: string;
  graphLabel: string | null;
  question: string;
  kind: QueryKind;
  provider: ModelProviderId;
  model: string;
  ok: boolean;
  askedAt: string;
  /** How many times a near-duplicate pulled this answer instead of a new call. */
  hitCount: number;
  groupingKeyUsed: GroupingKeyUsed;
}

export interface StoredAnswer extends HistoryEntry {
  answer: string;
  reason: string | null;
  evidence: EvidenceBundle;
  query: QueryDescriptor;
  engine: EngineStamp;
  shape: ShapeReport;
  total: number;
  grouping: GroupingResult;
  prepromptVersion: string;
  groupingSentence: string;
}
