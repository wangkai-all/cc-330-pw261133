import { el, fmtTs, fmtDate, fmtNum, fmtSigned } from '../dom.js';
import { state, teamById } from '../store.js';

const STAGE_LABEL = { group: '分组赛', playin: '加赛' };

export function renderReport(root, { report, toast }) {
  if (!report) {
    root.append(el('div', { class: 'loading' }, '生成报告中…'));
    return;
  }
  root.append(summaryCard(report));
  root.append(compareCards(report));
  root.append(appealSection(report));
  root.append(correctionsSection(report));
  root.append(confirmationSection(report));
  root.append(el('div', { class: 'card-foot', style: 'border:0;color:var(--ink-3);padding:18px 0 0' },
    '本报告由虚构规则与虚构赛果生成；规则版本以内容哈希标识，报告不引用任何真实赛事条款。'));
}

function summaryCard(report) {
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {}, el('h2', {}, '版本报告'), el('p', { class: 'subtitle' }, `生成于 ${fmtTs(report.generatedAt)} · revision ${report.revision}`)),
      el('button', { class: 'btn ghost sm', onclick: () => window.print() }, '打印 / 导出 PDF'),
    ),
    el('div', { class: 'card-body' },
      el('dl', { class: 'kv' },
        el('dt', {}, '赛季'), el('dd', {}, `${report.season.name}（${report.season.id}）`),
        el('dt', {}, '生效规则'), el('dd', {}, `${report.rule.label} · ${report.rule.id} · `, el('span', { class: 'hash' }, report.rule.hash)),
        el('dt', {}, '规则版本序列'), el('dd', {}, el('div', { class: 'chip-row' }, report.rule.versions.map((v) => el('span', { class: 'badge mono' }, `${v.id} @ ${fmtDate(v.validFrom)}`)))),
        el('dt', {}, '历史已知视图'), el('dd', {}, `截至 ${fmtTs(report.historical.asOf)}（不含追溯裁决对历史的影响）`),
        el('dt', {}, '最终更正视图'), el('dd', {}, `截至 ${fmtTs(report.final.asOf)}（含全部已生效修订）`),
        el('dt', {}, '待定项'), el('dd', {}, report.pending.length ? `${report.pending.length} 项` : '无'),
      ),
    ),
  );
}

function compareCards(report) {
  const wrap = el('div', { class: 'grid two', style: 'margin-top:16px' });
  wrap.append(viewCard('历史已知排名', report.historical, 'as-known'));
  wrap.append(viewCard('最终更正排名', report.final, 'final'));
  const row = el('div', { style: 'margin-top:16px' });
  row.append(changesCard(report.changes));
  return el('div', {}, wrap, row);
}

function viewCard(title, view, kind) {
  const card = el('section', { class: 'card' });
  card.append(el('div', { class: 'card-head' },
    el('div', {}, el('h2', {}, title), el('p', { class: 'subtitle' }, kind === 'as-known' ? '裁决生效当时公知的排名' : '包含追溯更正后的排名')),
    view.pending?.length ? el('span', { class: 'badge pending' }, `${view.pending.length} 处待定`) : el('span', { class: 'badge qualified' }, '无待定'),
  ));
  const body = el('div', { class: 'card-body flush' });
  const table = el('table', { class: 'report-table' });
  table.append(el('thead', {}, el('tr', {}, el('th', {}, '分区'), el('th', {}, '#'), el('th', {}, '队伍'), el('th', { class: 'num' }, '积分'), el('th', { class: 'num' }, '净胜'), el('th', {}, '晋级'))));
  const tbody = el('tbody');
  for (const section of view.sections) {
    for (const row of section.rows) {
      tbody.append(el('tr', {},
        el('td', { class: 'mono' }, section.section),
        el('td', { class: 'mono' }, row.tied ? `=${row.rank}` : String(row.rank)),
        el('td', {}, row.name),
        el('td', { class: 'num' }, fmtNum(row.points)),
        el('td', { class: 'num' }, fmtSigned(row.goalDiff)),
        el('td', {}, el('span', { class: `badge ${row.qualification}` }, row.qualification === 'qualified' ? '晋级' : row.qualification === 'eliminated' ? '淘汰' : '待定')),
      ));
    }
  }
  table.append(tbody);
  body.append(table);
  card.append(body);
  if (view.wildcard?.slots) {
    card.append(el('div', { class: 'card-foot' },
      `外卡（${view.wildcard.slots}）：`,
      view.wildcard.winners?.length ? view.wildcard.winners.map((id) => teamById(id).name).join('、') : '待定',
      view.wildcard.trace?.reason ? ` · ${view.wildcard.trace.reason}` : '',
    ));
  }
  return card;
}

function changesCard(changes) {
  const card = el('section', { class: 'card' });
  card.append(el('div', { class: 'card-head' },
    el('div', {}, el('h2', {}, '两视图差异'), el('p', { class: 'subtitle' }, '追溯裁决造成的名次 / 积分 / 晋级变化')),
    el('span', { class: `badge ${changes.length ? 'pending' : 'qualified'}` }, changes.length ? `${changes.length} 队受影响` : '无差异'),
  ));
  const body = el('div', { class: 'card-body' });
  if (!changes.length) {
    body.append(el('div', { class: 'empty' }, '历史已知排名与最终更正排名完全一致。'));
  } else {
    const table = el('table', {});
    table.append(el('thead', {}, el('tr', {}, el('th', {}, '队伍'), el('th', {}, '已知'), el('th', {}, '更正后'), el('th', {}, '变化'))));
    const tbody = el('tbody');
    for (const c of changes) {
      tbody.append(el('tr', {},
        el('td', {}, el('div', { class: 'team-name' }, c.name), el('div', { class: 'team-id' }, `${c.section} · ${c.teamId}`)),
        el('td', { class: 'mono' }, `#${c.from.rank} · ${c.from.points} 分 · ${c.from.qualification}`),
        el('td', { class: 'mono' }, `#${c.to.rank} · ${c.to.points} 分 · ${c.to.qualification}`),
        el('td', { class: c.to.rank < c.from.rank ? 'diff-up' : 'diff-down' },
          c.to.rank < c.from.rank ? `↑${c.from.rank - c.to.rank}` : c.to.rank > c.from.rank ? `↓${c.to.rank - c.from.rank}` : '名次不变'),
      ));
    }
    table.append(tbody);
    body.append(table);
  }
  card.append(body);
  return card;
}

