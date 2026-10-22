/**
 * Local Ollama.
 *
 * This is the one provider that needs NO key and NO internet, so it is the
 * path that proves the whole system end to end: pre-prompt assembled, evidence
 * rendered, grouping disclosed, answer stored, cache consulted - all of it
 * exercised without a cloud account existing.
 *
 * The host comes from an environment variable NAME with a loopback default.
 * A host is not a secret; a key would be, and this provider has none.
 */

import type {
  AdapterDeps,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ProviderAvailability,
} from '../types.js';
import { OLLAMA_HOST_ENV_VAR, ollamaHost } from '../keys.js';
import {
  answered, asString, blank, clockOf, neverThrow, parseJson, pick, statusReason,
} from './base.js';

const LABEL = 'Ollama (local)';

export const ollamaAdapter: ModelAdapter = {
  id: 'ollama',
  label: LABEL,
  requiresKey: false,
  keyEnvVar: null,
  worksOffline: true,
  defaultModel: 'llama3.1',

  availability(env): ProviderAvailability {
    // Usable is declared true without probing the host. Whether the daemon is
    // actually up is answered by the call, which returns a blank and a reason
    // if it is not - a reachability probe here would be a second source of
    // truth that can disagree with the call it is predicting.
    return {
      id: 'ollama',
      label: LABEL,
      requiresKey: false,
      keyEnvVar: null,
      keyPresent: true,
      worksOffline: true,
      usable: true,
      reason: null,
      defaultModel: 'llama3.1',
    };
  },

  async complete(request: ModelRequest, deps: AdapterDeps): Promise<ModelResponse> {
    const clock = clockOf(deps);
    const startedAt = clock();
    return neverThrow('ollama', request.model, request.temperature, startedAt, clock, deps.env, async () => {
      const host = ollamaHost(deps.env);

      const body = JSON.stringify({
        model: request.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        stream: false,
        options: {
          temperature: request.temperature,
          num_predict: request.maxOutputTokens,
        },
      });

      const res = await deps.post(
        host + '/api/chat',
        { 'content-type': 'application/json' },
        body,
        request.timeoutMs,
      );

      if (res.status < 200 || res.status >= 300) {
        const extra = res.status === 404
          ? ' The model may not be pulled on this machine.'
          : ' Check that the local daemon is running, or set ' +
            OLLAMA_HOST_ENV_VAR + ' to where it is.';
        return blank('ollama', request.model, request.temperature,
          statusReason(LABEL, res.status, res.body, deps.env) + extra,
          clock() - startedAt, deps.env);
      }

      const parsed = parseJson(res.body);
      if (!parsed.ok) {
        return blank('ollama', request.model, request.temperature, parsed.reason, clock() - startedAt, deps.env);
      }

      const text = asString(pick(parsed.value, ['message', 'content']));
      const stop = asString(pick(parsed.value, ['done_reason']));
      const model = asString(pick(parsed.value, ['model'])) ?? request.model;

      if (text === null || text.trim() === '') {
        return blank('ollama', model, request.temperature,
          LABEL + ' returned no text' + (stop === null ? '' : ' (done reason: ' + stop + ')') + '.',
          clock() - startedAt, deps.env);
      }
      return answered('ollama', model, request.temperature, text, stop, clock() - startedAt);
    });
  },
};
