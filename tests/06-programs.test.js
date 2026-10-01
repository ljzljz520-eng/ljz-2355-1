import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { listProgramsForModel, checkApplicability } from '../server/domain/programs.js';

test('服务程序适用范围：按机型白名单与序列号区间判定，不近似适用', async () => {
  const db = await freshDb();
  const progs = await listProgramsForModel(db, { modelId: 'm_x2', serialNo: 'BX2-2025-0100' });
  const byName = Object.fromEntries(progs.map((p) => [p.name, p]));
  assert.equal(byName['标准两年保修'].appliesTo, true);
  assert.equal(byName['X2 延保五年'].appliesTo, true);

  // X1 不适用 X2 延保
  const x1 = await listProgramsForModel(db, { modelId: 'm_x1', serialNo: 'AX1-2025-0001' });
  assert.ok(x1.every((p) => !(p.name === 'X2 延保五年' && p.appliesTo)));
  const ext = x1.find((p) => p.name === 'X2 延保五年');
  assert.ok(ext.reasons.includes('机型不在适用范围'));
});

test('序列号早于适用区间不适用，并给出原因', async () => {
  const db = await freshDb();
  const progs = await listProgramsForModel(db, { modelId: 'm_x2', serialNo: 'BX2-2024-9999' });
  const ext = progs.find((p) => p.name === 'X2 延保五年');
  assert.equal(ext.appliesTo, false);
  assert.ok(ext.reasons.includes('序列号不在适用区间'));
});

test('无序列号时对有序列号限制的程序不适用（不做乐观假设）', async () => {
  const db = await freshDb();
  const ext = (await listProgramsForModel(db, { modelId: 'm_x2' })).find((p) => p.name === 'X2 延保五年');
  assert.equal(ext.appliesTo, false);
});
