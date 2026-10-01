import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { addSubstitution, directSubstitutes, transitiveChains } from '../server/domain/parts.js';

test('替代关系有方向：TC-110→TC-100 成立，反向不自动成立', async () => {
  const db = await freshDb();
  const fwd = await directSubstitutes(db, 'p_tc110', { modelId: 'm_x1' });
  assert.deepEqual(fwd.map((x) => x.part.part_no), ['TC-100']);

  const rev = await directSubstitutes(db, 'p_tc100', { modelId: 'm_x1' });
  assert.deepEqual(rev, []); // 不能反推 TC-100 可用 TC-110
});

test('不做无条件传递：TC-120→TC-110→TC-100 不推出 TC-120 兼容 TC-100', async () => {
  const db = await freshDb();
  const direct = await directSubstitutes(db, 'p_tc120', { modelId: 'm_x1' });
  assert.deepEqual(direct.map((x) => x.part.part_no), ['TC-110']);
  // 多跳链只在诊断接口显式可见，且明确标注不是兼容结论
  const chains = await transitiveChains(db, 'p_tc120', 3);
  const to100 = chains.find((c) => c.chain[c.chain.length - 1] === 'p_tc100');
  assert.ok(to100, '诊断中应能看到链路');
});

test('生效范围过滤：机型与日期不满足时不返回', async () => {
  const db = await freshDb();
  assert.equal((await directSubstitutes(db, 'p_tc110', { modelId: 'm_x2' })).length, 0);
  assert.equal((await directSubstitutes(db, 'p_tc110', { modelId: 'm_x1', onDate: '2027-01-01' })).length, 0);
  assert.equal((await directSubstitutes(db, 'p_hs310', { modelId: 'm_x1', onDate: '2025-12-31' })).length, 0);
});

test('替代件环：新增会成环的边被拒绝并给出环路径', async () => {
  const db = await freshDb();
  // 现有 TC-120→TC-110→TC-100；若试图 TC-100→TC-120 形成长度3的环，必须拒绝
  const r = await addSubstitution(db, {
    fromPartNo: 'TC-100', toPartNo: 'TC-120',
    applicableModels: ['m_x1'],
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SUBST_CYCLE');
  assert.ok(r.path.length >= 3);
  // 验证没有写入
  const all = await db.find('part_substitutions');
  assert.ok(!all.some((e) => e.from_part_id === 'p_tc100' && e.to_part_id === 'p_tc120'));
});

test('双向互换必须两边显式 declared_pair，禁止单向反推', async () => {
  const db = await freshDb();
  const bad = await addSubstitution(db, {
    fromPartNo: 'TC-100', toPartNo: 'TC-110',
    directionNote: 'forward_only', applicableModels: ['m_x1'],
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'CYCLE_2');
});

test('自环与重复边被拒绝', async () => {
  const db = await freshDb();
  assert.equal((await addSubstitution(db, { fromPartNo: 'TC-100', toPartNo: 'TC-100' })).code, 'SELF_LOOP');
  const dup = await addSubstitution(db, { fromPartNo: 'TC-110', toPartNo: 'TC-100' });
  assert.equal(dup.code, 'DUP_EDGE');
});

test('序列号生效范围：无序列号不乐观放行，区间外禁用，区间内可用', async () => {
  const db = await freshDb();
  // HS-310→HS-300 带 serial_range {from: AX1-2026-0001}
  const noSerial = await directSubstitutes(db, 'p_hs310', { modelId: 'm_x1', onDate: '2026-06-01' });
  assert.equal(noSerial.length, 1, '边仍返回但显式标记为受限');
  assert.equal(noSerial[0].usable, false);
  assert.equal(noSerial[0].serialStatus, 'serial_required');

  const inRange = await directSubstitutes(db, 'p_hs310', {
    modelId: 'm_x1', serialNo: 'AX1-2026-0300', onDate: '2026-06-01',
  });
  assert.equal(inRange[0].usable, true);
  assert.equal(inRange[0].serialStatus, 'in_range');

  const outOfRange = await directSubstitutes(db, 'p_hs310', {
    modelId: 'm_x1', serialNo: 'AX1-2025-9000', onDate: '2026-06-01',
  });
  assert.equal(outOfRange[0].usable, false);
  assert.equal(outOfRange[0].serialStatus, 'out_of_range');
});
