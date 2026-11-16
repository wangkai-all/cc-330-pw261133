import { join } from 'node:path';
import { openDatabase, getMeta, getRevision } from './db.js';
import { ensureSeeded, loadSeedDocument, ROOT } from './seed.js';
import { createApp } from './http.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'tournament.db');

const db = openDatabase(DB_PATH);
const seedResult = ensureSeeded(db);
if (seedResult.seeded) {
  console.log(`[seed] 已载入虚构赛季 ${seedResult.seasonId}：${seedResult.teams} 队 / ${seedResult.matches} 场`);
} else {
  console.log(`[db] 使用现有数据库 ${DB_PATH}（revision ${getRevision(db)}）`);
}

const { server } = createApp({
  db,
  logger: process.env.QUIET === '1' ? () => {} : (line) => console.log(`[http] ${line}`),
});

server.listen(PORT, HOST, () => {
  console.log(`\n虚构赛果编排台已启动：http://${HOST}:${PORT}`);
  console.log(`数据库：${DB_PATH}`);
  console.log(`规则：${loadSeedDocument().season.notes}\n`);
});

function shutdown(signal) {
  console.log(`\n[${signal}] 正在关闭…`);
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { db, server };
