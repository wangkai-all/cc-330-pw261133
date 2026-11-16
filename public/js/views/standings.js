import { el, fmtNum, fmtSigned, qualBadge, PENDING_REASON } from '../dom.js';
import { state, activeStandings, teamById } from '../store.js';

const METRIC_LABEL = {
  points: '积分',
  goal_diff: '净胜球',
  goals_for: '进球',
  wins: '胜场',
  losses: '负场',
  disciplinary: '纪律分',
  draw_lots: '抽签序位',
};

const SCOPE_LABEL = {
  all: '全组',
  same_section: '同分区',
  head_to_head: '对赛子集',
  cross_group: '跨组',
};

export function renderStandings(root, { onBasis }) {
  const standings = activeStandings();
  if (!standings) {
    root.append(el('div', { class: 'loading' }, '暂无排名'));
    return;
  }
  const sectionWrap = el('div', { class: 'grid two' });
  for (const section of standings.sections) {
    sectionWrap.append(sectionCard(section, standings, onBasis));
  }
  root.append(sectionWrap);
  root.append(wildcardCard(standings));
}

function sectionCard(section, standings, onBasis) {
  const qualSpots = state.season?.qualSpots ?? 2;
  const rows = section.rows;
  const cutAfter = rows.filter((r) => r.rank <= qualSpots).length;
  const body = el('div', { class: 'card-body flush' });
  const table = el('table', {});
  table.append(el('thead', {}, el('tr', {},
    el('th', { class: 'num' }, '#'),
    el('th', {}, '队伍'),
    el('th', { class: 'num', title: '已赛' }, '赛'),
    el('th', { class: 'num' }, '胜'),
    el('th', { class: 'num' }, '平'),
    el('th', { class: 'num' }, '负'),
    el('th', { class: 'num' }, '进球'),
    el('th', { class: 'num' }, '失球'),
    el('th', { class: 'num' }, '净胜'),
    el('th', { class: 'num', title: '含处罚扣分后的积分' }, '积分'),
    el('th', {}, '状态'),
    el('th', {}, ''),
  )));
  const tbody = el('tbody');
  rows.forEach((row, index) => {
    const isCut = index === cutAfter - 1 && cutAfter < rows.length;
    const tr = el('tr', { class: isCut ? 'cutline' : '' });
    tr.append(
      el('td', { class: `rank-cell ${row.tied ? 'tied' : ''}` }, row.tied ? `=${row.rank}` : String(row.rank)),
      el('td', {}, el('div', { class: 'who' },
        el('div', {},
          el('div', { class: 'team-name' }, row.name),
          el('div', { class: 'team-id' }, row.teamId),
        ),
        row.tied ? el('span', { class: 'badge', title: '与同组队伍完全并列' }, '并列') : null,
      )),
      el('td', { class: 'num' }, fmtNum(row.played)),
      el('td', { class: 'num' }, fmtNum(row.wins)),
      el('td', { class: 'num' }, fmtNum(row.draws)),
      el('td', { class: 'num' }, fmtNum(row.losses)),
      el('td', { class: 'num' }, fmtNum(row.goalsFor)),
      el('td', { class: 'num' }, fmtNum(row.goalsAgainst)),
      el('td', { class: 'num' }, fmtSigned(row.goalDiff)),
      el('td', { class: 'num' }, el('strong', {}, fmtNum(row.points)),
        row.deduction ? el('span', { class: 'team-id', title: `原始 ${row.rawPoints} 分，扣 ${row.deduction} 分` }, ` −${row.deduction}`) : null),
      el('td', {}, qualBadge(row)),
      el('td', {}, el('button', {
        class: 'basis-btn', title: '查看该队的排序依据',
        onclick: () => onBasis(row.teamId),
      }, '依据')),
    );
    tbody.append(tr);
  });
  table.append(tbody);
  body.append(table);

  const tieCount = rows.filter((r) => r.tied).length;
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {},
        el('h2', {}, `${section.section} · ${state.season?.sections?.find((s) => s.id === section.section)?.label || ''}`),
        el('p', { class: 'subtitle' }, `前 ${qualSpots} 名晋级；规则 ${standings.ruleVersionId}`),
      ),
      el('div', { class: 'chip-row' },
        tieCount ? el('span', { class: 'badge pending' }, `${tieCount} 队并列`) : null,
        section.pending.length ? el('span', { class: 'badge pending' }, `${section.pending.length} 处待定`) : el('span', { class: 'badge qualified' }, '已分清'),
      ),
    ),
    body,
    el('div', { class: 'card-foot' },
      el('span', {}, `已赛 ${rows.reduce((n, r) => n + r.played, 0)} 场`),
      el('span', {}, `抽签序位用于最后一步，非净胜球`),
      section.pending.length ? el('span', { class: 'badge pending' }, section.pending.map((p) => PENDING_REASON[p.reason] || p.reason).join(' / ')) : null,
    ),
  );
}

