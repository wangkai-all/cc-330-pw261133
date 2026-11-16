import { nowIso } from './db.js';
import { loadState } from './state.js';
import { computeStandings, diffStandings } from './standings.js';
import { hashJson } from './rules.js';

/**
 * Incremental recomputation.
 *
 * Correctness argument: a match affects only the two sections it belongs to
 * (its own section, plus the wildcard pool which spans sections). A penalty
 * affects its own section plus the wildcard pool. An appeal maps to its
 * target's section. Therefore the affected set is the union of those sections,
 * and every group in that set is recomputed from scratch — "incremental at the
 * group boundary, full within a group". Cross-group wildcard ranking is
 * recomputed whenever any section in the affected set changes.
 *
 * Snapshots carry the revision watermark they were computed at, so a stale
 * recompute can never be mistaken for a fresh one (and never overwrites a
 * snapshot at a later revision).
 */

export function affectedSectionsForMatch(db, matchId) {
  const row = db.prepare('SELECT section FROM match WHERE id = ?').get(matchId);
  return row ? [row.section] : [];
}

export function affectedSectionsForPenalty(db, penaltyId) {
  const row = db.prepare('SELECT section FROM penalty WHERE id = ?').get(penaltyId);
  return row ? [row.section] : [];
}

export function affectedSectionsForAppeal(db, appealId) {
  const row = db.prepare('SELECT match_id, penalty_id FROM appeal WHERE id = ?').get(appealId);
  if (!row) return [];
  if (row.match_id) return affectedSectionsForMatch(db, row.match_id);
  if (row.penalty_id) return affectedSectionsForPenalty(db, row.penalty_id);
  return [];
}

export function sectionsNeedingWildcard(season) {
  return Boolean(season && season.wildcardSlots > 0);
}

/**
 * Recompute standings and persist both the "as known at revision R" and
 * "final (all effective revisions)" snapshots for the affected sections.
 * `kindFilter` lets callers compute only one view.
 */
export function recompute({
  db,
  seasonId = 'S-2627',
  sections = null,
  ruleVersionId = null,
  revision,
  kindFilter = null,
  persist = true,
  now = null,
}) {
  const computedAt = now || nowIso();
  const season = db.prepare('SELECT * FROM season WHERE id = ?').get(seasonId);
  if (!season) throw new Error(`season not found: ${seasonId}`);
  const effectiveRule = ruleVersionId || season.rule_version_id;
  const allSections = JSON.parse(season.sections_json).map((s) => s.id);
  const targetSections = sections && sections.length > 0 ? [...new Set(sections)] : allSections;
  const needsWildcard = Number(season.wildcard_slots) > 0;

  const results = {};
  const kinds = kindFilter ? [kindFilter] : ['as_known', 'final'];

  for (const kind of kinds) {
    // as_known  = the historical view: only rulings that were recorded no later
    //             than their own effective date (i.e. no retroactive effect).
    // final     = the corrected view: every ruling whose effective date has
    //             passed, including retroactive ones.
    // Both are computed from the same immutable revision chains, so neither can
    // overwrite the other's evidence.
    const state = kind === 'as_known'
      ? loadState(db, { seasonId, ruleVersionId: effectiveRule, asOf: null, historical: true })
      : loadState(db, { seasonId, ruleVersionId: effectiveRule, asOf: null });
    const standings = computeStandings(state);
    const perSection = {};
    for (const section of standings.sections) {
      if (!targetSections.includes(section.section)) continue;
      perSection[section.section] = section;
      const digest = hashJson({ section: section.section, rows: section.rows, trace: section.trace, wildcard: standings.wildcard, rule: standings.ruleVersionId });
      if (persist) {
        db.prepare(`INSERT INTO ranking_snapshot
            (season_id, section, kind, rule_version, revision, as_of, computed_at, input_hash, rows_json, trace_json, pending_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            seasonId,
            section.section,
            kind,
            standings.ruleVersionId,
            revision,
            standings.asOf,
            computedAt,
            digest,
            JSON.stringify(section.rows),
            JSON.stringify({ section: section.trace, wildcard: standings.wildcard }),
            JSON.stringify(standings.pending),
          );
      }
    }
    results[kind] = {
      standings,
      sections: perSection,
      persisted: persist,
      needsWildcard,
    };
  }

  return {
    seasonId,
    revision,
    ruleVersionId: effectiveRule,
    targetSections,
    needsWildcard,
    results,
    computedAt,
  };
}

export function latestSnapshots(db, seasonId = 'S-2627') {
  const rows = db.prepare(`SELECT * FROM ranking_snapshot WHERE season_id = ? ORDER BY id DESC`).all(seasonId);
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.section}:${row.kind}`;
    if (!latest.has(key)) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => a.section.localeCompare(b.section) || a.kind.localeCompare(b.kind));
}

export function snapshotAtRevision(db, seasonId, section, kind, revision) {
  return db.prepare(`SELECT * FROM ranking_snapshot
      WHERE season_id = ? AND section = ? AND kind = ? AND revision = ?
      ORDER BY id DESC LIMIT 1`).get(seasonId, section, kind, revision);
}

/**
 * Report the delta between the historical and final views (or between two
 * arbitrary revisions), which is what the version report renders.
 */
export function crossCheck(db, seasonId = 'S-2627') {
  const asKnown = loadState(db, { seasonId, historical: true });
  const final = loadState(db, { seasonId });
  const a = computeStandings(asKnown);
  const b = computeStandings(final);
  return {
    asKnown: snapshotFromStandings(a),
    final: snapshotFromStandings(b),
    changes: diffStandings(a, b),
    appliedCorrections: final.appliedCorrections,
  };
}
