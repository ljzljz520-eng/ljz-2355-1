import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import {
  createWorkOrder, getWorkOrderDetail, appendStepEvent, addEvidence,
  completeWorkOrder, syncBundle, resolveConflict,
} from '../server/domain/workorders.js';
import { buildPackage, withdrawPackage } from '../server/domain/packages.js';
import { getManual } from '../server/domain/manuals.js';

let seq = 0;
const ceid = (p) => `${p}-${++seq}-${Math.random().toString(36).slice(2, 7)}`;

async function x1Manuals(db) {
  const mans = (await db.find('manuals', { model_id: 'm_x1', status: 'approved' }))
    .sort((a, b) => a.revision - b.revision);
  return { rev1: mans[0], rev2: mans[1] };
}

test('建单绑定手册快照：错机型拒绝，草稿版拒绝', async () => {
  const db = await freshDb();
  const { rev1 } = await x1Manuals(db);
  await assert.rejects(() => createWorkOrder(db, { modelId: 'm_x2', manualId: rev1.id }), /不属于机型/);

  const drafts = await db.find('manuals', { status: 'draft' });
  await assert.rejects(() => createWorkOrder(db, { modelId: 'm_x1', manualId: drafts[0].id }), /审核通过/);

  const r = await createWorkOrder(db, { modelId: 'm_x1', manualId: rev1.id });
  assert.equal(r.workOrder.manual_revision, 1);
  assert.ok(r.snapshot.snapshot_hash);
  assert.equal(r.snapshot.steps.length, 5);
});

test('工单固定快照：云端发布 rev2 后工单仍呈现 rev1 步骤', async () => {
  const db = await freshDb();
  const { rev1, rev2 } = await x1Manuals(db);
  const { workOrder } = await createWorkOrder(db, { modelId: 'm_x1', manualId: rev1.id });
  assert.notEqual(rev1.id, rev2.id);
  const detail = await getWorkOrderDetail(db, workOrder.id);
  assert.equal(detail.pinnedManual.revision, 1);
  assert.ok(detail.steps.some((s) => s.key_code === 'S-OLD'));
  assert.ok(!detail.steps.some((s) => s.key_code === 'S-VERIFY'));
});

test('勾选校验 content_hash：按旧内容勾选被改步骤会被拒（打印中改步骤场景）', async () => {
  const db = await freshDb();
  const { rev1 } = await x1Manuals(db);
  const { workOrder } = await createWorkOrder(db, { modelId: 'm_x1', manualId: rev1.id });
  const rev1Manual = await getManual(db, rev1.id);
  const sTemp = rev1Manual.steps.find((s) => s.key_code === 'S-TEMP');

  // 用一个不存在于快照的“新 hash”模拟拿着改版正文在旧工单勾选
  await assert.rejects(
    () => appendStepEvent(db, workOrder.id, {
      stepKey: 'S-TEMP', action: 'check', contentHash: 'deadbeef',
      clientEventId: ceid('evt'), baseEventId: null,
    }),
    /手册已改版/,
  );
  // 正确 hash 可勾选
  const okEvt = await appendStepEvent(db, workOrder.id, {
    stepKey: 'S-TEMP', action: 'check', contentHash: sTemp.content_hash,
    clientEventId: ceid('evt'), baseEventId: null,
  });
  assert.equal(okEvt.event.content_hash, sTemp.content_hash);
});

test('乐观并发：云端与离线冲突时不静默覆盖，登记冲突并返回 409', async () => {
  const db = await freshDb();
  const { rev1 } = await x1Manuals(db);
  const { workOrder } = await createWorkOrder(db, { modelId: 'm_x1', manualId: rev1.id });
  const man = await getManual(db, rev1.id);
  const sLock = man.steps.find((s) => s.key_code === 'S-LOCK');

  // 云端先勾上
  const e1 = await appendStepEvent(db, workOrder.id, {
    stepKey: 'S-LOCK', action: 'check', contentHash: sLock.content_hash,
    clientEventId: ceid('cloud'), baseEventId: null,
  });
  // 离线端基于“空”版本又提交一次勾选/取消：应冲突
  await assert.rejects(
    () => appendStepEvent(db, workOrder.id, {
      stepKey: 'S-LOCK', action: 'uncheck', contentHash: sLock.content_hash,
      clientEventId: ceid('offline'), baseEventId: null,
    }),
    /冲突/,
  );
  // 冲突已登记
  const conflicts = await db.find('sync_conflicts', { work_order_id: workOrder.id, resolved: false });
  assert.equal(conflicts.length, 1);
  // 云端值未被覆盖：最终仍是 check
  const detail = await getWorkOrderDetail(db, workOrder.id);
  assert.deepEqual(detail.checkedKeys, ['S-LOCK']);

  // 离线端基于最新版本重试则成功
  const retry = await appendStepEvent(db, workOrder.id, {
    stepKey: 'S-LOCK', action: 'uncheck', contentHash: sLock.content_hash,
    clientEventId: ceid('offline2'), baseEventId: e1.event.id,
  });
  assert.equal(retry.event.action, 'uncheck');
});

