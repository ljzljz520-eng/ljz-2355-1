import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { getManual, judgeRebase, validateRebaseDecisions } from '../server/domain/manuals.js';

async function x1Revs(db) {
  const mans = (await db.find('manuals', { model_id: 'm_x1', status: 'approved' }))
    .sort((a, b) => a.revision - b.revision);
  const rev1 = await getManual(db, mans[0].id);
  const rev2 = await getManual(db, mans[1].id);
  return { rev1, rev2 };
}

test('改版后逐项判定：未变可继承、安全关键变更必须重做、删除归档、新增待做', async () => {
  const db = await freshDb();
  const { rev1, rev2 } = await x1Revs(db);

  // 现场已在 rev1 完成全部步骤
  const done = {};
  for (const s of rev1.steps) done[s.key_code] = { action: 'check', content_hash: s.content_hash };

  const items = judgeRebase({ oldSteps: rev1.steps, newSteps: rev2.steps, done });
  const byKey = Object.fromEntries(items.map((i) => [i.step_key, i]));

  assert.equal(byKey['S-LOCK'].verdict, 'unchanged');
  assert.equal(byKey['S-LOCK'].inherited, true);

  // S-TEMP 内容改变且安全关键：禁止继承
  assert.equal(byKey['S-TEMP'].verdict, 'content_changed');
  assert.equal(byKey['S-TEMP'].safety_critical, true);
  assert.equal(byKey['S-TEMP'].requiredDecision, 'redo_required');

  // S-HEAT 普通步骤内容改变：逐项复核而非自动完成
  assert.equal(byKey['S-HEAT'].verdict, 'content_changed');
  assert.equal(byKey['S-HEAT'].requiredDecision, 'review_each');

  assert.equal(byKey['S-VERIFY'].verdict, 'added');
  assert.equal(byKey['S-OLD'].verdict, 'removed');

  // S-CLOSE 正文未变，仅前置依赖从 S-HEAT 改为 S-VERIFY
  assert.equal(byKey['S-CLOSE'].verdict, 'dependency_changed');
  assert.equal(byKey['S-CLOSE'].requiredDecision, 'manual_review');
});

test('未勾选的步骤改版后是 not_done，不会被算完成', async () => {
  const db = await freshDb();
  const { rev1, rev2 } = await x1Revs(db);
  const done = { 'S-LOCK': { action: 'check', content_hash: rev1.steps[0].content_hash } };
  const items = judgeRebase({ oldSteps: rev1.steps, newSteps: rev2.steps, done });
  const temp = items.find((i) => i.step_key === 'S-TEMP');
  assert.equal(temp.verdict, 'not_done');
});

test('依赖变化触发 dependency_changed', async () => {
  const db = await freshDb();
  const oldSteps = [
    { key_code: 'A', title: 'a', content: 'x', safety_critical: false, depends_on_keys: [], content_hash: 'h1' },
    { key_code: 'B', title: 'b', content: 'y', safety_critical: false, depends_on_keys: ['A'], content_hash: 'h2' },
  ];
  const newSteps = [
    { key_code: 'A', title: 'a', content: 'x', safety_critical: false, depends_on_keys: [], content_hash: 'h1' },
    { key_code: 'B', title: 'b', content: 'y', safety_critical: false, depends_on_keys: [], content_hash: 'h2' },
  ];
  const done = { A: { action: 'check' }, B: { action: 'check' } };
  const items = judgeRebase({ oldSteps, newSteps, done });
  assert.equal(items.find((i) => i.step_key === 'B').verdict, 'dependency_changed');
});

test('决定校验：安全关键项禁止 inherit；决定缺失被拒绝；无“一键全完成”', async () => {
  const db = await freshDb();
  const { rev1, rev2 } = await x1Revs(db);
  const done = {};
  for (const s of rev1.steps) done[s.key_code] = { action: 'check', content_hash: s.content_hash };
  const items = judgeRebase({ oldSteps: rev1.steps, newSteps: rev2.steps, done });

  const bad = validateRebaseDecisions(items, { 'S-TEMP': 'inherit', 'S-HEAT': 'inherit', 'S-OLD': 'skip', 'S-CLOSE': 'redo' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(), /安全关键/);

  const missing = validateRebaseDecisions(items, {});
  assert.equal(missing.ok, false);
  assert.match(missing.errors.join(), /缺少逐项决定/);

  const good = validateRebaseDecisions(items, {
    'S-TEMP': 'redo', 'S-HEAT': 'redo', 'S-OLD': 'skip', 'S-CLOSE': 'redo',
  });
  assert.equal(good.ok, true, good.errors.join(';'));
});
