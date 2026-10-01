import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';

let api, stop;
before(async () => { const h = await startHarness(); api = h.api; stop = h.stop; });
after(async () => { if (stop) await stop(); });

test('整机型包 vs 按任务依赖打包：覆盖范围与内容指纹不同', async () => {
  const full = await api('/packages/full', { method: 'POST', body: { model_code: 'AC-200' } });
  assert.equal(full.status, 201);
  assert.ok(full.body.manifest.includes.all_steps.length >= 5);
  assert.ok(full.body.manifest.includes.fault_codes.includes('E-410'));

  const task = await api('/work-orders/1/packages/task', { method: 'POST', body: {} });
  assert.equal(task.status, 201);
  // 任务包钉在工单绑定的 v1.0，且只含 E-410 引用的步骤
  assert.equal(task.body.manifest.manual_version, 'v1.0');
  // 工单钉在 v1.0（只有 010-040），任务包按 v1.0 实际存在且被故障引用的步骤裁剪
  assert.deepEqual(task.body.manifest.includes.steps, ['010', '020', '030', '040']);
  assert.ok(!task.body.manifest.includes.steps.includes('050'));
  assert.ok(task.body.manifest.includes.parts.includes('FAN-01'));
  assert.match(task.body.manifest.note, /非整机型/);
});

test('业务服务适用范围：按机型/序列号/日期窗判定', async () => {
  const a = await api('/coverages?model=AC-200&serial=600&date=2026-06-01');
  const programs = a.body.applicable.map((c) => c.program);
  assert.ok(programs.includes('标准保修'));
  assert.ok(programs.includes('延保包 Plus'));

  const b = await api('/coverages?model=AC-200&serial=100&date=2026-06-01');
  assert.deepEqual(b.body.applicable.map((c) => c.program), ['标准保修']);

  const c = await api('/coverages?model=AC-300&serial=10&date=2026-06-01');
  assert.deepEqual(c.body.applicable.map((x) => x.program), ['标准保修']);

  const d = await api('/coverages?model=AC-200&serial=600&date=2031-01-01');
  assert.equal(d.body.applicable.length, 0);
});
