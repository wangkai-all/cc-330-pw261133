import { el, clear, $, $$, fmtTs, PENDING_REASON } from './dom.js';
import { api, getRevisionNumber } from './api.js';
import {
  state, bootstrap, loadStandings, refreshAll, activeStandings, openAppeals,
} from './store.js';
import { renderStandings, renderBasis } from './views/standings.js';
import { renderAppeals } from './views/appeals.js';
import { renderScenarios } from './views/scenarios.js';
import { renderReport } from './views/report.js';
import { renderData } from './views/data.js';

const app = $('#app');
const banners = $('#banners');
const drawer = $('#drawer');
const drawerBody = $('#drawer-body');
const drawerTitle = $('#drawer-title');
const drawerSub = $('#drawer-sub');
const toastNode = $('#toast');

let currentView = 'standings';
let reportCache = null;
let renderQueued = false;
let toastTimer = null;

const VIEW_META = {
  standings: { title: '积分与晋级', subtitle: '分组赛、加赛、处罚与申诉结果合并后的分层排序' },
  appeals: { title: '申诉与更正', subtitle: '裁决写入修订链；追溯生效日期分离历史与最终排名' },
  scenarios: { title: '情景试算', subtitle: '沙箱计算：不写正式积分、不覆盖其他情景' },
  report: { title: '版本报告', subtitle: '规则版本、历史已知与最终更正排名并列呈现' },
  data: { title: '数据与恢复', subtitle: '比赛更正、人工确认、批量导入与断点恢复' },
};

export function toast(message, kind = 'ok') {
  toastNode.textContent = message;
  toastNode.className = `toast ${kind === 'err' ? 'err' : ''}`;
  toastNode.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastNode.hidden = true; }, kind === 'err' ? 6000 : 3800);
}

async function loadMatchIndex() {
  const { matches } = await api.matches();
  state.matchIndex = matches;
}

function setView(view) {
  currentView = view;
  $$('.nav-item').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.view === view));
  const meta = VIEW_META[view];
  $('#view-title').textContent = meta.title;
  $('#view-subtitle').textContent = meta.subtitle;
  render().catch((error) => toast(error.message, 'err'));
}

function renderBanners() {
  clear(banners);
  const open = openAppeals().length;
  if (!state.booted) return;
  const wild = activeStandings()?.wildcard;
  if (state.viewMode === 'known') {
    banners.append(el('div', { class: 'banner info' },
      el('div', {}, el('strong', {}, '历史已知视图：'), '仅显示裁决生效当时公知的结果；追溯更正不计入。切换到“最终更正”查看完整更正后的排名。')));
  }
  if (state.viewMode === 'final' && state.standings?.pending?.length) {
    const reasons = [...new Set(state.standings.pending.map((p) => PENDING_REASON[p.reason] || p.reason))];
    banners.append(el('div', { class: 'banner warn' },
      el('div', {}, el('strong', {}, `${state.standings.pending.length} 处晋级仍待定：`), reasons.join('；'), '。系统不会在规则无法区分时指定晋级者。')));
  }
  if (state.viewMode === 'final' && wild?.status === 'pending' && !state.standings?.pending?.length) {
    banners.append(el('div', { class: 'banner warn' }, el('div', {}, el('strong', {}, '外卡名额待定：'), PENDING_REASON[wild.trace?.reason] || wild.trace?.reason || '')));
  }
  if (open) {
    banners.append(el('div', { class: 'banner info' },
      el('div', {}, el('strong', {}, `${open} 条申诉待裁决。`), '裁决前不会改变现有积分。'),
      el('div', { class: 'banner-actions' }, el('button', { class: 'btn ghost sm', onclick: () => setView('appeals') }, '前往处理'))));
  }
  const stale = (state.confirmations || []).filter((c) => c.stale);
  if (stale.length) {
    banners.append(el('div', { class: 'banner warn' },
      el('div', {}, el('strong', {}, `${stale.length} 个人工确认已过期：`), `确认于 revision ${stale.map((c) => c.revision).join('、')}，当前 revision ${getRevisionNumber()}。需要重新确认。`),
      el('div', { class: 'banner-actions' }, el('button', { class: 'btn ghost sm', onclick: () => setView('data') }, '去确认'))));
  }
}

async function render() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(async () => {
    renderQueued = false;
    try {
      clear(app);
      renderBanners();
      $('#revision-chip').textContent = String(getRevisionNumber());
      $('#nav-open-appeals').textContent = openAppeals().length ? String(openAppeals().length) : '';
      if (currentView === 'standings') {
        renderStandings(app, { onBasis: openBasis });
      } else if (currentView === 'appeals') {
        renderAppeals(app, { toast, rerender: () => { state.booted && rerenderAll(); } });
      } else if (currentView === 'scenarios') {
        renderScenarios(app, { toast, rerender: () => rerenderAll() });
      } else if (currentView === 'report') {
        renderReport(app, { report: reportCache, toast });
      } else if (currentView === 'data') {
        renderData(app, { toast, rerender: () => rerenderAll() });
      }
    } catch (error) {
      console.error(error);
      clear(app).append(el('div', { class: 'callout danger' }, `渲染失败：${error.message}`));
    }
  });
}

