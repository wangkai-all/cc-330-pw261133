#!/usr/bin/env node
import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase, getRevision } from '../server/db.js';
import { loadSeedDocument, seedDatabase, ROOT } from '../server/seed.js';
import { recompute } from '../server/recompute.js';

const args = process.argv.slice(2);
const reset = args.includes('--reset');
const dbPath = process.env.DB_PATH || join(ROOT, 'data', 'tournament.db');

if (reset && existsSync(dbPath)) {
  rmSync(dbPath);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) rmSync(`${dbPath}${suffix}`);
  }
  console.log(`[seed] 已删除旧数据库 ${dbPath}`);
}

const db = openDatabase(dbPath);
const document = loadSeedDocument();
seedDatabase(db, document);
const revision = getRevision(db);
const result = recompute({ db, revision });
console.log(`[seed] 赛季 ${result.seasonId} 已载入，revision=${revision}`);
for (const section of result.results.final.standings.sections) {
  console.log(`  分区 ${section.section}`);
  for (const row of section.rows) {
    console.log(`   ${String(row.rank).padStart(2)}  ${row.name.padEnd(6, '　')} 积分 ${String(row.points).padStart(3)}  净胜 ${String(row.goalDiff).padStart(3)}  ${row.qualification}${row.pendingReasons.length ? ` (${row.pendingReasons.join(',')})` : ''}`);
  }
}
console.log(`[seed] 数据库：${dbPath}`);
db.close();