test('幂等：同一 client_event_id 重传不重复记账', async () => {
  const db = await freshDb();
  const { rev1 } = await x1Manuals(db);
  const { workOrder } = await createWorkOrder(db, { modelId: 'm_x1', manualId: rev1.id });
  const man = await getManual(db, rev1.id);
  const sLock = man.steps.find((s) => s.key_code === 'S-LOCK');
  const id = ceid('same');
  const a = await appendStepEvent(db, workOrder.id, {
    stepKey: 'S-LOCK', action: 'check', contentHash: sLock.content_hash,
    clientEventId: id, baseEventId: null,
  });
  const b = await appendStepEvent(db, workOrder.id, {
    stepKey: 'S-LOCK', action: 'check', contentHash: sLock.content_hash,
    clientEventId: id, baseEventId: null,
  });
  assert.equal(b.deduped, true);
  const n = (await db.find('step_events', { work_order_id: workOrder.id })).length;
  assert.equal(n, 1);
});

test('照片晚传：先完工后补传证据，标记 late 且不丢失；打印单可追溯实际版本', async () => {
  const db = await freshDb();
  const { rev1 } = await x1Manuals(db);
  const { workOrder } = await createWorkOrder(db, { modelId: 'm_x1', manualId: rev1.id });
  const man = await getManual(db, rev1.id);
  for (const s of man.steps) {
    await appendStepEvent(db, workOrder.id, {
      stepKey: s.key_code, action: 'check', contentHash: s.content_hash,
      clientEventId: ceid('evt'), baseEventId: null,
    });
  }
  await completeWorkOrder(db, workOrder.id, { note: '完工，照片待回办公室补传' });

  const late = await addEvidence(db, workOrder.id, {
    stepKey: 'S-TEMP', filename: 'sensor.jpg', mime: 'image/jpeg',
    sizeBytes: 1024, sha256: 'abc', clientEvidenceId: ceid('pic'),
    capturedAt: new Date().toISOString(),
  });
  assert.equal(late.late, true);

  const detail = await getWorkOrderDetail(db, workOrder.id);
  const print = (await import('./print-helper.js')).build(detail, null);
  assert.match(print.text, /FAN-X1 REV 1/);
  assert.match(print.text, /快照指纹/);
  assert.match(print.text, /sensor.jpg 采集于.*晚传/);
  assert.equal(print.versionTrace.revision, 1);
});

test('同步批次：冲突项登记、其余事件与证据照常落库，未同步载荷保留', async () => {
  const db = await freshDb();
  const { rev1 } = await x1Manuals(db);
  const { workOrder } = await createWorkOrder(db, { modelId: 'm_x1', manualId: rev1.id });
  const man = await getManual(db, rev1.id);
  const byKey = Object.fromEntries(man.steps.map((s) => [s.key_code, s]));

  // 云端已勾 S-LOCK
  const cloud = await appendStepEvent(db, workOrder.id, {
    stepKey: 'S-LOCK', action: 'check', contentHash: byKey['S-LOCK'].content_hash,
    clientEventId: ceid('cloud'), baseEventId: null,
  });

  const result = await syncBundle(db, workOrder.id, {
    events: [
      // 冲突：离线也以为 S-LOCK 是自己勾的
      { stepKey: 'S-LOCK', action: 'check', contentHash: byKey['S-LOCK'].content_hash,
        clientEventId: ceid('offline-lock'), baseEventId: null },
      // 正常：S-TEMP 基于云端最新 S-LOCK 事件
      { stepKey: 'S-TEMP', action: 'check', contentHash: byKey['S-TEMP'].content_hash,
        clientEventId: ceid('offline-temp'), baseEventId: null },
    ],
    evidence: [
      { stepKey: 'S-TEMP', filename: 'proof.png', clientEvidenceId: ceid('pic'), sizeBytes: 9 },
    ],
  });
  assert.equal(result.conflicts.length, 1);
  assert.ok(result.unsynced.some((u) => u.item.stepKey === 'S-LOCK'));
  assert.ok(result.accepted.includes(result.accepted.find((x) => String(x).includes('temp'))));
  const evidences = await db.find('evidence', { work_order_id: workOrder.id });
  assert.equal(evidences.length, 1);
});

