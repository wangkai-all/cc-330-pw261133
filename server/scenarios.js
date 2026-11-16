import { randomUUID } from 'node:crypto';
import { nowIso, transaction, audit } from './db.js';
import { loadState, mutateState, loadSeason } from './state.js';
import { computeStandings, diffStandings } from './standings.js';
import { hashJson, loadRuleVersion, deriveRuleVariant } from './rules.js';

/**
 * Scenario sandbox.
 *
 * A scenario is computed entirely from an in-memory copy of the state (the
 * database itself is only READ to build that copy) and persisted as a
 * `scenario_run` row. Formal tables (match, match_revision, penalty,
 * ranking_snapshot, confirmation, revision_counter) are never written from
 * this module. The caller can therefore run several scenarios concurrently
 * without them interfering with each other or with formal record keeping.
 */

export function scenarioRule(db, seasonId, ruleVersionId, derived) {
  if (!ruleVersionId) return null;
  const stored = loadRuleVersion(db, ruleVersionId);
  if (stored) return stored;
  if (derived && derived.id === ruleVersionId) {
    return {
      id: derived.id,
      seasonId,
      label: derived.label,
      validFrom: derived.validFrom,
      contentHash: hashJson(derived.definition),
      definition: derived.definition,
      derived: true,
    };
  }
  return null;
}

export function runScenario(db, input, { persist = true, actor = 'desk' } = {}) {
  const seasonId = input.seasonId || 'S-2627';
  const season = loadSeason(db, seasonId);
  if (!season) throw Object.assign(new Error(`season not found: ${seasonId}`), { code: 'NOT_FOUND' });
  const baseRevision = Number(input.baseRevision ?? db.prepare('SELECT revision FROM revision_counter WHERE id = 1').get().revision);
  const derived = input.derivedRule || null;
  const ruleOverride = scenarioRule(db, seasonId, input.ruleVersionId, derived);
  if (input.ruleVersionId && !ruleOverride) {
    throw Object.assign(new Error(`unknown rule version: ${input.ruleVersionId}`), { code: 'BAD_INPUT' });
  }
  if (derived && !input.ruleVersionId) {
    // A derived variant must be referenced explicitly.
    throw Object.assign(new Error('derivedRule requires ruleVersionId'), { code: 'BAD_INPUT' });
  }

  const formal = computeStandings(loadState(db, { seasonId }));
  const baseState = loadState(db, { seasonId });
  if (ruleOverride) baseState.rule = ruleOverride;

  const { state, applied, rejected } = mutateState(baseState, {
    matches: input.matches || [],
    penalties: input.penalties || [],
    addMatches: input.addMatches || [],
  });
  const scenario = computeStandings(state);

  const result = {
    scenarioId: randomUUID(),
    label: input.label || '未命名情景',
    baseRevision,
    ruleVersionId: state.rule.id,
    ruleLabel: state.rule.label,
    ruleHash: state.rule.contentHash,
    asOf: state.asOf,
    applied,
    rejected,
    sections: scenario.sections,
    wildcard: scenario.wildcard,
    pending: scenario.pending,
    diffs: diffStandings(formal, scenario),
    formalRuleVersionId: formal.ruleVersionId,
    ruleChanged: formal.ruleVersionId !== state.rule.id,
    inputHash: hashJson({ input, baseRevision }),
  };

  if (persist) {
    transaction(db, () => {
      db.prepare(`INSERT INTO scenario_run
          (id, label, base_revision, rule_version, scenario_json, result_json, input_hash, created_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'complete')`)
        .run(result.scenarioId, result.label, baseRevision, result.ruleVersionId, JSON.stringify(input), JSON.stringify(result), result.inputHash, nowIso());
      audit(db, baseRevision, 'scenario_run', result.scenarioId, actor, { label: result.label, baseRevision });
    });
  }

  return result;
}

export function listScenarios(db, { limit = 50 } = {}) {
  return db.prepare('SELECT id, label, base_revision, rule_version, input_hash, created_at, status FROM scenario_run ORDER BY created_at DESC LIMIT ?')
    .all(Number(limit))
    .map((row) => ({
      id: row.id,
      label: row.label,
      baseRevision: Number(row.base_revision),
      ruleVersionId: row.rule_version,
      inputHash: row.input_hash,
      createdAt: row.created_at,
      status: row.status,
    }));
}

export function getScenario(db, id) {
  const row = db.prepare('SELECT * FROM scenario_run WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    baseRevision: Number(row.base_revision),
    ruleVersionId: row.rule_version,
    scenario: JSON.parse(row.scenario_json),
    result: JSON.parse(row.result_json),
    createdAt: row.created_at,
    status: row.status,
  };
}

export function compareScenarios(db, leftId, rightId) {
  const left = getScenario(db, leftId);
  const right = getScenario(db, rightId);
  if (!left || !right) return null;
  const index = (scenario) => {
    const map = new Map();
    for (const section of scenario.result.sections) {
      for (const row of section.rows) map.set(row.teamId, { ...row, section: section.section });
    }
    return map;
  };
  const a = index(left);
  const b = index(right);
  const teams = [...new Set([...a.keys(), ...b.keys()])].sort();
  const differences = [];
  for (const teamId of teams) {
    const l = a.get(teamId);
    const r = b.get(teamId);
    if (!l || !r) continue;
    const changed = l.rank !== r.rank || l.points !== r.points || l.goalDiff !== r.goalDiff || l.qualification !== r.qualification;
    if (changed) {
      differences.push({
        teamId,
        name: l.name,
        section: l.section,
        left: { rank: l.rank, points: l.points, goalDiff: l.goalDiff, qualification: l.qualification },
        right: { rank: r.rank, points: r.points, goalDiff: r.goalDiff, qualification: r.qualification },
      });
    }
  }
  return {
    left: { id: left.id, label: left.label, ruleVersionId: left.ruleVersionId, baseRevision: left.baseRevision },
    right: { id: right.id, label: right.label, ruleVersionId: right.ruleVersionId, baseRevision: right.baseRevision },
    differences,
    wildcard: { left: left.result.wildcard.status, right: right.result.wildcard.status },
    sameResult: differences.length === 0,
  };
}

/** Utility for tests + UI: list the fictional variants this build can preview. */
export function ruleVariantsFor(db, seasonId = 'S-2627') {
  const season = loadSeason(db, seasonId);
  const active = loadRuleVersion(db, season.ruleVersionId);
  const all = db.prepare('SELECT * FROM ruleset_version WHERE season_id = ? ORDER BY valid_from, id').all(seasonId);
  const variants = all.map((row) => ({
    id: row.id,
    label: row.label,
    validFrom: row.valid_from,
    active: row.id === season.ruleVersionId,
    hash: row.content_hash,
  }));
  if (active) {
    const derived = deriveRuleVariant(active.definition, { id: `${active.id}-PREVIEW`, label: `${active.label} · 试算变体`, validFrom: nowIso() });
    variants.push({
      id: derived.id,
      label: derived.label,
      validFrom: derived.validFrom,
      active: false,
      derived: true,
      definition: derived.definition,
    });
  }
  return variants;
}
