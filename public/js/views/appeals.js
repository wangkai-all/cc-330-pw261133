import { el, fmtTs, fmtDate, fmtNum, relTime } from '../dom.js';
import { state, teamById, refreshAppeals, refreshPenalties, notify } from '../store.js';
import { api, getRevisionNumber, newRequestId } from '../api.js';

const DRAFT_KEY = 'tdesk.appealDraft.v1';

const STATUS_LABEL = {
  open: '待受理',
  hearing: '审理中',
  upheld: '申诉成立',
  dismissed: '申诉驳回',
  partially_upheld: '部分成立',
};

const STATUS_CLASS = {
  open: 'pending',
  hearing: 'pending',
  upheld: 'qualified',
  dismissed: 'eliminated',
  partially_upheld: 'info',
};

export function renderAppeals(root, { toast, rerender }) {
  root.append(el('div', { class: 'grid two' },
    fileCard({ toast, rerender }),
    decisionCard({ toast, rerender }),
  ));
  root.append(listCard({ toast, rerender }));
  root.append(penaltyCard({ toast, rerender }));
}

/* ---------------------------------------------------------------- filing */
function fileCard({ toast, rerender }) {
  const draft = loadDraft();
  const body = el('div', { class: 'card-body' });

  const teamSelect = el('select', { name: 'teamId' },
    el('option', { value: '' }, '选择队伍…'),
    matchOptions().map((t) => el('option', { value: t.id, selected: draft.teamId === t.id }, `${t.name}（${t.section}）`)),
  );
  const targetType = el('select', { name: 'targetType' },
    el('option', { value: 'match', selected: draft.targetType !== 'penalty' }, '比赛结果'),
    el('option', { value: 'penalty', selected: draft.targetType === 'penalty' }, '处罚'),
  );
  const targetSelect = el('select', { name: 'targetId' });
  const title = el('input', { type: 'text', name: 'title', value: draft.title || '', placeholder: '例：申请更正 M-A-01 比分（虚构）' });
  const requested = el('input', { type: 'text', name: 'requestedOutcome', value: draft.requestedOutcome || '', placeholder: '例：比分改为 2:2' });
  const filedAt = el('input', { type: 'datetime-local', name: 'filedAt', value: draft.filedAt || localNow() });
  const hearingAt = el('input', { type: 'datetime-local', name: 'hearingAt', value: draft.hearingAt || '' });
  const note = el('textarea', { name: 'note', rows: '3', placeholder: '事实与理由（虚构）' }, draft.note || '');
  const savedHint = el('span', { class: 'small muted' }, draft.savedAt ? `草稿已恢复 · ${relTime(draft.savedAt)}` : '草稿自动保存到本机，可随时继续');

  function populateTargets() {
    targetSelect.replaceChildren();
    if (targetType.value === 'match') {
      for (const m of state.matchIndex || []) {
        targetSelect.append(el('option', { value: m.id, selected: draft.targetId === m.id }, `${m.id} · ${teamById(m.home).name} vs ${teamById(m.away).name}`));
      }
    } else {
      for (const p of state.penalties || []) {
        targetSelect.append(el('option', { value: p.id, selected: draft.targetId === p.id }, `${p.id} · ${teamById(p.teamId).name} · ${p.kind === 'forfeit' ? '判负' : `扣 ${p.points} 分`}`));
      }
    }
  }
  populateTargets();

  const persist = () => {
    const data = collect();
    data.savedAt = new Date().toISOString();
    localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
    savedHint.textContent = '草稿已自动保存';
    api.putDraft(`appeal:${data.teamId || 'new'}`, data).catch(() => {});
  };
  for (const control of [teamSelect, targetType, targetSelect, title, requested, filedAt, hearingAt, note]) {
    control.addEventListener('input', persist);
    control.addEventListener('change', persist);
  }
  targetType.addEventListener('change', () => { populateTargets(); persist(); });

  function collect() {
    return {
      teamId: teamSelect.value,
      targetType: targetType.value,
      targetId: targetSelect.value,
      title: title.value,
      requestedOutcome: requested.value,
      filedAt: filedAt.value,
      hearingAt: hearingAt.value,
      note: note.value,
    };
  }

  const form = el('form', { class: 'form-grid' },
    el('div', { class: 'form-row' }, el('label', {}, '申诉队伍'), teamSelect),
    el('div', { class: 'form-row' }, el('label', {}, '对象类型'), targetType),
    el('div', { class: 'form-row span-2' }, el('label', {}, '对象'), targetSelect),
    el('div', { class: 'form-row span-2' }, el('label', {}, '标题'), title),
    el('div', { class: 'form-row span-2' }, el('label', {}, '请求结果'), requested),
    el('div', { class: 'form-row' }, el('label', {}, '提交时间'), filedAt),
    el('div', { class: 'form-row' }, el('label', {}, '听证时间（可选）'), hearingAt),
    el('div', { class: 'form-row span-2' }, el('label', {}, '说明'), note),
  );
  const submit = el('button', { class: 'btn accent', type: 'submit' }, '提交申诉');
  const formActions = el('div', { class: 'form-actions' }, savedHint, submit);
  const wrap = el('div', {}, form, formActions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = collect();
    if (!data.teamId || !data.title || !data.targetId) {
      toast('请填写队伍、标题与对象', 'err');
      return;
    }
    submit.disabled = true;
    submit.replaceChildren(el('span', { class: 'spinner' }), ' 提交中');
    try {
      const payload = {
        teamId: data.teamId,
        title: data.title,
        requestedOutcome: data.requestedOutcome,
        note: data.note,
        filedAt: data.filedAt ? new Date(data.filedAt).toISOString() : undefined,
        hearingAt: data.hearingAt ? new Date(data.hearingAt).toISOString() : undefined,
        baseRevision: getRevisionNumber(),
        requestId: newRequestId('appeal'),
      };
      if (data.targetType === 'match') payload.matchId = data.targetId;
      else payload.penaltyId = data.targetId;
      await api.createAppeal(payload);
      localStorage.removeItem(DRAFT_KEY);
      await api.deleteDraft(`appeal:${data.teamId}`).catch(() => {});
      toast('申诉已登记；在裁决前不影响现有积分。');
      await refreshAppeals();
      rerender();
    } catch (error) {
      toast(error.message, 'err');
      if (error.status === 409) {
        toast(`数据已被他人更新（revision ${error.extra?.currentRevision ?? '?'}）。请刷新后重试；草稿仍在。`, 'err');
        notify('stale');
      }
    } finally {
      submit.disabled = false;
      submit.replaceChildren('提交申诉');
    }
  });

  body.append(wrap);
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {}, el('h2', {}, '录入申诉'), el('p', { class: 'subtitle' }, '申诉本身不改变积分；只有裁决并写明追溯生效日期后才进入排序')),
    ),
    body,
    el('div', { class: 'card-foot' }, '断线或刷新后可从本机草稿继续；服务端草稿用于跨设备恢复。'),
  );
}

