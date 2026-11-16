import { nowIso, audit } from './db.js';
import { normalizeTs } from './state.js';

/** Formal writes shared by the HTTP layer, tests and the CLI. */

const ROSTER_STAGES = new Set(['group', 'playin']);

export function validateMatchResult(payload, { teams } = {}) {
  const errors = [];
  const homeGoals = Number(payload.homeGoals);
  const awayGoals = Number(payload.awayGoals);
  if (!Number.isInteger(homeGoals) || homeGoals < 0) errors.push('homeGoals must be a non-negative integer');
  if (!Number.isInteger(awayGoals) || awayGoals < 0) errors.push('awayGoals must be a non-negative integer');
  if (payload.stage && !ROSTER_STAGES.has(payload.stage)) errors.push('stage must be group or playin');
  if (teams && payload.home && !teams.some((t) => t.id === payload.home)) errors.push(`unknown home team: ${payload.home}`);
  if (teams && payload.away && !teams.some((t) => t.id === payload.away)) errors.push(`unknown away team: ${payload.away}`);
  if (payload.home && payload.away && payload.home === payload.away) errors.push('home and away teams must differ');
  return errors;
}

export function recordMatch(db, payload, { revision, actor = 'desk' } = {}) {
  const section = payload.section;
  if (!section) throw Object.assign(new Error('section is required'), { code: 'BAD_INPUT' });
  const homeGoals = Number(payload.homeGoals);
  const awayGoals = Number(payload.awayGoals);
  const playedAt = normalizeTs(payload.playedAt || nowIso());
  const id = payload.id || `M-${section}-${Date.now().toString(36)}`;
  db.prepare(`INSERT INTO match (id, stage, section, home, away, home_goals, away_goals, played_at, status, cards_json, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'final', ?, ?)`)
    .run(id, payload.stage || 'group', section, payload.home, payload.away, homeGoals, awayGoals, playedAt, JSON.stringify(payload.cards || {}), revision);
  db.prepare(`INSERT INTO match_revision
      (match_id, revision_no, home_goals, away_goals, reason, source, recorded_at, effective_at)
      VALUES (?, 1, ?, ?, ?, 'manual', ?, ?)`)
    .run(id, homeGoals, awayGoals, payload.reason || '赛果录入', nowIso(), playedAt);
  audit(db, revision, 'match_record', id, actor, { home: payload.home, away: payload.away, homeGoals, awayGoals });
  return { id, section };
}

export function correctMatch(db, matchId, payload, { revision, actor = 'desk' } = {}) {
  const match = db.prepare('SELECT * FROM match WHERE id = ?').get(matchId);
  if (!match) throw Object.assign(new Error(`match not found: ${matchId}`), { code: 'NOT_FOUND' });
  const last = db.prepare('SELECT COALESCE(MAX(revision_no), 0) AS n FROM match_revision WHERE match_id = ?').get(matchId);
  const revisionNo = Number(last.n) + 1;
  const homeGoals = Number(payload.homeGoals ?? match.home_goals);
  const awayGoals = Number(payload.awayGoals ?? match.away_goals);
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals) || homeGoals < 0 || awayGoals < 0) {
    throw Object.assign(new Error('goals must be non-negative integers'), { code: 'BAD_INPUT' });
  }
  const effectiveAt = normalizeTs(payload.effectiveAt || match.played_at);
  const recordedAt = nowIso();
  db.prepare(`INSERT INTO match_revision
      (match_id, revision_no, home_goals, away_goals, reason, source, recorded_at, effective_at)
      VALUES (?, ?, ?, ?, ?, 'correction', ?, ?)`)
    .run(matchId, revisionNo, homeGoals, awayGoals, payload.reason || '赛果更正', recordedAt, effectiveAt);
  // Base row stays original; only the pointer moves.
  db.prepare('UPDATE match SET revision = ? WHERE id = ?').run(revision, matchId);
  audit(db, revision, 'match_correct', matchId, actor, { homeGoals, awayGoals, effectiveAt, recordedAt, revisionNo, reason: payload.reason || '' });
  return { id: matchId, section: match.section, revisionNo, recordedAt, effectiveAt, retroactive: effectiveAt < recordedAt };
}

