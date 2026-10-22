/**
 * Entry point. Opens the database, binds the port, prints what it is serving.
 *
 *   node --experimental-strip-types graph-chat/server/main.ts
 *
 * It prints which providers are usable, by environment-variable NAME and a
 * present/absent flag. It never prints a key.
 *
 * It loads `graph-chat/server/.env` into the process environment at startup,
 * and only here - the library beneath this file still reads nothing but
 * `process.env`, so a test or an embedder is unaffected. A variable already
 * set in the shell always wins over the file, because overriding what someone
 * deliberately exported is the surprising behaviour. No value is ever printed
 * or logged; only the count of names loaded.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AnswerStore, DEFAULT_DB_FILENAME } from './store.js';
import { createServer, API_BASE, DEFAULT_PORT, PORT_ENV_VAR } from './http.js';
import { providerAvailability } from './adapters/index.js';
import { fetchPost } from './transport.js';
import { DEFAULT_SIMILARITY_THRESHOLD } from './similarity.js';

export const DB_PATH_ENV_VAR = 'GRAPH_CHAT_DB';

/** Key files this service will read, in order. See the note in `main()`. */
export const ENV_FILE_NAMES = ['.env', 'process.env'] as const;

/**
 * Minimal `.env` reader: `KEY=value` per line, `#` comments and blank lines
 * skipped, one optional surrounding pair of quotes stripped. Deliberately not
 * a dependency - this is a dozen lines and a package here would be a supply
 * chain for a file format.
 *
 * Returns the NAMES it set, never the values.
 */
export function loadDotEnv(path: string, env: Record<string, string | undefined>): string[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const set: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    if (env[name] !== undefined && env[name] !== '') continue; // the shell wins
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) ||
                              (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value === '') continue;
    env[name] = value;
    set.push(name);
  }
  return set;
}

export async function main(): Promise<void> {
  const env = process.env as Record<string, string | undefined>;

  /* Both names are accepted. `.env` is the convention; `process.env` is what
   * people reasonably reach for after reading the code, since that is the
   * object the keys end up in. Neither is more correct than the other to
   * someone setting this up, so the service takes either rather than failing
   * silently over a filename. */
  let loaded: string[] = [];
  let loadedFrom = '';
  for (const name of ENV_FILE_NAMES) {
    const found = loadDotEnv(fileURLToPath(new URL('./' + name, import.meta.url)), env);
    if (found.length > 0) {
      loaded = found;
      loadedFrom = name;
      break;
    }
  }
  if (loaded.length > 0) {
    // eslint-disable-next-line no-console
    console.log('loaded ' + String(loaded.length) + ' variable(s) from ' + loadedFrom +
      ': ' + loaded.join(', '));
  } else {
    // eslint-disable-next-line no-console
    console.log('no key file found (looked for ' + ENV_FILE_NAMES.join(' and ') +
      ' beside this script); using only what is already in the environment');
  }
  const dbPath = env[DB_PATH_ENV_VAR] ??
    fileURLToPath(new URL('./data/' + DEFAULT_DB_FILENAME, import.meta.url));

  const store = await AnswerStore.open(dbPath);
  const server = await createServer({ store, post: fetchPost, env }, undefined);

  // eslint-disable-next-line no-console
  console.log('graph-chat service listening on port ' + String(server.port) +
    ' at ' + API_BASE + ' (set ' + PORT_ENV_VAR + ' to move it from ' +
    String(DEFAULT_PORT) + ')');
  // eslint-disable-next-line no-console
  console.log('stored answers: ' + String(store.countAnswers()) +
    ', near-duplicate threshold ' + DEFAULT_SIMILARITY_THRESHOLD.toFixed(2));
  for (const p of providerAvailability(env)) {
    // eslint-disable-next-line no-console
    console.log('  ' + p.id.padEnd(7) + (p.usable ? 'usable  ' : 'disabled') +
      '  key env var: ' + (p.keyEnvVar ?? '(none needed)') +
      '  set: ' + (p.requiresKey ? String(p.keyPresent) : 'n/a'));
  }
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '\u0000');

if (invokedDirectly) {
  void main();
}
