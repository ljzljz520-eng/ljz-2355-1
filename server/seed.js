// 演示数据。导出 seed(db) 供测试复用；直接运行时初始化默认库。
import { createHash } from 'node:crypto';
import { getDB, withTx, q } from './db.js';

export const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
// 步骤指纹只覆盖步骤自身内容（步骤号+标题+正文+所需备件），与所在手册版本解耦：
// 这样"内容未变的步骤跨版本指纹一致"，逐项继承判定才能正确识别 UNCHANGED。
const stepHash = (no, title, body, parts = []) => sha(`${no}|${title}|${body}|${[...parts].sort().join(',')}`);
const manualHash = (m, v, steps) => sha(`${m}|${v}|` + steps.map((s) => `${s.no}:${s.body}`).join('||'));

const DATA = () => {
  const ac200v1 = [
    { no: '010', title: '断电挂牌上锁', body: '关闭主电源并挂"禁止合闸"牌，验电后作业。', key: true, parts: [] },
    { no: '020', title: '拆卸冷凝器护板', body: '拧下护板 4 颗 M5 螺钉，取下护板。', key: false, parts: [] },
    { no: '030', title: '更换散热风机', body: '拔下风机接线端子，更换 FAN-01，复装端子。', key: true, parts: ['FAN-01'] },
    { no: '040', title: '通电自检', body: '恢复供电，执行自检程序并记录电流值。', key: true, parts: [] },
  ];
  const ac200v11 = [
    { no: '010', title: '断电挂牌上锁', body: '关闭主电源并挂"禁止合闸"牌，验电后作业。', key: true, parts: [] },
    { no: '020', title: '拆卸冷凝器护板', body: '拧下护板 4 颗 M5 螺钉（扭矩 2.5N·m），取下护板。', key: false, parts: [] },
    { no: '030', title: '更换散热风机', body: '拔下风机接线端子，更换 FAN-01；安装螺钉按对角顺序，扭矩 3.0N·m（v1.0 为 1.8N·m）。', key: true, parts: ['FAN-01'] },
    { no: '040', title: '通电自检', body: '恢复供电，执行自检程序并记录电流值。', key: true, parts: [] },
    { no: '050', title: '复测出口温度', body: '满载运行 10 分钟，记录冷凝器出口温度曲线。', key: false, parts: [] },
  ];
  const ac300v1 = [
    { no: '010', title: '进入总线诊断', body: '维护菜单进入 CAN 总线诊断页。', key: false, parts: [] },
    { no: '020', title: '排查通信丢帧', body: '测量终端电阻 120Ω，逐段检查线束并更换损坏段。', key: true, parts: ['BRD-20'] },
    { no: '030', title: '复位总线错误计数', body: '清除错误计数并观察 15 分钟。', key: true, parts: [] },
  ];
  return { ac200v1, ac200v11, ac300v1 };
};

