import { canonicalJson, hashJson } from './rules.js';

/**
 * Standings engine for the fictional tournament.
 *
 * Design notes
 * ------------
 * - A team's table total merges: group-stage matches, play-in matches (only if
 *   the active fictional ruleset says the stage counts), penalty point
 *   deductions and forfeits, and appeal outcomes (which arrive as revised match
 *   or penalty rows in the state snapshot).
 * - Ties are resolved strictly by the ordered `tiebreakerPlan.steps` of the
 *   active ruleset. A step can restrict itself to a *subset* of matches
 *   (`head_to_head`), which is the required "对赛子集" behaviour: total goal
 *   difference alone is never used unless the plan says so.
 * - A head-to-head step that produces a cyclic pairwise result and cannot
 *   separate the tied teams is recorded as `cycle` and the engine proceeds to
 *   the next step instead of inventing an order.
 * - Cross-group comparison only happens when the ruleset has a `crossGroup`
 *   plan. Otherwise wildcard places stay explicitly pending.
 */

const OVERALL_METRICS = new Set(['points', 'goal_diff', 'goals_for', 'wins', 'losses', 'disciplinary', 'draw_lots']);

function emptyAgg() {
  return {
    played: 0, wins: 0, draws: 0, losses: 0,
    goalsFor: 0, goalsAgainst: 0, points: 0, disciplinary: 0,
  };
}

function cardWeight(rule) {
  const p = rule.definition.penalties || {};
  return {
    yellow: Number(p.yellow || 0),
    secondYellow: Number(p.secondYellow || 0),
    red: Number(p.red || 0),
  };
}

function addSide(agg, match, side, rule, context) {
  const isHome = side === 'home';
  const gf = isHome ? match.homeGoals : match.awayGoals;
  const ga = isHome ? match.awayGoals : match.homeGoals;
  const teamId = isHome ? match.home : match.away;
  const points = rule.definition.points || {};
  const forfeitBy = match.forfeitBy;
  agg.played += 1;
  agg.goalsFor += gf;
  agg.goalsAgainst += ga;
  if (forfeitBy && forfeitBy === teamId) {
    agg.losses += 1;
    agg.points += Number(points.forfeitLoss ?? points.loss ?? 0);
  } else if (forfeitBy) {
    agg.wins += 1;
    agg.points += Number(points.forfeitWin ?? points.win ?? 0);
  } else if (gf > ga) {
    agg.wins += 1;
    agg.points += Number(points.win ?? 3);
  } else if (gf === ga) {
    agg.draws += 1;
    agg.points += Number(points.draw ?? 1);
  } else {
    agg.losses += 1;
    agg.points += Number(points.loss ?? 0);
  }
  if (context === 'head_to_head' || context === 'overall' || context === 'cross_group') {
    const cards = (match.cards || {})[side] || {};
    const w = cardWeight(rule);
    agg.disciplinary +=
      Number(cards.yellow || 0) * w.yellow +
      Number(cards.secondYellow || 0) * w.secondYellow +
      Number(cards.red || 0) * w.red;
  }
}

function stageAllowed(match, plan, rule, context) {
  if (match.stage === 'group') return plan.has('group');
  if (match.stage === 'playin') {
    if (!plan.has('playin')) return false;
    const countsFor = rule.definition.playin?.countsFor || [];
    return countsFor.includes(context);
  }
  return plan.has(match.stage);
}

export function overallStages(rule) {
  const set = new Set(['group']);
  if ((rule.definition.playin?.countsFor || []).includes('overall')) set.add('playin');
  return set;
}

/** Aggregate every team's whole season (matches from any opponent). */
export function aggregateOverall(state, teamIds, rule, { sectionFilter = null } = {}) {
  const map = new Map(teamIds.map((id) => [id, emptyAgg()]));
  for (const match of state.matches) {
    if (sectionFilter && match.section !== sectionFilter) continue;
    if (!stageAllowed(match, overallStages(rule), rule, 'overall')) continue;
    if (map.has(match.home)) addSide(map.get(match.home), match, 'home', rule, 'overall');
    if (map.has(match.away)) addSide(map.get(match.away), match, 'away', rule, 'overall');
  }
  return map;
}

