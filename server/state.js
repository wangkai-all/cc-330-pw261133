import { nowIso } from './db.js';
import { loadRuleVersion } from './rules.js';

/**
 * Timestamp helper: seed documents use plain dates; everything is compared as
 * ISO-8601 UTC strings. Null/undefined means "no bound".
 */
export function normalizeTs(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) return `${text}Z`;
  return text;
}

export function tsLte(a, b) {
  if (b === null || b === undefined) return true;
  if (a === null || a === undefined) return true;
  return normalizeTs(a) <= normalizeTs(b);
}

export function loadSeason(db, seasonId = 'S-2627') {
  const row = db.prepare('SELECT * FROM season WHERE id = ?').get(seasonId);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    ruleVersionId: row.rule_version_id,
    qualSpots: Number(row.qual_spots),
    wildcardSlots: Number(row.wildcard_slots ?? 0),
    sections: JSON.parse(row.sections_json),
    createdAt: row.created_at,
  };
}

export function loadTeams(db) {
  return db.prepare('SELECT * FROM team ORDER BY id').all().map((row) => ({
    id: row.id,
    name: row.name,
    section: row.section,
    seedLots: Number(row.seed_lots),
  }));
}

/**
 * Build an immutable, JSON-safe snapshot of the tournament as of `asOf`.
 * Cutoff semantics:
 *  - a record is *known* only if recorded_at <= asOf
 *  - a correction has *effect* only if effective_at <= asOf
 *  - a match counts only if played_at <= asOf and status = final
 *
 * `historical: true` builds the "as originally known" view: only rulings that
 * were recorded no later than the date they took effect were part of the
 * official record at the time (i.e. no retroactive decisions). The default
 * view is the "final corrected" one and includes retroactive rulings once
 * their effective date has passed.
 */
