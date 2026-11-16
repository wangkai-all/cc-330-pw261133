import { el, relTime } from '../dom.js';
import { api, getRevisionNumber, newRequestId } from '../api.js';
import { state, teamById, refreshScenarios } from '../store.js';

const DRAFT_KEY = 'tdesk.scenarioDraft.v1';

export function renderScenarios(root, { toast, rerender }) {
  const draft = loadDraft();
  root.append(el('div', { class: 'grid two' },
    builderCard({ toast, rerender, draft }),
    listCard({ toast, rerender }),
  ));
  root.append(resultCard());
}

function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveDraft(data) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...data, savedAt: new Date().toISOString() }));
}

function builderCard({ toast, rerender, draft }) {
  const body = el('div', { class: 'card-body' });

  const label = el('input', { type: 'text', value: draft.label || '', placeholder: '例：若 A-01 改为 0:2' });
  const ruleSelect = el('select', {},
    el('option', { value: '' }, '沿用当前生效规则'),
    (state.variants || []).map((v) => el('option', { value: v.id, selected: draft.ruleVersionId === v.id }, `${v.label}${v.derived ? '（试算变体）' : ''}`)),
  );
  const matchRows = el('div', { class: 'stack' });
  const matchOptions = el('select', {},
    (state.matchIndex || []).map((m) => el('option', { value: m.id }, `${m.id} · ${teamById(m.home).name} vs ${teamById(m.away).name}`)),
  );
  const gHome = el('input', { type: 'number', min: '0', style: 'width:76px', placeholder: '主' });
  const gAway = el('input', { type: 'number', min: '0', style: 'width:76px', placeholder: '客' });
  const addBtn = el('button', { class: 'btn ghost sm', type: 'button' }, '+ 添加假设比分');

  const matchList = [];
  function addMatchRow(prefill) {
    const id = prefill?.matchId || matchOptions.value;
    if (!id) return;
    if (matchList.some((m) => m.matchId === id)) {
      toast('该比赛已在假设列表中', 'err');
      return;
    }
    matchList.push({ ...prefill, matchId: id });
    drawMatchRows();
    persist();
  }
  function drawMatchRows() {
    matchRows.replaceChildren();
    if (!matchList.length) {
      matchRows.append(el('div', { class: 'small muted' }, '还没有假设。情景试算不会写入正式积分。'));
    }
    matchList.forEach((m, i) => {
      const h = el('input', { type: 'number', min: '0', value: m.homeGoals ?? '', style: 'width:70px' });
      const a = el('input', { type: 'number', min: '0', value: m.awayGoals ?? '', style: 'width:70px' });
      h.addEventListener('input', () => { m.homeGoals = Number(h.value); persist(); });
      a.addEventListener('input', () => { m.awayGoals = Number(a.value); persist(); });
      const info = (state.matchIndex || []).find((x) => x.id === m.matchId);
      matchRows.append(el('div', { class: 'scen-row' },
        el('div', { style: 'flex:1' },
          el('div', { class: 'scen-name' }, `${teamById(info?.home).name} vs ${teamById(info?.away).name}`),
          el('div', { class: 'scen-meta' }, `${m.matchId} · 原 ${info?.homeGoals ?? '?'}:${info?.awayGoals ?? '?'}`),
        ),
        h, el('span', { class: 'muted' }, ':'), a,
        el('button', { class: 'icon-btn', title: '移除', onclick: () => { matchList.splice(i, 1); drawMatchRows(); persist(); } }, '✕'),
      ));
    });
  }
  addBtn.addEventListener('click', () => {
    addMatchRow({ homeGoals: Number(gHome.value), awayGoals: Number(gAway.value) });
    gHome.value = '';
    gAway.value = '';
  });

  function persist() {
    saveDraft({ label: label.value, ruleVersionId: ruleSelect.value, matches: matchList });
  }
  label.addEventListener('input', persist);
  ruleSelect.addEventListener('change', persist);

  const runBtn = el('button', { class: 'btn accent' }, '运行试算');
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runBtn.replaceChildren(el('span', { class: 'spinner' }), ' 计算中');
    try {
      const variant = (state.variants || []).find((v) => v.id === ruleSelect.value);
      const payload = {
        label: label.value || '未命名情景',
        baseRevision: getRevisionNumber(),
        matches: matchList.filter((m) => Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals)),
      };
      if (ruleSelect.value) {
        payload.ruleVersionId = ruleSelect.value;
        if (variant?.derived) payload.derivedRule = { id: variant.id, label: variant.label, validFrom: variant.validFrom, definition: variant.definition };
      }
      const result = await api.runScenario(payload);
      state.lastScenario = result.scenario;
      state.selectedScenarioIds = [result.scenario.scenarioId];
      await refreshScenarios();
      toast(`试算完成：与正式排名相比 ${result.scenario.diffs.length} 处变化。未写入正式积分。`);
      rerender();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = '运行试算';
    }
  });

  drawMatchRows();
  body.append(
    el('div', { class: 'form-grid' },
      el('div', { class: 'form-row span-2' }, el('label', {}, '情景名称'), label),
      el('div', { class: 'form-row span-2' }, el('label', {}, '使用的规则版本'), ruleSelect),
    ),
    el('div', { class: 'section-title', style: 'margin:14px 0 6px' }, el('h2', {}, '假设比分'), el('span', { class: 'hint' }, '只影响本次试算')),
    el('div', { class: 'inline-form' }, matchOptions, gHome, gAway, addBtn),
    matchRows,
    el('div', { class: 'callout info small', style: 'margin-top:12px' },
      el('h4', {}, '沙箱保证'),
      el('div', {}, '试算在内存副本上执行：不写比赛、不写处罚、不写排名快照，也不递增正式 revision。多个情景可同时运行，互不覆盖。'),
    ),
    el('div', { class: 'form-actions' }, el('span', { class: 'small muted' }, '结果保留在情景历史中，可对比'), runBtn),
  );

  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {}, el('h2', {}, '情景试算'), el('p', { class: 'subtitle' }, '假设赛果或换用其他规则版本，观察排名与晋级如何变化')),
      el('span', { class: 'badge mono' }, `base revision ${state.revision}`),
    ),
    body,
  );
}

