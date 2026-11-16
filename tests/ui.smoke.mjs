/**
 * Web smoke test: loads the real public/index.html into a DOM, then boots the
 * real front-end modules in Node against a live server. jsdom does not execute
 * `<script type="module">`, so the modules are imported directly — the same
 * code path the browser takes.
 *
 * The test writes through the UI (files an appeal, runs scenarios, confirms
 * standings), so run it against a throwaway database:
 *
 *   npm run seed -- --reset
 *   PORT=8799 QUIET=1 node server/index.js &
 *   npm run test:ui        # BASE_URL defaults to http://127.0.0.1:8799
 */
import { readFileSync } from 'node:fs';

// jsdom is a dev-only dependency: it provides the DOM, never the app logic.
let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.error('需要 jsdom 才能运行网页冒烟测试：npm i -D jsdom');
  process.exit(2);
}

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8799';
try {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  if (!health.ok) throw new Error('not ok');
} catch {
  console.error(`无法连接 ${BASE}，请先启动服务端：PORT=8799 QUIET=1 node server/index.js`);
  process.exit(2);
}
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: `${BASE}/`, pretendToBeVisual: true });
const { window } = dom;

// ---- browser globals ------------------------------------------------------
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.localStorage = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null; },
  setItem(key, value) { this.store.set(key, String(value)); },
  removeItem(key) { this.store.delete(key); },
  key(index) { return [...this.store.keys()][index] ?? null; },
  get length() { return this.store.size; },
  clear() { this.store.clear(); },
};
Object.defineProperty(window, 'localStorage', { value: globalThis.localStorage, configurable: true });
window.HTMLElement.prototype.scrollIntoView = () => {};
// Simulate a browser that previously talked to a database at a much higher
// revision (now reseeded). A full page load must resync downward, otherwise
// every subsequent write would be rejected as stale.
globalThis.localStorage.setItem('tdesk.revision', '9999');
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => realFetch(new URL(input, BASE), init);
window.fetch = globalThis.fetch;

