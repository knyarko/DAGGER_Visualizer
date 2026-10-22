/**
 * Persistence.
 *
 * WHY node:sqlite
 *
 * The requirement is three things at once: survive a restart, be readable by a
 * SECOND viewer, and not be a per-browser store. That rules out
 * `localStorage`, `sessionStorage` and IndexedDB, all of which are one
 * browser profile's and none of which another person can read. It wants a
 * file on a server.
 *
 * The root `package.json` declares `better-sqlite3` and `@types/better-sqlite3`
 * - but root `node_modules/` does not exist in this checkout, so that
 * dependency is declared and not installed, and it is a native module that has
 * to be compiled per platform and per node version when it is. `node:sqlite`
 * is in the node that runs this repo today, needs no install, no compiler and
 * no lockfile change, and gives the same single-file database with WAL.
 *
 * So: `node:sqlite`, and it is imported in EXACTLY ONE place - the `openDb`
 * function below. Swapping to `better-sqlite3` later is a change to that one
 * function, because the rest of this file talks to the two methods both
 * libraries share (`prepare` and `exec`).
 *
 * A Postgres would also satisfy the requirement and would be the right answer
 * for several writers on several machines. It is not the right answer for a
 * feature reached from a desktop Visualizer, because it makes a server
 * somebody has to run a precondition of asking a question.
 *
 * WHERE THE FILE GOES, AND WHY IT IS NOT COMMITTED
 *
 * The repo's root ignore file covers `*.db-shm`, `*.db-wal`, `*_backup_*.db`
 * and `backup_*.db`, under a comment saying the main database is kept on
 * purpose. That rule belongs to another database. This one holds people's
 * questions and the model's answers and must not be committed, so the data
 * directory carries its own ignore file. No root file is edited to achieve it.
 */

import type {
  GroupingResult,
  HistoryEntry,
  ModelProviderId,
  StoredAnswer,
} from './types.js';
import type { GroupingKeyUsed } from './old_preprompt.js';
import type {
  EngineStamp,
  EvidenceBundle,
  QueryDescriptor,
  QueryKind,
  ShapeReport,
} from '../engine/types.js';

export const SCHEMA_VERSION = 1;

/** The default location, relative to this service's own folder. */
export const DEFAULT_DB_FILENAME = 'graph-chat.db';

/**
 * The two methods this file needs. Both `node:sqlite` and `better-sqlite3`
 * satisfy it, which is what makes the swap a one-function change.
 */
