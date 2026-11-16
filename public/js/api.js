/** API client with revision awareness, idempotent retries and offline queue. */

const REV_KEY = 'tdesk.revision';

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

let currentRevision = Number(localStorage.getItem(REV_KEY) || 0);

export function getRevisionNumber() {
  return currentRevision;
}

function rememberRevision(payload) {
  if (payload && typeof payload.revision === 'number' && payload.revision > currentRevision) {
    applyRevision(payload.revision);
  }
}

function applyRevision(revision) {
  currentRevision = revision;
  localStorage.setItem(REV_KEY, String(currentRevision));
  document.dispatchEvent(new CustomEvent('revisionchange', { detail: { revision: currentRevision } }));
}

/**
 * Full-page bootstrap is an explicit resync: take the server's revision even if
 * it is lower than the one cached in localStorage (e.g. the database was
 * reseeded). Mid-session responses only ever move forward — a stale tab must
 * still get 409 instead of silently retrying with a newer revision.
 */
export function syncRevision(revision) {
  if (typeof revision === 'number' && revision !== currentRevision) applyRevision(revision);
}

async function request(path, { method = 'GET', body, revision, requestId, retries = 0 } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (revision !== undefined && revision !== null) headers['If-Match'] = String(revision);
  if (requestId) headers['x-request-id'] = requestId;
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (networkError) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 350));
      return request(path, { method, body, revision, requestId, retries: retries - 1 });
    }
    throw new ApiError(0, 'network_error', '无法连接服务端，请稍后重试。');
  }
  let payload = null;
  const text = await response.text();
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = null; }
  }
  rememberRevision(payload);
  if (!response.ok) {
    const error = payload?.error || {};
    throw new ApiError(response.status, error.code || 'http_error', error.message || `请求失败（${response.status}）`, {
      ...error,
      currentRevision: error.currentRevision ?? payload?.revision,
    });
  }
  return payload;
}

export const api = {
  health: () => request('/api/health'),
  season: () => request('/api/season'),
  rules: () => request('/api/rules'),
  rule: (id) => request(`/api/rules/${encodeURIComponent(id)}`),
  variants: (id) => request(`/api/rules/${encodeURIComponent(id)}/variants`),
  standings: ({ view = 'final', ruleVersionId = null } = {}) => {
    const qs = new URLSearchParams({ view });
    if (ruleVersionId) qs.set('ruleVersionId', ruleVersionId);
    return request(`/api/standings?${qs}`);
  },
  basis: (teamId, { view = 'final', ruleVersionId = null } = {}) => {
    const qs = new URLSearchParams({ view });
    if (ruleVersionId) qs.set('ruleVersionId', ruleVersionId);
    return request(`/api/standings/${encodeURIComponent(teamId)}/basis?${qs}`);
  },
  trace: (section) => request(`/api/trace${section ? `?section=${encodeURIComponent(section)}` : ''}`),
  recompute: (body = {}) => request('/api/standings/recompute', { method: 'POST', body }),
  snapshots: () => request('/api/snapshots'),
  matches: () => request('/api/matches'),
  matchTimeline: (id) => request(`/api/matches/${encodeURIComponent(id)}/timeline`),
  recordMatch: (body) => request('/api/matches', { method: 'POST', body, revision: body.baseRevision, requestId: body.requestId, retries: 1 }),
  correctMatch: (id, body) => request(`/api/matches/${encodeURIComponent(id)}/corrections`, { method: 'POST', body, revision: body.baseRevision, requestId: body.requestId, retries: 1 }),
  penalties: () => request('/api/penalties'),
  createPenalty: (body) => request('/api/penalties', { method: 'POST', body, revision: body.baseRevision, requestId: body.requestId, retries: 1 }),
  appeals: () => request('/api/appeals'),
  appeal: (id) => request(`/api/appeals/${encodeURIComponent(id)}`),
  createAppeal: (body) => request('/api/appeals', { method: 'POST', body, revision: body.baseRevision, requestId: body.requestId, retries: 1 }),
  decideAppeal: (id, body) => request(`/api/appeals/${encodeURIComponent(id)}/decision`, { method: 'POST', body, revision: body.baseRevision, requestId: body.requestId, retries: 1 }),
  saveDraft: (id, draft) => request(`/api/appeals/${encodeURIComponent(id)}/draft`, { method: 'PUT', body: { draft } }),
  confirmations: () => request('/api/confirmations'),
  confirm: (body) => request('/api/confirmations', { method: 'POST', body, revision: body.baseRevision, requestId: body.requestId }),
  scenarios: () => request('/api/scenarios'),
  runScenario: (body) => request('/api/scenarios', { method: 'POST', body, retries: 1 }),
  scenario: (id) => request(`/api/scenarios/${encodeURIComponent(id)}`),
  compareScenarios: (left, right) => request(`/api/scenarios/compare?left=${encodeURIComponent(left)}&right=${encodeURIComponent(right)}`),
  report: (ruleVersionId) => request(`/api/report${ruleVersionId ? `?ruleVersionId=${encodeURIComponent(ruleVersionId)}` : ''}`),
  imports: () => request('/api/imports'),
  createImport: (body) => request('/api/imports', { method: 'POST', body }),
  applyImport: (id) => request(`/api/imports/${encodeURIComponent(id)}/apply`, { method: 'POST', body: { baseRevision: currentRevision }, revision: currentRevision }),
  drafts: () => request('/api/drafts'),
  putDraft: (key, payload, version) => request(`/api/drafts/${encodeURIComponent(key)}`, { method: 'PUT', body: { payload, version } }),
  deleteDraft: (key) => request(`/api/drafts/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  audit: (limit = 60) => request(`/api/audit?limit=${limit}`),
};

let counter = 0;
export function newRequestId(prefix = 'req') {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 7)}`;
}
