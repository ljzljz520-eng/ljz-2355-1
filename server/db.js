// PostgreSQL 访问层。默认使用 PGlite（进程内真实 PostgreSQL，数据落 .data/pglite）。
// 生产环境可通过 DATABASE_URL 指向外部 PG（使用 pg 驱动，接口兼容 query）。
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
let db;

export async function getDB({ dataDir = process.env.PGDATA ?? join(__dirname, '..', '.data', 'pglite') } = {}) {
  if (db) return db;
  if (!dataDir.startsWith('memory://')) mkdirSync(dirname(dataDir), { recursive: true });
  db = new PGlite(dataDir);
  await db.waitReady;
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await db.exec(schema);
  return db;
}

// 测试用：独立内存实例，互不污染
export async function createMemoryDB() {
  const mem = new PGlite('memory://');
  await mem.waitReady;
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await mem.exec(schema);
  return mem;
}

export async function q(client, text, params = []) {
  const res = await client.query(text, params);
  return res.rows;
}
export async function one(client, text, params = []) {
  const rows = await q(client, text, params);
  return rows[0] ?? null;
}

// PGlite 0.5 事务：BEGIN ... COMMIT/ROLLBACK
export async function withTx(client, fn) {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

export async function audit(client, action, entity, entityId, detail = {}, actor = 'technician') {
  await client.query(
    'INSERT INTO audit_log(actor, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [actor, action, entity, String(entityId ?? ''), JSON.stringify(detail)]
  );
}
