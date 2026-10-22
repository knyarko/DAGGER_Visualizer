/** Gemini. Key by environment-variable NAME; no live call is made by this sprint. */

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

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';
const LABEL = 'Gemini';

export const geminiAdapter: ModelAdapter = {
  id: 'gemini',
  label: LABEL,
  requiresKey: true,
  keyEnvVar: keyEnvVarFor('gemini'),
  worksOffline: false,
  defaultModel: 'gemini-2.0-flash',

  availability(env): ProviderAvailability {
    const present = keyPresent('gemini', env);
    const name = keyEnvVarFor('gemini');
    return {
      id: 'gemini',
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
      defaultModel: 'gemini-2.0-flash',
    };
  },

  async complete(request: ModelRequest, deps: AdapterDeps): Promise<ModelResponse> {
    const clock = clockOf(deps);
    const startedAt = clock();
    return neverThrow('gemini', request.model, request.temperature, startedAt, clock, deps.env, async () => {
      const key = readApiKey('gemini', deps.env);
      if (key === null) {
        return blank('gemini', request.model, request.temperature,
          'the environment variable ' + String(keyEnvVarFor('gemini')) +
          ' is not set, so no call was attempted.', clock() - startedAt, deps.env);
      }

      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.user }] }],
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.maxOutputTokens,
        },
      });

      const res = await deps.post(
        ENDPOINT + encodeURIComponent(request.model) + ':generateContent',
        { 'content-type': 'application/json', 'x-goog-api-key': key },
        body,
        request.timeoutMs,
      );

      if (res.status < 200 || res.status >= 300) {
        return blank('gemini', request.model, request.temperature,
          statusReason(LABEL, res.status, res.body, deps.env), clock() - startedAt, deps.env);
      }

      const parsed = parseJson(res.body);
      if (!parsed.ok) {
        return blank('gemini', request.model, request.temperature, parsed.reason, clock() - startedAt, deps.env);
      }

      const text = asString(pick(parsed.value, ['candidates', 0, 'content', 'parts', 0, 'text']));
      const stop = asString(pick(parsed.value, ['candidates', 0, 'finishReason']));
      const model = asString(pick(parsed.value, ['modelVersion'])) ?? request.model;

      if (text === null || text.trim() === '') {
        return blank('gemini', model, request.temperature,
          LABEL + ' returned no text' + (stop === null ? '' : ' (stop reason: ' + stop + ')') + '.',
          clock() - startedAt, deps.env);
      }
      return answered('gemini', model, request.temperature, text, stop, clock() - startedAt);
    });
  },
};
