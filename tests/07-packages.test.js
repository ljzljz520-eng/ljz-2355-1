import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { buildPackage, comparePackaging, taskClosure } from '../server/domain/packages.js';
import { createManualRevision, getManual } from '../server/domain/manuals.js';

test('任务依赖闭包只含显式上游，任务环报错', async () => {
  const db = await freshDb();
  const rev2Id = (await db.find('manuals', { model_id: 'm_x1', status: 'approved' }))
    .find((m) => m.revision === 2).id;
  const tasks = await db.find('tasks', { manual_id: rev2Id });
  const closure = taskClosure(tasks, ['S-TEMP']);
  assert.deepEqual(closure.sort(), ['S-LOCK', 'S-TEMP']);
  const cyclic = [
    { step_key: 'A', depends_on: ['B'] },
    { step_key: 'B', depends_on: ['A'] },
  ];
  assert.throws(() => taskClosure(cyclic, ['A']), /任务依赖存在环/);
});

test('比较：任务包是整包严格子集且版本一致；清单里步骤指纹齐全可离线核对', async () => {
  const db = await freshDb();
  const rev2Id = (await db.find('manuals', { model_id: 'm_x1', status: 'approved' }))
    .find((m) => m.revision === 2).id;
  const cmp = await comparePackaging(db, { manualId: rev2Id, rootTaskKeys: ['S-TEMP'] });
  assert.equal(cmp.subset, true);
  assert.equal(cmp.same_manual_revision, true);
  assert.ok(cmp.omitted_by_task_package.includes('S-VERIFY'));

  const full = await buildPackage(db, { kind: 'full_model', manualId: rev2Id });
  assert.ok(full.manifest.steps.every((s) => s.content_hash && s.depends_on_keys !== undefined));
  assert.ok(full.manifest_hash.length === 64);
});