/** Aggregate only matches played between the given teams, in allowed stages. */
export function aggregateHeadToHead(state, teamIds, rule, step) {
  const set = new Set(teamIds);
  const map = new Map(teamIds.map((id) => [id, emptyAgg()]));
  const stages = new Set(step.subset?.stages || ['group']);
  for (const match of state.matches) {
    if (!set.has(match.home) || !set.has(match.away)) continue;
    if (!stageAllowed(match, stages, rule, 'head_to_head')) continue;
    addSide(map.get(match.home), match, 'home', rule, 'head_to_head');
    addSide(map.get(match.away), match, 'away', rule, 'head_to_head');
  }
  return map;
}

export function teamDeductions(state, teamId) {
  return state.penalties
    .filter((p) => p.teamId === teamId && p.kind === 'point_deduction' && p.status === 'active')
    .reduce((sum, p) => sum + Number(p.points || 0), 0);
}

function metricFromAgg(metric, agg) {
  switch (metric) {
    case 'points': return agg.points;
    case 'goal_diff': return agg.goalsFor - agg.goalsAgainst;
    case 'goals_for': return agg.goalsFor;
    case 'wins': return agg.wins;
    case 'losses': return agg.losses;
    case 'disciplinary': return agg.disciplinary;
    default: return null;
  }
}

function directionOf(step) {
  if (step.direction) return step.direction;
  if (step.metric === 'disciplinary' || step.metric === 'draw_lots' || step.metric === 'losses') return 'asc';
  return 'desc';
}

function compareValues(a, b, direction) {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  return direction === 'asc' ? a - b : b - a;
}

function metricValues(state, rule, step, teamIds, sectionId) {
  const values = {};
  const details = {};
  if (step.metric === 'draw_lots') {
    for (const id of teamIds) {
      const team = state.teams.find((t) => t.id === id);
      values[id] = team ? team.seedLots : 9999;
      details[id] = { lot: values[id] };
    }
    return { values, details, source: 'seed_lots' };
  }
  if (step.scope === 'head_to_head') {
    const h2h = aggregateHeadToHead(state, teamIds, rule, step);
    for (const id of teamIds) {
      const agg = h2h.get(id);
      values[id] = metricFromAgg(step.metric, agg);
      details[id] = { ...agg };
    }
    return { values, details, source: 'head_to_head', stages: step.subset?.stages || ['group'] };
  }
  // 'all' and 'cross_group' aggregate each team's whole season. 'same_section'
  // asserts the tied teams share a section, so restricting the aggregate to
  // that section is equivalent today but stays correct if cross-section
  // fixtures are ever added.
  const agg = aggregateOverall(state, teamIds, rule, {
    sectionFilter: step.scope === 'same_section' ? sectionId : null,
  });
  for (const id of teamIds) {
    const a = agg.get(id);
    let value = metricFromAgg(step.metric, a);
    if (step.metric === 'points') {
      value -= teamDeductions(state, id);
      details[id] = { ...a, deduction: teamDeductions(state, id), rawPoints: a.points };
    } else {
      details[id] = { ...a };
    }
    values[id] = value;
  }
  return { values, details, source: step.scope === 'cross_group' ? 'cross_group' : 'overall' };
}

function pairwiseEdges(state, rule, step, teamIds) {
  const edges = [];
  for (let i = 0; i < teamIds.length; i += 1) {
    for (let j = i + 1; j < teamIds.length; j += 1) {
      const a = teamIds[i];
      const b = teamIds[j];
      const agg = aggregateHeadToHead(state, [a, b], rule, step);
      const pa = agg.get(a).points;
      const pb = agg.get(b).points;
      if (pa > pb) edges.push([a, b, pa, pb]);
      else if (pb > pa) edges.push([b, a, pb, pa]);
    }
  }
  return edges;
}

function findCycle(nodes, edges) {
  const adjacency = new Map(nodes.map((n) => [n, []]));
  for (const [from, to] of edges) adjacency.get(from)?.push(to);
  const color = new Map(nodes.map((n) => [n, 0]));
  const stack = [];
  let found = null;
  const visit = (node) => {
    color.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) || []) {
      if (found) break;
      if (color.get(next) === 0) visit(next);
      else if (color.get(next) === 1) {
        const start = stack.indexOf(next);
        found = [...stack.slice(start), next];
      }
    }
    stack.pop();
    color.set(node, 2);
  };
  for (const node of nodes) {
    if (color.get(node) === 0 && !found) visit(node);
  }
  return found;
}

