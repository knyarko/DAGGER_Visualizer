/**
 * The query service, reached over fetch and nothing else.
 *
 * ── THE GATE THIS FILE EXISTS TO HOLD ───────────────────────────────────────
 *   The Visualizer ships to GitHub Pages as a static bundle with NO SERVER.
 *   The production build must still build and run with this service absent, so
 *   nothing in this module is imported for its side effects, nothing here runs
 *   at module load, and no call here can throw into a render. If a change to
 *   this file ever makes the static build depend on a reachable service, the
 *   sprint has broken the one thing it promised not to break.
 *
 *   When the service is unreachable the feature DEGRADES, it does not fail:
 *     - the engine still runs, in this browser, so retrieval and aggregation
 *       still work and the counts, the rows, the evidence and the chart are all
 *       still real;
 *     - what is lost is the MODEL'S SENTENCE, the SHARED prior-question strip
 *       and the near-duplicate CACHE — all three live on the service by design,
 *       because a cache in one person's browser is not shared with anyone;
 *     - and the screen says so, in words, rather than showing an empty strip
 *       that reads as "nobody has asked anything".
 *
 * ── KEYS ────────────────────────────────────────────────────────────────────
 *   The view never holds an API key. The service reads keys from its own
 *   process environment by variable NAME, and `GET /providers` returns the NAME
 *   and a present/absent boolean, never a value. Nothing in this file reads,
 *   stores, forwards or logs a key.
 *
 * ── WHERE THE SERVICE IS ────────────────────────────────────────────────────
 *   `VITE_GRAPH_CHAT_URL` at build time, falling back to the service's own
 *   default port. It is a host, not a secret. A static deploy simply leaves it
 *   unset and every call below reports "unreachable", which is the degraded
 *   mode above and is the expected state on GitHub Pages.
 */

import { MAX_SAMPLE_ITEMS } from '../../../../graph-chat/server/types.ts';
import type {
  AskRequest,
  AskResponse,
  AskSampleItem,
  HistoryEntry,
  ModelProviderId,
  ProviderAvailability,
} from '../../../../graph-chat/server/types.ts';

export type {
  AskRequest,
  AskResponse,
  AskSampleItem,
  HistoryEntry,
  ModelProviderId,
  ProviderAvailability,
};
export { MAX_SAMPLE_ITEMS };

const DEFAULT_BASE = 'http://localhost:3002';
const BASE_PATH = '/api/graph-chat';

/** How long any one call may hang before it is treated as unreachable. A dead
 *  port usually refuses immediately; a black-holed one does not, and a view
 *  that waits forever for a service it was designed to work without is the
 *  degradation gate failing quietly. */
const TIMEOUT_MS = 6000;

function baseUrl(): string {
  /* Optional-chained: the bundler defines `import.meta.env`, but this module
   * is plain dependency-free TypeScript and is run outside a bundler to prove
   * the unreachable-service path. An undefined env there must degrade, not
   * throw. */
  const configured = import.meta.env?.VITE_GRAPH_CHAT_URL;
  const value = typeof configured === 'string' ? configured.trim() : '';
  return (value === '' ? DEFAULT_BASE : value).replace(/\/+$/, '') + BASE_PATH;
}

/** Every call returns one of these. Nothing here ever throws.
 *
 *  Both members carry both keys — one of them always `undefined` — so that the
 *  union narrows on `ok` under this project's compiler settings, which have
 *  `strict` off. A two-key union would read more cleanly and would not narrow
 *  here, and a result type that needs a cast at every call site is a result
 *  type that will eventually be ignored. */
export type ServiceResult<T> =
  | { ok: true; value: T; reason?: undefined }
  | { ok: false; value?: undefined; reason: string };

function reasonOf(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'the query service did not answer in time';
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return 'the query service could not be reached';
}

/* A 200 is not proof the query service answered. Anything may be listening on
 * that port, and casting its JSON to the expected type is how an unrelated
 * server took the whole view down with `providers.map is not a function`.
 * Every response is checked against the shape its caller expects, and an
 * unexpected one is a reason, not a crash. */
