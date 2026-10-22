/**
 * The HTTP surface.
 *
 * Built on `node:http` and nothing else. The root `package.json` declares
 * `express` and `cors`, but root `node_modules/` does not exist in this
 * checkout, so a service that needed them could not start here. Six routes do
 * not need a framework.
 *
 * Routing is separated from the socket on purpose: `handle()` takes a method,
 * a url and a body string and returns a status, headers and a body, so every
 * route is testable without binding a port. `createServer()` is the thin wrap
 * that puts it on one.
 */

import { adapterFor, isProviderId, providerAvailability } from './adapters/index.js';
import { ask, type AskDeps } from './answer.js';
import { assemblePreprompt, PREPROMPT_CLAUSES, PREPROMPT_VERSION } from './old_preprompt.js';
import { DEFAULT_SIMILARITY_THRESHOLD, SIMILARITY_METHOD } from './similarity.js';
import type { AnswerStore } from './store.js';
import { SCHEMA_VERSION } from './store.js';
import type { AskRequest, HttpPost } from './types.js';
import { MAX_SAMPLE_ITEMS, SERVICE_CONTRACT_VERSION } from './types.js';

export const API_BASE = '/api/graph-chat';

/** Requests larger than this are refused rather than buffered. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export const ALLOWED_ORIGIN_ENV_VAR = 'GRAPH_CHAT_ALLOWED_ORIGIN';
export const PORT_ENV_VAR = 'GRAPH_CHAT_PORT';
export const DEFAULT_PORT = 3002;

export interface ServiceDeps {
  store: AnswerStore;
  post: HttpPost;
  env?: Record<string, string | undefined>;
  now?: () => number;
  newId?: () => string;
  clockIso?: () => string;
  threshold?: number;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function corsHeaders(env?: Record<string, string | undefined>): Record<string, string> {
  const origin = env?.[ALLOWED_ORIGIN_ENV_VAR];
  return {
    'access-control-allow-origin':
      typeof origin === 'string' && origin.trim() !== '' ? origin.trim() : '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function json(status: number, value: unknown, env?: Record<string, string | undefined>): HttpResult {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(env) },
    body: JSON.stringify(value),
  };
}

function problem(
  status: number,
  message: string,
  env?: Record<string, string | undefined>,
): HttpResult {
  return json(status, { error: message }, env);
}

/** Enough validation to refuse a request that cannot be answered. No more. */
function validateAsk(value: unknown): { ok: true; request: AskRequest } | { ok: false; why: string } {
  if (typeof value !== 'object' || value === null) return { ok: false, why: 'the body must be a JSON object' };
  const v = value as Record<string, unknown>;
  if (typeof v['graphKey'] !== 'string' || v['graphKey'].trim() === '') {
    return { ok: false, why: 'graphKey is required - it is what scopes the cache to one loaded file' };
  }
  if (typeof v['question'] !== 'string' || v['question'].trim() === '') {
    return { ok: false, why: 'question is required' };
  }
  if (!isProviderId(v['provider'])) {
    return { ok: false, why: 'provider must be one of gemini, openai, claude, ollama' };
  }
  const evidence = v['evidence'];
  if (typeof evidence !== 'object' || evidence === null) {
    return { ok: false, why: 'evidence is required - the engine runs in the caller and its bundle comes in with the question' };
  }
  const kind = (evidence as Record<string, unknown>)['kind'];
  if (kind !== 'aggregate' && kind !== 'retrieval') {
    return { ok: false, why: 'evidence.kind must be "aggregate" or "retrieval"' };
  }
  const mk = v['messageKeyAvailable'];
  if (mk !== 'cluster_id' && mk !== 'record_id' && mk !== 'none') {
    return {
      ok: false,
      why:
        'messageKeyAvailable must be "cluster_id", "record_id" or "none" - ' +
        'without it the grouping key cannot be stated honestly, and a row id ' +
        'must never be reported as a message id',
    };
  }
  return { ok: true, request: value as unknown as AskRequest };
}

