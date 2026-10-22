/** Claude. Key by environment-variable NAME; no live call is made by this sprint. */

import type {
  AdapterDeps,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  ProviderAvailability,
} from '../types.js';
import { keyEnvVarFor, keyPresent, readApiKey } from '../keys.js';
import {
  answered, asString, blank, clockOf, neverThrow, parseJson, pick, statusReason,
} from './base.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const LABEL = 'Claude';

export const claudeAdapter: ModelAdapter = {
  id: 'claude',
  label: LABEL,
  requiresKey: true,
  keyEnvVar: keyEnvVarFor('claude'),
  worksOffline: false,
  defaultModel: 'claude-sonnet-4-5',

  availability(env): ProviderAvailability {
    const present = keyPresent('claude', env);
    const name = keyEnvVarFor('claude');
    return {
      id: 'claude',
      label: LABEL,
      requiresKey: true,
      keyEnvVar: name,
      keyPresent: present,
      worksOffline: false,
      usable: present,
      reason: present
        ? null
        : 'the environment variable ' + String(name) + ' is not set, so this ' +
          'provider cannot be called. Set it in the environment the service ' +
          'runs in; it is never read from a file by this service.',
      defaultModel: 'claude-sonnet-4-5',
    };
  },

  async complete(request: ModelRequest, deps: AdapterDeps): Promise<ModelResponse> {
    const clock = clockOf(deps);
    const startedAt = clock();
    return neverThrow('claude', request.model, request.temperature, startedAt, clock, deps.env, async () => {
      const key = readApiKey('claude', deps.env);
      if (key === null) {
        return blank('claude', request.model, request.temperature,
          'the environment variable ' + String(keyEnvVarFor('claude')) +
          ' is not set, so no call was attempted.', clock() - startedAt, deps.env);
      }

      const body = JSON.stringify({
        model: request.model,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
      });

      const res = await deps.post(
        ENDPOINT,
        {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': API_VERSION,
        },
        body,
        request.timeoutMs,
      );

      if (res.status < 200 || res.status >= 300) {
        return blank('claude', request.model, request.temperature,
          statusReason(LABEL, res.status, res.body, deps.env), clock() - startedAt, deps.env);
      }

      const parsed = parseJson(res.body);
      if (!parsed.ok) {
        return blank('claude', request.model, request.temperature, parsed.reason, clock() - startedAt, deps.env);
      }

      const text = asString(pick(parsed.value, ['content', 0, 'text']));
      const stop = asString(pick(parsed.value, ['stop_reason']));
      const model = asString(pick(parsed.value, ['model'])) ?? request.model;

      if (text === null || text.trim() === '') {
        return blank('claude', model, request.temperature,
          LABEL + ' returned no text' + (stop === null ? '' : ' (stop reason: ' + stop + ')') + '.',
          clock() - startedAt, deps.env);
      }
      return answered('claude', model, request.temperature, text, stop, clock() - startedAt);
    });
  },
};
