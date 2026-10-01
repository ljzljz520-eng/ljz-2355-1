import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';

let api, stop, db;
before(async () => { const h = await startHarness(); api = h.api; stop = h.stop; db = h.db; });
after(async () => { if (stop) await stop(); });

test('场景5 云端与离线冲突：分叉时离线证据隔离保留，不静默覆盖；撤回式解决也留证', async () => {
  const woId = 1; // WO-1001，种子 revision=1，离线基线 0

  // 5.1 云端先前进一版（模拟调度员在云端标记了 040 完成）
  const wo = await api(`/work-orders/${woId}`);
  const item040 = wo.body.items.find((i) => i.step_no === '040');
  await api(`/work-orders/${woId}/items/${item040.id}/complete`, { method: 'POST' });
  // 该端点不增加工单 revision（现场勾选），先制造一次云端同步使 revision 前移：
  // 用同基线应用一次云端合法同步
  let w = (await api(`/work-orders/${woId}`)).body.work_order;
  const synced = await api(`/work-orders/${woId}/sync`, { method: 'POST', body: {
    base_revision: w.revision, items: [], evidences: [],
  }});
  assert.equal(synced.status, 200);

  // 5.2 离线端仍持有旧基线，带回现场照片与勾选 → 冲突
  w = (await api(`/work-orders/${woId}`)).body.work_order;
  const staleBase = w.revision - 1;
  const conflictRes = await api(`/work-orders/${woId}/sync`, { method: 'POST', body: {
    base_revision: staleBase,
    items: [{ step_no: '020', state: 'done' }],
    evidences: [{ kind: 'photo', filename: 'offline-field-020.jpg', bytes: 123456, captured_at: new Date().toISOString() }],
  }});
  assert.equal(conflictRes.status, 409);
  assert.equal(conflictRes.body.conflict, true);

  // 5.3 离线证据被隔离保留（quarantined），云端数据未被覆盖
  const quar = await db.query(`SELECT count(*)::int AS n FROM evidence
    WHERE work_order_id=$1 AND status='quarantined' AND filename='offline-field-020.jpg'`, [woId]);
  assert.equal(quar.rows[0].n, 1);
  const still = await api(`/work-orders/${woId}`);
  const s040 = still.body.items.find((i) => i.step_no === '040');
  assert.equal(s040.state, 'done'); // 云端勾选保留

  // 5.4 冲突可查询，且不能重复解决
  const conflicts = await api(`/work-orders/${woId}/conflicts`);
  const cf = conflicts.body[0];
  assert.equal(cf.status, 'open');

  // 5.5 选择保留离线：隔离证据转 active，离线勾选生效；证据不丢
  const resolve = await api(`/sync-conflicts/${cf.id}/resolve`, { method: 'POST',
    body: { resolution: 'keep_offline', by: 'supervisor-li', note: '核实现场照片有效' } });
  assert.equal(resolve.status, 200);
  const actv = await db.query(`SELECT count(*)::int AS n FROM evidence
    WHERE work_order_id=$1 AND status='active' AND filename='offline-field-020.jpg'`, [woId]);
  assert.equal(actv.rows[0].n, 1);
  const s020 = (await api(`/work-orders/${woId}`)).body.items.find((i) => i.step_no === '020');
  assert.equal(s020.state, 'done');

  const again = await api(`/sync-conflicts/${cf.id}/resolve`, { method: 'POST', body: { resolution: 'keep_cloud' } });
  assert.equal(again.status, 409);

  // 审计记录冲突全程
  const logs = await api('/audit');
  const actions = logs.body.map((l) => l.action);
  assert.ok(actions.includes('sync.conflict'));
  assert.ok(actions.includes('sync.resolve'));
});

test('场景5b keep_cloud 解决：离线证据也保留（标记 withdrawn），不删除', async () => {
  const woId = 1;
  let w = (await api(`/work-orders/${woId}`)).body.work_order;
  const r = await api(`/work-orders/${woId}/sync`, { method: 'POST', body: {
    base_revision: w.revision - 1,
    items: [],
    evidences: [{ kind: 'signature', filename: 'offline-sign.png', bytes: 999 }],
  }});
  assert.equal(r.status, 409);
  const conflicts = await api(`/work-orders/${woId}/conflicts`);
  const openCf = conflicts.body.find((c) => c.status === 'open');
  await api(`/sync-conflicts/${openCf.id}/resolve`, { method: 'POST',
    body: { resolution: 'keep_cloud', note: '以云端为准' } });
  const kept = await db.query(`SELECT count(*)::int AS n FROM evidence
    WHERE work_order_id=$1 AND filename='offline-sign.png'`, [woId]);
  assert.equal(kept.rows[0].n, 1); // 行仍在，可审计
});
