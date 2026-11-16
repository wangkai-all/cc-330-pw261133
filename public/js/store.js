/** Shared UI state + data loading. */

import { api, syncRevision } from './api.js';

export const state = {
  season: null,
  teams: [],
  rules: null,
  ruleVersions: [],
  standings: null,
  standingsKnown: null,
  appeals: [],
  penalties: [],
  scenarios: [],
  variants: [],
  confirmations: [],
  revision: 0,
  viewMode: 'final',
  rulePreview: '', // '' = season default; otherwise a pinned version used for browsing
  booted: false,
  lastError: null,
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(reason = 'update') {
  for (const fn of listeners) fn(reason, state);
}

export async function bootstrap() {
  const [seasonPayload, rulesPayload, appealsPayload, scenariosPayload, confirmationsPayload, penaltiesPayload] = await Promise.all([
    api.season(),
    api.rules(),
    api.appeals(),
    api.scenarios(),
    api.confirmations(),
    api.penalties(),
  ]);
  state.season = seasonPayload.season;
  state.teams = seasonPayload.teams;
  state.ruleVersions = seasonPayload.ruleVersions;
  state.rules = rulesPayload;
  state.appeals = appealsPayload.appeals;
  state.scenarios = scenariosPayload.scenarios;
  state.variants = scenariosPayload.variants || [];
  state.confirmations = confirmationsPayload.confirmations;
  state.penalties = penaltiesPayload.penalties;
  // A fresh page load is a resync: trust the server even if localStorage held
  // a higher revision from a database that has since been reseeded.
  syncRevision(seasonPayload.revision);
  state.revision = seasonPayload.revision;
  await loadStandings();
  state.booted = true;
  notify('bootstrap');
}

export async function loadStandings() {
  const ruleVersionId = state.rulePreview || null;
  const [final, known] = await Promise.all([
    api.standings({ view: 'final', ruleVersionId }),
    api.standings({ view: 'known', ruleVersionId }),
  ]);
  state.standings = final;
  state.standingsKnown = known;
  state.revision = final.revision;
  return final;
}

export async function refreshAppeals() {
  const payload = await api.appeals();
  state.appeals = payload.appeals;
  state.revision = payload.revision;
}

export async function refreshPenalties() {
  const payload = await api.penalties();
  state.penalties = payload.penalties;
  state.revision = payload.revision;
}

export async function refreshScenarios() {
  const payload = await api.scenarios();
  state.scenarios = payload.scenarios;
  state.variants = payload.variants || [];
  state.revision = payload.revision;
}

export async function refreshConfirmations() {
  const payload = await api.confirmations();
  state.confirmations = payload.confirmations;
  state.revision = payload.revision;
}

export async function refreshAll() {
  await Promise.all([
    loadStandings(),
    refreshAppeals(),
    refreshScenarios(),
    refreshConfirmations(),
    refreshPenalties(),
  ]);
  notify('refresh');
}

export function activeStandings() {
  return state.viewMode === 'known' ? state.standingsKnown : state.standings;
}

export function teamById(id) {
  return state.teams.find((t) => t.id === id) || { id, name: id, section: '?' };
}

export function openAppeals() {
  return state.appeals.filter((entry) => entry.open);
}

export function matchOptions() {
  if (!state.standings) return [];
  const seen = new Map();
  for (const section of state.standings.sections) {
    for (const row of section.rows) seen.set(row.teamId, { id: row.teamId, name: row.name, section: section.section });
  }
  return [...seen.values()];
}
