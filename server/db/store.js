// 根据 DATABASE_URL 选择 PG 或内存实现；两者领域接口一致。
import { MemDb } from './mem.js';

export async function createStore() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { PgDb } = await import('./pg.js');
    const db = new PgDb(url);
    await db.initSchema();
    return { db, close: async () => db.close() };
  }
  return { db: new MemDb(), close: async () => {} };
}