function matchOptions() {
  return state.teams.map((t) => ({ id: t.id, name: t.name, section: t.section }));
}

function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
  } catch {
    return {};
  }
}

function localNow() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
}

/* -------------------------------------------------------------- decision */
function decisionCard({ toast, rerender }) {
  const open = state.appeals.filter((e) => e.open || e.appeal.status === 'open' || e.appeal.status === 'hearing');
  const body = el('div', { class: 'card-body' });
  if (open.length === 0) {
    body.append(el('div', { class: 'empty' }, '没有待裁决的申诉。'));
  } else {
    const select = el('select', {}, open.map((e) => el('option', { value: e.appeal.id }, `${e.appeal.id} · ${e.appeal.title}`)));
    const status = el('select', {},
      el('option', { value: 'upheld' }, '申诉成立（按请求更正）'),
      el('option', { value: 'partially_upheld' }, '部分成立'),
      el('option', { value: 'dismissed' }, '驳回（维持原判）'),
    );
    const home = el('input', { type: 'number', min: '0', step: '1', placeholder: '主队进球' });
    const away = el('input', { type: 'number', min: '0', step: '1', placeholder: '客队进球' });
    const effective = el('input', { type: 'datetime-local', value: localNow() });
    const reason = el('input', { type: 'text', placeholder: '裁决理由（虚构）' });
    const targetInfo = el('div', { class: 'callout info small' });
    const matchFields = el('div', { class: 'form-grid', style: 'margin-top:10px' },
      el('div', { class: 'form-row' }, el('label', {}, '更正后主队进球'), home),
      el('div', { class: 'form-row' }, el('label', {}, '更正后客队进球'), away),
    );
    const penaltyFields = el('div', { class: 'form-grid', style: 'margin-top:10px' },
      el('div', { class: 'form-row' }, el('label', {}, '处罚处理'),
        el('select', { name: 'penaltyAction' },
          el('option', { value: 'revoke' }, '撤销处罚'),
          el('option', { value: 'confirm' }, '维持处罚'),
        )),
      el('div', { class: 'form-row' }, el('label', {}, '扣分（如维持）'),
        el('input', { type: 'number', min: '0', step: '1', name: 'points', placeholder: '默认沿用原扣分' })),
    );

    function syncTarget() {
      const entry = state.appeals.find((e) => e.appeal.id === select.value);
      if (!entry) return;
      const isMatch = Boolean(entry.appeal.matchId);
      matchFields.style.display = isMatch ? '' : 'none';
      penaltyFields.style.display = isMatch ? 'none' : '';
      targetInfo.replaceChildren(
        el('h4', {}, isMatch ? `目标比赛 ${entry.appeal.matchId}` : `目标处罚 ${entry.appeal.penaltyId}`),
        el('div', {}, entry.appeal.title),
        el('div', { class: 'mono' }, `当前状态 ${STATUS_LABEL[entry.appeal.status] || entry.appeal.status} · 提交 ${fmtTs(entry.appeal.filedAt)}`),
      );
    }
    select.addEventListener('change', syncTarget);
    syncTarget();

    const submit = el('button', { class: 'btn accent' }, '登记裁决');
    const warn = el('div', { class: 'callout warn small', style: 'margin-top:10px' },
      el('h4', {}, '追溯生效意味着什么'),
      el('div', {}, '裁决会同时写入“记录时间”和“生效时间”。若生效时间早于记录时间，历史已知排名保持不变，最终更正排名会重算受影响分区。旧页面的确认会立即失效。'),
    );

    submit.addEventListener('click', async () => {
      const entry = state.appeals.find((e) => e.appeal.id === select.value);
      if (!entry) return;
      const payload = {
        baseRevision: getRevisionNumber(),
        requestId: newRequestId('decision'),
        status: status.value,
        reason: reason.value,
        effectiveAt: effective.value ? new Date(effective.value).toISOString() : undefined,
      };
      if (entry.appeal.matchId) {
        if (home.value === '' || away.value === '') {
          toast('比赛类申诉需填写更正后的比分', 'err');
          return;
        }
        payload.homeGoals = Number(home.value);
        payload.awayGoals = Number(away.value);
      } else {
        payload.penaltyAction = penaltyFields.querySelector('select').value;
        const pointsValue = penaltyFields.querySelector('input').value;
        if (pointsValue !== '') payload.points = Number(pointsValue);
      }
      submit.disabled = true;
      try {
        const result = await api.decideAppeal(entry.appeal.id, payload);
        toast(`裁决已登记，revision ${result.revision}；重算分区 ${result.affectedSections?.join('、') || '—'}。${result.retroactive ? '这是一次追溯更正。' : ''}`);
        await refreshAppeals();
        await refreshPenalties();
        rerender();
      } catch (error) {
        if (error.code === 'stale_revision') {
          toast(`裁决未提交：数据已被更新的裁决更新（当前 revision ${error.extra?.currentRevision ?? '?'}）。请刷新后重新确认。`, 'err');
          notify('stale');
        } else {
          toast(error.message, 'err');
        }
      } finally {
        submit.disabled = false;
      }
    });

    body.append(
      el('div', { class: 'form-grid' },
        el('div', { class: 'form-row span-2' }, el('label', {}, '选择申诉'), select),
      ),
      targetInfo,
      matchFields,
      penaltyFields,
      el('div', { class: 'form-grid', style: 'margin-top:10px' },
        el('div', { class: 'form-row' }, el('label', {}, '裁决结果'), status),
        el('div', { class: 'form-row' }, el('label', {}, '追溯生效时间'), effective),
        el('div', { class: 'form-row span-2' }, el('label', {}, '理由'), reason),
      ),
      warn,
      el('div', { class: 'form-actions' }, submit),
    );
  }
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', {}, el('h2', {}, '裁决登记'), el('p', { class: 'subtitle' }, '写入修订链，不覆盖原始记录；旧页面无法覆盖新裁决')),
      el('span', { class: 'badge mono' }, `revision ${state.revision}`),
    ),
    body,
  );
}

