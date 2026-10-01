// 内存数据访问：与 PgDb 实现同一通用集合接口，供无数据库环境开发与测试。
const TABLES = [
  'models', 'manuals', 'steps', 'fault_codes', 'parts', 'part_substitutions',
  'service_programs', 'service_program_manuals', 'work_orders', 'step_events',
  'evidence', 'tasks', 'packages', 'sync_conflicts',
];

export class MemDb {
  constructor() {
    this.t = new Map(TABLES.map((name) => [name, new Map()]));
    this.kind = 'memory';
  }

  async find(table, filter = {}) {
    const m = this.t.get(table);
    if (!m) throw new Error(`unknown table ${table}`);
    const out = [];
    const conds = Object.entries(filter).filter(([, v]) => v !== undefined);
    for (const row of m.values()) {
      if (conds.every(([k, v]) => row[k] === v)) out.push(clone(row));
    }
    return out;
  }

  async findOne(table, filter = {}) {
    const rows = await this.find(table, filter);
    return rows[0] ?? null;
  }

  async insert(table, row) {
    const m = this.t.get(table);
    if (m.has(row.id)) throw new Error(`duplicate id in ${table}: ${row.id}`);
    m.set(row.id, clone(row));
    return clone(row);
  }

  async update(table, id, patch) {
    const m = this.t.get(table);
    const cur = m.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    m.set(id, next);
    return clone(next);
  }

  async count(table) {
    return this.t.get(table).size;
  }
}

const clone = (v) =>
  v === undefined ? v : JSON.parse(JSON.stringify(v));