export async function seed(db) {
  await db.exec(`
    TRUNCATE audit_log, print_records, packages, sync_conflicts, sync_events,
      evidence, work_order_item_decisions, work_order_items, work_orders,
      service_coverages, part_substitutions, parts, fault_codes, manual_steps,
      manuals, model_revisions, machine_models RESTART IDENTITY CASCADE;
  `);
  const { ac200v1, ac200v11, ac300v1 } = DATA();

  await withTx(db, async (c) => {
    await c.query(`INSERT INTO machine_models(code,name,released_at) VALUES
      ('AC-200','风冷机组 200','2024-03-01'), ('AC-300','风冷机组 300','2025-06-01')`);
    await c.query(`INSERT INTO model_revisions(model_code,revision,released_at,notes) VALUES
      ('AC-200','Rev A','2024-03-01','初版'),
      ('AC-200','Rev B','2025-09-01','风机扭矩要求更新'),
      ('AC-300','Rev A','2025-06-01','初版')`);

    async function insertManual(model, version, raw, supersedesId = null) {
      const hash = manualHash(model, version, raw);
      const res = await c.query(
        `INSERT INTO manuals(model_code,version,status,supersedes_id,content_hash,approved_at)
         VALUES ($1,$2,'approved',$3,$4, now()) RETURNING id`,
        [model, version, supersedesId, hash]
      );
      const id = res.rows[0].id;
      for (const s of raw) {
        await c.query(
          `INSERT INTO manual_steps(manual_id,step_no,title,instruction,is_key_step,required_parts,step_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, s.no, s.title, s.body, s.key, s.parts, stepHash(s.no, s.title, s.body, s.parts)]
        );
      }
      return id;
    }
    const m200v1 = await insertManual('AC-200', 'v1.0', ac200v1);
    const m200v11 = await insertManual('AC-200', 'v1.1', ac200v11, m200v1);
    await c.query(`UPDATE manuals SET status='superseded' WHERE id=$1`, [m200v1]);
    const m300v1 = await insertManual('AC-300', 'v1.0', ac300v1);

    await c.query(`INSERT INTO parts(sku,name,category) VALUES
      ('FAN-01','散热风机组件（AC-200）','风机'),
      ('FAN-02','散热风机组件（通用改型）','风机'),
      ('FAN-03','散热风机组件（AC-300 专用）','风机'),
      ('BRD-10','主控板 v1','电控'),
      ('BRD-11','主控板 v2（AC-200 改型）','电控'),
      ('BRD-20','总线终端板','电控')`);

    // 有向 + 范围：FAN-02→FAN-01 仅限 AC-200/序列号 1-1000；
    // FAN-03→FAN-02 仅限 AC-300 —— 机型范围不相交，传递在交集处中断。
    await c.query(`INSERT INTO part_substitutions
        (sku,replaces_sku,direction,model_code,serial_from,serial_to,note) VALUES
      ('FAN-02','FAN-01','forward','AC-200',1,1000,'AC-200 早期序列号可直接互换'),
      ('FAN-03','FAN-02','forward','AC-300',1,500,'仅 AC-300 机型验证'),
      ('BRD-11','BRD-10','forward','AC-200',500,2000,'2026 起对 Rev B 生效')`,
      []);
    await c.query(`UPDATE part_substitutions SET valid_from='2026-01-01' WHERE sku='BRD-11'`);

    await c.query(`INSERT INTO service_coverages
        (program,model_code,serial_from,serial_to,valid_from,valid_to,terms) VALUES
      ('标准保修','AC-200',1,1000,'2025-01-01','2027-12-31','整机 2 年，易损件 1 年'),
      ('延保包 Plus','AC-200',500,2000,'2026-01-01','2030-12-31','延保期内风机总成免工时'),
      ('标准保修','AC-300',1,800,'2025-06-01','2028-06-01','整机 3 年')`);

    // 同一故障码 E-410：跨机型含义完全不同
    await c.query(`INSERT INTO fault_codes
        (code,model_code,meaning,severity,advised_action,manual_id,ref_step_nos) VALUES
      ('E-410','AC-200','冷凝器出口温度超限（硬件过热路径）','critical',
        '按 v1.1 第 010-040 步断电并更换散热风机，完成后复测出口温度。',
        $1, ARRAY['010','020','030','040','050']),
      ('E-410','AC-300','CAN 通信总线周期性丢帧（总线诊断路径）','warning',
        '按 v1.0 第 020 步排查总线终端电阻与线束，切勿按过热流程处理。',
        $2, ARRAY['010','020','030']),
      ('E-202','AC-300','维护周期提醒（仅提示）','info',
        '按 v1.0 执行例行保养检查。', $2, ARRAY['010'])`,
      [m200v11, m300v1]);

    // 演示工单：AC-200 / 序列号 500，离线勾选并钉在已被取代的 v1.0 快照
    const wo = await c.query(
      `INSERT INTO work_orders(wo_no,model_code,serial_no,fault_code,status,offline,
         bound_manual_id,bound_version,bound_content_hash,bound_at,revision,base_revision)
       VALUES ('WO-1001','AC-200',500,'E-410','in_progress',true,$1,'v1.0',$2, now(),1,0)
       RETURNING id`,
      [m200v1, manualHash('AC-200', 'v1.0', ac200v1)]
    );
    const woId = wo.rows[0].id;
    const doneHashes = new Map(ac200v1.map((s) => [s.no, stepHash(s.no, s.title, s.body, s.parts)]));
    const states = { '010': 'done', '020': 'done', '030': 'done', '040': 'pending' };
    for (const s of ac200v1) {
      const done = states[s.no] === 'done';
      await c.query(
        `INSERT INTO work_order_items(work_order_id,step_no,title,step_hash,is_key_step,state,
           completed_at,completed_step_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [woId, s.no, s.title, doneHashes.get(s.no), s.key, states[s.no],
         done ? new Date('2026-09-28T10:00:00Z') : null, done ? doneHashes.get(s.no) : null]
      );
    }
    const item010 = await c.query(`SELECT id FROM work_order_items WHERE work_order_id=$1 AND step_no='010'`, [woId]);
    await c.query(
      `INSERT INTO evidence(work_order_id,item_id,kind,filename,mime,bytes,captured_at)
       VALUES ($1,$2,'photo','lockout-tagout.jpg','image/jpeg',204800,'2026-09-28T10:05:00Z')`,
      [woId, item010.rows[0].id]
    );

    await c.query(
      `INSERT INTO packages(kind,model_code,work_order_id,manifest,content_hash)
       VALUES ('full','AC-200',$1,$2,$3)`,
      [woId,
       JSON.stringify({ kind: 'full', model_code: 'AC-200', manual_version: 'v1.0', note: '整机型离线包' }),
       manualHash('AC-200', 'v1.0', ac200v1)]
    );

    await c.query(
      `INSERT INTO audit_log(actor,action,entity,entity_id,detail)
       VALUES ('seeder','seed','system','', '{"note":"演示数据：工单钉在 v1.0，v1.1 已发布待逐项判定"}')`
    );
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await getDB();
  await seed(db);
  const rows = await q(db, 'SELECT model_code, version, status FROM manuals ORDER BY id');
  console.log('seeded:', rows);
}
