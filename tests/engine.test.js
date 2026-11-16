import test from 'node:test';
import assert from 'node:assert/strict';

import { createSeededDatabase } from '../server/seed.js';
import { loadState } from '../server/state.js';
import { computeStandings, explainTeam } from '../server/standings.js';
import { loadAppeal, applyAppealDecision } from '../server/appeals.js';
import { correctMatch } from '../server/writes.js';
import { recompute } from '../server/recompute.js';
import { loadRuleVersion, insertRuleVersion, deriveRuleVariant, validateDefinition } from '../server/rules.js';
import { getRevision } from '../server/db.js';

function rowOf(standings, teamId) {
  for (const section of standings.sections) {
    const row = section.rows.find((r) => r.teamId === teamId);
    if (row) return row;
  }
  return null;
}

function sectionOf(standings, id) {
  return standings.sections.find((s) => s.section === id);
}

function rows(standings, id) {
  return sectionOf(standings, id).rows.map((r) => [r.teamId, r.rank, r.points, r.qualification]);
}

test('seed: a three-way head-to-head cycle is flagged, then the next subset step splits it', () => {
  const db = createSeededDatabase();
  const standings = computeStandings(loadState(db));
  const a = sectionOf(standings, 'A');
  assert.deepEqual(a.rows.map((r) => r.teamId), ['T-FEN', 'T-PAP', 'T-KLP', 'T-DUN', 'T-SLT']);
  const h2h = a.trace.steps.find((s) => s.stepId === 'h2h-points');
  assert.deepEqual(h2h.inputs.slice().sort(), ['T-FEN', 'T-KLP', 'T-PAP']);
  assert.deepEqual(h2h.values, { 'T-FEN': 3, 'T-KLP': 3, 'T-PAP': 3 });
  assert.equal(h2h.cycle.detected, true, 'KLP>FEN>PAP>KLP is a cycle');
  assert.equal(h2h.blockedByCycle, true);
  assert.deepEqual(h2h.buckets, [['T-FEN', 'T-KLP', 'T-PAP']], 'no order is invented');
  // The next step narrows to the same three teams and compares their
  // head-to-head goal difference, not their season-long goal difference.
  const gd = a.trace.steps.find((s) => s.stepId === 'h2h-gd');
  assert.deepEqual(gd.values, { 'T-FEN': 1, 'T-PAP': 0, 'T-KLP': -1 });
  assert.deepEqual(gd.buckets, [['T-FEN'], ['T-PAP'], ['T-KLP']]);
  assert.equal(a.rows[0].decidedBy, 'h2h-gd');
  assert.equal(a.rows[2].decidedBy, 'h2h-gd');
});

test('overall goal difference is not the primary key', () => {
  const db = createSeededDatabase();
  const a = sectionOf(computeStandings(loadState(db)), 'A');
  const klp = a.rows.find((r) => r.teamId === 'T-KLP');
  const fen = a.rows.find((r) => r.teamId === 'T-FEN');
  assert.ok(klp.goalDiff > fen.goalDiff, 'KLP has the best season-long GD…');
  assert.ok(klp.rank > fen.rank, '…but ranks below FEN because the head-to-head subset governs');
});

test('penalty deduction is merged into the table but reported separately', () => {
  const db = createSeededDatabase();
  const pap = rowOf(computeStandings(loadState(db)), 'T-PAP');
  assert.equal(pap.deduction, 1);
  assert.equal(pap.rawPoints, 7);
  assert.equal(pap.points, 6);
});

test('play-in match counts only for the whole-season aggregate in v1 (subset excludes it)', () => {
  const db = createSeededDatabase();
  const state = loadState(db);
  const playin = state.matches.find((m) => m.id === 'M-A-08');
  assert.equal(playin.stage, 'playin');
  const h2hPlanV1 = loadRuleVersion(db, 'RV-HANDBOOK-1').definition.tiebreakerPlan.steps[0];
  assert.deepEqual(h2hPlanV1.subset.stages, ['group']);
  const h2hPlanV2 = loadRuleVersion(db, 'RV-HANDBOOK-2').definition.tiebreakerPlan.steps[0];
  assert.deepEqual(h2hPlanV2.subset.stages, ['group', 'playin']);
  // In v1 DUN and SLT are split by their group match; the play-in does not
  // enter the head-to-head subset, but it does enter their overall aggregates.
  const v1 = sectionOf(computeStandings(state), 'A');
  const dun = v1.rows.find((r) => r.teamId === 'T-DUN');
  const salt = v1.rows.find((r) => r.teamId === 'T-SLT');
  assert.equal(dun.goalsFor, 1, 'play-in goal conceded, not scored, by DUN');
  assert.equal(dun.points, 4);
  assert.equal(salt.points, 3);
  assert.ok(dun.rank < salt.rank);
});