test('撤回包：提示受影响工单，已做事件与未同步证据保留，工单仍可按旧快照打印', async () => {
  const db = await freshDb();
  const { rev2 } = await x1Manuals(db);
  const { workOrder } = await createWorkOrder(db, { modelId: 'm_x1', manualId: rev2.id });
  const man = await getManual(db, rev2.id);
  const sLock = man.steps.find((s) => s.key_code === 'S-LOCK');
  await appendStepEvent(db, workOrder.id, {
    stepKey: 'S-LOCK', action: 'check', contentHash: sLock.content_hash,
    clientEventId: ceid('evt'), baseEventId: null,
  });
  await addEvidence(db, workOrder.id, {
    stepKey: 'S-LOCK', filename: 'lock.jpg', clientEvidenceId: ceid('pic'), sizeBytes: 1,
  });

  const built = await buildPackage(db, { kind: 'full_model', manualId: rev2.id });
  const w = await withdrawPackage(db, built.record.id, '发现温控描述需修订');
  assert.equal(w.package.status, 'withdrawn');
  assert.equal(w.affectedWorkOrders.length, 1);
  assert.equal(w.affectedWorkOrders[0].unsyncedEvidenceRetained, true);

  // 证据/事件仍在
  const evidences = await db.find('evidence', { work_order_id: workOrder.id });
  assert.equal(evidences.length, 1);
  const detail = await getWorkOrderDetail(db, workOrder.id);
  const print = (await import('./print-helper.js')).build(detail, null);
  assert.match(print.text, /FAN-X1 REV 2/);
});

test('冲突裁决 keep_local：服务器以云端最新为基线重放离线动作，冲突消解且状态落事件流', async () => {
  const db = await freshDb();
  const { rev1 } = await x1Manuals(db);
  const { workOrder } = await createWorkOrder(db, { modelId: 'm_x1', manualId: rev1.id });
  const man = await getManual(db, rev1.id);
  const sLock = man.steps.find((s) => s.key_code === 'S-LOCK');

  await appendStepEvent(db, workOrder.id, {
    stepKey: 'S-LOCK', action: 'check', contentHash: sLock.content_hash,
    clientEventId: ceid('cloud'), baseEventId: null,
  });
  await assert.rejects(
    () => appendStepEvent(db, workOrder.id, {
      stepKey: 'S-LOCK', action: 'uncheck', contentHash: sLock.content_hash,
      clientEventId: 'offline-x', baseEventId: null,
    }),
    /冲突/,
  );
  const cfl = (await db.find('sync_conflicts', { work_order_id: workOrder.id, resolved: false }))[0];
  const r = await resolveConflict(db, cfl.id, { resolution: 'keep_local', note: '现场确认为准' });
  assert.ok(r.appliedEventId, 'keep_local 必须产生重放事件');
  const after = await getWorkOrderDetail(db, workOrder.id);
  assert.deepEqual(after.checkedKeys, [], '离线动作 uncheck 被重放后，该步骤不再勾选');
  assert.equal(after.conflicts.length, 0);

  // 重复裁决拒绝
  await assert.rejects(() => resolveConflict(db, cfl.id, { resolution: 'keep_remote' }), /已裁决/);
});

test('冲突裁决 keep_remote：仅消解冲突，云端勾选保留', async () => {
  const db = await freshDb();
  const { rev1 } = await x1Manuals(db);
  const { workOrder } = await createWorkOrder(db, { modelId: 'm_x1', manualId: rev1.id });
  const man = await getManual(db, rev1.id);
  const sLock = man.steps.find((s) => s.key_code === 'S-LOCK');
  await appendStepEvent(db, workOrder.id, {
    stepKey: 'S-LOCK', action: 'check', contentHash: sLock.content_hash,
    clientEventId: ceid('cloud'), baseEventId: null,
  });
  await assert.rejects(() => appendStepEvent(db, workOrder.id, {
    stepKey: 'S-LOCK', action: 'uncheck', contentHash: sLock.content_hash,
    clientEventId: 'offline-y', baseEventId: null,
  }), /冲突/);
  const cfl = (await db.find('sync_conflicts', { work_order_id: workOrder.id }))[0];
  await resolveConflict(db, cfl.id, { resolution: 'keep_remote' });
  const after = await getWorkOrderDetail(db, workOrder.id);
  assert.deepEqual(after.checkedKeys, ['S-LOCK']);
  assert.equal(after.conflicts.length, 0);
});