function wildcardCard(standings) {
  const wild = standings.wildcard;
  const slots = wild.slots || 0;
  if (!slots) {
    return el('section', { class: 'card', style: 'margin-top:16px' },
      el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, '外卡名额'), el('p', { class: 'subtitle' }, '本赛季未设置跨组外卡名额'))) ,
    );
  }
  const statusBadge = wild.status === 'qualified'
    ? el('span', { class: 'badge qualified' }, '已确定')
    : el('span', { class: 'badge pending' }, '待定');

  const body = el('div', { class: 'card-body' });
  if (wild.status === 'none') {
    body.append(el('div', { class: 'empty' }, '没有符合条件的外卡候选。'));
  } else if (wild.status === 'pending') {
    const reason = wild.trace?.reason;
    body.append(el('div', { class: 'callout warn' },
      el('h4', {}, `外卡名额保留待定（${PENDING_REASON[reason] || reason || '未知原因'}）`),
      el('div', {}, wild.pending.length
        ? `涉及队伍：${wild.pending.map((p) => teamById(p.teamId).name).join('、')}。在规则允许的比较全部完成前不会指定晋级者。`
        : '规则不足以唯一确定候选，已保留待定。'),
      wild.trace?.problems ? el('ul', {}, wild.trace.problems.map((p) => el('li', {}, `${p.section} 分区：${PENDING_REASON[p.reason] || p.reason}（${p.teams.map((t) => teamById(t).name).join('、')}）`))) : null,
    ));
  } else {
    body.append(el('div', { class: 'callout info' },
      el('h4', {}, `按规则跨组步骤确定 ${wild.winners.length} 个外卡名额`),
      el('div', {}, `晋级：${wild.winners.map((id) => teamById(id).name).join('、')}`),
    ));
  }
  if (wild.candidates?.length) {
    const table = el('table', {});
    table.append(el('thead', {}, el('tr', {},
      el('th', {}, '候选'), el('th', {}, '分区'), el('th', { class: 'num' }, '跨组名次'), el('th', {}, '结果'),
    )));
    const tbody = el('tbody');
    const byTeam = new Map((wild.ranked || []).map((r) => [r.teamId, r]));
    for (const teamId of wild.candidates) {
      const team = teamById(teamId);
      const rankInfo = byTeam.get(teamId);
      const pending = (wild.pending || []).find((p) => p.teamId === teamId);
      tbody.append(el('tr', {},
        el('td', {}, el('div', { class: 'team-name' }, team.name), el('div', { class: 'team-id' }, team.id)),
        el('td', {}, team.section),
        el('td', { class: 'num' }, rankInfo ? fmtNum(rankInfo.rank) : '—'),
        el('td', {}, pending
          ? el('span', { class: 'badge pending' }, PENDING_REASON[pending.reason] || pending.reason)
          : wild.winners.includes(teamId)
            ? el('span', { class: 'badge qualified' }, '外卡晋级')
            : el('span', { class: 'badge eliminated' }, '未获外卡')),
      ));
    }
    // Candidates that were excluded because their own section cut line is
    // ambiguous still need to be visible.
    for (const problem of wild.trace?.problems || []) {
      for (const teamId of problem.teams) {
        if (wild.candidates.includes(teamId)) continue;
        const team = teamById(teamId);
        tbody.append(el('tr', {},
          el('td', {}, el('div', { class: 'team-name' }, team.name), el('div', { class: 'team-id' }, team.id)),
          el('td', {}, team.section),
          el('td', { class: 'num' }, '—'),
          el('td', {}, el('span', { class: 'badge pending' }, '组内并列，候选未定')),
        ));
      }
    }
    table.append(tbody);
    body.append(el('div', { class: 'mini-table', style: 'margin-top:12px' }, table));
  }
  if (wild.trace?.steps?.length) {
    body.append(el('details', { style: 'margin-top:12px' },
      el('summary', { class: 'small muted', style: 'cursor:pointer' }, '跨组比较步骤'),
      traceSteps(wild.trace.steps, new Map()),
    ));
  }
  return el('section', { class: 'card', style: 'margin-top:16px' },
    el('div', { class: 'card-head' },
      el('div', {}, el('h2', {}, `外卡名额 · ${slots} 个`), el('p', { class: 'subtitle' }, '仅当规则显式启用跨组步骤时才比较不同分区')),
      statusBadge,
    ),
    body,
  );
}