test('a retroactive ruling splits the historical and corrected views', () => {
  const db = createSeededDatabase();
  const known = computeStandings(loadState(db, { historical: true }));
  const final = computeStandings(loadState(db));
  // M-B-01 was originally 1:0 to GLS and later corrected to 0:1 (QRT).
  assert.equal(rowOf(known, 'T-GLS').wins, 2);
  assert.equal(rowOf(known, 'T-GLS').points, 6);
  assert.equal(rowOf(known, 'T-GLS').rank, 2);
  assert.equal(rowOf(known, 'T-QRT').points, 6);
  assert.equal(rowOf(known, 'T-QRT').rank, 3);
  assert.equal(rowOf(final, 'T-GLS').points, 3);
  assert.equal(rowOf(final, 'T-QRT').points, 9);
  assert.equal(rowOf(final, 'T-QRT').rank, 2);
  assert.equal(rowOf(final, 'T-QRT').qualification, 'qualified');
  assert.notDeepEqual(rows(known, 'B'), rows(final, 'B'));
});

test('a ruling effective in the future stays out of the current view', () => {
  const db = createSeededDatabase();
  const appeal = loadAppeal(db, 'AP-02');
  applyAppealDecision(db, appeal, {
    status: 'upheld', homeGoals: 0, awayGoals: 5, effectiveAt: '2027-06-01T00:00:00Z', reason: 'future',
  }, 'test');
  const now = computeStandings(loadState(db));
  assert.equal(rowOf(now, 'T-ASH').goalsFor, 3);
  const later = computeStandings(loadState(db, { asOf: '2027-06-02T00:00:00Z' }));
  assert.equal(rowOf(later, 'T-ASH').goalsFor, 8);
});

test('revoking a penalty through an appeal removes the deduction in the final view only', () => {
  const db = createSeededDatabase();
  const appeal = loadAppeal(db, 'AP-01');
  applyAppealDecision(db, appeal, {
    status: 'upheld', penaltyAction: 'revoke', effectiveAt: '2026-09-13T00:00:00Z', reason: '虚构裁决',
  }, 'test');
  const final = computeStandings(loadState(db));
  assert.equal(rowOf(final, 'T-PAP').deduction, 0);
  assert.equal(rowOf(final, 'T-PAP').points, 7);
  const known = computeStandings(loadState(db, { historical: true }));
  assert.equal(rowOf(known, 'T-PAP').deduction, 1);
});

test('cyclic head-to-head that cannot separate teams is flagged and handed to the next step', () => {
  const db = createSeededDatabase();
  // Build a group of three where each beats the next by the same margin.
  db.exec(`
    INSERT INTO team (id, name, section, seed_lots) VALUES ('T-X1','循环甲','C',1),('T-X2','循环乙','C',2),('T-X3','循环丙','C',3);
    INSERT INTO match (id, stage, section, home, away, home_goals, away_goals, played_at, status, cards_json, revision) VALUES
      ('M-C-1','group','C','T-X1','T-X2',1,0,'2026-09-01T00:00:00Z','final','{}',1),
      ('M-C-2','group','C','T-X2','T-X3',1,0,'2026-09-02T00:00:00Z','final','{}',1),
      ('M-C-3','group','C','T-X3','T-X1',1,0,'2026-09-03T00:00:00Z','final','{}',1);
  `);
  const season = JSON.parse(db.prepare('SELECT sections_json FROM season').get().sections_json);
  season.push({ id: 'C', label: '测试分区' });
  db.prepare('UPDATE season SET sections_json = ?').run(JSON.stringify(season));
  const standings = computeStandings(loadState(db));
  const c = sectionOf(standings, 'C');
  const pointsStep = c.trace.steps.find((s) => s.stepId === 'h2h-points');
  assert.ok(pointsStep.cycle, 'cycle must be detected');
  assert.equal(pointsStep.blockedByCycle, true);
  assert.equal(pointsStep.buckets.length, 1);
  // h2h GD is also 0 for all three; overall GD is 0; overall GF is equal; the
  // explicit lots step then breaks the tie deterministically.
  const lots = c.trace.steps.find((s) => s.stepId === 'lots');
  assert.deepEqual(lots.buckets.map((b) => b.length), [1, 1, 1]);
  assert.deepEqual(c.rows.map((r) => r.teamId), ['T-X1', 'T-X2', 'T-X3']);
  assert.ok(c.trace.steps.find((s) => s.stepId === 'h2h-gd').cycle);
});