function splitByMetric(currentBuckets, state, rule, step, sectionId, traceSteps) {
  const next = [];
  for (const bucket of currentBuckets) {
    if (bucket.teams.length <= 1) {
      next.push(bucket);
      continue;
    }
    const { values, details, source, stages } = metricValues(state, rule, step, bucket.teams, sectionId);
    const direction = directionOf(step);
    const distinct = new Set(bucket.teams.map((id) => values[id]));
    const allEqual = distinct.size === 1;

    let cycle = null;
    let blocked = false;
    if (step.scope === 'head_to_head') {
      const path = findCycle(bucket.teams, pairwiseEdges(state, rule, step, bucket.teams));
      if (path) cycle = { path, detected: true };
      if (path && allEqual) {
        blocked = true;
        cycle.blocked = true;
      }
    }

    const trace = {
      stepId: step.id,
      label: step.label || step.id,
      scope: step.scope,
      metric: step.metric,
      direction,
      source,
      stages: stages || null,
      inputs: [...bucket.teams],
      values: { ...values },
      details,
      cycle,
      blockedByCycle: blocked,
      unresolved: allEqual && !blocked,
      buckets: [],
    };

    if (blocked) {
      trace.buckets = [bucket.teams];
      trace.note = '对赛结果形成循环，且本步指标完全相同，无法在本步排序；进入下一步。';
      traceSteps.push(trace);
      next.push(bucket);
      continue;
    }

    const sorted = [...bucket.teams].sort((a, b) => compareValues(values[a], values[b], direction) || a.localeCompare(b));
    const groups = [];
    for (const id of sorted) {
      const last = groups[groups.length - 1];
      if (last && last.value === values[id]) last.teams.push(id);
      else groups.push({ value: values[id], teams: [id] });
    }
    if (allEqual) trace.note = '本步指标完全相同，无法区分；进入下一步。';
    if (cycle && !allEqual) trace.note = '对赛关系存在循环，但本步汇总指标仍可分开并列队伍（记录供复核）。';
    trace.buckets = groups.map((g) => g.teams);
    traceSteps.push(trace);
    for (const group of groups) {
      next.push({ teams: group.teams, since: group.teams.length === 1 ? step.id : bucket.since });
    }
  }
  return next;
}

function initialBuckets(state, rule, sectionId, teams) {
  const agg = aggregateOverall(state, teams, rule, { sectionFilter: sectionId });
  const values = {};
  for (const id of teams) {
    const deduction = teamDeductions(state, id);
    values[id] = agg.get(id).points - deduction;
  }
  const sorted = [...teams].sort((a, b) => compareValues(values[a], values[b], 'desc') || a.localeCompare(b));
  const buckets = [];
  for (const id of sorted) {
    const last = buckets[buckets.length - 1];
    if (last && last.value === values[id]) last.teams.push(id);
    else buckets.push({ value: values[id], teams: [id] });
  }
  return { agg, values, buckets, trace: {
    stepId: 'initial-points',
    label: '总积分（含处罚扣分）',
    scope: 'all',
    metric: 'points',
    direction: 'desc',
    source: 'overall',
    inputs: [...teams],
    values,
    details: Object.fromEntries(teams.map((id) => [id, {
      ...agg.get(id),
      deduction: teamDeductions(state, id),
      rawPoints: agg.get(id).points,
    }])),
    buckets: buckets.map((b) => b.teams),
    unresolved: buckets.length === 1 && teams.length > 1,
    cycle: null,
    blockedByCycle: false,
  } };
}