export interface SqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqlDatabase {
  prepare(sql: string): SqlStatement;
  exec(sql: string): unknown;
  close?(): void;
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS answers (
  answer_id           TEXT PRIMARY KEY,
  graph_key           TEXT NOT NULL,
  graph_label         TEXT,
  question            TEXT NOT NULL,
  question_content    TEXT NOT NULL,
  question_normalised TEXT NOT NULL,
  kind                TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model               TEXT NOT NULL,
  ok                  INTEGER NOT NULL,
  answer              TEXT NOT NULL,
  reason              TEXT,
  evidence_json       TEXT NOT NULL,
  query_json          TEXT NOT NULL,
  engine_json         TEXT NOT NULL,
  shape_json          TEXT NOT NULL,
  grouping_json       TEXT NOT NULL,
  grouping_key_used   TEXT NOT NULL,
  grouping_sentence   TEXT NOT NULL,
  preprompt_version   TEXT NOT NULL,
  total               INTEGER NOT NULL,
  asked_at            TEXT NOT NULL,
  hit_count           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_answers_graph_time
  ON answers (graph_key, asked_at DESC);

CREATE TABLE IF NOT EXISTS cache_hits (
  hit_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  answer_id      TEXT NOT NULL,
  asked_question TEXT NOT NULL,
  similarity     REAL NOT NULL,
  hit_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_hits_answer ON cache_hits (answer_id);
`;

/**
 * The migration path.
 *
 * Step `n` moves a database at version `n - 1` to version `n`. A fresh file
 * runs every step in order. Steps are append-only: an existing step is never
 * edited, because a database somewhere has already run it. Adding a column
 * later means adding step 2 with its `ALTER TABLE`, not changing SCHEMA_V1.
 */
const MIGRATIONS: ReadonlyArray<{ to: number; sql: string }> = Object.freeze([
  { to: 1, sql: SCHEMA_V1 },
]);

function currentVersion(db: SqlDatabase): number {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value?: string }
      | undefined
      | null;
    if (!row || typeof row.value !== 'string') return 0;
    const n = Number.parseInt(row.value, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    // No schema_meta table yet: this is a fresh file.
    return 0;
  }
}

export function migrate(db: SqlDatabase): { from: number; to: number; applied: number[] } {
  const from = currentVersion(db);
  const applied: number[] = [];
  for (const step of MIGRATIONS) {
    if (step.to <= from) continue;
    db.exec(step.sql);
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(String(step.to));
    applied.push(step.to);
  }
  return { from, to: SCHEMA_VERSION, applied };
}

/**
 * The ONE place a database driver is named. `path` of `':memory:'` gives a
 * throwaway database, which is what the tests use.
 */
export async function openDb(path: string): Promise<SqlDatabase> {
  const sqlite = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (p: string) => SqlDatabase;
  };
  const db = new sqlite.DatabaseSync(path);
  if (path !== ':memory:') {
    try {
      db.exec('PRAGMA journal_mode = WAL');
    } catch {
      // A filesystem that will not do WAL still serves a single writer.
    }
  }
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

export interface NewAnswer {
  answerId: string;
  graphKey: string;
  graphLabel: string | null;
  question: string;
  questionContent: string;
  questionNormalised: string;
  kind: QueryKind;
  provider: ModelProviderId;
  model: string;
  ok: boolean;
  answer: string;
  reason: string | null;
  evidence: EvidenceBundle;
  query: QueryDescriptor;
  engine: EngineStamp;
  shape: ShapeReport;
  grouping: GroupingResult;
  groupingSentence: string;
  prepromptVersion: string;
  total: number;
  askedAt: string;
}

/** A row as the cache's candidate scan needs it: no JSON blobs decoded. */
export interface CandidateRow {
  answerId: string;
  question: string;
  questionContent: string;
  questionNormalised: string;
  askedAt: string;
}

export class AnswerStore {
  private constructor(private readonly db: SqlDatabase) {}

  static async open(path: string): Promise<AnswerStore> {
    const db = await openDb(path);
    migrate(db);
    return new AnswerStore(db);
  }

  /** For tests and for a caller that already has a database open. */
  static fromDb(db: SqlDatabase): AnswerStore {
    migrate(db);
    return new AnswerStore(db);
  }

  schemaVersion(): number {
    return currentVersion(this.db);
  }

  insert(a: NewAnswer): void {
    this.db
      .prepare(
        'INSERT INTO answers (answer_id, graph_key, graph_label, question, ' +
        'question_content, question_normalised, kind, provider, model, ok, ' +
        'answer, reason, evidence_json, query_json, engine_json, shape_json, ' +
        'grouping_json, grouping_key_used, grouping_sentence, ' +
        'preprompt_version, total, asked_at, hit_count) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)',
      )
      .run(
        a.answerId, a.graphKey, a.graphLabel, a.question,
        a.questionContent, a.questionNormalised, a.kind, a.provider, a.model,
        a.ok ? 1 : 0, a.answer, a.reason,
        JSON.stringify(a.evidence), JSON.stringify(a.query),
        JSON.stringify(a.engine), JSON.stringify(a.shape),
        JSON.stringify(a.grouping), a.grouping.keyUsed, a.groupingSentence,
        a.prepromptVersion, a.total, a.askedAt,
      );
  }

  /**
   * Candidates for the near-duplicate scan, scoped to ONE graph. The scope is
   * not an optimisation: the same question asked of a different file is a
   * different question and must never match here.
   *
   * Only successful answers are offered. A stored failure is kept for the
   * history but is never served as a cache hit - handing back a blank because
   * a provider was down once is worse than calling again.
   */
  candidates(graphKey: string, limit = 500): CandidateRow[] {
    const rows = this.db
      .prepare(
        'SELECT answer_id, question, question_content, question_normalised, asked_at ' +
        'FROM answers WHERE graph_key = ? AND ok = 1 ORDER BY asked_at DESC LIMIT ?',
      )
      .all(graphKey, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      answerId: String(r['answer_id']),
      question: String(r['question']),
      questionContent: String(r['question_content']),
      questionNormalised: String(r['question_normalised']),
      askedAt: String(r['asked_at']),
    }));
  }

  get(answerId: string): StoredAnswer | null {
    const row = this.db
      .prepare('SELECT * FROM answers WHERE answer_id = ?')
      .get(answerId) as Record<string, unknown> | undefined | null;
    if (!row) return null;
    return rowToStored(row);
  }

  history(graphKey: string, limit = 50): HistoryEntry[] {
    const rows = this.db
      .prepare(
        'SELECT answer_id, graph_key, graph_label, question, kind, provider, ' +
        'model, ok, asked_at, hit_count, grouping_key_used FROM answers ' +
        'WHERE graph_key = ? ORDER BY asked_at DESC LIMIT ?',
      )
      .all(graphKey, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      answerId: String(r['answer_id']),
      graphKey: String(r['graph_key']),
      graphLabel: r['graph_label'] === null || r['graph_label'] === undefined
        ? null
        : String(r['graph_label']),
      question: String(r['question']),
      kind: String(r['kind']) as QueryKind,
      provider: String(r['provider']) as ModelProviderId,
      model: String(r['model']),
      ok: Number(r['ok']) === 1,
      askedAt: String(r['asked_at']),
      hitCount: Number(r['hit_count']),
      groupingKeyUsed: String(r['grouping_key_used']) as GroupingKeyUsed,
    }));
  }

  recordHit(answerId: string, askedQuestion: string, score: number, at: string): void {
    this.db
      .prepare(
        'INSERT INTO cache_hits (answer_id, asked_question, similarity, hit_at) VALUES (?,?,?,?)',
      )
      .run(answerId, askedQuestion, score, at);
    this.db
      .prepare('UPDATE answers SET hit_count = hit_count + 1 WHERE answer_id = ?')
      .run(answerId);
  }

  countAnswers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM answers').get() as { c?: number };
    return Number(row?.c ?? 0);
  }

  close(): void {
    if (typeof this.db.close === 'function') this.db.close();
  }
}

function parse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToStored(r: Record<string, unknown>): StoredAnswer {
  const grouping = parse<GroupingResult>(r['grouping_json'], {
    keyUsed: 'none',
    groups: [],
    groupsBefore: 0,
    groupsAfter: 0,
    tripletCount: 0,
    ungroupableTripletCount: 0,
    note: '',
  });
  return {
    answerId: String(r['answer_id']),
    graphKey: String(r['graph_key']),
    graphLabel: r['graph_label'] === null || r['graph_label'] === undefined
      ? null
      : String(r['graph_label']),
    question: String(r['question']),
    kind: String(r['kind']) as QueryKind,
    provider: String(r['provider']) as ModelProviderId,
    model: String(r['model']),
    ok: Number(r['ok']) === 1,
    askedAt: String(r['asked_at']),
    hitCount: Number(r['hit_count']),
    groupingKeyUsed: String(r['grouping_key_used']) as GroupingKeyUsed,
    answer: String(r['answer']),
    reason: r['reason'] === null || r['reason'] === undefined ? null : String(r['reason']),
    evidence: parse(r['evidence_json'], null as unknown as EvidenceBundle),
    query: parse(r['query_json'], null as unknown as QueryDescriptor),
    engine: parse(r['engine_json'], null as unknown as EngineStamp),
    shape: parse(r['shape_json'], null as unknown as ShapeReport),
    total: Number(r['total']),
    grouping,
    prepromptVersion: String(r['preprompt_version']),
    groupingSentence: String(r['grouping_sentence']),
  };
}