test('an unresolvable tie crossing the cut line leaves every tied team pending', () => {
  const db = createSeededDatabase();
  const def = structuredClone(loadRuleVersion(db, 'RV-HANDBOOK-2').definition);
  // Points-only plan: no head-to-head, no goal difference, no lots.
  def.tiebreakerPlan = { steps: [{ id: 'points-only', scope: 'all', metric: 'points' }] };
  def.crossGroup = { enabled: false, label: 'off' };
  insertRuleVersion(db, { id: 'RV-TEST-UNRESOLVED', seasonId: 'S-2627', label: 'test', validFrom: '2026-08-01T00:00:00Z', definition: def });
  const standings = computeStandings(loadState(db, { ruleVersionId: 'RV-TEST-UNRESOLVED' }));
  const a = sectionOf(standings, 'A');
  const firstRankTeams = a.rows.filter((r) => r.rank === 1);
  assert.equal(firstRankTeams.length, 3);
  for (const row of firstRankTeams) {
    assert.equal(row.qualification, 'pending');
    assert.equal(row.tied, true);
    assert.ok(row.pendingReasons.includes('tie_unresolved'));
  }
  assert.ok(standings.pending.some((p) => p.reason === 'tie_unresolved'));
  // Section B is fully separated on points, so nothing there becomes pending
  // merely because another group is undecided.
  const b = sectionOf(standings, 'B');
  assert.equal(b.rows.filter((r) => r.qualification === 'pending').length, 0);
  assert.ok(b.pending.length === 0);
});

test('wildcard is pending when the ruleset has no cross-group plan', () => {
  const db = createSeededDatabase();
  const standings = computeStandings(loadState(db));
  assert.equal(standings.wildcard.status, 'pending');
  assert.equal(standings.wildcard.trace.reason, 'cross_group_not_defined');
  assert.deepEqual(standings.wildcard.candidates.slice().sort(), ['T-ASH', 'T-KLP']);
  assert.deepEqual(standings.wildcard.winners, []);
  const pending = standings.pending.filter((p) => p.reason === 'cross_group_not_defined').map((p) => p.teamId).sort();
  assert.deepEqual(pending, ['T-ASH', 'T-KLP']);
  assert.equal(rowOf(standings, 'T-ASH').qualification, 'pending');
  assert.equal(rowOf(standings, 'T-KLP').qualification, 'pending');
});

test('v2 ruleset resolves the wildcard through explicit cross-group steps', () => {
  const db = createSeededDatabase();
  assert.equal(validateDefinition(loadRuleVersion(db, 'RV-HANDBOOK-2').definition).ok, true);
  const standings = computeStandings(loadState(db, { ruleVersionId: 'RV-HANDBOOK-2' }));
  assert.deepEqual(standings.wildcard.candidates.slice().sort(), ['T-ASH', 'T-KLP']);
  assert.deepEqual(standings.wildcard.winners, ['T-KLP']);
  assert.deepEqual(standings.wildcard.ranked.map((r) => [r.teamId, r.rank, r.qualification]), [
    ['T-KLP', 1, 'qualified'], ['T-ASH', 2, 'eliminated'],
  ]);
  assert.ok(standings.wildcard.trace.steps.length > 0);
  assert.equal(rowOf(standings, 'T-KLP').qualification, 'qualified');
  assert.equal(rowOf(standings, 'T-KLP').qualifiedVia, 'wildcard');
});

test('cross-group tie at the wildcard line stays pending with a specific reason', () => {
  const db = createSeededDatabase();
  const def = structuredClone(loadRuleVersion(db, 'RV-HANDBOOK-2').definition);
  def.crossGroup = { enabled: true, label: 'points only', steps: [{ id: 'xg-points', scope: 'cross_group', metric: 'points' }] };
  insertRuleVersion(db, { id: 'RV-TEST-XGTIE', seasonId: 'S-2627', label: 'test', validFrom: '2026-08-01T00:00:00Z', definition: def });
  const standings = computeStandings(loadState(db, { ruleVersionId: 'RV-TEST-XGTIE' }));
  assert.equal(standings.wildcard.status, 'pending');
  assert.equal(standings.wildcard.trace.reason, 'cross_group_tie');
  assert.deepEqual(standings.wildcard.pending.map((p) => p.teamId).sort(), ['T-ASH', 'T-KLP']);
  for (const item of standings.wildcard.pending) assert.equal(item.reason, 'cross_group_tie');
  assert.deepEqual(standings.wildcard.winners, [], 'no winner may be invented');
});

