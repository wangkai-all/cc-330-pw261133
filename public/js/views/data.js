import { el, fmtTs, fmtDate, relTime } from '../dom.js';
import { state, teamById, refreshConfirmations, refreshAll } from '../store.js';
import { api, getRevisionNumber, newRequestId } from '../api.js';

export function renderData(root, { toast, rerender, report }) {
  root.append(el('div', { class: 'grid two' },
    matchesCard({ toast, rerender }),
    confirmCard({ toast, rerender }),
  ));
  root.append(importCard({ toast, rerender }));
  root.append(draftsCard({ toast }));
  root.append(auditCard({ report }));
}

function matchesCard({ toast, rerender }) {
  const card = el('section', { class: 'card' });
  card.append(el('div', { class: 'card-head' },
    el('div', {}, el('h2', {}, '比赛与更正'), el('p', { class: 'subtitle' }, '原始记录不可覆盖；更正写入修订链并标注生效时间')),
  ));
  const body = el('div', { class: 'card-body flush' });
  const table = el('table', {});
  table.append(el('thead', {}, el('tr', {}, el('th', {}, '比赛'), el('th', {}, '阶段'), el('th', {}, '比分'), el('th', { class: 'num' }, '版本'), el('th', {}, ''))));
  const tbody = el('tbody');
  for (const m of state.matchIndex || []) {
    tbody.append(el('tr', {},
      el('td', {}, el('div', { class: 'team-name' }, `${teamById(m.home).name} vs ${teamById(m.away).name}`), el('div', { class: 'team-id' }, `${m.id} · ${fmtDate(m.playedAt)}`)),
      el('td', {}, m.stage === 'playin' ? el('span', { class: 'badge info' }, '加赛') : el('span', { class: 'badge' }, '分组赛')),
      el('td', { class: 'mono' }, `${m.homeGoals}:${m.awayGoals}`),
      el('td', { class: 'num mono' }, `${m.revisionCount} 版`),
      el('td', {}, el('button', { class: 'basis-btn', onclick: () => openCorrection(m, { toast, rerender }) }, '更正')),
    ));
  }
  table.append(tbody);
  body.append(table);
  card.append(body);
  return card;
}

function openCorrection(match, { toast, rerender }) {
  const dialog = el('div', { class: 'drawer' });
  const close = () => dialog.remove();
  const home = el('input', { type: 'number', min: '0', value: String(match.homeGoals) });
  const away = el('input', { type: 'number', min: '0', value: String(match.awayGoals) });
  const effective = el('input', { type: 'datetime-local', value: new Date(match.playedAt).toISOString().slice(0, 16) });
  const reason = el('input', { type: 'text', placeholder: '更正理由（虚构）' });
  const submit = el('button', { class: 'btn accent' }, '写入更正');
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const result = await api.correctMatch(match.id, {
        homeGoals: Number(home.value),
        awayGoals: Number(away.value),
        effectiveAt: effective.value ? new Date(effective.value).toISOString() : undefined,
        reason: reason.value,
        baseRevision: getRevisionNumber(),
        requestId: newRequestId('correction'),
      });
      toast(`已写入更正（revision ${result.revision}）${result.correction?.retroactive ? '，追溯生效' : ''}`);
      close();
      await refreshAll();
      rerender();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      submit.disabled = false;
    }
  });
  dialog.append(
    el('div', { class: 'drawer-scrim', onclick: close }),
    el('section', { class: 'drawer-panel', role: 'dialog', 'aria-modal': 'true' },
      el('header', { class: 'drawer-head' },
        el('div', {}, el('h2', {}, `更正 ${match.id}`), el('p', { class: 'subtitle' }, `${teamById(match.home).name} vs ${teamById(match.away).name} · 当前 ${match.homeGoals}:${match.awayGoals}`)),
        el('button', { class: 'icon-btn', onclick: close }, '✕'),
      ),
      el('div', { class: 'drawer-body' },
        el('div', { class: 'form-grid' },
          el('div', { class: 'form-row' }, el('label', {}, '主队进球'), home),
          el('div', { class: 'form-row' }, el('label', {}, '客队进球'), away),
          el('div', { class: 'form-row span-2' }, el('label', {}, '生效时间（可早于现在 = 追溯）'), effective),
          el('div', { class: 'form-row span-2' }, el('label', {}, '理由'), reason),
        ),
        el('div', { class: 'callout warn', style: 'margin-top:12px' },
          el('h4', {}, '旧结果无法覆盖新裁决'),
          el('div', {}, '若在提交前其他页面已登记新裁决，本次更正会以 stale revision 被拒绝，原始草稿仍保留在表单中。'),
        ),
        el('div', { class: 'form-actions' }, submit),
      ),
    ),
  );
  document.body.append(dialog);
}