/* ---------------------------------------------------------------- listing */
function listCard({ toast, rerender }) {
  const body = el('div', { class: 'card-body' });
  const appeals = state.appeals;
  if (!appeals.length) {
    body.append(el('div', { class: 'empty' }, '暂无申诉记录。'));
  }
  const byId = new Map(appeals.map((e) => [e.appeal.id, e]));
  for (const entry of appeals) {
    const appeal = entry.appeal;
    const item = el('div', { class: 'appeal-item' });
    item.append(el('div', { class: 'appeal-head' },
      el('div', {},
        el('div', { class: 'appeal-title' }, appeal.title),
        el('div', { class: 'appeal-meta' },
          el('span', { class: 'mono' }, appeal.id),
          el('span', {}, teamById(appeal.teamId).name),
          el('span', {}, entry.target?.type === 'match' ? `比赛 ${entry.target.id}` : entry.target?.type === 'penalty' ? `处罚 ${entry.target.id}` : '无对象'),
          el('span', {}, `提交 ${fmtDate(appeal.filedAt)}`),
          appeal.hearingAt ? el('span', {}, `听证 ${fmtDate(appeal.hearingAt)}`) : null,
        ),
      ),
      el('span', { class: `badge ${STATUS_CLASS[appeal.status] || ''}` }, STATUS_LABEL[appeal.status] || appeal.status),
    ));
    if (appeal.note) item.append(el('div', { class: 'appeal-note' }, appeal.note));
    if (appeal.status === 'upheld' || appeal.status === 'partially_upheld') {
      const decided = entry.chain.filter((c) => c.source === appeal.id);
      if (decided.length) {
        const node = decided[decided.length - 1];
        const retro = node.effectiveAt < node.recordedAt;
        item.append(el('div', { class: 'callout', style: 'margin-top:9px' },
          el('div', { class: 'small' },
            `生效 ${fmtTs(node.effectiveAt)} · 记录 ${fmtTs(node.recordedAt)} `,
            retro ? el('span', { class: 'badge retro' }, '追溯') : el('span', { class: 'badge' }, '按期'),
          ),
          node.type === 'match'
            ? el('div', { class: 'small mono', style: 'margin-top:4px' }, `${node.matchId} → ${node.homeGoals}:${node.awayGoals}（第 ${node.revisionNo} 版）`)
            : el('div', { class: 'small mono', style: 'margin-top:4px' }, `${node.penaltyId} → ${node.action} / ${node.points} 分（第 ${node.revisionNo} 版）`),
        ));
      }
    }
    if (entry.chain.length > 1) {
      const chain = el('div', { class: 'chain' });
      entry.chain.forEach((node, i) => {
        if (i > 0) chain.append(el('span', { class: 'chain-arrow' }, '→'));
        chain.append(el('span', { class: 'chain-node', title: `记录 ${fmtTs(node.recordedAt)} · 生效 ${fmtTs(node.effectiveAt)}` },
          node.type === 'match' ? `${node.homeGoals}:${node.awayGoals}` : `${node.action}:${node.points}`));
      });
      item.append(chain);
    }
    body.append(item);
  }
  return el('section', { class: 'card', style: 'margin-top:16px' },
    el('div', { class: 'card-head' },
      el('div', {}, el('h2', {}, '申诉与修订链'), el('p', { class: 'subtitle' }, '每条裁决都保留记录时间与追溯生效时间；原始赛果不被覆盖')),
      el('button', { class: 'btn ghost sm', onclick: async () => { await refreshAppeals(); rerender(); } }, '刷新'),
    ),
    body,
  );
}