export function insertPenalty(db, payload, { revision, actor = 'desk' } = {}) {
  const team = db.prepare('SELECT * FROM team WHERE id = ?').get(payload.teamId);
  if (!team) throw Object.assign(new Error(`team not found: ${payload.teamId}`), { code: 'BAD_INPUT' });
  if (!['point_deduction', 'forfeit'].includes(payload.kind)) {
    throw Object.assign(new Error('kind must be point_deduction or forfeit'), { code: 'BAD_INPUT' });
  }
  const id = payload.id || `P-${Date.now().toString(36)}`;
  const recordedAt = nowIso();
  const effectiveAt = normalizeTs(payload.effectiveAt || recordedAt);
  const points = payload.kind === 'forfeit' ? 0 : Number(payload.points ?? 1);
  db.prepare(`INSERT INTO penalty (id, team_id, section, match_id, kind, points, reason, recorded_at, effective_at, status, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`)
    .run(id, payload.teamId, team.section, payload.matchId || null, payload.kind, points, payload.reason || '', recordedAt, effectiveAt, revision);
  db.prepare(`INSERT INTO penalty_revision
      (penalty_id, revision_no, action, points, status, reason, source, recorded_at, effective_at)
      VALUES (?, 1, 'impose', ?, 'active', ?, 'manual', ?, ?)`)
    .run(id, points, payload.reason || '', recordedAt, effectiveAt);
  audit(db, revision, 'penalty_impose', id, actor, { teamId: payload.teamId, kind: payload.kind, points, effectiveAt });
  return { id, section: team.section, effectiveAt, recordedAt };
}

