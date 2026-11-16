/**
 * HTTP layer for the fictional tournament desk.
 *
 * Concurrency contract
 * --------------------
 * - Every formal mutation runs inside `BEGIN IMMEDIATE` and compares the
 *   client's `baseRevision` (or `If-Match`) against the committed revision.
 *   Mismatch -> 409 `stale_revision` with the current revision, so a stale tab
 *   can never overwrite a newer ruling.
 * - Every formal mutation optionally carries `requestId`; replays return the
 *   original response (idempotency) instead of double-applying.
 * - Scenario runs are read-only against formal tables (see scenarios.js).
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  getRevision, bumpRevision, transaction, nowIso, audit, setMeta, getMeta,
} from './db.js';
import { loadState } from './state.js';
import { computeStandings, explainTeam, diffStandings } from './standings.js';
import { loadRuleVersion, loadRuleVersions, validateDefinition, deriveRuleVariant, hashJson } from './rules.js';
import {
  recompute, latestSnapshots, affectedSectionsForMatch, affectedSectionsForPenalty, affectedSectionsForAppeal,
} from './recompute.js';
import {
  loadAppeals, loadAppeal, applyAppealDecision, appealChain, appealTimeline,
} from './appeals.js';
import { runScenario, listScenarios, getScenario, compareScenarios, ruleVariantsFor } from './scenarios.js';
import {
  recordMatch, correctMatch, insertPenalty, insertAppeal, updateAppealDraft, confirmStandings,
  confirmations, isConfirmationStale, loadMatches, matchTimeline, validateMatchResult,
} from './writes.js';
import { loadSeason, loadTeams } from './state.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PUBLIC = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new HttpError(413, 'payload_too_large', 'request body exceeds 2 MiB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'bad_json', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function requestedRevision(req, body) {
  const header = req.headers['if-match'] || req.headers['x-base-revision'];
  if (header !== undefined && header !== null && String(header).trim() !== '') {
    const cleaned = String(header).trim().replace(/^W\//, '').replace(/"/g, '');
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (body && body.baseRevision !== undefined && body.baseRevision !== null) return Number(body.baseRevision);
  return undefined;
}

function summarizeRows(standings) {
  return standings.sections.flatMap((s) => s.rows.map((r) => ({
    section: s.section, teamId: r.teamId, name: r.name, rank: r.rank, points: r.points,
    goalDiff: r.goalDiff, qualification: r.qualification, tied: r.tied, decidedBy: r.decidedBy,
  })));
}

function serializeStandings(standings, revision) {
  return {
    revision,
    seasonId: standings.seasonId,
    ruleVersionId: standings.ruleVersionId,
    ruleLabel: standings.ruleLabel,
    ruleHash: standings.ruleHash,
    asOf: standings.asOf,
    sections: standings.sections,
    wildcard: standings.wildcard,
    pending: standings.pending,
    table: summarizeRows(standings),
  };
}

export function createApp({ db, defaultSeason = 'S-2627', logger = () => {} }) {
  function currentRevision() {
    return getRevision(db);
  }

  function applyFormalMutation(req, res, body, mutation) {
    const expected = requestedRevision(req, body);
    const requestId = body.requestId || req.headers['x-request-id'];
    if (requestId) {
      const prior = db.prepare('SELECT result_json, scope FROM idempotency WHERE request_id = ?').get(String(requestId));
      if (prior) {
        return sendJson(res, 200, { ...JSON.parse(prior.result_json), replayed: true });
      }
    }
    if (expected === undefined) {
      throw new HttpError(428, 'revision_required', 'a baseRevision (If-Match or body.baseRevision) is required for formal writes');
    }
    const result = transaction(db, () => {
      const revision = bumpRevision(db, expected);
      const outcome = mutation(revision);
      const affected = outcome.affectedSections || [];
      const recomputed = recompute({
        db,
        seasonId: outcome.seasonId || defaultSeason,
        sections: affected.length > 0 ? affected : null,
        revision,
      });
      const payload = {
        ok: true,
        revision,
        previousRevision: expected,
        ...outcome,
        standings: serializeStandings(recomputed.results.final.standings, revision),
        snapshots: {
          asKnown: Object.keys(recomputed.results.as_known.sections),
          final: Object.keys(recomputed.results.final.sections),
        },
      };
      if (requestId) {
        db.prepare('INSERT INTO idempotency (request_id, scope, result_json, created_at) VALUES (?, ?, ?, ?)')
          .run(String(requestId), outcome.action || 'formal', JSON.stringify(payload), nowIso());
      }
      return payload;
    });
    return sendJson(res, 200, result);
  }

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    })}$`);
    routes.push({ method, regex, keys, handler });
  };

  // ---- meta -------------------------------------------------------------
  route('GET', '/api/health', async () => ({
    ok: true,
    revision: currentRevision(),
    seeded: Boolean(getMeta(db, 'seed_hash')),
    time: nowIso(),
  }));

  route('GET', '/api/season', async () => {
    const season = loadSeason(db, defaultSeason);
    return {
      season,
      teams: loadTeams(db),
      ruleVersions: loadRuleVersions(db, defaultSeason).map((r) => ({
        id: r.id, label: r.label, validFrom: r.validFrom, hash: r.contentHash, active: r.id === season.ruleVersionId,
        supersedesId: r.supersedesId,
      })),
      revision: currentRevision(),
    };
  });

  // ---- rules ------------------------------------------------------------
  route('GET', '/api/rules', async () => ({
    active: loadRuleVersion(db, loadSeason(db, defaultSeason).ruleVersionId),
    versions: loadRuleVersions(db, defaultSeason),
    revision: currentRevision(),
  }));

  route('GET', '/api/rules/:id', async (ctx) => {
    const rule = loadRuleVersion(db, ctx.params.id);
    if (!rule) throw new HttpError(404, 'not_found', `rule version not found: ${ctx.params.id}`);
    return { rule, validation: validateDefinition(rule.definition) };
  });

  route('GET', '/api/rules/:id/variants', async () => ({ variants: ruleVariantsFor(db, defaultSeason) }));

  route('POST', '/api/rules/:id/activate', async (ctx) => {
    const season = loadSeason(db, defaultSeason);
    const rule = loadRuleVersion(db, ctx.params.id);
    if (!rule) throw new HttpError(404, 'not_found', 'rule version not found');
    if (rule.seasonId !== season.id) throw new HttpError(400, 'bad_input', 'rule version belongs to another season');
    const check = validateDefinition(rule.definition, { crossGroupRequired: (season.wildcardSlots || 0) > 0 });
    if (!check.ok) throw new HttpError(422, 'invalid_rules', 'ruleset failed validation', { errors: check.errors });
    return applyFormalMutation(ctx.req, ctx.res, ctx.body, (revision) => {
      db.prepare('UPDATE season SET rule_version_id = ? WHERE id = ?').run(rule.id, season.id);
      audit(db, revision, 'rule_activate', rule.id, 'desk', { previous: season.ruleVersionId });
      return {
        action: 'rule_activate',
        seasonId: season.id,
        ruleVersionId: rule.id,
        previousRuleVersionId: season.ruleVersionId,
        affectedSections: season.sections.map((s) => s.id),
      };
    });
  });

  // ---- standings + evidence ---------------------------------------------
  route('GET', '/api/standings', async (ctx) => {
    const view = ctx.query.get('view') === 'known' ? 'known' : 'final';
    const ruleVersionId = ctx.query.get('ruleVersionId') || null;
    const revision = currentRevision();
    let state;
    try {
      state = loadState(db, { seasonId: defaultSeason, ruleVersionId, historical: view === 'known' });
    } catch (err) {
      throw new HttpError(404, 'not_found', err.message);
    }
    const standings = computeStandings(state);
    return serializeStandings(standings, revision);
  });

  route('GET', '/api/standings/:teamId/basis', async (ctx) => {
    const view = ctx.query.get('view') === 'known' ? 'known' : 'final';
    const ruleVersionId = ctx.query.get('ruleVersionId') || null;
    let state;
    try {
      state = loadState(db, { seasonId: defaultSeason, ruleVersionId, historical: view === 'known' });
    } catch (err) {
      throw new HttpError(404, 'not_found', err.message);
    }
    const standings = computeStandings(state);
    const explanation = explainTeam(state, standings, ctx.params.teamId);
    if (!explanation) throw new HttpError(404, 'not_found', `team not found: ${ctx.params.teamId}`);
    return {
      ...explanation,
      view,
      rule: { id: state.rule.id, label: state.rule.label, hash: state.rule.contentHash },
      revision: currentRevision(),
    };
  });

  route('GET', '/api/trace', async (ctx) => {
    const section = ctx.query.get('section');
    const state = loadState(db, { seasonId: defaultSeason });
    const standings = computeStandings(state);
    const sections = section ? standings.sections.filter((s) => s.section === section) : standings.sections;
    if (section && sections.length === 0) throw new HttpError(404, 'not_found', `section not found: ${section}`);
    return {
      revision: currentRevision(),
      ruleVersionId: standings.ruleVersionId,
      sections: sections.map((s) => s.trace),
      wildcard: standings.wildcard.trace,
      pending: standings.pending,
    };
  });

  route('POST', '/api/standings/recompute', async (ctx) => {
    const body = ctx.body || {};
    const expected = requestedRevision(ctx.req, body);
    if (expected !== undefined && expected !== currentRevision()) {
      throw new HttpError(409, 'stale_revision', 'baseRevision does not match the committed revision', { currentRevision: currentRevision() });
    }
    const revision = currentRevision();
    const result = recompute({
      db,
      seasonId: defaultSeason,
      sections: body.sections || null,
      ruleVersionId: body.ruleVersionId || null,
      revision,
    });
    const finalState = loadState(db, { seasonId: defaultSeason });
    return {
      ok: true,
      revision,
      computedAt: result.computedAt,
      sections: result.targetSections,
      asKnown: serializeStandings(result.results.as_known.standings, revision),
      final: serializeStandings(result.results.final.standings, revision),
      changes: diffStandings(result.results.as_known.standings, result.results.final.standings),
      appliedCorrections: finalState.appliedCorrections,
    };
  });

  route('GET', '/api/snapshots', async () => ({
    revision: currentRevision(),
    snapshots: latestSnapshots(db, defaultSeason).map((row) => ({
      id: Number(row.id),
      section: row.section,
      kind: row.kind,
      ruleVersionId: row.rule_version,
      revision: Number(row.revision),
      asOf: row.as_of,
      computedAt: row.computed_at,
      inputHash: row.input_hash,
      rows: JSON.parse(row.rows_json),
      pending: JSON.parse(row.pending_json),
    })),
  }));

  // ---- matches ----------------------------------------------------------
  route('GET', '/api/matches', async () => ({
    revision: currentRevision(),
    matches: loadMatches(db),
  }));

  route('GET', '/api/matches/:id/timeline', async (ctx) => {
    const timeline = matchTimeline(db, ctx.params.id);
    if (!timeline) throw new HttpError(404, 'not_found', `match not found: ${ctx.params.id}`);
    return { ...timeline, revision: currentRevision() };
  });

  route('POST', '/api/matches', async (ctx) => {
    const body = ctx.body || {};
    const teams = loadTeams(db);
    const errors = validateMatchResult(body, { teams });
    if (errors.length > 0) throw new HttpError(422, 'invalid_match', 'match payload invalid', { errors });
    const team = teams.find((t) => t.id === body.home);
    if (!team) throw new HttpError(422, 'invalid_match', 'unknown home team');
    if (body.section !== team.section) throw new HttpError(422, 'invalid_match', 'section does not match the home team section');
    return applyFormalMutation(ctx.req, ctx.res, body, (revision) => {
      const created = recordMatch(db, { ...body, section: team.section }, { revision });
      return {
        action: 'match_record',
        match: created,
        affectedSections: [created.section],
      };
    });
  });

  route('POST', '/api/matches/:id/corrections', async (ctx) => {
    const body = ctx.body || {};
    const existing = db.prepare('SELECT * FROM match WHERE id = ?').get(ctx.params.id);
    if (!existing) throw new HttpError(404, 'not_found', `match not found: ${ctx.params.id}`);
    const errors = validateMatchResult(
      { homeGoals: body.homeGoals ?? existing.home_goals, awayGoals: body.awayGoals ?? existing.away_goals },
      {},
    );
    if (errors.length > 0) throw new HttpError(422, 'invalid_match', 'correction payload invalid', { errors });
    return applyFormalMutation(ctx.req, ctx.res, body, (revision) => {
      const correction = correctMatch(db, ctx.params.id, body, { revision });
      return {
        action: 'match_correct',
        correction,
        affectedSections: [correction.section],
      };
    });
  });

  // ---- penalties --------------------------------------------------------
  route('GET', '/api/penalties', async () => ({
    revision: currentRevision(),
    penalties: db.prepare('SELECT * FROM penalty ORDER BY id').all().map((row) => ({
      id: row.id,
      teamId: row.team_id,
      section: row.section,
      matchId: row.match_id,
      kind: row.kind,
      points: Number(row.points),
      reason: row.reason,
      recordedAt: row.recorded_at,
      effectiveAt: row.effective_at,
      status: row.status,
      revisions: db.prepare('SELECT * FROM penalty_revision WHERE penalty_id = ? ORDER BY revision_no').all(row.id).map((rev) => ({
        revisionNo: Number(rev.revision_no),
        action: rev.action,
        points: Number(rev.points),
        status: rev.status,
        reason: rev.reason,
        source: rev.source,
        recordedAt: rev.recorded_at,
        effectiveAt: rev.effective_at,
        retroactive: rev.effective_at < rev.recorded_at,
      })),
    })),
  }));

  route('POST', '/api/penalties', async (ctx) => {
    const body = ctx.body || {};
    if (!body.teamId) throw new HttpError(422, 'invalid_penalty', 'teamId is required');
    return applyFormalMutation(ctx.req, ctx.res, body, (revision) => {
      const created = insertPenalty(db, body, { revision });
      return {
        action: 'penalty_impose',
        penalty: created,
        affectedSections: [created.section],
      };
    });
  });

  // ---- appeals ----------------------------------------------------------
  route('GET', '/api/appeals', async () => ({
    revision: currentRevision(),
    appeals: appealTimeline(db).map((entry) => ({
      appeal: entry.appeal,
      target: entry.target,
      chain: entry.chain,
      open: entry.open,
    })),
  }));

  route('GET', '/api/appeals/:id', async (ctx) => {
    const appeal = loadAppeal(db, ctx.params.id);
    if (!appeal) throw new HttpError(404, 'not_found', `appeal not found: ${ctx.params.id}`);
    return { appeal, chain: appealChain(db, appeal), revision: currentRevision() };
  });

  route('POST', '/api/appeals', async (ctx) => {
    const body = ctx.body || {};
    if (!body.title || String(body.title).trim().length < 2) throw new HttpError(422, 'invalid_appeal', 'title is required');
    if (!body.teamId) throw new HttpError(422, 'invalid_appeal', 'teamId is required');
    if (!body.matchId && !body.penaltyId) throw new HttpError(422, 'invalid_appeal', 'appeal must target a match or a penalty');
    if (body.matchId && body.penaltyId) throw new HttpError(422, 'invalid_appeal', 'appeal must target either a match or a penalty');
    return applyFormalMutation(ctx.req, ctx.res, body, (revision) => {
      const created = insertAppeal(db, body, { revision });
      return {
        action: 'appeal_file',
        appeal: loadAppeal(db, created.id),
        affectedSections: [created.section],
      };
    });
  });

  route('PUT', '/api/appeals/:id/draft', async (ctx) => {
    const body = ctx.body || {};
    const result = updateAppealDraft(db, ctx.params.id, body.draft ?? body, { actor: body.actor || 'desk' });
    return { ok: true, revision: currentRevision(), draft: result };
  });

  route('POST', '/api/appeals/:id/decision', async (ctx) => {
    const body = ctx.body || {};
    const appeal = loadAppeal(db, ctx.params.id);
    if (!appeal) throw new HttpError(404, 'not_found', `appeal not found: ${ctx.params.id}`);
    if (['upheld', 'dismissed', 'partially_upheld'].includes(appeal.status)) {
      throw new HttpError(409, 'appeal_decided', `appeal ${appeal.id} already decided (${appeal.status})`);
    }
    const status = body.status || 'upheld';
    if (!['upheld', 'dismissed', 'partially_upheld'].includes(status)) {
      throw new HttpError(422, 'invalid_decision', 'status must be upheld, dismissed or partially_upheld');
    }
    if (appeal.matchId && status !== 'dismissed') {
      if (!Number.isInteger(Number(body.homeGoals)) || !Number.isInteger(Number(body.awayGoals)) || Number(body.homeGoals) < 0 || Number(body.awayGoals) < 0) {
        throw new HttpError(422, 'invalid_decision', 'homeGoals and awayGoals are required for a match appeal decision');
      }
    }
    return applyFormalMutation(ctx.req, ctx.res, body, (revision) => {
      const outcome = applyAppealDecision(db, appeal, { ...body, status, revision }, body.actor || 'desk');
      const sections = affectedSectionsForAppeal(db, appeal.id);
      audit(db, revision, 'appeal_decision', appeal.id, body.actor || 'desk', {
        status, effectiveAt: outcome.effectiveAt, appended: outcome.appended,
      });
      return {
        action: 'appeal_decision',
        appealId: appeal.id,
        status,
        effectiveAt: outcome.effectiveAt,
        recordedAt: outcome.recordedAt,
        appended: outcome.appended,
        retroactive: outcome.effectiveAt < outcome.recordedAt,
        affectedSections: sections,
      };
    });
  });

  // ---- confirmations ----------------------------------------------------
  route('GET', '/api/confirmations', async () => {
    const revision = currentRevision();
    return {
      revision,
      confirmations: confirmations(db, defaultSeason).map((c) => ({ ...c, stale: isConfirmationStale(c, revision) })),
    };
  });

  route('POST', '/api/confirmations', async (ctx) => {
    const body = ctx.body || {};
    const expected = requestedRevision(ctx.req, body);
    const requestId = body.requestId || ctx.req.headers['x-request-id'];
    if (requestId) {
      const prior = db.prepare('SELECT result_json FROM idempotency WHERE request_id = ?').get(String(requestId));
      if (prior) return sendJson(ctx.res, 200, { ...JSON.parse(prior.result_json), replayed: true });
    }
    if (expected === undefined) {
      throw new HttpError(428, 'revision_required', 'a baseRevision is required to confirm standings');
    }
    const result = transaction(db, () => {
      const current = getRevision(db);
      if (Number(expected) !== current) {
        const err = new Error(`stale revision: expected ${expected}, current ${current}`);
        err.code = 'STALE_REVISION';
        err.currentRevision = current;
        throw err;
      }
      // A confirmation is an acknowledgement, not a new ruling: it records the
      // revision and snapshot hash it refers to and does NOT bump the counter.
      // Any later formal mutation makes this confirmation stale by comparison.
      // If this database has never persisted a snapshot at the current
      // revision (e.g. it was started on an existing file), derive it now from
      // the same immutable revision chains.
      const existing = db.prepare(`SELECT 1 FROM ranking_snapshot
          WHERE season_id = ? AND section = ? AND kind = 'final' AND revision = ? LIMIT 1`)
        .get(defaultSeason, body.section, current);
      if (!existing) {
        const season = loadSeason(db, defaultSeason);
        if (!season.sections.some((s) => s.id === body.section)) {
          throw new HttpError(422, 'bad_input', `unknown section: ${body.section}`);
        }
        recompute({ db, seasonId: defaultSeason, sections: [body.section], revision: current });
      }
      const confirmation = confirmStandings(db, body, { revision: current, actor: body.actor || 'desk' });
      const payload = { ok: true, revision: current, confirmation };
      if (requestId) {
        db.prepare('INSERT INTO idempotency (request_id, scope, result_json, created_at) VALUES (?, ?, ?, ?)')
          .run(String(requestId), 'confirm', JSON.stringify(payload), nowIso());
      }
      return payload;
    });
    return sendJson(ctx.res, 200, result);
  });

  // ---- scenarios --------------------------------------------------------
  route('GET', '/api/scenarios', async () => ({
    revision: currentRevision(),
    scenarios: listScenarios(db),
    variants: ruleVariantsFor(db, defaultSeason),
  }));

  route('POST', '/api/scenarios', async (ctx) => {
    const body = ctx.body || {};
    const revision = currentRevision();
    const baseRevision = Number(body.baseRevision ?? revision);
    if (baseRevision !== revision) {
      // Scenarios are allowed to be based on an older revision, but they are
      // then explicitly labelled stale so nobody mistakes them for the current
      // state.
    }
    const result = runScenario(db, { ...body, baseRevision }, { persist: body.persist !== false });
    return {
      ok: true,
      revision,
      baseRevision,
      staleBase: baseRevision !== revision,
      scenario: result,
    };
  });

  route('GET', '/api/scenarios/compare', async (ctx) => {
    const left = ctx.query.get('left');
    const right = ctx.query.get('right');
    if (!left || !right) throw new HttpError(400, 'bad_request', 'left and right scenario ids are required');
    const comparison = compareScenarios(db, left, right);
    if (!comparison) throw new HttpError(404, 'not_found', 'one or both scenarios do not exist');
    return { ...comparison, revision: currentRevision() };
  });

  route('GET', '/api/scenarios/:id', async (ctx) => {
    const scenario = getScenario(db, ctx.params.id);
    if (!scenario) throw new HttpError(404, 'not_found', `scenario not found: ${ctx.params.id}`);
    return { ...scenario, revision: currentRevision() };
  });

  // ---- report -----------------------------------------------------------
  route('GET', '/api/report', async (ctx) => {
    const revision = currentRevision();
    const ruleVersionId = ctx.query.get('ruleVersionId') || null;
    const knownState = loadState(db, { seasonId: defaultSeason, historical: true, ruleVersionId });
    const finalState = loadState(db, { seasonId: defaultSeason, ruleVersionId });
    const known = computeStandings(knownState);
    const final = computeStandings(finalState);
    const appeals = appealTimeline(db);
    return {
      generatedAt: nowIso(),
      revision,
      season: knownState.season,
      rule: {
        id: final.ruleVersionId,
        label: final.ruleLabel,
        hash: final.ruleHash,
        versions: loadRuleVersions(db, defaultSeason).map((r) => ({ id: r.id, label: r.label, validFrom: r.validFrom, hash: r.contentHash })),
      },
      historical: { asOf: known.asOf, sections: known.sections, wildcard: known.wildcard, pending: known.pending },
      final: { asOf: final.asOf, sections: final.sections, wildcard: final.wildcard, pending: final.pending },
      changes: diffStandings(known, final),
      appeals: appeals.map((entry) => ({
        id: entry.appeal.id,
        title: entry.appeal.title,
        status: entry.appeal.status,
        teamId: entry.appeal.teamId,
        target: entry.target,
        decisions: entry.chain,
        effectiveAt: entry.chain.find((c) => c.source === entry.appeal.id)?.effectiveAt || null,
        recordedAt: entry.chain.find((c) => c.source === entry.appeal.id)?.recordedAt || null,
        retroactive: entry.chain.some((c) => c.source === entry.appeal.id && c.effectiveAt < c.recordedAt),
      })),
      confirmations: confirmations(db, defaultSeason).map((c) => ({ ...c, stale: isConfirmationStale(c, revision) })),
      appliedCorrections: finalState.appliedCorrections,
      pending: final.pending,
    };
  });

  // ---- import batches (resumable) --------------------------------------
  route('POST', '/api/imports', async (ctx) => {
    const body = ctx.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) throw new HttpError(422, 'invalid_import', 'items must be a non-empty array');
    const id = body.id || `IMP-${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO import_batch (id, label, payload_json, cursor, status, created_at, updated_at)
        VALUES (?, ?, ?, 0, 'pending', ?, ?)`)
      .run(id, body.label || '批量赛果', JSON.stringify(items), nowIso(), nowIso());
    return { ok: true, id, total: items.length, cursor: 0, status: 'pending', revision: currentRevision() };
  });

  route('GET', '/api/imports', async () => ({
    revision: currentRevision(),
    imports: db.prepare('SELECT * FROM import_batch ORDER BY created_at DESC').all().map((row) => ({
      id: row.id,
      label: row.label,
      total: JSON.parse(row.payload_json).length,
      cursor: Number(row.cursor),
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  }));

  route('POST', '/api/imports/:id/apply', async (ctx) => {
    const body = ctx.body || {};
    const batch = db.prepare('SELECT * FROM import_batch WHERE id = ?').get(ctx.params.id);
    if (!batch) throw new HttpError(404, 'not_found', 'import batch not found');
    if (batch.status === 'complete') {
      return { ok: true, id: batch.id, status: 'complete', applied: 0, revision: currentRevision(), alreadyComplete: true };
    }
    const items = JSON.parse(batch.payload_json);
    const start = Number(batch.cursor);
    // One item per call keeps the operation small and resumable after a crash.
    const index = start;
    if (index >= items.length) {
      db.prepare('UPDATE import_batch SET status = ?, updated_at = ? WHERE id = ?').run('complete', nowIso(), batch.id);
      return { ok: true, id: batch.id, status: 'complete', applied: 0, revision: currentRevision() };
    }
    const item = items[index];
    const teams = loadTeams(db);
    const errors = validateMatchResult(item, { teams });
    if (errors.length > 0) {
      db.prepare('UPDATE import_batch SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', errors.join('; '), nowIso(), batch.id);
      throw new HttpError(422, 'invalid_import_item', `item ${index} invalid: ${errors.join('; ')}`, { index, errors });
    }
    return applyFormalMutation(ctx.req, ctx.res, body, (revision) => {
      const match = recordMatch(db, item, { revision });
      const next = index + 1;
      db.prepare('UPDATE import_batch SET cursor = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(next, next >= items.length ? 'complete' : 'pending', nowIso(), batch.id);
      return {
        action: 'import_apply',
        import: { id: batch.id, index, applied: 1, cursor: next, total: items.length, status: next >= items.length ? 'complete' : 'pending' },
        affectedSections: [match.section],
      };
    });
  });

  // ---- drafts (recovery) ----------------------------------------------
  route('GET', '/api/drafts', async () => ({
    drafts: db.prepare('SELECT * FROM draft ORDER BY updated_at DESC').all().map((row) => ({
      key: row.key,
      payload: JSON.parse(row.payload),
      version: Number(row.version),
      updatedAt: row.updated_at,
    })),
  }));

  route('PUT', '/api/drafts/:key', async (ctx) => {
    const body = ctx.body || {};
    const existing = db.prepare('SELECT * FROM draft WHERE key = ?').get(ctx.params.key);
    if (body.version !== undefined && existing && Number(body.version) !== Number(existing.version)) {
      throw new HttpError(409, 'draft_conflict', 'draft version mismatch', {
        currentVersion: Number(existing.version),
        payload: JSON.parse(existing.payload),
      });
    }
    const version = existing ? Number(existing.version) + 1 : 1;
    db.prepare(`INSERT INTO draft (key, payload, version, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, version = excluded.version, updated_at = excluded.updated_at`)
      .run(ctx.params.key, JSON.stringify(body.payload ?? {}), version, nowIso());
    return { ok: true, key: ctx.params.key, version, updatedAt: nowIso(), revision: currentRevision() };
  });

  route('DELETE', '/api/drafts/:key', async (ctx) => {
    db.prepare('DELETE FROM draft WHERE key = ?').run(ctx.params.key);
    return { ok: true, key: ctx.params.key };
  });

  // ---- audit ------------------------------------------------------------
  route('GET', '/api/audit', async (ctx) => {
    const limit = Math.min(Number(ctx.query.get('limit') || 50), 500);
    return {
      revision: currentRevision(),
      entries: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit).map((row) => ({
        id: Number(row.id),
        revision: row.revision === null ? null : Number(row.revision),
        action: row.action,
        target: row.target,
        actor: row.actor,
        detail: JSON.parse(row.detail_json || '{}'),
        createdAt: row.created_at,
      })),
    };
  });

  // ---- static -----------------------------------------------------------
  async function serveStatic(ctx) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(ctx.req.url, 'http://localhost').pathname);
    } catch {
      throw new HttpError(400, 'bad_request', 'invalid URL encoding');
    }
    if (pathname === '/') pathname = '/index.html';
    const resolved = normalize(join(PUBLIC, pathname));
    if (!resolved.startsWith(PUBLIC)) throw new HttpError(403, 'forbidden', 'path escapes public directory');
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      const index = join(PUBLIC, 'index.html');
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'not_found', 'unknown endpoint');
      ctx.res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      createReadStream(index).pipe(ctx.res);
      return;
    }
    ctx.res.writeHead(200, {
      'content-type': MIME[extname(resolved)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    createReadStream(resolved).pipe(ctx.res);
  }

  async function handle(req, res) {
    const started = Date.now();
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        await serveStatic({ req, res });
        return;
      }
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      let matched = null;
      let pathMatched = false;
      for (const entry of routes) {
        const m = entry.regex.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (entry.method === method) {
          matched = { entry, m };
          break;
        }
      }
      if (!matched) {
        if (pathMatched) throw new HttpError(405, 'method_not_allowed', `${method} not allowed on ${url.pathname}`);
        throw new HttpError(404, 'not_found', `unknown endpoint: ${url.pathname}`);
      }
      const params = {};
      matched.entry.keys.forEach((key, i) => { params[key] = matched.m[i + 1]; });
      const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await readBody(req) : {};
      const ctx = { req, res, params, query: url.searchParams, body, url };
      const result = await matched.entry.handler(ctx);
      if (result !== undefined && !res.writableEnded) sendJson(res, 200, result);
      logger(`${method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    } catch (err) {
      const codeStatus = { STALE_REVISION: 409, CONFLICT: 409, NOT_FOUND: 404, BAD_INPUT: 422 }[err.code];
      const status = err instanceof HttpError ? err.status : codeStatus || 500;
      const code = err instanceof HttpError ? err.code : err.code === 'STALE_REVISION' ? 'stale_revision' : status === 500 ? 'internal_error' : err.code.toLowerCase();
      if (status >= 500) logger(`ERROR ${req.method} ${req.url}: ${err.stack || err.message}`);
      if (!res.writableEnded) {
        sendJson(res, status, {
          ok: false,
          error: { code, message: err.message, ...(err.extra || {}), ...(err.currentRevision !== undefined ? { currentRevision: err.currentRevision } : {}) },
        });
      }
    }
  }

  const server = createServer((req, res) => { handle(req, res); });
  return { server, handle, routes };
}
