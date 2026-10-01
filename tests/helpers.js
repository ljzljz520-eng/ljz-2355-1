import { MemDb } from '../server/db/mem.js';
import { seedStore } from '../server/db/seed.js';

export async function freshDb() {
  const db = new MemDb();
  await seedStore(db);
  return db;
}

export const findBy = async (db, table, kv) => db.findOne(table, kv);
