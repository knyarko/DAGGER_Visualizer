/** OpenAI. Key by environment-variable NAME; no live call is made by this sprint. */

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

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const LABEL = 'OpenAI';

export const openaiAdapter: ModelAdapter = {
  id: 'openai',
  label: LABEL,
  requiresKey: true,
  keyEnvVar: keyEnvVarFor('openai'),
  worksOffline: false,
  defaultModel: 'gpt-4o-mini',

  availability(env): ProviderAvailability {
    const present = keyPresent('openai', env);
    const name = keyEnvVarFor('openai');
    return {
      id: 'openai',
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
      defaultModel: 'gpt-4o-mini',
    };
  },

  async complete(request: ModelRequest, deps: AdapterDeps): Promise<ModelResponse> {
    const clock = clockOf(deps);
    const startedAt = clock();
    return neverThrow('openai', request.model, request.temperature, startedAt, clock, deps.env, async () => {
      const key = readApiKey('openai', deps.env);
      if (key === null) {
        return blank('openai', request.model, request.temperature,
          'the environment variable ' + String(keyEnvVarFor('openai')) +
          ' is not set, so no call was attempted.', clock() - startedAt, deps.env);
      }

      const body = JSON.stringify({
        model: request.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        temperature: request.temperature,
        max_tokens: request.maxOutputTokens,
      });

      const res = await deps.post(
        ENDPOINT,
        { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body,
        request.timeoutMs,
      );

      if (res.status < 200 || res.status >= 300) {
        return blank('openai', request.model, request.temperature,
          statusReason(LABEL, res.status, res.body, deps.env), clock() - startedAt, deps.env);
      }

      const parsed = parseJson(res.body);
      if (!parsed.ok) {
        return blank('openai', request.model, request.temperature, parsed.reason, clock() - startedAt, deps.env);
      }

      const text = asString(pick(parsed.value, ['choices', 0, 'message', 'content']));
      const stop = asString(pick(parsed.value, ['choices', 0, 'finish_reason']));
      const model = asString(pick(parsed.value, ['model'])) ?? request.model;

      if (text === null || text.trim() === '') {
        return blank('openai', model, request.temperature,
          LABEL + ' returned no text' + (stop === null ? '' : ' (finish reason: ' + stop + ')') + '.',
          clock() - startedAt, deps.env);
      }
      return answered('openai', model, request.temperature, text, stop, clock() - startedAt);
    });
  },
};