function confirmCard({ toast, rerender }) {
  const card = el('section', { class: 'card' });
  card.append(el('div', { class: 'card-head' },
    el('div', {}, el('h2', {}, '人工确认'), el('p', { class: 'subtitle' }, '确认当前 revision 的最终排名；任何后续正式写入都会使其过期')),
  ));
  const body = el('div', { class: 'card-body' });
  const sections = state.season?.sections || [];
  const sectionSelect = el('select', {}, sections.map((s) => el('option', { value: s.id }, `${s.id} · ${s.label}`)));
  const note = el('input', { type: 'text', placeholder: '备注（可空）' });
  const submit = el('button', { class: 'btn' }, '确认当前排名');
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const result = await api.confirm({
        section: sectionSelect.value,
        note: note.value,
        baseRevision: getRevisionNumber(),
        requestId: newRequestId('confirm'),
      });
      toast(`已确认分区 ${result.confirmation.section} 在 revision ${result.confirmation.revision} 的排名`);
      await refreshConfirmations();
      rerender();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      submit.disabled = false;
    }
  });
  body.append(el('div', { class: 'inline-form' }, sectionSelect, note, submit));
  if (state.confirmations?.length) {
    const table = el('table', { style: 'margin-top:12px' });
    table.append(el('thead', {}, el('tr', {}, el('th', {}, '分区'), el('th', {}, 'revision'), el('th', {}, '哈希'), el('th', {}, '时间'), el('th', {}, '状态'))));
    const tbody = el('tbody');
    for (const c of state.confirmations) {
      tbody.append(el('tr', {},
        el('td', {}, c.section),
        el('td', { class: 'mono' }, String(c.revision)),
        el('td', {}, el('span', { class: 'hash' }, c.snapshotHash)),
        el('td', { class: 'mono small' }, fmtTs(c.createdAt)),
        el('td', {}, c.stale ? el('span', { class: 'badge pending' }, '已过期，请重新确认') : el('span', { class: 'badge qualified' }, '有效')),
      ));
    }
    table.append(tbody);
    body.append(table);
  }
  card.append(body);
  return card;
}

function importCard({ toast, rerender }) {
  const card = el('section', { class: 'card', style: 'margin-top:16px' });
  card.append(el('div', { class: 'card-head' },
    el('div', {}, el('h2', {}, '批量录入与断点恢复'), el('p', { class: 'subtitle' }, '每条应用一次正式写入；中断后可从游标继续，不会重复记账')),
  ));
  const body = el('div', { class: 'card-body' });
  const textarea = el('textarea', { rows: '6', style: 'width:100%;font-family:var(--mono);font-size:11.5px', placeholder: '[{"id":"M-A-90","section":"A","home":"T-KLP","away":"T-DUN","homeGoals":1,"awayGoals":1,"playedAt":"2026-10-10"}]' });
  const createBtn = el('button', { class: 'btn ghost sm' }, '创建批次');
  createBtn.addEventListener('click', async () => {
    let items;
    try {
      items = JSON.parse(textarea.value);
    } catch {
      toast('JSON 解析失败', 'err');
      return;
    }
    try {
      const batch = await api.createImport({ label: `批量录入 ${new Date().toLocaleString('zh-CN')}`, items });
      toast(`批次 ${batch.id} 已创建，共 ${batch.total} 条`);
      rerender();
    } catch (error) {
      toast(error.message, 'err');
    }
  });
  body.append(textarea, el('div', { class: 'form-actions' },
    el('span', { class: 'small muted' }, '导入项必须是合法比赛；不合法的条目会使批次失败并记录错误'), createBtn));
  body.append(el('div', { id: 'import-list', class: 'stack', style: 'margin-top:12px' }, el('div', { class: 'empty' }, '载入批次中…')));
  api.imports().then(({ imports }) => {
    const list = body.querySelector('#import-list');
    if (!list) return;
    list.replaceChildren();
    if (!imports.length) {
      list.append(el('div', { class: 'empty' }, '暂无导入批次。'));
      return;
    }
    for (const batch of imports) {
      const applyBtn = el('button', { class: 'btn sm', disabled: batch.status === 'complete' || batch.status === 'failed' },
        batch.status === 'complete' ? '已完成' : '应用下一条');
      applyBtn.addEventListener('click', async () => {
        applyBtn.disabled = true;
        try {
          const res = await api.applyImport(batch.id);
          toast(res.import ? `已应用第 ${res.import.index + 1}/${res.import.total} 条` : '批次已完成');
          await refreshAll();
          rerender();
        } catch (error) {
          toast(error.message, 'err');
          rerender();
        }
      });
      list.append(el('div', { class: 'scen-row' },
        el('div', { style: 'flex:1' },
          el('div', { class: 'scen-name' }, batch.label),
          el('div', { class: 'scen-meta' }, `${batch.id} · ${batch.cursor}/${batch.total} · ${batch.status}${batch.error ? ` · ${batch.error}` : ''}`),
        ),
        applyBtn,
        batch.status !== 'complete' ? el('button', { class: 'btn ghost sm', onclick: async () => { for (let i = 0; i < 50; i += 1) { const r = await api.applyImport(batch.id); if (r.import?.status === 'complete' || r.alreadyComplete) break; } await refreshAll(); rerender(); } }, '全部应用') : null,
      ));
    }
  }).catch((error) => {
    toast(`载入批次失败：${error.message}`, 'err');
  });
  card.append(body);
  return card;
}