function listCard({ toast, rerender }) {
  const body = el('div', { class: 'card-body' });
  const scenarios = state.scenarios || [];
  if (!scenarios.length) {
    body.append(el('div', { class: 'empty' }, '还没有运行过情景。'));
  } else {
    const selected = new Set(state.selectedScenarioIds || []);
    const list = el('div', { class: 'scen-list' });
    for (const s of scenarios) {
      const isSel = selected.has(s.id);
      list.append(el('div', { class: `scen-row ${isSel ? 'is-selected' : ''}` },
        el('div', { style: 'flex:1;cursor:pointer', onclick: () => {
          state.selectedScenarioIds = isSel
            ? (state.selectedScenarioIds || []).filter((id) => id !== s.id)
            : [...(state.selectedScenarioIds || []), s.id].slice(-2);
          rerender();
        } },
          el('div', { class: 'scen-name' }, s.label),
          el('div', { class: 'scen-meta' }, `${s.ruleVersionId} · base ${s.baseRevision} · ${relTime(s.createdAt)}`),
        ),
        el('button', { class: 'basis-btn', onclick: async () => {
          try {
            const full = await api.scenario(s.id);
            state.lastScenario = full.result;
            state.selectedScenarioIds = [s.id];
            rerender();
          } catch (e) { toast(e.message, 'err'); }
        } }, '查看'),
      ));
    }
    body.append(list);
    const chosen = state.selectedScenarioIds || [];
    const compareBtn = el('button', { class: 'btn ghost sm', disabled: chosen.length !== 2 }, '对比所选两个情景');
    compareBtn.addEventListener('click', async () => {
      try {
        const comparison = await api.compareScenarios(chosen[0], chosen[1]);
        state.lastComparison = comparison;
        rerender();
      } catch (e) { toast(e.message, 'err'); }
    });
    body.append(el('div', { style: 'margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:8px' },
      el('span', { class: 'small muted' }, chosen.length === 2 ? '已选两个情景' : '选择两个情景可对比'),
      compareBtn,
    ));
  }
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, '情景历史'), el('p', { class: 'subtitle' }, '只保存情景输入与结果，不触碰正式数据'))),
    body,
  );
}