export function computeSection(state, sectionId) {
  const sectionTeams = state.teams.filter((t) => t.section === sectionId).map((t) => t.id);
  const season = state.season;
  const rule = state.rule;
  const plan = rule.definition.tiebreakerPlan;
  const init = initialBuckets(state, rule, sectionId, sectionTeams);
  const traceSteps = [init.trace];
  let buckets = init.buckets.map((b) => ({ teams: b.teams, since: b.teams.length === 1 ? 'initial-points' : 'initial-points' }));
  const steps = plan?.steps || [];
  for (const step of steps) {
    if (!OVERALL_METRICS.has(step.metric)) continue;
    if (step.scope === 'cross_group') continue; // handled by the wildcard pass only
    buckets = splitByMetric(buckets, state, rule, step, sectionId, traceSteps);
  }

  const rows = [];
  let rank = 1;
  const pending = [];
  const boundary = [];
  for (const bucket of buckets) {
    const startPos = rank;
    const endPos = rank + bucket.teams.length - 1;
    const straddles = startPos <= season.qualSpots && endPos > season.qualSpots;
    for (const teamId of bucket.teams) {
      const team = state.teams.find((t) => t.id === teamId);
      const details = init.agg.get(teamId);
      const deduction = teamDeductions(state, teamId);
      const row = {
        teamId,
        name: team.name,
        section: sectionId,
        rank,
        tied: bucket.teams.length > 1,
        played: details.played,
        wins: details.wins,
        draws: details.draws,
        losses: details.losses,
        goalsFor: details.goalsFor,
        goalsAgainst: details.goalsAgainst,
        goalDiff: details.goalsFor - details.goalsAgainst,
        rawPoints: details.points,
        deduction,
        points: details.points - deduction,
        disciplinary: details.disciplinary,
        lots: team.seedLots,
        qualification: 'pending',
        pendingReasons: [],
        decidedBy: bucket.since,
      };
      if (endPos <= season.qualSpots) {
        row.qualification = 'qualified';
      } else if (startPos > season.qualSpots) {
        row.qualification = 'eliminated';
      } else {
        row.qualification = 'pending';
        row.pendingReasons.push('tie_unresolved');
        pending.push({
          teamId,
          rank,
          reason: 'tie_unresolved',
          detail: `并列名次 ${startPos}-${endPos} 跨越晋级线 ${season.qualSpots}，规则步骤耗尽仍未分开。`,
        });
      }
      rows.push(row);
    }
    if (straddles) boundary.push({ startPos, endPos, teams: [...bucket.teams] });
    rank = endPos + 1;
  }

  // Candidate for a cross-group wildcard: the best team(s) outside the
  // automatic spots. If the cut line itself is tied, the candidate is
  // ambiguous and must stay pending.
  // Wildcard candidate: the best-placed team(s) outside the automatic spots.
  // If the cut line itself is tied the candidate is ambiguous, and the wildcard
  // place must stay pending. Candidates are derived from the *final* bucket
  // order (rows are already materialised from that order).
  let wildcardCandidate = { ambiguous: false, teams: [] };
  const boundaryTie = boundary.length > 0;
  if (boundaryTie) {
    wildcardCandidate = { ambiguous: true, teams: [...boundary[0].teams], reason: 'tie_unresolved' };
  } else {
    const posInRows = new Map(rows.map((r, index) => [r.teamId, index]));
    const firstOut = rows.find((r) => r.rank > season.qualSpots);
    if (firstOut) {
      const targetIndex = posInRows.get(firstOut.teamId);
      const sameRank = rows.filter((r) => r.rank === firstOut.rank).map((r) => r.teamId);
      // A team is only usable as a wildcard candidate when its rank bucket is
      // a single team; otherwise the candidate is ambiguous.
      wildcardCandidate = sameRank.length > 1
        ? { ambiguous: true, teams: sameRank, reason: 'rank_tie' }
        : { ambiguous: false, teams: [rows[targetIndex].teamId] };
    }
  }

  return {
    section: sectionId,
    rows,
    pending,
    buckets: buckets.map((b) => b.teams),
    wildcardCandidate,
    trace: {
      sectionId,
      ruleVersion: rule.id,
      initialPoints: init.trace,
      steps: traceSteps.slice(1),
      finalBuckets: buckets.map((b) => b.teams),
    },
  };
}

function rankCandidateTies(state, candidates, traceSteps) {
  const cross = state.rule.definition.crossGroup;
  let buckets = [{ teams: [...candidates], since: 'cross_group_entry' }];
  const steps = cross?.enabled ? cross.steps || [] : [];
  for (const step of steps) {
    const normalized = { ...step, scope: 'cross_group' };
    buckets = splitByMetric(buckets, state, state.rule, normalized, null, traceSteps);
  }
  return buckets;
}