function draftsCard({ toast }) {
  const card = el('section', { class: 'card', style: 'margin-top:16px' });
  card.append(el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, '恢复点'), el('p', { class: 'subtitle' }, '服务端保存的草稿与本地草稿；刷新/断线后可继续未完成的操作'))));
  const body = el('div', { class: 'card-body' });
  const local = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key && key.startsWith('tdesk.')) {
      try {
        local.push({ key, value: JSON.parse(localStorage.getItem(key)) });
      } catch { /* ignore */ }
    }
  }
  if (local.length) {
    const table = el('table', {});
    table.append(el('thead', {}, el('tr', {}, el('th', {}, '本地草稿'), el('th', {}, '保存时间'), el('th', {}, ''))));
    const tbody = el('tbody');
    for (const item of local) {
      tbody.append(el('tr', {},
        el('td', { class: 'mono' }, item.key),
        el('td', { class: 'mono small' }, item.value?.savedAt ? relTime(item.value.savedAt) : '—'),
        el('td', {}, el('button', { class: 'basis-btn', onclick: () => { localStorage.removeItem(item.key); toast('已清除本地草稿；刷新以更新列表'); document.dispatchEvent(new CustomEvent('draftschange')); } }, '清除')),
      ));
    }
    table.append(tbody);
    body.append(table);
    body.append(el('div', { class: 'small muted', style: 'margin-top:6px' }, '本地草稿只保存在此浏览器；服务端草稿在“申诉”页自动同步。'));
  } else {
    body.append(el('div', { class: 'empty' }, '本地没有未完成的草稿。'));
  }
  card.append(body);
  return card;
}

function auditCard({ report }) {
  const card = el('section', { class: 'card', style: 'margin-top:16px' });
  card.append(el('div', { class: 'card-head' }, el('div', {}, el('h2', {}, '审计事件'), el('p', { class: 'subtitle' }, '正式写入、情景运行与草稿保存均留痕'))));
  const body = el('div', { class: 'card-body flush' });
  const table = el('table', {});
  table.append(el('thead', {}, el('tr', {}, el('th', {}, 'revision'), el('th', {}, '动作'), el('th', {}, '对象'), el('th', {}, '操作者'), el('th', {}, '时间'))));
  const tbody = el('tbody');
  tbody.append(el('tr', {}, el('td', { colspan: '5' }, el('div', { class: 'empty' }, '载入审计事件…'))));
  table.append(tbody);
  body.append(table);
  card.append(body);
  api.audit(40).then(({ entries }) => {
    tbody.replaceChildren();
    if (!entries.length) {
      tbody.append(el('tr', {}, el('td', { colspan: '5' }, el('div', { class: 'empty' }, '暂无审计事件。'))));
      return;
    }
    for (const entry of entries) {
      tbody.append(el('tr', {},
        el('td', { class: 'mono' }, entry.revision === null ? '—' : String(entry.revision)),
        el('td', { class: 'mono' }, entry.action),
        el('td', { class: 'mono small' }, entry.target),
        el('td', {}, entry.actor),
        el('td', { class: 'mono small' }, fmtTs(entry.createdAt)),
      ));
    }
  }).catch(() => {
    tbody.replaceChildren(el('tr', {}, el('td', { colspan: '5' }, el('div', { class: 'empty' }, '审计事件载入失败。'))));
  });
  return card;
}
