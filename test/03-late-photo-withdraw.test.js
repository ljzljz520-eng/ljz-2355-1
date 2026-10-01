import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';

let api, stop, db;
before(async () => { const h = await startHarness(); api = h.api; stop = h.stop; db = h.db; });
after(async () => { if (stop) await stop(); });

test('场景3 照片晚传：作业后补交可接收，保留原始采集时间并标记晚传', async () => {
  const woId = 1; // 种子工单 WO-1001
  const wo = await api(`/work-orders/${woId}`);
  const item030 = wo.body.items.find((i) => i.step_no === '030');

  // 模拟晚传：采集时间为两天前，上传在现在
  const captured = new Date(Date.now() - 2 * 86400e3).toISOString();
  const up = await api(`/work-orders/${woId}/evidence`, { method: 'POST', body: {
    kind: 'photo', filename: 'fan-replacement.jpg', mime: 'image/jpeg', bytes: 512000,
    item_id: item030.id, captured_at: captured,
  }});
  assert.equal(up.status, 201);
  assert.equal(up.body.late_upload, true);
  assert.equal(up.body.evidence.status, 'active');
  assert.ok(Math.abs(new Date(up.body.evidence.captured_at) - new Date(captured)) < 5000);

  // 撤回前必须先看到影响提示
  const prev = await api(`/evidence/${up.body.evidence.id}/withdraw-preview`, { method: 'POST' });
  assert.equal(prev.status, 200);
  assert.match(prev.body.warning, /不会删除文件/);
  assert.equal(prev.body.linked_items[0].step_no, '030');

  // 执行撤回：状态 withdrawn，行与文件元数据仍保留；重复撤回被拒绝
  const wd = await api(`/evidence/${up.body.evidence.id}/withdraw`, { method: 'POST', body: { note: '照片模糊，待重拍' } });
  assert.equal(wd.status, 200);
  assert.equal(wd.body.retained, true);
  const again = await api(`/evidence/${up.body.evidence.id}/withdraw`, { method: 'POST' });
  assert.equal(again.status, 409);

  const rows = await db.query('SELECT count(*)::int AS n FROM evidence WHERE id=$1 AND status=$2',
    [up.body.evidence.id, 'withdrawn']);
  assert.equal(rows.rows[0].n, 1);

  // 审计留痕（晚传接收 + 撤回）
  const logs = await api('/audit');
  const actions = logs.body.map((l) => l.action);
  assert.ok(actions.includes('evidence.upload'));
  assert.ok(actions.includes('evidence.withdraw'));
});
