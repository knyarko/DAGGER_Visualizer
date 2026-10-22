/**
 * Provider keys, by environment-variable NAME only.
 *
 * There is exactly one function in this service that reads a key's value -
 * `readApiKey` - and exactly one place each value is used, inside the adapter
 * that needs it, as a request header. A key is never:
 *
 *   - written as a literal anywhere in this repo;
 *   - given a default or a fallback value;
 *   - logged, printed, or put on any returned object;
 *   - written to a file, a cache row or a stored answer.
 *
 * THIS MODULE reads no file of any kind - only `process.env`. If the process
 * has the variable, the adapter can call; if it does not, the adapter reports
 * that the variable is unset and the request returns a blank and a reason.
 *
 * Getting a `.env` INTO the process environment is the entry point's job and
 * happens only in `main.ts`, which loads `graph-chat/server/.env` at startup
 * and logs the names it set, never the values. A variable already exported in
 * the shell wins. Nothing beneath `main.ts` knows a file was involved, so a
 * test or an embedder is unaffected.
 *
 * `redact` is the belt-and-braces half. Every message that leaves the adapter
 * layer passes through it, so a provider that echoes the key back in an error
 * body cannot push it into a response, a note or a stored row.
 */

import type { ModelProviderId } from './types.js';

/**
 * The variable NAME per provider. The local provider needs no key and its
 * entry is null - not an empty string, which would read as "a key that is
 * blank" rather than "no key is involved".
 */
export const KEY_ENV_VARS: Readonly<Record<ModelProviderId, string | null>> =
  Object.freeze({
    gemini: 'GEMINI_API_KEY',
    openai: 'OPENAI_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
    ollama: null,
  });

/** Where the local provider is reachable. A host name, never a key. */
export const OLLAMA_HOST_ENV_VAR = 'OLLAMA_HOST';
export const OLLAMA_DEFAULT_HOST = 'http://127.0.0.1:11434';

export function keyEnvVarFor(provider: ModelProviderId): string | null {
  return KEY_ENV_VARS[provider];
}

function envOf(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  if (env) return env;
  // `process` is referenced in exactly this one expression in the whole
  // service, so the module stays testable with an injected environment.
  return (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env ?? {};
}

/**
 * Is the variable set to something non-empty? Answers a yes/no about the
 * NAME. Does not return, log or expose the value.
 */
export function keyPresent(
  provider: ModelProviderId,
  env?: Record<string, string | undefined>,
): boolean {
  const name = keyEnvVarFor(provider);
  if (name === null) return true; // nothing to be present
  const raw = envOf(env)[name];
  return typeof raw === 'string' && raw.trim() !== '';
}

/**
 * The ONE place a key value is read. Returns null when unset; never throws,
 * never defaults, never logs.
 */
export function readApiKey(
  provider: ModelProviderId,
  env?: Record<string, string | undefined>,
): string | null {
  const name = keyEnvVarFor(provider);
  if (name === null) return null;
  const raw = envOf(env)[name];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

export function ollamaHost(env?: Record<string, string | undefined>): string {
  const raw = envOf(env)[OLLAMA_HOST_ENV_VAR];
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim().replace(/\/+$/, '');
  return OLLAMA_DEFAULT_HOST;
}

/**
 * Remove any configured key value from a string before it leaves the service.
 *
 * Every provider error message goes through this. It is not a substitute for
 * not logging keys - it is the second line, for the case where the provider
 * puts the key in its own error body.
 *
 * Short values are left alone: a one or two character "key" is noise, and
 * blanking it would redact unrelated text.
 */
export function redact(
  text: string,
  env?: Record<string, string | undefined>,
): string {
  let out = text;
  for (const provider of Object.keys(KEY_ENV_VARS) as ModelProviderId[]) {
    const value = readApiKey(provider, env);
    if (value === null || value.length < 8) continue;
    while (out.includes(value)) out = out.replace(value, '[redacted]');
  }
  return out;
}