async function call<T>(
  path: string,
  parse: (value: unknown) => T | null,
  init?: RequestInit,
): Promise<ServiceResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(baseUrl() + path, { ...init, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, reason: `the query service answered ${response.status}` };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      const body = await response.clone().text().catch(() => '');
      const head = body.slice(0, 120).replace(/\s+/g, ' ').trim();
      return {
        ok: false,
        reason:
          'GET ' + baseUrl() + path + ' answered ' + String(response.status) +
          ' with something that is not JSON' + (head === '' ? '.' : ': ' + head + '...'),
      };
    }
    const taken = parse(parsed);
    if (taken === null) {
      /* Say what actually arrived. A reason that only says "wrong shape" sends
       * the next person guessing at the cause the way this one was guessed at
       * twice; a reason carrying the URL and a slice of the body identifies it
       * in one read. Truncated, because a body can be a whole HTML page. */
      let got: string;
      try {
        got = JSON.stringify(parsed);
      } catch {
        got = String(parsed);
      }
      if (got.length > 160) got = got.slice(0, 160) + '...';
      return {
        ok: false,
        reason:
          'GET ' + baseUrl() + path + ' answered ' + String(response.status) +
          ' but not with the query service. It sent: ' + got,
      };
    }
    return { ok: true, value: taken };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

export interface ServiceHealth {
  [key: string]: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/* Health must name itself: any JSON object would otherwise pass, which is how
 * an unrelated server on this port got as far as the provider call. */
const isHealth = (v: unknown): v is ServiceHealth =>
  isObject(v) && typeof v.prepromptVersion === 'string';

/* The service wraps its list payloads - `/providers` answers
 * `{ providers: [...] }` and `/history` answers `{ graphKey, entries: [...] }`.
 * The envelope is unwrapped HERE so nothing inward ever sees it. Handing the
 * wrapper to the view is what produced `providers.map is not a function`. */
const takeProviders = (v: unknown): ProviderAvailability[] | null => {
  const list = isObject(v) && Array.isArray(v.providers) ? v.providers : Array.isArray(v) ? v : null;
  if (list === null) return null;
  return list.every(e => isObject(e) && typeof e.id === 'string' && typeof e.label === 'string')
    ? (list as ProviderAvailability[])
    : null;
};

const takeHistory = (v: unknown): HistoryEntry[] | null => {
  const list = isObject(v) && Array.isArray(v.entries) ? v.entries : Array.isArray(v) ? v : null;
  if (list === null) return null;
  return list.every(e => isObject(e) && typeof e.answerId === 'string')
    ? (list as HistoryEntry[])
    : null;
};

const takeHealth = (v: unknown): ServiceHealth | null => (isHealth(v) ? v : null);

const takeAskResponse = (v: unknown): AskResponse | null =>
  isObject(v) && typeof v.answerId === 'string' && typeof v.answer === 'string'
    ? (v as unknown as AskResponse)
    : null;

export function health(): Promise<ServiceResult<ServiceHealth>> {
  return call('/health', takeHealth);
}

export function providers(): Promise<ServiceResult<ProviderAvailability[]>> {
  return call('/providers', takeProviders);
}

export function history(graphKey: string, limit = 12): Promise<ServiceResult<HistoryEntry[]>> {
  const query = `?graphKey=${encodeURIComponent(graphKey)}&limit=${encodeURIComponent(String(limit))}`;
  return call('/history' + query, takeHistory);
}

/**
 * Ask. `/ask` answers 200 even when the model failed — `ok: false`, an empty
 * answer and a plain `reason` — so a transport failure here means the SERVICE
 * is unreachable, which is a different thing from the model being down, and
 * the view says the two differently.
 */
export function ask(request: AskRequest): Promise<ServiceResult<AskResponse>> {
  return call('/ask', takeAskResponse, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

/** The rows actually on screen, so the model's sentence is about what the
 *  viewer is looking at. Capped on the way out as well as on the way in. */
export function sampleFrom(
  items: ReadonlyArray<{ triplet_id: string; label: string; msg_text: string; mediaCount: number }>,
): AskSampleItem[] {
  return items.slice(0, MAX_SAMPLE_ITEMS).map(item => ({
    triplet_id: item.triplet_id,
    label: item.label,
    msg_text: item.msg_text,
    hasMedia: item.mediaCount > 0,
  }));
}