export function computeWildcard(state, sectionResults) {
  const season = state.season;
  const rule = state.rule;
  const slots = season.wildcardSlots || 0;
  const candidates = [];
  const problems = [];
  for (const result of sectionResults) {
    const candidate = result.wildcardCandidate;
    if (!candidate || candidate.teams.length === 0) continue;
    if (candidate.ambiguous) {
      problems.push({
        section: result.section,
        reason: candidate.reason || 'candidate_ambiguous',
        teams: candidate.teams,
      });
    } else {
      candidates.push(...candidate.teams);
    }
  }

  if (slots <= 0) {
    return { status: 'none', slots: 0, candidates: [], winners: [], ranked: [], pending: [], trace: null };
  }
  if (candidates.length === 0 && problems.length === 0) {
    return { status: 'none', slots, candidates: [], winners: [], ranked: [], pending: [], trace: null };
  }
  if (problems.length > 0) {
    const pending = problems.flatMap((p) => p.teams.map((teamId) => ({
      teamId,
      reason: 'cross_group_pending',
      detail: `分区 ${p.section} 的跨组候选因并列无法唯一确定（${p.reason}）。`,
    })));
    return {
      status: 'pending',
      slots,
      candidates,
      winners: [],
      ranked: [],
      pending,
      trace: { reason: 'candidate_ambiguous', problems },
    };
  }
  if (!rule.definition.crossGroup?.enabled) {
    const pending = candidates.map((teamId) => ({
      teamId,
      reason: 'cross_group_not_defined',
      detail: `规则 ${rule.id} 未启用跨组比较，外卡名额保留待定。`,
    }));
    return {
      status: 'pending',
      slots,
      candidates,
      winners: [],
      ranked: [],
      pending,
      trace: { reason: 'cross_group_not_defined', ruleVersion: rule.id, candidates },
    };
  }

  const traceSteps = [];
  const buckets = rankCandidateTies(state, candidates, traceSteps);
  const ranked = [];
  let rank = 1;
  for (const bucket of buckets) {
    for (const teamId of bucket.teams) ranked.push({ teamId, rank, tied: bucket.teams.length > 1 });
    rank += bucket.teams.length;
  }
  const pending = [];
  const winners = [];
  const slotsCutTie = buckets.some((bucket) => {
    const start = ranked.find((r) => bucket.teams.includes(r.teamId)).rank;
    const end = start + bucket.teams.length - 1;
    return start <= slots && end > slots;
  });
  for (const bucket of buckets) {
    const start = ranked.find((r) => bucket.teams.includes(r.teamId)).rank;
    const end = start + bucket.teams.length - 1;
    for (const teamId of bucket.teams) {
      const row = ranked.find((r) => r.teamId === teamId);
      if (end <= slots) {
        row.qualification = 'qualified';
        winners.push(teamId);
      } else if (start > slots) {
        row.qualification = 'eliminated';
      } else {
        row.qualification = 'pending';
        pending.push({
          teamId,
          reason: 'cross_group_tie',
          detail: `跨组比较后仍并列于外卡线（名次 ${start}-${end}，名额 ${slots}）。`,
        });
      }
    }
  }
  const status = pending.length > 0 ? 'pending' : 'qualified';
  return {
    status,
    slots,
    candidates,
    winners,
    ranked,
    pending,
    slotsCutTie,
    trace: {
      reason: status === 'pending' ? 'cross_group_tie' : 'resolved',
      ruleVersion: rule.id,
      steps: traceSteps,
      finalBuckets: buckets.map((b) => b.teams),
      candidates,
    },
  };
}