function resultCard() {
  const scenario = state.lastScenario;
  const comparison = state.lastComparison;
  const card = el('section', { class: 'card', style: 'margin-top:16px' });
  const head = el('div', { class: 'card-head' },
    el('div', {}, el('h2', {}, comparison ? '情景对比' : '试算结果'),
      el('p', { class: 'subtitle' }, comparison
        ? `${comparison.left.label} ↔ ${comparison.right.label}`
        : scenario ? `${scenario.label} · 规则 ${scenario.ruleVersionId}` : '运行或选择一个情景后显示')),
  );
  if (comparison) head.append(el('span', { class: 'badge info' }, comparison.sameResult ? '两情景结果相同' : `${comparison.differences.length} 处差异`));
  else if (scenario) head.append(el('span', { class: 'badge mono' }, `base revision ${scenario.baseRevision}`));
  card.append(head);
  const body = el('div', { class: 'card-body' });

  if (comparison) {
    if (!comparison.differences.length) {
      body.append(el('div', { class: 'empty' }, '两个情景的排名、积分与晋级结果完全一致。'));
    } else {
      const table = el('table', {});
      table.append(el('thead', {}, el('tr', {}, el('th', {}, '队伍'), el('th', {}, '左：名次/积分'), el('th', {}, '右：名次/积分'), el('th', {}, '变化'))));
      const tbody = el('tbody');
      for (const d of comparison.differences) {
        tbody.append(el('tr', {},
          el('td', {}, el('div', { class: 'team-name' }, d.name), el('div', { class: 'team-id' }, d.teamId)),
          el('td', { class: 'mono' }, `${d.left.rank} / ${d.left.points} · ${d.left.qualification}`),
          el('td', { class: 'mono' }, `${d.right.rank} / ${d.right.points} · ${d.right.qualification}`),
          el('td', { class: d.right.rank < d.left.rank ? 'diff-up' : d.right.rank > d.left.rank ? 'diff-down' : 'diff-flat' },
            d.right.rank < d.left.rank ? `↑ ${d.left.rank - d.right.rank}` : d.right.rank > d.left.rank ? `↓ ${d.right.rank - d.left.rank}` : '名次不变'),
        ));
      }
      table.append(tbody);
      body.append(table);
    }
    card.append(body);
    return card;
  }

  if (!scenario) {
    body.append(el('div', { class: 'empty' }, '尚无结果。使用左侧表单运行情景，或从历史中查看。'));
    card.append(body);
    return card;
  }

  const formal = state.standings;
  if (scenario.ruleChanged) {
    body.append(el('div', { class: 'callout info' },
      el('h4', {}, '规则版本不同'),
      el('div', {}, `正式排名使用 ${formal.ruleVersionId}，本情景使用 ${scenario.ruleVersionId}。差异可能来自规则本身，而不只是假设比分。`),
    ));
  }
  if (scenario.rejected?.length) {
    body.append(el('div', { class: 'callout warn', style: 'margin-top:10px' },
      el('h4', {}, `${scenario.rejected.length} 条假设未被采用`),
      el('ul', {}, scenario.rejected.map((r) => el('li', {}, `${r.type} ${r.matchId || r.penaltyId || ''}：${r.reason}`))),
    ));
  }
  const changeTable = el('table', { style: 'margin-top:10px' });
  changeTable.append(el('thead', {}, el('tr', {}, el('th', {}, '队伍'), el('th', {}, '正式'), el('th', {}, '情景'), el('th', {}, '晋级变化'))));
  const tbody = el('tbody');
  const byTeam = new Map(scenario.diffs.map((d) => [d.teamId, d]));
  for (const section of scenario.sections) {
    for (const row of section.rows) {
      const diff = byTeam.get(row.teamId);
      tbody.append(el('tr', {},
        el('td', {}, el('div', { class: 'team-name' }, row.name), el('div', { class: 'team-id' }, `${section.section} · ${row.teamId}`)),
        el('td', { class: 'mono' }, diff ? `${diff.from.rank} / ${diff.from.points}` : `${row.rank} / ${row.points}`),
        el('td', { class: 'mono' }, `${row.tied ? '=' : ''}${row.rank} / ${row.points} · ${row.qualification}`),
        el('td', {}, diff ? el('span', { class: `badge ${diff.to.rank < diff.from.rank ? 'qualified' : diff.to.rank > diff.from.rank ? 'pending' : 'info'}` },
          `${diff.from.qualification} → ${diff.to.qualification}`) : el('span', { class: 'muted small' }, '无变化')),
      ));
    }
  }
  changeTable.append(tbody);
  body.append(changeTable);
  if (scenario.pending?.length) {
    body.append(el('div', { class: 'callout warn', style: 'margin-top:12px' },
      el('h4', {}, '情景中的待定项'),
      el('ul', {}, scenario.pending.map((p) => el('li', {}, `${teamById(p.teamId).name}：${p.reason}`))),
    ));
  }
  card.append(body);
  card.append(el('div', { class: 'card-foot' }, '情景结果只是假设；正式积分、快照与确认均未改变。'));
  return card;
}