export function loadState(db, { seasonId = 'S-2627', asOf = null, ruleVersionId = null, historical = false } = {}) {
  const at = asOf === null ? nowIso() : normalizeTs(asOf);
  const season = loadSeason(db, seasonId);
  if (!season) throw new Error(`season not found: ${seasonId}`);
  const ruleId = ruleVersionId || season.ruleVersionId;
  const rule = loadRuleVersion(db, ruleId);
  if (!rule) throw new Error(`rule version not found: ${ruleId}`);

  const teams = loadTeams(db);

  const matchRows = db.prepare('SELECT * FROM match ORDER BY played_at, id').all();
  const revisions = db
    .prepare('SELECT * FROM match_revision ORDER BY match_id, revision_no')
    .all()
    .map((r) => ({
      id: Number(r.id),
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

  const byMatch = new Map();
  for (const rev of revisions) {
    if (!byMatch.has(rev.matchId)) byMatch.set(rev.matchId, []);
    byMatch.get(rev.matchId).push(rev);
  }

  const matches = [];
  const appliedCorrections = [];
  for (const row of matchRows) {
    const playedAt = normalizeTs(row.played_at);
    if (!tsLte(playedAt, at)) continue;
    const known = (byMatch.get(row.id) || []).filter(
      (rev) => tsLte(rev.recordedAt, at) && tsLte(rev.effectiveAt, at)
        && (!historical || normalizeTs(rev.recordedAt) <= normalizeTs(rev.effectiveAt)),
    );
    const selected = known.reduce((best, rev) => (!best || rev.revisionNo > best.revisionNo ? rev : best), null);
    const homeGoals = selected ? selected.homeGoals : Number(row.home_goals);
    const awayGoals = selected ? selected.awayGoals : Number(row.away_goals);
    if (selected && selected.revisionNo > 1) {
      appliedCorrections.push({
        matchId: row.id,
        revisionNo: selected.revisionNo,
        reason: selected.reason,
        source: selected.source,
        recordedAt: selected.recordedAt,
        effectiveAt: selected.effectiveAt,
      });
    }
    matches.push({
      id: row.id,
      stage: row.stage,
      section: row.section,
      home: row.home,
      away: row.away,
      homeGoals,
      awayGoals,
      playedAt,
      status: row.status,
      cards: JSON.parse(row.cards_json || '{}'),
      revisionNo: selected ? selected.revisionNo : 0,
      revisionId: selected ? selected.id : null,
      effectiveAt: selected ? selected.effectiveAt : null,
      revisionCount: (byMatch.get(row.id) || []).length,
      baseHomeGoals: Number(row.home_goals),
      baseAwayGoals: Number(row.away_goals),
    });
  }

  const penaltyRows = db.prepare('SELECT * FROM penalty ORDER BY id').all();
  const penaltyRevisions = db
    .prepare('SELECT * FROM penalty_revision ORDER BY penalty_id, revision_no')
    .all()
    .map((r) => ({
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

  const penalties = [];
  for (const row of penaltyRows) {
    const revisionsForPenalty = penaltyRevisions.filter((r) => r.penaltyId === row.id);
    // Select the latest revision that is *known* and *effective* at this
    // timestamp; its status decides whether the penalty currently applies.
    // Filtering on `status === 'active'` here would resurrect a revoked
    // penalty, so status is applied after selection.
    const known = revisionsForPenalty.filter(
      (rev) => tsLte(rev.recordedAt, at) && tsLte(rev.effectiveAt, at)
        && (!historical || normalizeTs(rev.recordedAt) <= normalizeTs(rev.effectiveAt)),
    );
    const selected = known.reduce((best, rev) => (!best || rev.revisionNo > best.revisionNo ? rev : best), null);
    penalties.push({
      id: row.id,
      teamId: row.team_id,
      section: row.section,
      kind: row.kind,
      matchId: row.match_id || null,
      points: selected ? selected.points : Number(row.points),
      status: selected ? selected.status : row.status,
      effectiveAt: selected ? selected.effectiveAt : normalizeTs(row.effective_at),
      recordedAt: selected ? selected.recordedAt : normalizeTs(row.recorded_at),
      revisionNo: selected ? selected.revisionNo : 0,
      revisionCount: revisionsForPenalty.length,
      revisions: revisionsForPenalty,
      reason: row.reason,
    });
  }

  // Forfeit penalties rewrite the referenced match result (0:3 against the
  // penalised team). Point deductions are applied in the standings maths.
  for (const penalty of penalties) {
    if (penalty.status !== 'active') continue;
    const match = matches.find((m) => m.id === penalty.matchId);
    if (!match) continue;
    const teamIsHome = match.home === penalty.teamId;
    const teamIsAway = match.away === penalty.teamId;
    if (!teamIsHome && !teamIsAway) continue;
    if (teamIsHome) {
      match.homeGoals = 0;
      match.awayGoals = Math.max(3, match.awayGoals);
    } else {
      match.awayGoals = 0;
      match.homeGoals = Math.max(3, match.homeGoals);
    }
    match.forfeitBy = penalty.teamId;
    match.forfeitPenaltyId = penalty.id;
  }

  return {
    season,
    rule,
    asOf: at,
    historical,
    teams,
    matches: matches.filter((m) => m.status === 'final'),
    penalties: penalties.filter((p) => p.status === 'active'),
    allPenalties: penalties,
    appliedCorrections,
    matchRevisions: revisions,
    penaltyRevisions,
  };
}

/**
 * Apply scenario mutations to a state object without touching the database.
 * Unknown targets are reported, never silently ignored.
 */
export function mutateState(base, mutations = {}) {
  const state = structuredClone(base);
  const applied = [];
  const rejected = [];

  if (mutations.ruleVersionId && mutations.ruleVersionId !== state.rule.id) {
    applied.push({ type: 'rule_version', from: state.rule.id, to: mutations.ruleVersionId });
  }

  for (const change of mutations.matches || []) {
    const match = state.matches.find((m) => m.id === change.matchId);
    if (!match) {
      rejected.push({ type: 'match', matchId: change.matchId, reason: 'unknown_match' });
      continue;
    }
    if (change.homeGoals !== undefined) match.homeGoals = Number(change.homeGoals);
    if (change.awayGoals !== undefined) match.awayGoals = Number(change.awayGoals);
    if (change.stage) match.stage = change.stage;
    match.scenarioAdjusted = true;
    applied.push({ type: 'match', matchId: match.id, homeGoals: match.homeGoals, awayGoals: match.awayGoals, label: change.label || '假设比分' });
  }

  for (const change of mutations.penalties || []) {
    const penalty = state.penalties.find((p) => p.id === change.penaltyId);
    if (!penalty) {
      rejected.push({ type: 'penalty', penaltyId: change.penaltyId, reason: 'unknown_penalty' });
      continue;
    }
    if (change.points !== undefined) penalty.points = Number(change.points);
    if (change.remove === true) {
      state.penalties = state.penalties.filter((p) => p.id !== penalty.id);
      applied.push({ type: 'penalty_remove', penaltyId: penalty.id, label: change.label || '假设撤销处罚' });
      continue;
    }
    penalty.scenarioAdjusted = true;
    applied.push({ type: 'penalty', penaltyId: penalty.id, points: penalty.points, label: change.label || '假设处罚调整' });
  }

  for (const added of mutations.addMatches || []) {
    if (state.matches.some((m) => m.id === added.id)) {
      rejected.push({ type: 'add_match', matchId: added.id, reason: 'duplicate_match' });
      continue;
    }
    state.matches.push({
      id: added.id,
      stage: added.stage || 'playin',
      section: added.section,
      home: added.home,
      away: added.away,
      homeGoals: Number(added.homeGoals),
      awayGoals: Number(added.awayGoals),
      playedAt: normalizeTs(added.playedAt || state.asOf),
      status: 'final',
      cards: added.cards || {},
      revisionNo: 0,
      revisionId: null,
      effectiveAt: null,
      revisionCount: 0,
      scenarioAdjusted: true,
    });
    applied.push({ type: 'add_match', matchId: added.id, label: '假设加赛' });
  }

  return { state, applied, rejected };
}
