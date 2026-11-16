import { createHash } from 'node:crypto';

/**
 * Fictional ruleset handling. Definitions come exclusively from the seeded
 * JSON documents; nothing here encodes a real-world competition's rules.
 */

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function hashJson(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);
}

const METRICS = new Set(['points', 'goal_diff', 'goals_for', 'wins', 'disciplinary', 'draw_lots', 'losses']);
const SCOPES = new Set(['all', 'same_section', 'head_to_head', 'cross_group']);
const DIRECTIONS = new Set(['desc', 'asc']);

/**
 * Structural validation of a fictional ruleset definition.
 * Returns { ok, errors, warnings } — errors block activation.
 */
export function validateDefinition(def, { crossGroupRequired = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!def || typeof def !== 'object') {
    return { ok: false, errors: ['definition must be an object'], warnings };
  }
  if (!def.points || typeof def.points.win !== 'number' || typeof def.points.draw !== 'number') {
    errors.push('points must define numeric win and draw');
  }
  const plan = def.tiebreakerPlan;
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    errors.push('tiebreakerPlan.steps must be a non-empty array');
  } else {
    const ids = new Set();
    plan.steps.forEach((step, index) => {
      const at = `tiebreakerPlan.steps[${index}]`;
      if (!step.id || typeof step.id !== 'string') errors.push(`${at}.id is required`);
      else if (ids.has(step.id)) errors.push(`${at}.id duplicated: ${step.id}`);
      ids.add(step.id);
      if (!SCOPES.has(step.scope)) errors.push(`${at}.scope invalid: ${step.scope}`);
      if (!METRICS.has(step.metric)) errors.push(`${at}.metric invalid: ${step.metric}`);
      if (step.direction && !DIRECTIONS.has(step.direction)) errors.push(`${at}.direction invalid: ${step.direction}`);
      if (step.scope === 'head_to_head' && step.subset && !Array.isArray(step.subset.stages)) {
        errors.push(`${at}.subset.stages must be an array when present`);
      }
    });
    const last = plan.steps[plan.steps.length - 1];
    if (last && last.metric !== 'draw_lots') {
      warnings.push('last tiebreaker step does not end in draw_lots; unresolved ties will be marked pending where they cross a cut line');
    }
  }
  if (!def.crossGroup || typeof def.crossGroup.enabled !== 'boolean') {
    errors.push('crossGroup.enabled must be a boolean');
  } else if (def.crossGroup.enabled) {
    const steps = def.crossGroup.steps;
    if (!Array.isArray(steps) || steps.length === 0) errors.push('crossGroup.steps must be a non-empty array');
    else {
      steps.forEach((step, index) => {
        const at = `crossGroup.steps[${index}]`;
        if (step.scope !== 'cross_group') errors.push(`${at}.scope must be cross_group`);
        if (!METRICS.has(step.metric)) errors.push(`${at}.metric invalid: ${step.metric}`);
        if (step.direction && !DIRECTIONS.has(step.direction)) errors.push(`${at}.direction invalid: ${step.direction}`);
      });
    }
  } else if (crossGroupRequired) {
    errors.push('this ruleset disables cross-group comparison but the season requests cross-group qualification');
  }

  // Verify no duplicate step semantics that would make later steps dead.
  return { ok: errors.length === 0, errors, warnings };
}

export function loadRuleVersions(db, seasonId) {
  return db
    .prepare('SELECT * FROM ruleset_version WHERE season_id = ? ORDER BY valid_from, id')
    .all(seasonId)
    .map(mapRuleRow);
}

export function loadRuleVersion(db, id) {
  const row = db.prepare('SELECT * FROM ruleset_version WHERE id = ?').get(id);
  return row ? mapRuleRow(row) : null;
}

export function mapRuleRow(row) {
  const definition = JSON.parse(row.definition_json);
  return {
    id: row.id,
    seasonId: row.season_id,
    label: row.label,
    validFrom: row.valid_from,
    supersedesId: row.supersedes_id,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    definition,
  };
}

export function insertRuleVersion(db, { id, seasonId, label, validFrom, definition, supersedesId = null }) {
  const hash = hashJson(definition);
  db.prepare(`INSERT INTO ruleset_version
      (id, season_id, label, valid_from, definition_json, content_hash, supersedes_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, seasonId, label, validFrom, JSON.stringify(definition), hash, supersedesId, new Date().toISOString());
  return { id, hash };
}

/**
 * A demo-only v3 used by tests and the "try another version" scenario.
 * Derived from v2: adds a head-to-head disciplinary step and a wildcard
 * cross-group step. Clearly fictional.
 */
export function deriveRuleVariant(baseDefinitionOrVersion, { id, label, validFrom }) {
  const source = baseDefinitionOrVersion?.definition ?? baseDefinitionOrVersion;
  const def = structuredClone(source);
  def.tiebreakerPlan.steps = [
    ...def.tiebreakerPlan.steps.slice(0, 2),
    { id: 'h2h-discipline', scope: 'head_to_head', metric: 'disciplinary', direction: 'asc', subset: { stages: ['group', 'playin'] }, label: '并列队伍之间纪律分（越低越好）' },
    ...def.tiebreakerPlan.steps.slice(2),
  ];
  def.crossGroup = { ...(def.crossGroup || {}), enabled: true, steps: def.crossGroup?.steps || [{ id: 'xg-points', scope: 'cross_group', metric: 'points', label: '跨组积分' }] };
  return { id, label, validFrom, definition: def };
}