async function rerenderAll() {
  await refreshAll();
  if (currentView === 'report') reportCache = await api.report(state.rulePreview || null);
  await render();
}

async function openBasis(teamId) {
  drawer.hidden = false;
  drawerTitle.textContent = '排序依据';
  drawerSub.textContent = '';
  clear(drawerBody).append(el('div', { class: 'loading' }, '载入比较步骤…'));
  try {
    const explanation = await api.basis(teamId, { view: state.viewMode, ruleVersionId: state.rulePreview || null });
    drawerTitle.textContent = `${explanation.name} · 排序依据`;
    drawerSub.textContent = `${explanation.section} 分区 · ${state.viewMode === 'known' ? '历史已知' : '最终更正'}视图 · 规则 ${explanation.rule.id}`;
    clear(drawerBody);
    renderBasis(drawerBody, explanation);
    const timelineBtn = el('button', { class: 'btn ghost sm', style: 'margin-top:14px' }, '查看相关比赛修订');
    timelineBtn.addEventListener('click', () => showTimeline(explanation));
    drawerBody.append(timelineBtn);
  } catch (error) {
    clear(drawerBody).append(el('div', { class: 'callout danger' }, error.message));
  }
}

async function showTimeline(explanation) {
  clear(drawerBody).append(el('div', { class: 'loading' }, '载入修订链…'));
  try {
    const matches = await Promise.all((state.matchIndex || [])
      .filter((m) => m.home === explanation.teamId || m.away === explanation.teamId)
      .map((m) => api.matchTimeline(m.id)));
    clear(drawerBody);
    drawerTitle.textContent = `${explanation.name} · 比赛修订链`;
    drawerBody.append(el('button', { class: 'btn ghost sm', onclick: () => openBasis(explanation.teamId) }, '← 返回排序依据'));
    for (const tl of matches) {
      const block = el('div', { class: 'timeline', style: 'margin-top:14px' });
      for (const rev of tl.revisions) {
        block.append(el('div', { class: `timeline-item ${rev.retroactive ? 'retro' : ''}` },
          el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
            el('strong', { class: 'mono' }, `${tl.match.id} 第 ${rev.revisionNo} 版`),
            el('span', { class: 'badge mono' }, `${rev.homeGoals}:${rev.awayGoals}`),
            rev.retroactive ? el('span', { class: 'badge retro' }, '追溯') : null,
          ),
          el('div', { class: 'small muted' }, rev.reason),
          el('div', { class: 'small mono' }, `生效 ${fmtTs(rev.effectiveAt)} · 记录 ${fmtTs(rev.recordedAt)}`),
        ));
      }
      drawerBody.append(block);
    }
    if (!matches.length) drawerBody.append(el('div', { class: 'empty' }, '该队没有比赛记录。'));
  } catch (error) {
    toast(error.message, 'err');
  }
}

function closeDrawer() {
  drawer.hidden = true;
}

function bindChrome() {
  $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $$('.seg').forEach((seg) => seg.addEventListener('click', async () => {
    state.viewMode = seg.dataset.viewmode;
    $$('.seg').forEach((s) => s.classList.toggle('is-active', s === seg));
    await loadStandings();
    await render();
  }));
  $('#btn-refresh').addEventListener('click', async () => {
    try {
      await refreshAll();
      if (currentView === 'report') reportCache = await api.report(state.rulePreview || null);
      await render();
      toast('已刷新');
    } catch (error) {
      toast(error.message, 'err');
    }
  });
  $('#rule-select').addEventListener('change', async (event) => {
    state.rulePreview = event.target.value;
    try {
      await loadStandings();
      if (currentView === 'report') reportCache = await api.report(state.rulePreview || null);
      await render();
      toast(state.rulePreview ? `预览规则 ${state.rulePreview}（仅浏览，不改正式赛季设置）` : '已回到赛季默认规则');
    } catch (error) {
      toast(error.message, 'err');
    }
  });
  drawer.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-drawer]')) closeDrawer();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden) closeDrawer();
  });
  document.addEventListener('revisionchange', () => {
    $('#revision-chip').textContent = String(getRevisionNumber());
  });
}

function populateRuleSelect() {
  const select = $('#rule-select');
  clear(select);
  select.append(el('option', { value: '' }, '赛季默认'));
  for (const rule of state.ruleVersions) {
    select.append(el('option', { value: rule.id, selected: state.rulePreview === rule.id },
      `${rule.label}${rule.active ? ' · 生效中' : ''}`));
  }
}

async function boot() {
  bindChrome();
  try {
    await loadMatchIndex();
    await bootstrap();
    populateRuleSelect();
    reportCache = await api.report(state.rulePreview || null);
    await render();
  } catch (error) {
    clear(app).append(el('div', { class: 'callout danger' },
      el('h4', {}, '无法载入'), el('div', {}, error.message),
      el('div', { class: 'small', style: 'margin-top:6px' }, '请确认服务端已启动（npm start）。')));
  }
}

boot();
