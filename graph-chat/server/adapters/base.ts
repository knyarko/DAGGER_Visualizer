/**
 * Shared adapter plumbing.
 *
 * THE DISCIPLINE, stated once here and relied on by all four adapters:
 * a provider that fails returns a BLANK and a REASON. It does not throw. A
 * dead provider, a refused key, a timeout, a 500, a body that is not JSON and
 * a body that is JSON of the wrong shape all land in the same place - an
 * answer of '' with `ok: false` and a sentence saying what happened - because
 * a model failure must not take the request down with it.
 *
 * The temperature actually used rides back on every response rather than
 * being assumed from what was asked for. A near-zero default lives here and
 * is never written as a literal at a call site.
 */

import type {
  AdapterDeps,
  ModelProviderId,
  ModelRequest,
  ModelResponse,
} from '../types.js';
import { redact } from '../keys.js';

/** Near-zero. Narration of fixed evidence has no use for sampling. */
export const DEFAULT_TEMPERATURE = 0;
export const DEFAULT_MAX_OUTPUT_TOKENS = 700;
export const DEFAULT_TIMEOUT_MS = 60_000;

export function makeRequest(
  system: string,
  user: string,
  model: string,
  overrides: Partial<ModelRequest> = {},
): ModelRequest {
  return {
    system,
    user,
    model,
    maxOutputTokens: overrides.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: overrides.temperature ?? DEFAULT_TEMPERATURE,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export function blank(
  provider: ModelProviderId,
  model: string,
  temperature: number,
  reason: string,
  elapsedMs: number,
  env?: Record<string, string | undefined>,
): ModelResponse {
  return {
    ok: false,
    text: '',
    reason: redact(reason, env),
    provider,
    model,
    temperature,
    elapsedMs,
    stopReason: null,
  };
}

export function answered(
  provider: ModelProviderId,
  model: string,
  temperature: number,
  text: string,
  stopReason: string | null,
  elapsedMs: number,
): ModelResponse {
  return { ok: true, text, reason: null, provider, model, temperature, elapsedMs, stopReason };
}

export function clockOf(deps: AdapterDeps): () => number {
  return deps.now ?? (() => Date.now());
}

/** Parse a response body without letting a bad one throw out of the adapter. */
export function parseJson(body: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(body) as unknown };
  } catch {
    const head = body.slice(0, 160).replace(/\s+/g, ' ').trim();
    return {
      ok: false,
      reason: 'the provider returned a body that is not JSON: ' + (head === '' ? '(empty)' : head),
    };
  }
}

/**
 * A readable sentence for a non-2xx status. The body is included because it
 * usually says what is wrong, and it is redacted because it sometimes says it
 * by quoting the key back.
 */
export function statusReason(
  label: string,
  status: number,
  body: string,
  env?: Record<string, string | undefined>,
): string {
  const head = redact(body.slice(0, 300).replace(/\s+/g, ' ').trim(), env);
  if (status === 401 || status === 403) {
    return label + ' refused the request (HTTP ' + String(status) +
      '). The key in the environment variable was rejected or is not allowed ' +
      'to use this model. ' + head;
  }
  if (status === 404) {
    return label + ' has no such model (HTTP 404). ' + head;
  }
  if (status === 429) {
    return label + ' is rate limiting (HTTP 429). Nothing is wrong with the ' +
      'question; try again shortly. ' + head;
  }
  return label + ' returned HTTP ' + String(status) + '. ' + head;
}

/** Walk a parsed body safely. Returns null rather than throwing. */
export function pick(value: unknown, path: ReadonlyArray<string | number>): unknown {
  let cur: unknown = value;
  for (const step of path) {
    if (cur === null || cur === undefined) return null;
    if (typeof step === 'number') {
      if (!Array.isArray(cur)) return null;
      cur = cur[step];
    } else {
      if (typeof cur !== 'object' || Array.isArray(cur)) return null;
      cur = (cur as Record<string, unknown>)[step];
    }
  }
  return cur ?? null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Run an adapter body so that NOTHING escapes as an exception. Every adapter's
 * `complete` is wrapped in this.
 */
export async function neverThrow(
  provider: ModelProviderId,
  model: string,
  temperature: number,
  startedAt: number,
  clock: () => number,
  env: Record<string, string | undefined> | undefined,
  body: () => Promise<ModelResponse>,
): Promise<ModelResponse> {
  try {
    return await body();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return blank(
      provider,
      model,
      temperature,
      'the call to ' + provider + ' failed before an answer came back: ' + message,
      clock() - startedAt,
      env,
    );
  }
}
