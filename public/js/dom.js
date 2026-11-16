/** Small DOM helper layer — no framework, no build step. */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mountOnce(node) {
  return node instanceof Node ? node : el('span', {}, String(node));
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

export function fmtNum(n) {
  if (n === null || n === undefined) return '–';
  if (typeof n !== 'number') return String(n);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function fmtSigned(n) {
  if (n === null || n === undefined) return '–';
  if (n > 0) return `+${n}`;
  return String(n);
}

const TS_FMT = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

export function fmtTs(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return TS_FMT.format(date).replace(/\//g, '-');
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return String(iso).slice(0, 10);
}

export function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  const m = Math.round(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export const QUAL_LABEL = {
  qualified: '晋级',
  eliminated: '淘汰',
  pending: '待定',
};

export const PENDING_REASON = {
  tie_unresolved: '组内并列未分解',
  rank_tie: '名次并列',
  cross_group_pending: '跨组名额待定',
  cross_group_tie: '跨组比较仍并列',
  cross_group_not_defined: '规则未定义跨组比较',
  candidate_ambiguous: '跨组候选不唯一',
};

export function qualBadge(row) {
  const reasons = (row.pendingReasons || []).map((r) => PENDING_REASON[r] || r);
  const label = row.qualification === 'pending'
    ? `待定${reasons.length ? ` · ${reasons[0]}` : ''}`
    : QUAL_LABEL[row.qualification] || row.qualification;
  const cls = row.qualification === 'pending' ? 'pending' : row.qualification;
  const wrap = el('span', { class: 'chip-row' }, el('span', { class: `badge ${cls}` }, label));
  if (row.qualifiedVia === 'wildcard') wrap.append(el('span', { class: 'badge wildcard' }, '外卡'));
  return wrap;
}

export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
