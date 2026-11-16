import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowIso, transaction, bumpRevision, setMeta, getMeta, audit, openDatabase } from './db.js';
import { hashJson, insertRuleVersion, validateDefinition } from './rules.js';
import { normalizeTs } from './state.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function loadSeedDocument(path = join(ROOT, 'seed', 'season.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function seedDatabase(db, document = loadSeedDocument()) {
  const season = document.season;
  const sections = season.sections || [];
  const teams = document.teams || [];
  const matches = document.matches || [];
  const penalties = document.penalties || [];
  const appeals = document.appeals || [];

  const teamIds = new Set(teams.map((t) => t.id));
  const problems = [];
  for (const match of matches) {
    if (!teamIds.has(match.home) || !teamIds.has(match.away)) problems.push(`match ${match.id} references unknown team`);
    if (!sections.some((s) => s.id === match.section)) problems.push(`match ${match.id} references unknown section`);
    if (teamIds.has(match.home) && teamIds.has(match.away)) {
      const h = teams.find((t) => t.id === match.home);
      const a = teams.find((t) => t.id === match.away);
      if (h.section !== match.section || a.section !== match.section) problems.push(`match ${match.id} teams are not in section ${match.section}`);
    }
  }
  for (const penalty of penalties) {
    if (!teamIds.has(penalty.team)) problems.push(`penalty ${penalty.id} references unknown team`);
    const team = teams.find((t) => t.id === penalty.team);
    if (team && penalty.section && team.section !== penalty.section) problems.push(`penalty ${penalty.id} section mismatch`);
  }
  for (const appeal of appeals) {
    if (!teamIds.has(appeal.team)) problems.push(`appeal ${appeal.id} references unknown team`);
    if (appeal.matchId && !matches.some((m) => m.id === appeal.matchId)) problems.push(`appeal ${appeal.id} references unknown match`);
    if (appeal.penaltyId && !penalties.some((p) => p.id === appeal.penaltyId)) problems.push(`appeal ${appeal.id} references unknown penalty`);
  }
  if (problems.length > 0) {
    const err = new Error(`seed document invalid:\n - ${problems.join('\n - ')}`);
    err.code = 'BAD_SEED';
    throw err;
  }

  transaction(db, () => {
    db.exec('DELETE FROM appeal');
    db.exec('DELETE FROM penalty_revision');
    db.exec('DELETE FROM penalty');
    db.exec('DELETE FROM match_revision');
    db.exec('DELETE FROM match');
    db.exec('DELETE FROM team');
    db.exec('DELETE FROM ruleset_version');
    db.exec('DELETE FROM season');
    db.exec('DELETE FROM ranking_snapshot');
    db.exec('DELETE FROM confirmation');
    db.exec('DELETE FROM scenario_run');
    db.exec('DELETE FROM import_batch');
    db.exec('DELETE FROM idempotency');
    db.exec('DELETE FROM audit_log');
    db.exec('DELETE FROM revision_counter');

    const createdAt = nowIso();
    db.prepare('INSERT INTO revision_counter (id, revision) VALUES (1, 1)').run();

    db.prepare(`INSERT INTO season (id, name, rule_version_id, qual_spots, wildcard_slots, sections_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(season.id, season.name, season.ruleVersionId, season.qualificationSpotsPerSection ?? 2, season.wildcardSlots ?? 0, JSON.stringify(sections), createdAt);

    for (const ruleset of document.rulesets) {
      const check = validateDefinition(ruleset.definition);
      if (!check.ok) throw Object.assign(new Error(`ruleset ${ruleset.id} invalid: ${check.errors.join('; ')}`), { code: 'BAD_SEED' });
      insertRuleVersion(db, {
        id: ruleset.id,
        seasonId: season.id,
        label: ruleset.label,
        validFrom: normalizeTs(ruleset.validFrom),
        definition: ruleset.definition,
        supersedesId: ruleset.supersedesId || null,
      });
    }

    const insertTeam = db.prepare('INSERT INTO team (id, name, section, seed_lots) VALUES (?, ?, ?, ?)');
    for (const team of teams) insertTeam.run(team.id, team.name, team.section, Number(team.seedLots ?? 99));

    const insertMatch = db.prepare(`INSERT INTO match
        (id, stage, section, home, away, home_goals, away_goals, played_at, status, cards_json, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    for (const match of matches) {
      insertMatch.run(
        match.id,
        match.stage || 'group',
        match.section,
        match.home,
        match.away,
        Number(match.homeGoals ?? 0),
        Number(match.awayGoals ?? 0),
        normalizeTs(match.playedAt),
        match.status || 'final',
        JSON.stringify(match.cards || {}),
      );
      db.prepare(`INSERT INTO match_revision
          (match_id, revision_no, home_goals, away_goals, reason, source, recorded_at, effective_at, superseded)
          VALUES (?, 1, ?, ?, '原始记录', 'seed', ?, ?, 0)`)
        .run(match.id, Number(match.homeGoals ?? 0), Number(match.awayGoals ?? 0), normalizeTs(match.playedAt), normalizeTs(match.playedAt));
    }

    const insertPenalty = db.prepare(`INSERT INTO penalty
        (id, team_id, section, match_id, kind, points, reason, recorded_at, effective_at, status, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1)`);
    const insertPenaltyRev = db.prepare(`INSERT INTO penalty_revision
        (penalty_id, revision_no, action, points, status, reason, source, recorded_at, effective_at)
        VALUES (?, 1, 'impose', ?, 'active', ?, 'seed', ?, ?)`);
    for (const penalty of penalties) {
      const team = teams.find((t) => t.id === penalty.team);
      insertPenalty.run(
        penalty.id,
        penalty.team,
        penalty.section || team?.section || 'A',
        penalty.matchId || null,
        penalty.kind || 'point_deduction',
        Number(penalty.points ?? 0),
        penalty.reason || '',
        normalizeTs(penalty.recordedAt),
        normalizeTs(penalty.effectiveAt),
      );
      insertPenaltyRev.run(penalty.id, Number(penalty.points ?? 0), penalty.reason || '', normalizeTs(penalty.recordedAt), normalizeTs(penalty.effectiveAt));
    }

    const insertAppeal = db.prepare(`INSERT INTO appeal
        (id, team_id, penalty_id, match_id, title, filed_at, status, requested_outcome, note, hearing_at, decided_at, decision_note, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    const insertMatchRevision = db.prepare(`INSERT INTO match_revision
        (match_id, revision_no, home_goals, away_goals, reason, source, recorded_at, effective_at, superseded)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`);
    const insertPenaltyRevision = db.prepare(`INSERT INTO penalty_revision
        (penalty_id, revision_no, action, points, status, reason, source, recorded_at, effective_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const appeal of appeals) {
      insertAppeal.run(
        appeal.id,
        appeal.team,
        appeal.penaltyId || null,
        appeal.matchId || null,
        appeal.title,
        normalizeTs(appeal.filedAt),
        appeal.status || 'open',
        appeal.requestedOutcome || '',
        appeal.note || '',
        normalizeTs(appeal.hearingAt),
        normalizeTs(appeal.decidedAt),
        appeal.decisionNote || '',
      );
      // Seeded decisions are replayed as revision rows so the initial database
      // already demonstrates a retroactive ruling (recorded later, effective
      // earlier). Pending appeals contribute nothing.
      const decision = appeal.decision;
      if (decision && ['upheld', 'partially_upheld'].includes(appeal.status)) {
        const recordedAt = normalizeTs(decision.recordedAt || appeal.decidedAt);
        const effectiveAt = normalizeTs(decision.effectiveAt || appeal.filedAt);
        if (appeal.matchId) {
          const match = matches.find((m) => m.id === appeal.matchId);
          const homeGoals = Number(decision.homeGoals ?? match.homeGoals);
          const awayGoals = Number(decision.awayGoals ?? match.awayGoals);
          insertMatchRevision.run(appeal.matchId, 2, homeGoals, awayGoals, decision.reason || appeal.title, appeal.id, recordedAt, effectiveAt);
        }
        if (appeal.penaltyId) {
          const penalty = penalties.find((p) => p.id === appeal.penaltyId);
          const points = Number(decision.points ?? penalty.points ?? 0);
          const action = decision.penaltyAction || 'revoke';
          const status = action === 'revoke' ? 'inactive' : 'active';
          insertPenaltyRevision.run(appeal.penaltyId, 2, action, points, status, decision.reason || appeal.title, appeal.id, recordedAt, effectiveAt);
        }
      }
    }

    setMeta(db, 'seed_hash', hashJson(document));
    setMeta(db, 'seeded_at', createdAt);
    setMeta(db, 'schema_version', '1');
    audit(db, 1, 'seed', season.id, 'seed', { teams: teams.length, matches: matches.length, appeals: appeals.length });
  });

  return { seasonId: season.id, revision: 1, teams: teams.length, matches: matches.length };
}

export function ensureSeeded(db, document = loadSeedDocument()) {
  if (getMeta(db, 'seed_hash')) return { seeded: false };
  const result = seedDatabase(db, document);
  return { seeded: true, ...result };
}

export function createSeededDatabase(path = ':memory:', document = loadSeedDocument()) {
  const db = openDatabase(path);
  seedDatabase(db, document);
  return db;
}

export { ROOT };
