import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, publishAc200V12 } from './helpers.js';

let api, stop;
before(async () => { const h = await startHarness(); api = h.api; stop = h.stop; });
after(async () => { if (stop) await stop(); });

test('场景4 打印中改步骤：打印钉版可追溯，改步骤后逐项判定且不静默重置/不全算完成', async () => {
  const woId = 1; // WO-1001 已离线绑定 v1.0（种子中已被 v1.1 取代）

  // 4.1 打印维护单：记录实际使用的说明版与指纹，且给出取代提示
  const print = await api(`/work-orders/${woId}/print`, { method: 'POST' });
  assert.equal(print.status, 201);
  assert.equal(print.body.print_record.printed_version, 'v1.0');
  assert.match(print.body.supersession_notice, /v1\.1/);
  assert.ok(print.body.print_record.content_hash.length === 16);

  // 4.2 云端再发布 v1.2（打印期间/之后关键步骤 030 再次更新）
  const pub = await publishAc200V12(api);
  assert.equal(pub.status, 201);
  const v12Id = pub.body.id;

  // 4.3 工单详情：对已完成项逐项给出判定，关键步骤 030→needs_redo；未完成项不要求裁决
  const detail = await api(`/work-orders/${woId}`);
  assert.equal(detail.body.reevaluation.against_version, 'v1.2');
  const d030 = detail.body.reevaluation.decisions.find((d) => d.step_no === '030');
  assert.equal(d030.suggested, 'needs_redo');
  assert.equal(d030.reason, 'KEY_STEP_CHANGED');
  const d010 = detail.body.reevaluation.decisions.find((d) => d.step_no === '010');
  assert.equal(d010.suggested, 'inheritable'); // 内容未变
  assert.ok(detail.body.reevaluation.pendingDecisions >= 2);
  assert.equal(detail.body.reevaluation.canComplete, false);

  // 既没有静默重置：已完成项仍是 done/保留完成时间
  const item030 = detail.body.items.find((i) => i.step_no === '030');
  assert.equal(item030.state, 'done');
  assert.ok(item030.completed_at);

  // 4.4 未逐项裁决前完成工单 → 409，列明阻断项
  const blocked = await api(`/work-orders/${woId}/complete`, { method: 'POST' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'WO_NOT_COMPLETABLE');
  assert.ok(blocked.body.blockers.some((b) => b.item === '030'));

  // 4.5 不允许静默换绑；必须显式迁移。迁移保留已做记录，新增 050，输出逐项判定
  const quiet = await api(`/work-orders/${woId}/bind-manual`, { method: 'POST', body: { manual_id: v12Id } });
  assert.equal(quiet.status, 409);
  const mig = await api(`/work-orders/${woId}/bind-manual`, { method: 'POST', body: { manual_id: v12Id, migrate: true } });
  assert.equal(mig.status, 201);
  assert.ok(mig.body.reevaluation.pendingDecisions >= 2);
  assert.match(mig.body.warning, /逐项裁决/);

  const afterMig = await api(`/work-orders/${woId}`);
  // 没有静默重置：旧完成态仍在
  const a010 = afterMig.body.items.find((i) => i.step_no === '010');
  assert.equal(a010.state, 'done');
  assert.ok(a010.completed_at);
  // 没有全算完成：新增步骤 050 是 pending
  const a050 = afterMig.body.items.find((i) => i.step_no === '050');
  assert.equal(a050.state, 'pending');
  // 迁移后指纹已是 v1.2
  assert.equal(afterMig.body.bound_manual.version, 'v1.2');

  // 4.6 逐项裁决：010 继承、020 复核继承、030 关键步骤重作
  const items = afterMig.body.items;
  const decide = async (no, action, note) => {
    const it = items.find((i) => i.step_no === no);
    const r = await api(`/work-orders/${woId}/items/${it.id}/decision`, {
      method: 'POST', body: { action, by: 'zhang', note } });
    assert.equal(r.status, 200, `${no} ${action}`);
  };
  await decide('010', 'inherit', '上锁步骤无变化');
  await decide('020', 'inherit', '护板拆卸非关键，复核一致');
  await decide('030', 'redo', '按 v1.2 扭矩 4.0N·m 与硅脂要求重作');

  // needs_redo 的项必须重新完成，否则仍然阻断
  assert.equal((await api(`/work-orders/${woId}/complete`, { method: 'POST' })).status, 409);
  const i030 = items.find((i) => i.step_no === '030');
  await api(`/work-orders/${woId}/items/${i030.id}/complete`, { method: 'POST' });
  // 未完成步骤 040/050 仍阻断
  const blocked3 = await api(`/work-orders/${woId}/complete`, { method: 'POST' });
  assert.equal(blocked3.status, 409);
  const remain = blocked3.body.blockers.map((b) => b.item);
  assert.ok(remain.includes('040') && remain.includes('050'));
  const i040 = items.find((i) => i.step_no === '040');
  const i050 = items.find((i) => i.step_no === '050');
  await api(`/work-orders/${woId}/items/${i040.id}/complete`, { method: 'POST' });
  await api(`/work-orders/${woId}/items/${i050.id}/complete`, { method: 'POST' });

  // 4.7 全部满足后才能完成，且完成时钉到 v1.2 指纹
  const done = await api(`/work-orders/${woId}/complete`, { method: 'POST' });
  assert.equal(done.status, 200);
  const finalWo = await api(`/work-orders/${woId}`);
  assert.equal(finalWo.body.work_order.status, 'completed');
  assert.equal(finalWo.body.work_order.bound_version, 'v1.2');

  // 4.8 打印记录始终可追溯到实际使用过的版本：首张维护单仍是 v1.0
  const prints = await api(`/work-orders/${woId}/prints`);
  assert.equal(prints.body[0].printed_version, 'v1.0');
  assert.equal(prints.body[0].content_hash, detail.body.bound_manual.content_hash);
});

test('未绑定快照不能打印可追溯维护单', async () => {
  const create = await api('/work-orders', { method: 'POST',
    body: { wo_no: 'WO-FRESH', model_code: 'AC-200', serial_no: 600, fault_code: 'E-410' } });
  const r = await api(`/work-orders/${create.body.id}/print`, { method: 'POST' });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'NO_SNAPSHOT');
});
