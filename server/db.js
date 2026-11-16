import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Monotonic formal revision. Every formal mutation bumps it.
CREATE TABLE IF NOT EXISTS revision_counter (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS season (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  rule_version_id      TEXT NOT NULL,
  qual_spots           INTEGER NOT NULL,
  wildcard_slots       INTEGER NOT NULL DEFAULT 0,
  sections_json        TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ruleset_version (
  id              TEXT PRIMARY KEY,
  season_id       TEXT NOT NULL,
  label           TEXT NOT NULL,
  valid_from      TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  supersedes_id   TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  section   TEXT NOT NULL,
  seed_lots INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS match (
  id          TEXT PRIMARY KEY,
  stage       TEXT NOT NULL,
  section     TEXT NOT NULL,
  home        TEXT NOT NULL,
  away        TEXT NOT NULL,
  home_goals  INTEGER NOT NULL,
  away_goals  INTEGER NOT NULL,
  played_at   TEXT NOT NULL,
  status      TEXT NOT NULL,
  cards_json  TEXT NOT NULL,
  revision    INTEGER NOT NULL
);

-- Append-only correction chain per match (the "latest effective" wins for an
-- as-of timestamp; nothing is destructively overwritten).
CREATE TABLE IF NOT EXISTS match_revision (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id       TEXT NOT NULL,
  revision_no    INTEGER NOT NULL,
  home_goals     INTEGER NOT NULL,
  away_goals     INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  source         TEXT NOT NULL,
  recorded_at    TEXT NOT NULL,
  effective_at   TEXT NOT NULL,
  superseded     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (match_id, revision_no)
);

CREATE TABLE IF NOT EXISTS penalty (
  id           TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL,
  section      TEXT NOT NULL,
  match_id     TEXT,
  kind         TEXT NOT NULL,
  points       INTEGER NOT NULL,
  reason       TEXT NOT NULL,
  recorded_at  TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  status       TEXT NOT NULL,
  revision     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS penalty_revision (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  penalty_id    TEXT NOT NULL,
  revision_no   INTEGER NOT NULL,
  action        TEXT NOT NULL,
  points        INTEGER NOT NULL,
  status        TEXT NOT NULL,
  reason        TEXT NOT NULL,
  source        TEXT NOT NULL,
  recorded_at   TEXT NOT NULL,
  effective_at  TEXT NOT NULL,
  UNIQUE (penalty_id, revision_no)
);

CREATE TABLE IF NOT EXISTS appeal (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL,
  penalty_id        TEXT,
  match_id          TEXT,
  title             TEXT NOT NULL,
  filed_at          TEXT NOT NULL,
  status            TEXT NOT NULL,
  requested_outcome TEXT NOT NULL,
  note              TEXT NOT NULL DEFAULT '',
  hearing_at        TEXT,
  decided_at        TEXT,
  decision_note     TEXT,
  revision          INTEGER NOT NULL,
  draft_json        TEXT
);

CREATE TABLE IF NOT EXISTS draft (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ranking_snapshot (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id      TEXT NOT NULL,
  section        TEXT NOT NULL,
  kind           TEXT NOT NULL,           -- as_known | final
  rule_version   TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  as_of          TEXT NOT NULL,
  computed_at    TEXT NOT NULL,
  input_hash     TEXT NOT NULL,
  rows_json      TEXT NOT NULL,
  trace_json     TEXT NOT NULL,
  pending_json   TEXT NOT NULL,
  derived_only   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_snapshot_lookup
  ON ranking_snapshot (season_id, section, kind, rule_version);

CREATE TABLE IF NOT EXISTS confirmation (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id     TEXT NOT NULL,
  section       TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  rule_version  TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  confirmed_by  TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scenario_run (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  rule_version  TEXT NOT NULL,
  scenario_json TEXT NOT NULL,
  result_json   TEXT NOT NULL,
  input_hash    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'complete'
);

CREATE TABLE IF NOT EXISTS import_batch (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  cursor      INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency (
  request_id TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  revision   INTEGER NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function getRevision(db) {
  const row = db.prepare('SELECT revision FROM revision_counter WHERE id = 1').get();
  return row ? Number(row.revision) : 0;
}

export function bumpRevision(db, expected) {
  const current = getRevision(db);
  if (expected !== undefined && expected !== null && Number(expected) !== current) {
    const err = new Error(`stale revision: expected ${expected}, current ${current}`);
    err.code = 'STALE_REVISION';
    err.currentRevision = current;
    throw err;
  }
  const next = current + 1;
  db.prepare('INSERT INTO revision_counter (id, revision) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision').run(next);
  return next;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export function readOnlyTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function audit(db, revision, action, target, actor, detail = {}) {
  db.prepare('INSERT INTO audit_log (revision, action, target, actor, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(revision, action, target, actor || 'desk', JSON.stringify(detail), nowIso());
}
