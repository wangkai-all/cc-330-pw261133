import { nowIso } from './db.js';
import { normalizeTs } from './state.js';
import { hashJson } from './rules.js';

/**
 * Appeal workflow. An appeal never edits the base match/penalty row directly;
 * it appends a *revision* with both a recorded-at timestamp (when the desk
 * learned of it) and an effective-at timestamp (the retroactive boundary used
 * when replaying the timeline). The standings engine reads the revision chain.
 *
 * Status ladder: open -> hearing -> upheld | dismissed | partially_upheld
 */

export const APPEAL_STATUSES = ['open', 'hearing', 'upheld', 'dismissed', 'partially_upheld'];
export const OPEN_STATUSES = new Set(['open', 'hearing']);

export function loadAppeals(db) {
  return db.prepare('SELECT * FROM appeal ORDER BY filed_at, id').all().map(mapAppeal);
}

export function mapAppeal(row) {
  return {
    id: row.id,
    teamId: row.team_id,
    penaltyId: row.penalty_id,
    matchId: row.match_id,
    title: row.title,
    filedAt: normalizeTs(row.filed_at),
    status: row.status,
    requestedOutcome: row.requested_outcome,
    note: row.note || '',
    hearingAt: normalizeTs(row.hearing_at),
    decidedAt: normalizeTs(row.decided_at),
    decisionNote: row.decision_note || '',
    revision: Number(row.revision),
    draft: row.draft_json ? JSON.parse(row.draft_json) : null,
  };
}

export function loadAppeal(db, id) {
  const row = db.prepare('SELECT * FROM appeal WHERE id = ?').get(id);
  return row ? mapAppeal(row) : null;
}

export function validateAppealInput(input, { partial = false } = {}) {
  const errors = [];
  if (!partial || input.title !== undefined) {
    if (!input.title || String(input.title).trim().length < 2) errors.push('title is required (>= 2 chars)');
  }
  if (!partial || input.teamId !== undefined) {
    if (!input.teamId) errors.push('teamId is required');
  }
  if (input.status !== undefined && !APPEAL_STATUSES.includes(input.status)) {
    errors.push(`status must be one of ${APPEAL_STATUSES.join(', ')}`);
  }
  if (input.matchId && input.penaltyId) errors.push('an appeal targets either a match or a penalty, not both');
  return errors;
}

/** Revision chain of the target a decided appeal points at. */
export function appealChain(db, appeal) {
  if (appeal.matchId) {
    return db.prepare('SELECT * FROM match_revision WHERE match_id = ? ORDER BY revision_no').all().map((r) => ({
      type: 'match',
      matchId: r.match_id,
      revisionNo: Number(r.revision_no),
      homeGoals: Number(r.home_goals),
      awayGoals: Number(r.away_goals),
      reason: r.reason,
      source: r.source,
      recordedAt: normalizeTs(r.recorded_at),
      effectiveAt: normalizeTs(r.effective_at),
      superseded: Boolean(r.superseded),
    }));
  }
  if (appeal.penaltyId) {
    return db.prepare('SELECT * FROM penalty_revision WHERE penalty_id = ? ORDER BY revision_no').all().map((r) => ({
      type: 'penalty',
      penaltyId: r.penalty_id,
      revisionNo: Number(r.revision_no),
      action: r.action,
      points: Number(r.points),
      status: r.status,
      reason: r.reason,
      source: r.source,
      recordedAt: normalizeTs(r.recorded_at),
      effectiveAt: normalizeTs(r.effective_at),
    }));
  }
  return [];
}

export function appealTimeline(db) {
  const appeals = loadAppeals(db);
  return appeals.map((appeal) => ({
    appeal,
    target: appeal.matchId ? { type: 'match', id: appeal.matchId } : appeal.penaltyId ? { type: 'penalty', id: appeal.penaltyId } : null,
    chain: appealChain(db, appeal),
    open: OPEN_STATUSES.has(appeal.status),
  }));
}

/**
 * Decide an appeal. Returns the revision rows that were appended so the HTTP
 * layer can recompute affected groups.
 */
export function applyAppealDecision(db, appeal, decision, actor) {
  const now = nowIso();
  const effectiveAt = normalizeTs(decision.effectiveAt || appeal.filedAt || now);
  const revision = Number(decision.revision ?? 1);
  const appended = [];

  if (appeal.matchId) {
    const match = db.prepare('SELECT * FROM match WHERE id = ?').get(appeal.matchId);
    if (!match) throw Object.assign(new Error(`match not found: ${appeal.matchId}`), { code: 'NOT_FOUND' });
    const last = db.prepare('SELECT COALESCE(MAX(revision_no), 0) AS n FROM match_revision WHERE match_id = ?').get(appeal.matchId);
    const revisionNo = Number(last.n) + 1;
    const homeGoals = Number(decision.homeGoals ?? match.home_goals);
    const awayGoals = Number(decision.awayGoals ?? match.away_goals);
    if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals) || homeGoals < 0 || awayGoals < 0) {
      throw Object.assign(new Error('decision goals must be non-negative integers'), { code: 'BAD_INPUT' });
    }
    db.prepare(`INSERT INTO match_revision
        (match_id, revision_no, home_goals, away_goals, reason, source, recorded_at, effective_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(appeal.matchId, revisionNo, homeGoals, awayGoals, decision.reason || appeal.title, appeal.id, now, effectiveAt);
    appended.push({ type: 'match', id: appeal.matchId, revisionNo });
    // The base `match` row is the *original* record and is never overwritten:
    // the revision chain is the authoritative timeline for both the historical
    // and the corrected views. Only the row's revision pointer moves.
    db.prepare('UPDATE match SET revision = ? WHERE id = ?').run(revision, appeal.matchId);
  }

  if (appeal.penaltyId) {
    const penalty = db.prepare('SELECT * FROM penalty WHERE id = ?').get(appeal.penaltyId);
    if (!penalty) throw Object.assign(new Error(`penalty not found: ${appeal.penaltyId}`), { code: 'NOT_FOUND' });
    const last = db.prepare('SELECT COALESCE(MAX(revision_no), 0) AS n FROM penalty_revision WHERE penalty_id = ?').get(appeal.penaltyId);
    const revisionNo = Number(last.n) + 1;
    const action = decision.penaltyAction || (decision.outcome === 'dismissed' ? 'confirm' : 'revoke');
    const points = Number(decision.points ?? penalty.points);
    const status = action === 'revoke' ? 'inactive' : 'active';
    db.prepare(`INSERT INTO penalty_revision
        (penalty_id, revision_no, action, points, status, reason, source, recorded_at, effective_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(appeal.penaltyId, revisionNo, action, points, status, decision.reason || appeal.title, appeal.id, now, effectiveAt);
    // Base penalty row is the original record; see the note above.
    db.prepare('UPDATE penalty SET revision = ? WHERE id = ?').run(revision, appeal.penaltyId);
    appended.push({ type: 'penalty', id: appeal.penaltyId, revisionNo });
  }

  db.prepare(`UPDATE appeal SET status = ?, decided_at = ?, decision_note = ?, revision = ? WHERE id = ?`)
    .run(decision.status || 'upheld', now, decision.note || decision.reason || '', revision, appeal.id);

  return { appended, effectiveAt, recordedAt: now, actor };
}

export function appealInputHash(input) {
  return hashJson(input);
}