/* --------------------------------------------------------------- penalties */
function penaltyCard({ toast, rerender }) {
  const body = el('div', { class: 'card-body' });
  // Inline form to add a penalty (point deduction / forfeit).
  const team = el('select', {}, state.teams.map((t) => el('option', { value: t.id }, `${t.name}（${t.section}）`)));
  const kind = el('select', {},
    el('option', { value: 'point_deduction' }, '扣分'),
    el('option', { value: 'forfeit' }, '判负（改写比赛为 0:3）'),
  );
  const points = el('input', { type: 'number', min: '1', step: '1', value: '1', style: 'width:90px' });
  const match = el('input', { type: 'text', placeholder: '判负对应的比赛 ID（可选）' });
  const effective = el('input', { type: 'datetime-local', value: localNow() });
  const reason = el('input', { type: 'text', placeholder: '理由（虚构）' });
  const submit = el('button', { class: 'btn' }, '登记处罚');
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const result = await api.createPenalty({
        teamId: team.value,
        kind: kind.value,
        points: Number(points.value || 1),
        matchId: match.value || undefined,
        effectiveAt: effective.value ? new Date(effective.value).toISOString() : undefined,
        reason: reason.value,
        baseRevision: getRevisionNumber(),
        requestId: newRequestId('penalty'),
      });
      toast(`处罚已登记，revision ${result.revision}`);
      await refreshPenalties();
      rerender();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      submit.disabled = false;
    }
  });
  body.append(el('div', { class: 'inline-form' },
    el('div', { class: 'form-row' }, el('label', {}, '队伍'), team),
    el('div', { class: 'form-row' }, el('label', {}, '类型'), kind),
    el('div', { class: 'form-row' }, el('label', {}, '扣分'), points),
    el('div', { class: 'form-row' }, el('label', {}, '生效时间'), effective),
    el('div', { class: 'form-row', style: 'flex:2 1 220px' }, el('label', {}, '比赛 ID（判负时）'), match),
    el('div', { class: 'form-row', style: 'flex:2 1 200px' }, el('label', {}, '理由'), reason),
    submit,
  ));
  if (state.penalties.length) {
    const table = el('table', { style: 'margin-top:12px' });
    table.append(el('thead', {}, el('tr', {}, el('th', {}, '处罚'), el('th', {}, '队伍'), el('th', {}, '类型'), el('th', { class: 'num' }, '分值'), el('th', {}, '状态'), el('th', {}, '生效 / 记录'), el('th', {}, '修订'))));
    const tbody = el('tbody');
    for (const p of state.penalties) {
      tbody.append(el('tr', {},
        el('td', { class: 'mono' }, p.id),
        el('td', {}, teamById(p.teamId).name),
        el('td', {}, p.kind === 'forfeit' ? '判负' : '扣分'),
        el('td', { class: 'num' }, fmtNum(p.points)),
        el('td', {}, p.status === 'active' ? el('span', { class: 'badge qualified' }, '生效') : el('span', { class: 'badge eliminated' }, '已撤销')),
        el('td', { class: 'mono small' }, `${fmtDate(p.effectiveAt)} / ${fmtDate(p.recordedAt)}`),
        el('td', { class: 'mono' }, `${p.revisions.length} 版`),
      ));
    }
    table.append(tbody);
    body.append(table);
  }
  return el('section', { class: 'card', style: 'margin-top:16px' },
    el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, '处罚'), el('p', { class: 'subtitle' }, '扣分直接从积分扣除；判负会改写对应比赛的比分为 0:3'))),
    body,
  );
}
