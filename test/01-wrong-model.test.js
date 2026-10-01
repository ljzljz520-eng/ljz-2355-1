import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';

let api, stop;
before(async () => { const h = await startHarness(); api = h.api; stop = h.stop; });
after(async () => { if (stop) await stop(); });

test('场景1 错机型：E-410 同名跨机型含义不同，不能按字符串命中给出结论', async () => {
  // 在 AC-300 上查 E-410 → 得到的是总线丢帧释义，而不是 AC-200 的过热释义
  const ok = await api('/fault-codes/lookup?code=e-410&model=AC-300');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.resolved, true);
  assert.match(ok.body.matches[0].meaning, /CAN/);
  assert.doesNotMatch(ok.body.matches[0].meaning, /温度/);

  // 在 AC-200 上查 → 完全不同的释义（温度超限）
  const ok2 = await api('/fault-codes/lookup?code=E-410&model=AC-200');
  assert.match(ok2.body.matches[0].meaning, /温度/);

  // 不选机型 → 拒绝归并，要求先选机型
  const amb = await api('/fault-codes/lookup?code=E-410');
  assert.equal(amb.status, 200);
  assert.equal(amb.body.resolved, false);
  assert.equal(amb.body.reason, 'AMBIGUOUS_MODEL');
  assert.equal(amb.body.matches.length, 2);

  // 错机型字符串命中：E-202 只在 AC-300 存在，AC-200 查询不得套用
  const wrong = await api('/fault-codes/lookup?code=E-202&model=AC-200');
  assert.equal(wrong.body.resolved, false);
  assert.equal(wrong.body.reason, 'WRONG_MODEL');
  assert.ok(wrong.body.crossModel.some((m) => m.model_code === 'AC-300'));

  // 未知故障码：不编造释义与操作
  const nf = await api('/fault-codes/lookup?code=E-999&model=AC-200');
  assert.equal(nf.body.reason, 'NOT_FOUND');
  assert.match(nf.body.message, /不提供推测性解释/);

  // 建单时错机型故障码必须被拦截
  const create = await api('/work-orders', { method: 'POST',
    body: { wo_no: 'WO-BAD1', model_code: 'AC-200', serial_no: 10, fault_code: 'E-202' } });
  assert.equal(create.status, 422);
  assert.equal(create.body.reason, 'WRONG_MODEL');
});
