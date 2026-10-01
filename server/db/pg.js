import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 以 JSONB 存储的列：读出时解析，写入时序列化
const JSON_COLS = {
  steps: ['depends_on_keys'],
  fault_codes: ['symptoms'],
  part_substitutions: ['applicable_models', 'serial_range'],
  service_programs: ['applies_models', 'applies_serials'],
  tasks: ['depends_on'],
  packages: ['root_task_keys', 'included_keys'],
};

export class PgDb {
  constructor(connectionString) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
    this.kind = 'postgres';
  }

  async initSchema() {
    const sql = await readFile(path.join(__dirname, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
  }

  _hydrate(table, row) {
    if (!row) return row;
    for (const c of JSON_COLS[table] ?? []) {
      if (typeof row[c] === 'string') {
        try { row[c] = JSON.parse(row[c]); } catch { /* keep raw */ }
      }
    }
    return row;
  }

  _serialize(table, key, value) {
    if (value === undefined) return undefined;
    if ((JSON_COLS[table] ?? []).includes(key) && (value !== null && typeof value !== 'string')) {
      return JSON.stringify(value);
    }
    return value;
  }

  async find(table, filter = {}) {
    const keys = Object.keys(filter).filter((k) => filter[k] !== undefined);
    const where = keys
      .map((k, i) => `"${k}" IS NOT DISTINCT FROM $${i + 1}`)
      .join(' AND ');
    const text = `SELECT * FROM "${table}"${where ? ` WHERE ${where}` : ''}`;
    const values = keys.map((k) => this._serialize(table, k, filter[k]));
    const { rows } = await this.pool.query(text, values);
    return rows.map((r) => this._hydrate(table, r));
  }

  async findOne(table, filter = {}) {
    const rows = await this.find(table, filter);
    return rows[0] ?? null;
  }

  async insert(table, row) {
    const keys = Object.keys(row).filter((k) => row[k] !== undefined);
    const text = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(',')})
      VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`;
    const values = keys.map((k) => this._serialize(table, k, row[k]));
    const { rows } = await this.pool.query(text, values);
    return this._hydrate(table, rows[0]);
  }

  async update(table, id, patch) {
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined && k !== 'id');
    if (!keys.length) return this.findOne(table, { id });
    const set = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const values = keys.map((k) => this._serialize(table, k, patch[k]));
    values.push(id);
    const text = `UPDATE "${table}" SET ${set} WHERE id = $${values.length} RETURNING *`;
    const { rows } = await this.pool.query(text, values);
    return this._hydrate(table, rows[0]) ?? null;
  }

  async count(table) {
    const { rows } = await this.pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
    return rows[0].n;
  }

  async close() {
    await this.pool.end();
  }
}