export function computeStandings(state) {
  const sectionResults = state.season.sections.map((section) => computeSection(state, section.id));
  const wildcard = computeWildcard(state, sectionResults);

  // Fold wildcard outcomes back into the section rows for display.
  const wildcardByTeam = new Map();
  for (const item of wildcard.ranked) wildcardByTeam.set(item.teamId, item);
  for (const result of sectionResults) {
    for (const row of result.rows) {
      if (wildcard.winners.includes(row.teamId)) {
        row.qualification = 'qualified';
        row.qualifiedVia = 'wildcard';
      } else if (wildcard.pending.some((p) => p.teamId === row.teamId)) {
        row.qualification = 'pending';
        row.pendingReasons.push('cross_group_pending');
      } else if (row.qualification === 'pending') {
        // keep section-level pending reasons
      }
    }
    if (wildcard.status === 'pending' && result.wildcardCandidate?.ambiguous) {
      for (const teamId of result.wildcardCandidate.teams) {
        const row = result.rows.find((r) => r.teamId === teamId);
        if (row && !row.pendingReasons.includes('cross_group_pending') && !wildcard.winners.includes(teamId)) {
          if (row.qualification === 'pending') row.pendingReasons.push('cross_group_pending');
        }
      }
    }
  }

  const pendingAll = [
    ...sectionResults.flatMap((r) => r.pending),
    ...wildcard.pending,
  ];
  // De-duplicate by team + reason, keep the more specific detail.
  const seen = new Set();
  const pending = [];
  for (const item of pendingAll) {
    const key = `${item.teamId}:${item.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pending.push(item);
  }

  const inputHash = hashJson({
    season: state.season.id,
    rule: state.rule.id,
    ruleHash: state.rule.contentHash,
    asOf: state.asOf,
    teams: state.teams,
    matches: state.matches.map((m) => [m.id, m.home, m.away, m.homeGoals, m.awayGoals, m.stage, m.section, m.playedAt, m.forfeitBy || null]),
    penalties: state.penalties.map((p) => [p.id, p.teamId, p.kind, p.points, p.status, p.effectiveAt]),
  });

  return {
    seasonId: state.season.id,
    ruleVersionId: state.rule.id,
    ruleLabel: state.rule.label,
    ruleHash: state.rule.contentHash,
    asOf: state.asOf,
    inputHash,
    sections: sectionResults,
    wildcard,
    pending,
  };
}

/**
 * Human-readable justification for one team, derived from the trace. Used by
 * the API (`/api/standings/:teamId/basis`) and the web UI.
 */
export function explainTeam(state, standings, teamId) {
  const section = standings.sections.find((s) => s.rows.some((r) => r.teamId === teamId));
  if (!section) return null;
  const row = section.rows.find((r) => r.teamId === teamId);
  const steps = [];
  const init = section.trace.initialPoints;
  steps.push({
    stepId: 'initial-points',
    label: init.label,
    metric: 'points',
    scope: 'all',
    value: init.values[teamId],
    bucket: init.buckets.find((b) => b.includes(teamId)),
    detail: init.details[teamId],
  });
  for (const step of section.trace.steps) {
    if (!step.inputs.includes(teamId)) continue;
    steps.push({
      stepId: step.stepId,
      label: step.label,
      metric: step.metric,
      scope: step.scope,
      direction: step.direction,
      stages: step.stages,
      value: step.values[teamId],
      inputs: step.inputs,
      bucket: step.buckets.find((b) => b.includes(teamId)) || null,
      cycle: step.cycle || null,
      blockedByCycle: step.blockedByCycle,
      note: step.note || null,
    });
  }
  return {
    teamId,
    name: row.name,
    section: section.section,
    ruleVersionId: standings.ruleVersionId,
    row,
    rank: row.rank,
    qualification: row.qualification,
    pendingReasons: row.pendingReasons,
    decidedBy: row.decidedBy,
    steps,
    wildcard: standings.wildcard.candidates.includes(teamId) || standings.wildcard.winners.includes(teamId)
      ? standings.wildcard
      : null,
  };
}

export function standingsDigest(standings) {
  return hashJson({
    rule: standings.ruleVersionId,
    sections: standings.sections.map((s) => ({ section: s.section, rows: s.rows.map((r) => [r.teamId, r.rank, r.points, r.qualification]) })),
    wildcard: { status: standings.wildcard.status, winners: standings.wildcard.winners, pending: standings.wildcard.pending },
    pending: standings.pending,
  });
}

export function diffStandings(before, after) {
  const index = (standings) => {
    const map = new Map();
    for (const section of standings.sections) {
      for (const row of section.rows) {
        map.set(row.teamId, { ...row, section: section.section });
      }
    }
    return map;
  };
  const a = index(before);
  const b = index(after);
  const changes = [];
  for (const [teamId, oldRow] of a) {
    const newRow = b.get(teamId);
    if (!newRow) continue;
    if (oldRow.rank !== newRow.rank || oldRow.points !== newRow.points || oldRow.qualification !== newRow.qualification) {
      changes.push({
        teamId,
        name: newRow.name,
        section: newRow.section,
        from: { rank: oldRow.rank, points: oldRow.points, qualification: oldRow.qualification, goalDiff: oldRow.goalDiff },
        to: { rank: newRow.rank, points: newRow.points, qualification: newRow.qualification, goalDiff: newRow.goalDiff },
      });
    }
  }
  return changes.sort((x, y) => x.section.localeCompare(y.section) || x.teamId.localeCompare(y.teamId));
}

export function snapshotFromStandings(standings) {
  return {
    seasonId: standings.seasonId,
    ruleVersionId: standings.ruleVersionId,
    ruleLabel: standings.ruleLabel,
    ruleHash: standings.ruleHash,
    asOf: standings.asOf,
    inputHash: standings.inputHash,
    sections: standings.sections.map((s) => ({
      section: s.section,
      rows: s.rows,
      pending: s.pending,
      trace: s.trace,
    })),
    wildcard: standings.wildcard,
    pending: standings.pending,
  };
}

export { canonicalJson };