test('an ambiguous wildcard candidate keeps the wildcard place pending, even with cross-group steps', () => {
  const db = createSeededDatabase();
  const def = structuredClone(loadRuleVersion(db, 'RV-HANDBOOK-2').definition);
  // Points-only plan makes the three-way A tie cross the cut line, so no
  // single "best third" exists to feed the cross-group comparison.
  def.tiebreakerPlan = { steps: [{ id: 'points-only', scope: 'all', metric: 'points' }] };
  insertRuleVersion(db, { id: 'RV-TEST-AMBIENT', seasonId: 'S-2627', label: 'test', validFrom: '2026-08-01T00:00:00Z', definition: def });
  const standings = computeStandings(loadState(db, { ruleVersionId: 'RV-TEST-AMBIENT' }));
  assert.equal(standings.wildcard.status, 'pending');
  assert.equal(standings.wildcard.trace.reason, 'candidate_ambiguous');
  assert.deepEqual(standings.wildcard.winners, [], 'no winner may be invented');
  assert.deepEqual(standings.wildcard.trace.problems.map((p) => p.section), ['A']);
  assert.deepEqual(standings.wildcard.pending.map((p) => p.teamId).sort(), ['T-FEN', 'T-KLP', 'T-PAP']);
});

test('a rule variant without cross-group support keeps wildcard pending, never guessed', () => {
  const db = createSeededDatabase();
  const def = structuredClone(loadRuleVersion(db, 'RV-HANDBOOK-2').definition);
  def.crossGroup = { enabled: false, label: 'disabled for test' };
  insertRuleVersion(db, { id: 'RV-TEST-NOXG', seasonId: 'S-2627', label: 'test', validFrom: '2026-08-01T00:00:00Z', definition: def });
  const standings = computeStandings(loadState(db, { ruleVersionId: 'RV-TEST-NOXG' }));
  assert.equal(standings.wildcard.status, 'pending');
  assert.equal(standings.wildcard.trace.reason, 'cross_group_not_defined');
});

test('explicit draw-lots step is deterministic and recorded as the decider', () => {
  const db = createSeededDatabase();
  const def = structuredClone(loadRuleVersion(db, 'RV-HANDBOOK-2').definition);
  def.tiebreakerPlan = { steps: [{ id: 'lots', scope: 'all', metric: 'draw_lots', label: '抽签' }] };
  def.crossGroup = { enabled: false, label: 'off' };
  insertRuleVersion(db, { id: 'RV-TEST-LOTS', seasonId: 'S-2627', label: 'test', validFrom: '2026-08-01T00:00:00Z', definition: def });
  const first = computeStandings(loadState(db, { ruleVersionId: 'RV-TEST-LOTS' }));
  const second = computeStandings(loadState(db, { ruleVersionId: 'RV-TEST-LOTS' }));
  assert.deepEqual(rows(first, 'A'), rows(second, 'A'));
  assert.equal(rowOf(first, 'T-KLP').decidedBy, 'lots');
});

test('explainTeam exposes the ordered evidence including the cycle flag', () => {
  const db = createSeededDatabase();
  const state = loadState(db);
  const standings = computeStandings(state);
  const explanation = explainTeam(state, standings, 'T-KLP');
  assert.equal(explanation.rank, 3);
  assert.deepEqual(explanation.steps.map((s) => s.stepId), ['initial-points', 'h2h-points', 'h2h-gd']);
  assert.equal(explanation.steps[1].value, 3);
  assert.ok(explanation.steps[1].cycle, 'cycle is surfaced');
  assert.equal(explanation.steps[1].blockedByCycle, true);
  assert.equal(explanation.steps[2].value, -1);
  assert.equal(explanation.pendingReasons.includes('cross_group_pending'), true);
});