export function insertAppeal(db, payload, { revision, actor = 'desk' } = {}) {
  const team = db.prepare('SELECT * FROM team WHERE id = ?').get(payload.teamId);
  if (!team) throw Object.assign(new Error(`team not found: ${payload.teamId}`), { code: 'BAD_INPUT' });
  if (!payload.matchId && !payload.penaltyId) {
    throw Object.assign(new Error('appeal must target a match or a penalty'), { code: 'BAD_INPUT' });
  }
  if (payload.matchId && payload.penaltyId) {
    throw Object.assign(new Error('appeal must target either a match or a penalty, not both'), { code: 'BAD_INPUT' });
  }
  if (payload.matchId && !db.prepare('SELECT 1 FROM match WHERE id = ?').get(payload.matchId)) {
    throw Object.assign(new Error(`match not found: ${payload.matchId}`), { code: 'BAD_INPUT' });
  }
  if (payload.penaltyId && !db.prepare('SELECT 1 FROM penalty WHERE id = ?').get(payload.penaltyId)) {
    throw Object.assign(new Error(`penalty not found: ${payload.penaltyId}`), { code: 'BAD_INPUT' });
  }
  const id = payload.id || `AP-${Date.now().toString(36)}`;
  db.prepare(`INSERT INTO appeal
      (id, team_id, penalty_id, match_id, title, filed_at, status, requested_outcome, note, hearing_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
    .run(
      id,
      payload.teamId,
      payload.penaltyId || null,
      payload.matchId || null,
      String(payload.title || '').trim(),
      normalizeTs(payload.filedAt || nowIso()),
      payload.requestedOutcome || '',
      payload.note || '',
      normalizeTs(payload.hearingAt),
      revision,
    );
  audit(db, revision, 'appeal_file', id, actor, { teamId: payload.teamId, title: payload.title });
  return { id, section: team.section };
}

export function updateAppealDraft(db, appealId, draft, { actor = 'desk' } = {}) {
  const appeal = db.prepare('SELECT * FROM appeal WHERE id = ?').get(appealId);
  if (!appeal) throw Object.assign(new Error(`appeal not found: ${appealId}`), { code: 'NOT_FOUND' });
  // Drafts are explicitly non-formal: they do not bump the revision counter.
  db.prepare('UPDATE appeal SET draft_json = ? WHERE id = ?').run(JSON.stringify(draft || null), appealId);
  audit(db, null, 'appeal_draft', appealId, actor, { keys: Object.keys(draft || {}) });
  return { id: appealId, saved: true };
}

export function confirmStandings(db, payload, { revision, actor = 'desk' } = {}) {
  const seasonId = payload.seasonId || 'S-2627';
  const section = payload.section;
  if (!section) throw Object.assign(new Error('section is required'), { code: 'BAD_INPUT' });
  const row = db.prepare(`SELECT * FROM ranking_snapshot
      WHERE season_id = ? AND section = ? AND kind = 'final' AND revision = ?
      ORDER BY id DESC LIMIT 1`).get(seasonId, section, revision);
  if (!row) {
    throw Object.assign(new Error('no final snapshot at this revision; recompute first'), { code: 'CONFLICT' });
  }
  db.prepare(`INSERT INTO confirmation (season_id, section, revision, rule_version, snapshot_hash, confirmed_by, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(seasonId, section, revision, row.rule_version, row.input_hash, actor, payload.note || '', nowIso());
  audit(db, revision, 'confirm', `${seasonId}:${section}`, actor, { snapshotHash: row.input_hash, ruleVersion: row.rule_version });
  return {
    seasonId,
    section,
    revision,
    ruleVersion: row.rule_version,
    snapshotHash: row.input_hash,
    confirmedBy: actor,
    createdAt: nowIso(),
  };
}

export function confirmations(db, seasonId = 'S-2627') {
  return db.prepare(`SELECT * FROM confirmation WHERE season_id = ? ORDER BY id DESC`).all(seasonId).map((row) => ({
    id: Number(row.id),
    seasonId: row.season_id,
    section: row.section,
    revision: Number(row.revision),
    ruleVersion: row.rule_version,
    snapshotHash: row.snapshot_hash,
    confirmedBy: row.confirmed_by,
    note: row.note,
    createdAt: row.created_at,
    stale: false,
  }));
}

export function isConfirmationStale(confirmation, currentRevision) {
  return Number(confirmation.revision) !== Number(currentRevision);
}

export function loadMatches(db) {
  const rows = db.prepare('SELECT * FROM match ORDER BY played_at, id').all();
  const revCounts = db.prepare('SELECT match_id, COUNT(*) AS n, MAX(revision_no) AS last FROM match_revision GROUP BY match_id').all();
  const countMap = new Map(revCounts.map((r) => [r.match_id, { count: Number(r.n), last: Number(r.last) }]));
  return rows.map((row) => ({
    id: row.id,
    stage: row.stage,
    section: row.section,
    home: row.home,
    away: row.away,
    homeGoals: Number(row.home_goals),
    awayGoals: Number(row.away_goals),
    playedAt: row.played_at,
    status: row.status,
    cards: JSON.parse(row.cards_json || '{}'),
    revisionCount: countMap.get(row.id)?.count ?? 0,
    lastRevisionNo: countMap.get(row.id)?.last ?? 0,
  }));
}

export function matchTimeline(db, matchId) {
  const match = db.prepare('SELECT * FROM match WHERE id = ?').get(matchId);
  if (!match) return null;
  return {
    match: { id: match.id, home: match.home, away: match.away, section: match.section, playedAt: match.played_at },
    revisions: db.prepare('SELECT * FROM match_revision WHERE match_id = ? ORDER BY revision_no').all(matchId).map((row) => ({
      revisionNo: Number(row.revision_no),
      homeGoals: Number(row.home_goals),
      awayGoals: Number(row.away_goals),
      reason: row.reason,
      source: row.source,
      recordedAt: row.recorded_at,
      effectiveAt: row.effective_at,
      retroactive: row.effective_at < row.recorded_at,
    })),
  };
}
