import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { searchFaults, normalizeCode } from '../server/domain/faults.js';

test('同码 E404 在不同机型下返回不同含义，选定机型才给结论', async () => {
  const db = await freshDb();
  const x1 = await searchFaults({ db }, { modelId: 'm_x1', q: 'e404' });
  assert.equal(x1.mode, 'model_scoped_exact');
  assert.match(x1.items[0].meaning, /温度传感器/);

  const x2 = await searchFaults({ db }, { modelId: 'm_x2', q: 'E-404' });
  assert.equal(x2.mode, 'model_scoped_exact');
  assert.match(x2.items[0].meaning, /固件参数未标定/);
  assert.ok(!x2.items.some((i) => i.meaning.includes('温度传感器')));
});

test('错机型：X2 的码不出现在 X1 的命中里，只给消歧提示', async () => {
  const db = await freshDb();
  // 只在 X1 有 H204：在 X2 检索不应把 X1 含义当结果
  const r = await searchFaults({ db }, { modelId: 'm_x2', q: 'H204' });
  assert.equal(r.mode, 'code_unknown_for_model');
  assert.equal(r.items.length, 0);
  assert.match(r.warning, /没有记录/);
  assert.equal(r.otherModels[0].modelId, 'm_x1');
});

test('未选机型只做消歧，不泄露任机型维修结论', async () => {
  const db = await freshDb();
  const r = await searchFaults({ db }, { q: 'E404' });
  assert.equal(r.mode, 'disambiguation_only');
  assert.equal(r.distinctModels, 2);
  assert.ok(r.items.every((i) => i.meaning === undefined));
});

test('草稿故障码不参与现场检索；症状关键词也限定机型', async () => {
  const db = await freshDb();
  const r = await searchFaults({ db }, { modelId: 'm_x1', q: 'T999' });
  assert.equal(r.mode, 'code_unknown_for_model');
  const kw = await searchFaults({ db }, { modelId: 'm_x1', q: '绝缘' });
  assert.equal(kw.items.length, 1);
  assert.equal(kw.items[0].code, 'H204');
});

test('码值归一化：分隔符与大小写不影响匹配', () => {
  assert.equal(normalizeCode(' e-404 '), 'E404');
});
