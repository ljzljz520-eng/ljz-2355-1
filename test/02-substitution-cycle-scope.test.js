import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { intersectScopes, wouldCreateCycle, checkCompatible } from '../server/domain/substitution.js';

let api, stop;
before(async () => { const h = await startHarness(); api = h.api; stop = h.stop; });
after(async () => { if (stop) await stop(); });

test('场景2a 替代件环：新增会成环的有向边被拒绝（409），数据库不落库', async () => {
  // 已有 FAN-02→FAN-01、FAN-03→FAN-02；若再建 FAN-01→FAN-03 即闭环
  const r = await api('/substitutions', { method: 'POST', body: {
    sku: 'FAN-01', replaces_sku: 'FAN-03', direction: 'forward', model_code: 'AC-200',
  }});
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'SUBSTITUTION_CYCLE');

  // 落库数量不变（只有种子 3 条）
  const list = await api('/substitutions');
  assert.equal(list.body.length, 3);
});

test('场景2b 有向性：FAN-02 能替 FAN-01（AC-200/sn500），反向不成立', async () => {
  const yes = await api('/substitutions/check?source=FAN-02&target=FAN-01&model=AC-200&serial=500&date=2026-05-01');
  assert.equal(yes.body.compatible, true);
  const no = await api('/substitutions/check?source=FAN-01&target=FAN-02&model=AC-200&serial=500');
  assert.equal(no.body.compatible, false);
});

test('场景2c 禁止无条件传递：FAN-03→FAN-02→FAN-01 跨机型范围不相交，传递中断', async () => {
  // 不传上下文时 findSubstitutions 也在交集处（机型 AC-300 ∩ AC-200 = 空）剪枝
  const r = await api('/substitutions/check?source=FAN-03&target=FAN-01&model=AC-300&serial=100&date=2026-05-01');
  assert.equal(r.body.compatible, false);
  assert.equal(r.body.reason, 'NO_DIRECTED_PATH');
});

test('场景2d 生效范围：序列号越界 / 日期未生效均判不兼容', async () => {
  // FAN-02 替 FAN-01 仅限序列号 1-1000
  const oob = await api('/substitutions/check?source=FAN-02&target=FAN-01&model=AC-200&serial=5000');
  assert.equal(oob.body.compatible, false);
  assert.equal(oob.body.reason, 'OUT_OF_SCOPE');
  // BRD-11 替 BRD-10 限 sn>=500 且 2026-01-01 起
  const early = await api('/substitutions/check?source=BRD-11&target=BRD-10&model=AC-200&serial=600&date=2025-12-31');
  assert.equal(early.body.compatible, false);
  const good = await api('/substitutions/check?source=BRD-11&target=BRD-10&model=AC-200&serial=600&date=2026-06-01');
  assert.equal(good.body.compatible, true);
});

test('场景2e 纯函数：范围交集与环检测', () => {
  assert.equal(intersectScopes(
    { model_code: 'AC-300', serial_from: 1, serial_to: 500, valid_from: null, valid_to: null },
    { model_code: 'AC-200', serial_from: 1, serial_to: 1000, valid_from: null, valid_to: null }), null);
  assert.deepEqual(intersectScopes(
    { model_code: 'AC-200', serial_from: 1, serial_to: 1000, valid_from: null, valid_to: null },
    { model_code: null, serial_from: 500, serial_to: 2000, valid_from: null, valid_to: null })
    .serial_from, 500);
  const edges = [
    { id: 1, sku: 'A', replaces_sku: 'B', direction: 'forward', status: 'approved' },
    { id: 2, sku: 'B', replaces_sku: 'C', direction: 'forward', status: 'approved' },
  ];
  assert.equal(wouldCreateCycle(edges, { sku: 'C', replaces_sku: 'A', direction: 'forward' }), true);
  assert.equal(wouldCreateCycle(edges, { sku: 'C', replaces_sku: 'D', direction: 'forward' }), false);
  // 被拒绝的边不参与环检测
  edges.push({ id: 3, sku: 'C', replaces_sku: 'A', direction: 'forward', status: 'rejected' });
  assert.equal(wouldCreateCycle(edges, { sku: 'A', replaces_sku: 'C', direction: 'reverse' }), true);
  // 有效上下文内的多级传递
  const chain = [
    { id: 1, sku: 'A', replaces_sku: 'B', direction: 'forward', status: 'approved',
      model_code: 'AC-200', serial_from: 1, serial_to: 1000, valid_from: '1970-01-01', valid_to: '9999-12-31' },
    { id: 2, sku: 'B', replaces_sku: 'C', direction: 'forward', status: 'approved',
      model_code: 'AC-200', serial_from: 100, serial_to: 800, valid_from: '1970-01-01', valid_to: '9999-12-31' },
  ];
  const c = checkCompatible(chain, 'A', 'C', { modelCode: 'AC-200', serial: 500, date: '2026-01-01' });
  assert.equal(c.compatible, true);
  assert.equal(c.paths[0].effectiveScope.serial_from, 100);
  assert.equal(checkCompatible(chain, 'A', 'C', { modelCode: 'AC-200', serial: 900, date: '2026-01-01' }).compatible, false);
});