const failures = [];
const notes = [];
const check = (label, ok, detail = '') => {
  if (ok) notes.push(`  ✓ ${label}`);
  else failures.push(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};
const pageErrors = [];
window.addEventListener('error', (e) => pageErrors.push(e.message));
const origError = console.error;
console.error = (...args) => {
  pageErrors.push(args.map((a) => (a && a.stack) || String(a)).join(' '));
  origError(...args);
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => [...window.document.querySelectorAll(sel)];
const text = (node) => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');
const waitFor = async (fn, label) => {
  for (let i = 0; i < 80; i += 1) {
    const value = fn();
    if (value) return value;
    await wait(60);
  }
  throw new Error(`timeout waiting for ${label}`);
};

// ---- boot the real app ----------------------------------------------------
await import('../public/js/app.js');
await waitFor(() => $$('table tbody tr').length > 0, 'standings table');

console.log('— 首页 —');
check('标题渲染', text($('#view-title')) === '积分与晋级', text($('#view-title')));
check('导航 5 个视图', $$('.nav-item').length === 5, String($$('.nav-item').length));
check('排名表行数 ≥ 10', $$('table tbody tr').length >= 10, String($$('table tbody tr').length));
check('revision 显示', /^\d+$/.test(text($('#revision-chip'))), text($('#revision-chip')));
check('页面加载会与服务器 revision 重新同步（不沿用旧缓存）', text($('#revision-chip')) !== '9999', text($('#revision-chip')));
check('待定横幅出现', text($('#banners')).includes('待定'), text($('#banners')));
check('列头包含净胜', text($('table thead')).includes('净胜'));
check('外卡卡片存在', text($('#app')).includes('外卡名额'), text($('#app')).slice(0, 80));

console.log('— 排序依据抽屉 —');
const klpRow = $$('table tbody tr').find((tr) => tr.textContent.includes('北岸汽笛'));
check('找到并列队伍行', Boolean(klpRow));
klpRow.querySelector('.basis-btn').click();
await waitFor(() => $('#drawer-body .stepper'), 'basis stepper');
check('抽屉打开', !$('#drawer').hidden);
check('抽屉标题含队伍名', text($('#drawer-title')).includes('北岸汽笛'), text($('#drawer-title')));
const drawerText = text($('#drawer-body'));
check('列出初始积分步骤', drawerText.includes('总积分'), drawerText.slice(0, 120));
check('列出对赛子集步骤', drawerText.includes('对赛子集'));
check('循环被标记', $$('#drawer-body .badge.cycle').length > 0 || drawerText.includes('循环'), `badges=${$$('#drawer-body .badge.cycle').length}`);
check('显示各步指标值', $$('#drawer-body .bucket').length > 0, String($$('#drawer-body .bucket').length));
$('[data-close-drawer]').click();
check('抽屉可关闭', $('#drawer').hidden);

console.log('— 申诉视图 —');
$$('.nav-item').find((b) => b.dataset.view === 'appeals').click();
await waitFor(() => $('form'), 'appeal form');
check('表单存在', Boolean($('form')));
check('申诉列表 ≥ 3', $$('.appeal-item').length >= 3, String($$('.appeal-item').length));
const appealCountBefore = $$('.appeal-item').length;
const targetType = $('select[name="targetType"]');
targetType.value = 'penalty';
targetType.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(30);
check('对象类型切换后出现处罚选项', $$('select[name="targetId"] option').some((o) => o.textContent.includes('P-01')));

$('select[name="teamId"]').value = 'T-SLT';
$('select[name="teamId"]').dispatchEvent(new window.Event('change', { bubbles: true }));
targetType.value = 'match';
targetType.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(30);
$('select[name="targetId"]').value = 'M-A-07';
$('select[name="targetId"]').dispatchEvent(new window.Event('change', { bubbles: true }));
$('input[name="title"]').value = `UI 冒烟：申请更正 M-A-07（虚构 ${Date.now()}）`;
$('input[name="title"]').dispatchEvent(new window.Event('input', { bubbles: true }));
$('textarea[name="note"]').value = '由 DOM 测试写入。';
const appealTitle = $('input[name="title"]').value;
$('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
await waitFor(() => text($('#app')).includes(appealTitle), 'appeal appears in list');
check('提交后出现提示', !$('#toast').hidden, text($('#toast')));
check('新申诉出现在列表', text($('#app')).includes(appealTitle));
check('申诉列表至少增加一条', $$('.appeal-item').length >= appealCountBefore + 1, `${appealCountBefore} → ${$$('.appeal-item').length}`);
check('本地草稿已清除', !window.localStorage.getItem('tdesk.appealDraft.v1'));
const appealsList = await (await fetch(`${BASE}/api/appeals`)).json();
const myAppeal = appealsList.appeals.find((e) => e.appeal.title === appealTitle);
const appealId = myAppeal?.appeal.id || '';
check('新申诉已登记到服务端', Boolean(myAppeal), appealTitle);

console.log('— 申诉裁决 —');
// Decide the appeal filed above. The decision must insert a retroactive
// revision, move the final view and leave the historical view untouched.
const beforeKnown = await (await fetch(`${BASE}/api/standings?view=known`)).json();
const decideCard = $$('#app .card').find((c) => text(c.querySelector('h2')) === '裁决登记');
check('裁决卡存在', Boolean(decideCard));
const decideSelect = decideCard ? [...decideCard.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value.startsWith('AP-'))) : null;
check('裁决表单列出待裁决申诉', Boolean(decideSelect), String($$('select').length));
if (decideSelect && appealId) {
  decideSelect.value = appealId;
  decideSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(50);
  const goals = [...decideCard.querySelectorAll('input[type="number"][placeholder="主队进球"]')];
  const awayGoals = [...decideCard.querySelectorAll('input[type="number"][placeholder="客队进球"]')];
  check('比赛类申诉出现比分输入', goals.length > 0 && awayGoals.length > 0);
  if (goals.length && awayGoals.length) {
    // Pick a score that differs from the current one, so the assertion below
    // still holds when the smoke test is re-run without reseeding.
    const currentMatches = await (await fetch(`${BASE}/api/matches`)).json();
    const target = currentMatches.matches.find((m) => m.id === 'M-A-07');
    goals[0].value = String((target?.homeGoals ?? 0) + 1);
    awayGoals[0].value = '0';
    const effective = decideCard.querySelector('input[type="datetime-local"]');
    if (effective) {
      effective.value = '2026-09-01T00:00';
      effective.dispatchEvent(new window.Event('input', { bubbles: true }));
    }
    const reason = [...decideCard.querySelectorAll('input[type="text"]')].find((i) => i.placeholder?.includes('裁决理由'));
    if (reason) reason.value = 'UI 冒烟：追溯更正（虚构）';
    const decideBtn = [...decideCard.querySelectorAll('.btn.accent')].find((b) => b.textContent.includes('登记裁决'));
    check('登记裁决按钮存在', Boolean(decideBtn));
    if (decideBtn) {
      decideBtn.click();
      await waitFor(() => text($('#toast')).includes('裁决已登记') || text($('#toast')).includes('追溯'), 'decision toast');
      check('裁决写入并提示追溯', text($('#toast')).includes('追溯') || text($('#toast')).includes('裁决已登记'), text($('#toast')));
      await wait(400);
      check('申诉状态变为已裁决', /申诉成立|部分成立/.test(text($('#app'))));
      const afterKnown = await (await fetch(`${BASE}/api/standings?view=known`)).json();
      const timeline = await (await fetch(`${BASE}/api/matches/M-A-07/timeline`)).json();
      const applied = timeline.revisions.filter((r) => r.source?.startsWith('AP-'));
      check('裁决向修订链追加了追溯版本', applied.length > 0 && applied.at(-1).retroactive === true, JSON.stringify(applied.at(-1) || {}));
      const knownRow = afterKnown.table.find((r) => r.teamId === 'T-SLT');
      check('历史已知排名不受追溯影响', JSON.stringify(afterKnown.table) === JSON.stringify(beforeKnown.table), JSON.stringify(knownRow));
    }
  }
}

console.log('— 情景视图 —');
$$('.nav-item').find((b) => b.dataset.view === 'scenarios').click();
const runBtn = await waitFor(() => $$('.btn.accent').find((b) => b.textContent.includes('运行试算')), 'scenario run button');
runBtn.click();
await waitFor(() => text($('#app')).includes('试算结果'), 'scenario result');
check('结果卡出现', text($('#app')).includes('试算结果'));
check('沙箱说明存在', text($('#app')).includes('未改变') || text($('#app')).includes('假设'));
check('情景历史存在', text($('#app')).includes('情景历史'));

console.log('— 情景对比 —');
// Run a second scenario with a different rule version, then compare the two.
// The builder renders the rule select before the hypothetical-match select.
const ruleSelect = $$('#app select').find((s) => [...s.options].some((o) => o.value === 'RV-HANDBOOK-2'));
check('情景页有规则版本选择', Boolean(ruleSelect), String($$('#app select').length));
const variantOption = [...ruleSelect.options].find((o) => o.value === 'RV-HANDBOOK-2');
const historyCount = () => $$('.scen-row').filter((r) => r.querySelector('.basis-btn')).length;
const settle = async (maxRounds = 8) => {
  let last = '';
  let rounds = 0;
  for (let i = 0; i < 3; i += 1) {
    await wait(120);
    const snapshot = `${historyCount()}:${$$('.scen-row.is-selected').length}`;
    if (snapshot !== last && rounds < maxRounds) {
      last = snapshot;
      rounds += 1;
      i = -1;
    }
  }
};
if (variantOption) {
  // Give each run a unique label so this block works on a reused database
  // (the history endpoint returns at most 50 rows).
  const labelInput = $$('#app input[type="text"]').find((i) => i.placeholder?.includes('例：若'));
  const secondLabel = `第二情景 ${Date.now()}`;
  if (labelInput) {
    labelInput.value = secondLabel;
    labelInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  ruleSelect.value = variantOption.value;
  ruleSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  await wait(30);
  $$('.btn.accent').find((b) => b.textContent.includes('运行试算')).click();
  await waitFor(() => text($('#app')).includes(secondLabel), 'second scenario in history');
  await settle();
  const viewButtons = $$('.scen-row .basis-btn');
  check('情景历史有查看按钮', viewButtons.length >= 2, String(viewButtons.length));

  // Select a second scenario from history and compare. Every render replaces
  // the list, so re-query nodes between steps and wait for the DOM to settle.
  const unselected = $$('.scen-row')
    .filter((r) => r.querySelector('.basis-btn'))
    .find((r) => !r.classList.contains('is-selected'));
  check('情景历史有未选中的行', Boolean(unselected));
  if (unselected) {
    unselected.firstElementChild.click();
    await settle();
    check('已选两条情景', $$('.scen-row.is-selected').length === 2, String($$('.scen-row.is-selected').length));

    const compareBtn = $$('.btn').find((b) => b.textContent.includes('对比所选两个情景'));
    check('对比按钮可用', Boolean(compareBtn) && !compareBtn.disabled);
    if (compareBtn) compareBtn.click();
    let compared = false;
    for (let i = 0; i < 40 && !compared; i += 1) {
      await wait(80);
      compared = text($('#app')).includes('情景对比');
    }
    check('对比结果卡出现', compared);
    check('对比给出差异或“完全一致”', /处差异|完全一致/.test(text($('#app'))));
  }
}

console.log('— 报告视图 —');
$$('.nav-item').find((b) => b.dataset.view === 'report').click();
await waitFor(() => text($('#app')).includes('历史已知排名'), 'report');
const reportText = text($('#app'));
check('历史已知排名卡', reportText.includes('历史已知排名'));
check('最终更正排名卡', reportText.includes('最终更正排名'));
check('差异卡', reportText.includes('两视图差异'));
check('规则哈希', Boolean($('.hash')), text($('.hash')));
check('申诉与追溯生效', reportText.includes('申诉与追溯生效'));
check('采用更正时间线', reportText.includes('被采用的赛果更正'));
check('人工确认', reportText.includes('人工确认记录'));

console.log('— 数据视图 —');
$$('.nav-item').find((b) => b.dataset.view === 'data').click();
await waitFor(() => text($('#app')).includes('人工确认'), 'data view');
const dataText = text($('#app'));
check('比赛与更正卡', dataText.includes('比赛与更正'));
check('人工确认卡', dataText.includes('人工确认'));
check('断点恢复卡', dataText.includes('断点恢复'));
check('确认按钮存在', $$('.btn').some((b) => b.textContent.includes('确认当前排名')));
const confirmBtn = $$('.btn').find((b) => b.textContent.includes('确认当前排名'));
confirmBtn.click();
await waitFor(() => text($('#toast')).includes('已确认'), 'confirmation toast');
check('确认成功', text($('#toast')).includes('已确认'), text($('#toast')));

console.log('— 历史已知视图 —');
$$('.seg').find((s) => s.dataset.viewmode === 'known').click();
await waitFor(() => text($('#banners')).includes('历史已知视图'), 'known banner');
check('历史视图横幅', text($('#banners')).includes('历史已知视图'), text($('#banners')).slice(0, 120));
$$('.nav-item').find((b) => b.dataset.view === 'standings').click();
await waitFor(() => $$('table tbody tr').length > 0, 'known standings');
check('历史视图仍有排名表', $$('table tbody tr').length >= 10);

console.log(`\n通过 ${notes.length} 项`);
notes.forEach((n) => console.log(n));
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项:`);
  failures.forEach((f) => console.log(f));
}
if (pageErrors.length) {
  console.log('\n页面错误:');
  [...new Set(pageErrors)].forEach((e) => console.log('  !', e));
}
window.close();
process.exit(failures.length || pageErrors.length ? 1 : 0);