function appealSection(report) {
  const card = el('section', { class: 'card', style: 'margin-top:16px' });
  card.append(el('div', { class: 'card-head' },
    el('div', {}, el('h2', {}, '申诉与追溯生效'), el('p', { class: 'subtitle' }, '每条修订同时标注记录时间与生效时间；追溯条目会改变最终视图')),
    el('span', { class: 'badge mono' }, `${report.appeals.length} 条`),
  ));
  const body = el('div', { class: 'card-body' });
  if (!report.appeals.length) {
    body.append(el('div', { class: 'empty' }, '暂无申诉。'));
    card.append(body);
    return card;
  }
  const table = el('table', {});
  table.append(el('thead', {}, el('tr', {}, el('th', {}, '申诉'), el('th', {}, '状态'), el('th', {}, '目标'), el('th', {}, '生效'), el('th', {}, '记录'), el('th', {}, '性质'))));
  const tbody = el('tbody');
  for (const a of report.appeals) {
    tbody.append(el('tr', {},
      el('td', {}, el('div', { class: 'team-name' }, a.title), el('div', { class: 'team-id' }, `${a.id} · ${teamById(a.teamId).name}`)),
      el('td', {}, a.status),
      el('td', { class: 'mono' }, a.target ? `${a.target.type}:${a.target.id}` : '—'),
      el('td', { class: 'mono' }, a.effectiveAt ? fmtTs(a.effectiveAt) : '—'),
      el('td', { class: 'mono' }, a.recordedAt ? fmtTs(a.recordedAt) : '—'),
      el('td', {}, a.retroactive ? el('span', { class: 'badge retro' }, '追溯生效') : a.decisions.length ? el('span', { class: 'badge' }, '按期生效') : el('span', { class: 'badge pending' }, '未裁决')),
    ));
  }
  table.append(tbody);
  body.append(table);
  card.append(body);
  return card;
}

function correctionsSection(report) {
  const card = el('section', { class: 'card', style: 'margin-top:16px' });
  card.append(el('div', { class: 'card-head' },
    el('div', {}, el('h2', {}, '被采用的赛果更正'), el('p', { class: 'subtitle' }, '仅列出真正改变了比分或处罚状态的修订（第 2 版及以后）')),
  ));
  const body = el('div', { class: 'card-body' });
  if (!report.appliedCorrections?.length) {
    body.append(el('div', { class: 'empty' }, '没有生效的赛果更正。'));
  } else {
    const timeline = el('div', { class: 'timeline' });
    for (const c of report.appliedCorrections) {
      const retro = c.effectiveAt < c.recordedAt;
      timeline.append(el('div', { class: `timeline-item ${retro ? 'retro' : ''}` },
        el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
          el('strong', { class: 'mono' }, c.matchId),
          el('span', { class: 'badge mono' }, `第 ${c.revisionNo} 版`),
          retro ? el('span', { class: 'badge retro' }, '追溯') : null,
        ),
        el('div', { class: 'small muted' }, c.reason),
        el('div', { class: 'small mono' }, `生效 ${fmtTs(c.effectiveAt)} · 记录 ${fmtTs(c.recordedAt)} · 来源 ${c.source}`),
      ));
    }
    body.append(timeline);
  }
  card.append(body);
  return card;
}

function confirmationSection(report) {
  const card = el('section', { class: 'card', style: 'margin-top:16px' });
  card.append(el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, '人工确认记录'), el('p', { class: 'subtitle' }, '确认绑定 revision 与快照哈希；后续任何正式写入都会让旧确认过期'))));
  const body = el('div', { class: 'card-body' });
  if (!report.confirmations?.length) {
    body.append(el('div', { class: 'empty' }, '尚无人工确认。'));
  } else {
    const table = el('table', {});
    table.append(el('thead', {}, el('tr', {}, el('th', {}, '分区'), el('th', {}, 'revision'), el('th', {}, '规则'), el('th', {}, '快照哈希'), el('th', {}, '确认人'), el('th', {}, '时间'), el('th', {}, '状态'))));
    const tbody = el('tbody');
    for (const c of report.confirmations) {
      tbody.append(el('tr', {},
        el('td', {}, c.section),
        el('td', { class: 'mono' }, String(c.revision)),
        el('td', { class: 'mono' }, c.ruleVersion),
        el('td', {}, el('span', { class: 'hash' }, c.snapshotHash)),
        el('td', {}, c.confirmedBy),
        el('td', { class: 'mono small' }, fmtTs(c.createdAt)),
        el('td', {}, c.stale ? el('span', { class: 'badge pending' }, '已过期') : el('span', { class: 'badge qualified' }, '当前有效')),
      ));
    }
    table.append(tbody);
    body.append(table);
  }
  card.append(body);
  return card;
}