export function traceSteps(steps, nameById) {
  const list = el('div', { class: 'stepper' });
  steps.forEach((step, index) => {
    const isCycle = Boolean(step.cycle);
    const blocked = Boolean(step.blockedByCycle);
    const node = el('div', { class: `step ${isCycle ? 'cycle' : ''} ${blocked ? 'blocked' : ''}` },
      el('div', { class: 'step-num' }, String(index + 1)),
      el('div', {},
        el('div', { class: 'step-head' },
          el('span', { class: 'step-title' }, step.label || step.stepId),
          el('span', { class: 'step-meta' }, `${SCOPE_LABEL[step.scope] || step.scope} · ${METRIC_LABEL[step.metric] || step.metric} · ${step.direction === 'asc' ? '越小越好' : '越大越好'}`),
          step.stages ? el('span', { class: 'step-meta' }, `子集：${step.stages.join(' + ')}`) : null,
          isCycle ? el('span', { class: 'badge cycle' }, blocked ? '循环 · 无法分解' : '循环 · 已记录') : null,
          step.unresolved ? el('span', { class: 'badge pending' }, '指标相同') : null,
        ),
        step.note ? el('div', { class: 'step-note' }, step.note) : null,
        step.cycle?.path ? el('div', { class: 'step-meta', style: 'margin-top:5px' }, `循环路径：${step.cycle.path.map((id) => nameById.get(id) || id).join(' → ')}`) : null,
        el('div', { class: 'buckets' }, (step.buckets || []).map((bucket) => el('div', { class: 'bucket' },
          el('b', {}, bucket.map((id) => step.values?.[id] ?? '').join(' / ')),
          el('span', {}, bucket.map((id) => nameById.get(id) || id).join('、')),
        ))),
        step.values && Object.keys(step.values).length > 4 ? el('details', { style: 'margin-top:6px' },
          el('summary', { class: 'step-meta', style: 'cursor:pointer' }, '各队指标值'),
          el('div', { class: 'mini-table' }, metricTable(step, nameById)),
        ) : null,
      ),
    );
    list.append(node);
  });
  return list;
}

function metricTable(step, nameById) {
  const table = el('table', {});
  table.append(el('thead', {}, el('tr', {}, el('th', {}, '队伍'), el('th', { class: 'num' }, METRIC_LABEL[step.metric] || step.metric))));
  const tbody = el('tbody');
  for (const teamId of step.inputs || []) {
    tbody.append(el('tr', {},
      el('td', {}, nameById.get(teamId) || teamId),
      el('td', { class: 'num' }, fmtNum(step.values?.[teamId])),
    ));
  }
  table.append(tbody);
  return table;
}

/** The "why is this team here" panel content. */
export function renderBasis(body, explanation, onShowTimeline) {
  const { row } = explanation;
  const nameById = new Map(state.teams.map((t) => [t.id, t.name]));
  const head = el('div', { class: 'stack' });
  head.append(el('div', { class: 'callout' },
    el('h4', {}, `${row.name} · 第 ${row.tied ? `=${row.rank}` : row.rank} 名`),
    el('div', { class: 'small' }, `${explanation.section} 分区 · ${row.points} 分（原始 ${row.rawPoints}${row.deduction ? `，扣 ${row.deduction}` : ''}） · 净胜 ${fmtSigned(row.goalDiff)} · 进球 ${row.goalsFor}`),
    el('div', { style: 'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap' },
      qualBadge(row),
      el('span', { class: 'badge mono' }, `决定步骤：${row.decidedBy}`),
      el('span', { class: 'badge mono' }, `规则 ${explanation.rule.id}`),
    ),
    row.pendingReasons?.length ? el('div', { class: 'small', style: 'margin-top:7px;color:var(--amber)' },
      `待定原因：${row.pendingReasons.map((r) => PENDING_REASON[r] || r).join('；')}`) : null,
  ));
  if (explanation.steps.length) {
    head.append(el('div', { class: 'section-title', style: 'margin:6px 0 0' }, el('h2', {}, '逐层比较'), el('span', { class: 'hint' }, '只有出现在并列集合中的步骤才会列出')));
    head.append(traceSteps(explanation.steps.map((s, i) => ({
      stepId: s.stepId, label: s.label, scope: s.scope, metric: s.metric, direction: s.direction,
      stages: s.stages, values: s.value !== undefined ? { [explanation.teamId]: s.value } : (s.detail || {}),
      inputs: s.inputs || [explanation.teamId],
      buckets: s.bucket ? [s.bucket] : [],
      cycle: s.cycle, blockedByCycle: s.blockedByCycle, note: s.note,
      unresolved: s.note?.includes('相同'),
    })), nameById));
  }
  if (explanation.wildcard) {
    head.append(el('div', { class: 'callout info', style: 'margin-top:14px' },
      el('h4', {}, '外卡比较'),
      el('div', {}, `状态：${explanation.wildcard.status === 'qualified' ? '已确定' : '待定'}；候选：${(explanation.wildcard.candidates || []).map((id) => nameById.get(id) || id).join('、') || '无'}`),
    ));
  }
  body.append(head);
}
