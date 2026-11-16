/**
 * HTTP-level contract tests: concurrency, idempotency, scenario isolation,
 * confirmation staleness and resumable imports. These exercise the real app
 * object over a real socket, so they cover routing, transactions and the
 * error envelope rather than only the engine functions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSeededDatabase } from '../server/seed.js';
import { createApp } from '../server/http.js';
import { getRevision } from '../server/db.js';

async function boot() {
  const db = createSeededDatabase();
  const { server } = createApp({ db, defaultSeason: 'S-2627' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, body: json, headers: res.headers };
  };
  const close = () => new Promise((resolve) => server.close(resolve));
  return { db, base, call, close };
}

const correction = (homeGoals, awayGoals) => ({
  homeGoals,
  awayGoals,
  effectiveAt: '2026-09-20T00:00:00Z',
  reason: '测试更正（虚构）',
});

test('stale baseRevision cannot overwrite a newer ruling', async () => {
  const { db, call, close } = await boot();
  try {
    const rev = getRevision(db);
    assert.equal(rev, 1);
    const first = await call('POST', '/api/matches/M-A-09/corrections', { ...correction(1, 0), baseRevision: 1 });
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 2);

    // A second tab that still holds revision 1 must be rejected.
    const second = await call('POST', '/api/matches/M-A-09/corrections', { ...correction(2, 2), baseRevision: 1 });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'stale_revision');
    assert.equal(second.body.error.currentRevision, 2);

    // The newer ruling survives untouched.
    const timeline = await call('GET', '/api/matches/M-A-09/timeline');
    const applied = timeline.body.revisions.filter((r) => r.revisionNo > 1);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].homeGoals, 1);
    assert.equal(applied[0].awayGoals, 0);
    assert.equal(getRevision(db), 2);
  } finally {
    await close();
  }
});

test('If-Match is honoured and formal writes require a revision', async () => {
  const { call, close } = await boot();
  try {
    const missing = await call('POST', '/api/matches/M-A-09/corrections', correction(0, 1));
    assert.equal(missing.status, 428);
    assert.equal(missing.body.error.code, 'revision_required');

    const ok = await call('POST', '/api/matches/M-A-09/corrections', correction(0, 1), { 'If-Match': '"1"' });
    assert.equal(ok.status, 200);
    const stale = await call('POST', '/api/matches/M-A-09/corrections', correction(0, 2), { 'If-Match': '1' });
    assert.equal(stale.status, 409);
  } finally {
    await close();
  }
});

test('idempotent replay returns the original result and does not double-apply', async () => {
  const { db, call, close } = await boot();
  try {
    const payload = { ...correction(2, 1), baseRevision: 1, requestId: 'req-replay-1' };
    const first = await call('POST', '/api/matches/M-A-09/corrections', payload);
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 2);
    assert.ok(!first.body.replayed);

    const replay = await call('POST', '/api/matches/M-A-09/corrections', payload);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.revision, 2);
    assert.equal(getRevision(db), 2, 'revision did not advance');

    const timeline = await call('GET', '/api/matches/M-A-09/timeline');
    assert.equal(timeline.body.revisions.length, 2, 'no duplicate revision row');

    // A different requestId at the same baseRevision is still stale.
    const other = await call('POST', '/api/matches/M-A-09/corrections', { ...correction(3, 3), baseRevision: 1, requestId: 'req-replay-2' });
    assert.equal(other.status, 409);
  } finally {
    await close();
  }
});

test('scenario runs never write formal points, snapshots or revision', async () => {
  const { db, call, close } = await boot();
  try {
    const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    const before = {
      revision: getRevision(db),
      matches: count('match'),
      matchRevisions: count('match_revision'),
      penalties: count('penalty'),
      penaltyRevisions: count('penalty_revision'),
      snapshots: count('ranking_snapshot'),
      scenarios: count('scenario_run'),
    };
    const standingsBefore = await call('GET', '/api/standings?view=final');

    const run = await call('POST', '/api/scenarios', {
      label: '并发试算 A',
      baseRevision: before.revision,
      matches: [{ matchId: 'M-A-09', homeGoals: 4, awayGoals: 0 }],
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.scenario.baseRevision, before.revision);
    assert.ok(run.body.scenario.diffs.length > 0, 'hypothetical score changes something');

    const after = {
      revision: getRevision(db),
      matches: count('match'),
      matchRevisions: count('match_revision'),
      penalties: count('penalty'),
      penaltyRevisions: count('penalty_revision'),
      snapshots: count('ranking_snapshot'),
      scenarios: count('scenario_run'),
    };
    assert.equal(after.revision, before.revision);
    assert.equal(after.matches, before.matches);
    assert.equal(after.matchRevisions, before.matchRevisions);
    assert.equal(after.penalties, before.penalties);
    assert.equal(after.penaltyRevisions, before.penaltyRevisions);
    assert.equal(after.snapshots, before.snapshots);
    assert.equal(after.scenarios, before.scenarios + 1, 'only the scenario log grew');

    const standingsAfter = await call('GET', '/api/standings?view=final');
    assert.deepEqual(standingsAfter.body.table, standingsBefore.body.table);

    // Two scenarios may coexist; comparing them does not touch formal state either.
    const second = await call('POST', '/api/scenarios', {
      label: '并发试算 B',
      baseRevision: before.revision,
      ruleVersionId: 'RV-HANDBOOK-2',
    });
    assert.equal(second.status, 200);
    const compared = await call('GET', `/api/scenarios/compare?left=${run.body.scenario.scenarioId}&right=${second.body.scenario.scenarioId}`);
    assert.equal(compared.status, 200);
    assert.equal(getRevision(db), before.revision);
    assert.equal(count('scenario_run'), before.scenarios + 2);
  } finally {
    await close();
  }
});

test('a confirmation binds a revision and turns stale after any formal write', async () => {
  const { call, close } = await boot();
  try {
    const missing = await call('POST', '/api/confirmations', { section: 'A' });
    assert.equal(missing.status, 428);

    const confirmed = await call('POST', '/api/confirmations', { section: 'A', baseRevision: 1, note: '初版确认' });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.revision, 1);
    assert.ok(confirmed.body.confirmation.snapshotHash);
    assert.equal(confirmed.body.revision, 1);

    const fresh = await call('GET', '/api/confirmations');
    assert.equal(fresh.body.confirmations[0].stale, false);

    const written = await call('POST', '/api/matches/M-A-09/corrections', { ...correction(1, 1), baseRevision: 1 });
    assert.equal(written.status, 200);

    const stale = await call('GET', '/api/confirmations');
    assert.equal(stale.body.confirmations[0].stale, true);
    assert.equal(stale.body.confirmations[0].revision, 1);

    // Confirming again at the new revision is accepted and supersedes.
    const reconfirmed = await call('POST', '/api/confirmations', { section: 'A', baseRevision: 2 });
    assert.equal(reconfirmed.status, 200);
    const final = await call('GET', '/api/confirmations');
    assert.equal(final.body.confirmations.filter((c) => !c.stale).length, 1);
  } finally {
    await close();
  }
});

test('import batches resume from their cursor without double-booking', async () => {
  const { db, call, close } = await boot();
  try {
    const created = await call('POST', '/api/imports', {
      label: '断点恢复测试',
      items: [
        { id: 'M-A-90', section: 'A', home: 'T-KLP', away: 'T-SLT', homeGoals: 2, awayGoals: 0, playedAt: '2026-10-10' },
        { id: 'M-A-91', section: 'A', home: 'T-DUN', away: 'T-FEN', homeGoals: 1, awayGoals: 1, playedAt: '2026-10-11' },
      ],
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.total, 2);
    assert.equal(created.body.cursor, 0);

    let revision = getRevision(db);
    const first = await call('POST', `/api/imports/${created.body.id}/apply`, { baseRevision: revision });
    assert.equal(first.status, 200);
    assert.equal(first.body.import.index, 0);
    assert.equal(first.body.import.cursor, 1);
    assert.equal(first.body.import.status, 'pending');

    // Simulate an interruption: the cursor survives on disk, not in memory.
    const mid = await call('GET', '/api/imports');
    assert.equal(mid.body.imports[0].cursor, 1);

    revision = getRevision(db);
    const second = await call('POST', `/api/imports/${created.body.id}/apply`, { baseRevision: revision });
    assert.equal(second.status, 200);
    assert.equal(second.body.import.index, 1);
    assert.equal(second.body.import.cursor, 2);
    assert.equal(second.body.import.status, 'complete');

    const matches = await call('GET', '/api/matches');
    assert.equal(matches.body.matches.filter((m) => m.id === 'M-A-90').length, 1);
    assert.equal(matches.body.matches.filter((m) => m.id === 'M-A-91').length, 1);

    // Re-applying a complete batch is a no-op, not a duplicate match.
    const again = await call('POST', `/api/imports/${created.body.id}/apply`, { baseRevision: getRevision(db) });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyComplete, true);
    const after = await call('GET', '/api/matches');
    assert.equal(after.body.matches.filter((m) => m.id === 'M-A-90').length, 1);
  } finally {
    await close();
  }
});

test('appeal filing does not change points; the decision does, with retroactive split', async () => {
  const { call, close } = await boot();
  try {
    const beforeFinal = await call('GET', '/api/standings?view=final');
    const beforeKnown = await call('GET', '/api/standings?view=known');
    const filed = await call('POST', '/api/appeals', {
      teamId: 'T-SLT',
      matchId: 'M-A-08',
      title: '测试申诉（虚构）',
      requestedOutcome: '比分改为 0:1',
      baseRevision: 1,
    });
    assert.equal(filed.status, 200);
    assert.equal(filed.body.appeal.status, 'open');
    const afterFiling = await call('GET', '/api/standings?view=final');
    assert.deepEqual(afterFiling.body.table, beforeFinal.body.table, 'filing alone changes nothing');

    // An open appeal cannot be re-decided twice.
    const decided = await call('POST', `/api/appeals/${filed.body.appeal.id}/decision`, {
      baseRevision: 2,
      status: 'upheld',
      homeGoals: 0,
      awayGoals: 1,
      effectiveAt: '2026-09-01T00:00:00Z',
      reason: '测试裁决',
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.retroactive, true);

    const twice = await call('POST', `/api/appeals/${filed.body.appeal.id}/decision`, {
      baseRevision: 3,
      status: 'dismissed',
      homeGoals: 0,
      awayGoals: 1,
    });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'appeal_decided');

    // Retroactive: the as-known table is unchanged, the final table moves.
    const known = await call('GET', '/api/standings?view=known');
    assert.deepEqual(known.body.table, beforeKnown.body.table, 'historical view ignores the retroactive ruling');
    const final = await call('GET', '/api/standings?view=final');
    assert.notDeepEqual(final.body.table, beforeFinal.body.table, 'final view includes it');
  } finally {
    await close();
  }
});