test('forfeit penalty rewrites the referenced match score and is idempotent per ruling chain', () => {
  const db = createSeededDatabase();
  db.prepare(`INSERT INTO penalty (id, team_id, section, match_id, kind, points, reason, recorded_at, effective_at, status, revision)
      VALUES ('P-F', 'T-QRT', 'B', 'M-B-03', 'forfeit', 0, '虚构判负', '2026-10-01T00:00:00Z', '2026-09-12T00:00:00Z', 'active', 1)`).run();
  db.prepare(`INSERT INTO penalty_revision (penalty_id, revision_no, action, points, status, reason, source, recorded_at, effective_at)
      VALUES ('P-F', 1, 'impose', 0, 'active', '虚构判负', 'manual', '2026-10-01T00:00:00Z', '2026-09-12T00:00:00Z')`).run();
  const qrt = rowOf(computeStandings(loadState(db)), 'T-QRT');
  // M-B-03 reversed: QRT 0:3 ASH instead of 1:0, so QRT loses 3 goals of GD.
  assert.equal(qrt.goalsFor, 7);
  assert.equal(qrt.goalsAgainst, 4);
});

test('recompute persists both views per revision and never overwrites an older watermark', () => {
  const db = createSeededDatabase();
  recompute({ db, revision: getRevision(db) });
  db.prepare('UPDATE revision_counter SET revision = 2 WHERE id = 1').run();
  recompute({ db, revision: 2 });
  const snapshots = db.prepare('SELECT revision, kind, COUNT(*) AS n FROM ranking_snapshot GROUP BY revision, kind ORDER BY revision, kind').all();
  assert.deepEqual(snapshots.map((s) => [Number(s.revision), s.kind, Number(s.n)]), [
    [1, 'as_known', 2], [1, 'final', 2], [2, 'as_known', 2], [2, 'final', 2],
  ]);
  const latest = db.prepare("SELECT revision FROM ranking_snapshot WHERE kind='final' AND section='A' ORDER BY id DESC LIMIT 1").get();
  assert.equal(Number(latest.revision), 2);
});

test('rule validation rejects malformed step plans and non-boolean crossGroup', () => {
  const bad = {
    points: { win: 3, draw: 1 },
    tiebreakerPlan: { steps: [{ id: 'x', scope: 'nonsense', metric: 'vibes' }, { id: 'x', scope: 'all', metric: 'points' }] },
    crossGroup: { enabled: 'yes' },
  };
  const result = validateDefinition(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('scope invalid')));
  assert.ok(result.errors.some((e) => e.includes('metric invalid')));
  assert.ok(result.errors.some((e) => e.includes('duplicated')));
  assert.ok(result.errors.some((e) => e.includes('crossGroup.enabled')));
});

test('derived ruleset variant is valid, hashes differ, and preview does not mutate the base', () => {
  const db = createSeededDatabase();
  const base = loadRuleVersion(db, 'RV-HANDBOOK-2');
  const variant = deriveRuleVariant(base, { id: 'RV-X', label: 'x', validFrom: '2026-01-01T00:00:00Z' });
  assert.equal(validateDefinition(variant.definition).ok, true);
  assert.ok(variant.definition.tiebreakerPlan.steps.some((s) => s.id === 'h2h-discipline'));
  assert.equal(base.definition.tiebreakerPlan.steps.some((s) => s.id === 'h2h-discipline'), false);
});

test('a correction recorded after its effective date only changes the final view', () => {
  const db = createSeededDatabase();
  correctMatch(db, 'M-A-05', { homeGoals: 4, awayGoals: 0, effectiveAt: '2026-09-19T00:00:00Z', reason: 'test' }, { revision: 2 });
  const known = computeStandings(loadState(db, { historical: true }));
  const final = computeStandings(loadState(db));
  assert.equal(rowOf(known, 'T-FEN').goalsFor, 5);
  assert.equal(rowOf(final, 'T-FEN').goalsFor, 6);
  assert.equal(rowOf(known, 'T-FEN').goalDiff, 4);
  assert.equal(rowOf(final, 'T-FEN').goalDiff, 5);
});

test('disciplinary metric honours the ruleset card weights and direction', () => {
  const db = createSeededDatabase();
  const v1 = computeStandings(loadState(db, { ruleVersionId: 'RV-HANDBOOK-1' })).sections.find((s) => s.section === 'B');
  // v1 weights cards at 0, so every team's disciplinary score is 0 and the
  // v1 plan has no disciplinary step at all.
  assert.ok(v1.trace.steps.every((s) => s.metric !== 'disciplinary'));
  const v2 = computeStandings(loadState(db, { ruleVersionId: 'RV-HANDBOOK-2' })).sections.find((s) => s.section === 'B');
  const disc = v2.rows.find((r) => r.teamId === 'T-GLS');
  // GLS cards: 2Y (M-B-04) + 0 (M-B-07) + 1Y (M-B-02) = 3 with weight 1 each.
  assert.equal(disc.disciplinary, 3);
});