export async function handle(
  method: string,
  url: string,
  body: string,
  deps: ServiceDeps,
): Promise<HttpResult> {
  const env = deps.env;
  const upper = method.toUpperCase();
  if (upper === 'OPTIONS') return { status: 204, headers: corsHeaders(env), body: '' };

  const parsed = new URL(url, 'http://service.invalid');
  const path = parsed.pathname.replace(/\/+$/, '') || '/';

  /* ---------------- GET /health ---------------- */
  if (upper === 'GET' && path === API_BASE + '/health') {
    let answers: number | null = null;
    try {
      answers = deps.store.countAnswers();
    } catch {
      answers = null;
    }
    return json(200, {
      ok: true,
      contractVersion: SERVICE_CONTRACT_VERSION,
      prepromptVersion: PREPROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      storedAnswers: answers,
      similarity: { method: SIMILARITY_METHOD, threshold: deps.threshold ?? DEFAULT_SIMILARITY_THRESHOLD },
      maxSampleItems: MAX_SAMPLE_ITEMS,
    }, env);
  }

  /* ---------------- GET /providers ---------------- */
  if (upper === 'GET' && path === API_BASE + '/providers') {
    // Key NAMES and a present/absent flag. No key value is read out here.
    return json(200, { providers: providerAvailability(env) }, env);
  }

  /* ---------------- GET /preprompt ---------------- */
  if (upper === 'GET' && path === API_BASE + '/preprompt') {
    // Shown, never edited: there is no route that writes it.
    const sample = assemblePreprompt({
      grouping: { keyUsed: 'record_id', groupCount: 0, tripletCount: 0, ungroupableTripletCount: 0 },
    });
    return json(200, {
      version: PREPROMPT_VERSION,
      editable: false,
      clauses: PREPROMPT_CLAUSES.map((c) => ({
        id: c.id,
        heading: c.heading,
        fixed: c.fixed,
        source: c.source,
      })),
      exampleText: sample.text,
    }, env);
  }

  /* ---------------- GET /history ---------------- */
  if (upper === 'GET' && path === API_BASE + '/history') {
    const graphKey = parsed.searchParams.get('graphKey');
    if (graphKey === null || graphKey.trim() === '') {
      return problem(400, 'graphKey is required', env);
    }
    const rawLimit = Number.parseInt(parsed.searchParams.get('limit') ?? '50', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    try {
      return json(200, { graphKey, entries: deps.store.history(graphKey, limit) }, env);
    } catch (err) {
      return problem(500, 'the stored questions could not be read: ' +
        (err instanceof Error ? err.message : String(err)), env);
    }
  }

  /* ---------------- GET /answer/:id ---------------- */
  if (upper === 'GET' && path.startsWith(API_BASE + '/answer/')) {
    const id = decodeURIComponent(path.slice((API_BASE + '/answer/').length));
    if (id === '') return problem(400, 'an answer id is required', env);
    try {
      const stored = deps.store.get(id);
      if (stored === null) return problem(404, 'no such answer', env);
      return json(200, stored, env);
    } catch (err) {
      return problem(500, 'the stored answer could not be read: ' +
        (err instanceof Error ? err.message : String(err)), env);
    }
  }

  /* ---------------- POST /ask ---------------- */
  if (upper === 'POST' && path === API_BASE + '/ask') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      return problem(413, 'the request body is larger than this service accepts', env);
    }
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      return problem(400, 'the body is not valid JSON', env);
    }
    const checked = validateAsk(value);
    if (!checked.ok) return problem(400, checked.why, env);

    const adapter = adapterFor(checked.request.provider);
    const availability = adapter.availability(env);
    if (!availability.usable) {
      // Still a 200: this is an answer-shaped outcome, not a broken request.
      return json(200, {
        answerId: '',
        graphKey: checked.request.graphKey,
        question: checked.request.question,
        kind: checked.request.kind,
        answer: '',
        reason: availability.reason,
        ok: false,
        provider: checked.request.provider,
        model: availability.defaultModel,
        grouping: { keyUsed: 'none', groupsBefore: 0, groupsAfter: 0, ungroupableTripletCount: 0, note: '' },
        preprompt: { version: PREPROMPT_VERSION, groupingSentence: '' },
        cache: {
          hit: false, answerId: null, originalQuestion: null, originalAskedAt: null,
          similarity: 0, threshold: deps.threshold ?? DEFAULT_SIMILARITY_THRESHOLD,
          method: SIMILARITY_METHOD, candidatesConsidered: 0,
        },
        askedAt: (deps.clockIso ?? (() => new Date().toISOString()))(),
        elapsedMs: 0,
        notes: availability.reason === null ? [] : [availability.reason],
      }, env);
    }

    const askDeps: AskDeps = {
      store: deps.store,
      post: deps.post,
      env: deps.env,
      now: deps.now,
      newId: deps.newId,
      clockIso: deps.clockIso,
      threshold: deps.threshold,
    };
    const response = await ask(checked.request, askDeps);
    return json(200, response, env);
  }

  return problem(404, 'no such route', env);
}

/* ------------------------------------------------------------------ *
 * The socket. Everything above is reachable without it.
 * ------------------------------------------------------------------ */

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export async function createServer(deps: ServiceDeps, port?: number): Promise<RunningServer> {
  const http = await import('node:http');
  const fromEnv = Number.parseInt(deps.env?.[PORT_ENV_VAR] ?? '', 10);
  const chosen = port ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT);

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        refused = true;
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(deps.env) });
        res.end(JSON.stringify({ error: 'the request body is larger than this service accepts' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (refused) return;
      const body = Buffer.concat(chunks).toString('utf8');
      handle(req.method ?? 'GET', req.url ?? '/', body, deps)
        .then((result) => {
          res.writeHead(result.status, result.headers);
          res.end(result.body);
        })
        .catch((err: unknown) => {
          // A route must not be able to take the process down.
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(deps.env) });
          res.end(JSON.stringify({
            error: 'the service failed while answering: ' +
              (err instanceof Error ? err.message : String(err)),
          }));
        });
    });
  });

  await new Promise<void>((resolve) => server.listen(chosen, resolve));

  return {
    port: chosen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
