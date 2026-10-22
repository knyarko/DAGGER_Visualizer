/** The adapter registry. One interface, four implementations, one lookup. */

import type { ModelAdapter, ModelProviderId, ProviderAvailability } from '../types.js';
import { PROVIDER_IDS } from '../types.js';
import { geminiAdapter } from './gemini.js';
import { openaiAdapter } from './openai.js';
import { claudeAdapter } from './claude.js';
import { ollamaAdapter } from './ollama.js';

export const ADAPTERS: Readonly<Record<ModelProviderId, ModelAdapter>> = Object.freeze({
  gemini: geminiAdapter,
  openai: openaiAdapter,
  claude: claudeAdapter,
  ollama: ollamaAdapter,
});

export function adapterFor(provider: ModelProviderId): ModelAdapter {
  return ADAPTERS[provider];
}

export function isProviderId(value: unknown): value is ModelProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * What the dropdown is built from. Reports key presence by NAME; no value of
 * any key is read out of here.
 */
export function providerAvailability(
  env?: Record<string, string | undefined>,
): ProviderAvailability[] {
  return PROVIDER_IDS.map((id) => ADAPTERS[id].availability(env));
}

export { geminiAdapter, openaiAdapter, claudeAdapter, ollamaAdapter };
export * from './base.js';
