// 工单：离线勾选绑定工单 + 手册快照；事件流；证据晚传；同步冲突不静默覆盖
import { newId, HttpError, sha256 } from '../util.js';
import { getManual, snapshotFingerprint } from './manuals.js';

/** 折叠事件流，得到每个步骤的最终勾选状态（保留 base_event_id 用于乐观并发） */
export function foldEvents(events) {
  const done = {};
  const lastEventByKey = {};
  const sorted = [...events].sort((a, b) =>
    String(a.created_at).localeCompare(String(b.created_at)),
  );
  for (const e of sorted) {
    done[e.step_key] = {
      action: e.action,
      content_hash: e.content_hash,
      note: e.note,
      event_id: e.id,
    };
    lastEventByKey[e.step_key] = e.id;
  }
  return { done, lastEventByKey };
}

export async function createWorkOrder(db, input) {
  const { modelId, serialNo = '', programId = null, technician = '', manualId } = input;
  const model = await db.findOne('models', { id: modelId });
  if (!model) throw new HttpError(404, '机型不存在');

  const manual = await getManual(db, manualId);
  if (manual.model_id !== modelId) {
    throw new HttpError(409, `手册 ${manual.code} 不属于机型 ${model.name}，禁止错机型建单`, {
      code: 'MODEL_MANUAL_MISMATCH',
    });
  }
  if (manual.status !== 'approved') {
    throw new HttpError(409, `手册 ${manual.code} rev${manual.revision} 状态为 ${manual.status}，只有审核通过版可下发现场`, {
      code: 'MANUAL_NOT_APPROVED',
    });
  }
  if (programId) {
    const program = await db.findOne('service_programs', { id: programId });
    if (!program) throw new HttpError(404, '服务程序不存在');
    const { appliesTo } = await import('./programs.js').then((m) => m.checkApplicability(db, program, { modelId, serialNo }));
    if (!appliesTo) throw new HttpError(409, '该服务程序不适用于此机型/序列号', { code: 'OUT_OF_SCOPE' });
  }

  const n = (await db.count('work_orders')) + 1;
  const wo = await db.insert('work_orders', {
    id: newId('wo'),
    code: `WO-${new Date().getFullYear()}-${String(n).padStart(4, '0')}`,
    model_id: modelId,
    serial_no: serialNo,
    program_id: programId,
    manual_id: manual.id,
    manual_code: manual.code,
    manual_revision: manual.revision,
    snapshot_hash: manual.snapshot_hash,
    status: 'open',
    technician,
    created_at: new Date().toISOString(),
    completed_at: null,
  });
  return { workOrder: wo, snapshot: { steps: manual.steps, snapshot_hash: manual.snapshot_hash } };
}

async function loadWO(db, id) {
  const wo = await db.findOne('work_orders', { id });
  if (!wo) throw new HttpError(404, '工单不存在');
  return wo;
}

export async function getWorkOrderDetail(db, id) {
  const wo = await loadWO(db, id);
  const events = await db.find('step_events', { work_order_id: id });
  const evidence = await db.find('evidence', { work_order_id: id });
  const manual = await getManual(db, wo.manual_id);
  const conflicts = await db.find('sync_conflicts', { work_order_id: id });
  const { done } = foldEvents(events);
  return {
    workOrder: wo,
    pinnedManual: {
      manualId: manual.id, code: manual.code, revision: manual.revision,
      title: manual.title, status: manual.status, snapshot_hash: wo.snapshot_hash,
    },
    steps: manual.steps,
    events,
    checkedKeys: Object.entries(done)
      .filter(([, v]) => v.action === 'check')
      .map(([k]) => k),
    evidence,
    conflicts: conflicts.filter((c) => !c.resolved),
  };
}

/**
 * 追加步骤勾选事件。
 * - client_event_id 幂等：离线重传不重复记账
 * - base_event_id 乐观并发：与云端最后事件不一致时登记冲突并返回 409，不静默覆盖
 * - content_hash 必须等于快照中该步骤的指纹，防止按旧正文勾选
 */
export async function appendStepEvent(db, woId, ev) {
  const wo = await loadWO(db, woId);
  const dup = await db.findOne('step_events', { client_event_id: ev.clientEventId });
  if (dup) return { deduped: true, event: dup };

  const manual = await getManual(db, wo.manual_id);
  const step = manual.steps.find((s) => s.key_code === ev.stepKey);
  if (!step) throw new HttpError(404, `步骤 ${ev.stepKey} 不在工单快照中`);

  if (ev.action === 'check' && ev.contentHash && ev.contentHash !== step.content_hash) {
    throw new HttpError(409, '步骤内容与快照版本不一致（手册已改版），请走改版继承流程，不能按旧内容勾选', {
      code: 'STEP_HASH_MISMATCH', expected: step.content_hash, got: ev.contentHash,
    });
  }

  const events = await db.find('step_events', { work_order_id: woId });
  const { lastEventByKey } = foldEvents(events);
  const baseExpected = ev.baseEventId ?? null;
  const baseActual = lastEventByKey[ev.stepKey] ?? null;
  if (baseExpected !== baseActual) {
    const conflict = await db.insert('sync_conflicts', {
      id: newId('cfl'),
      work_order_id: woId,
      step_key: ev.stepKey,
      remote_action: null,
      remote_event_id: baseActual,
      local_action: ev.action,
      local_event_id: ev.clientEventId,
      detail: `离线端基于 ${baseExpected ?? '空'} 提交，云端最新为 ${baseActual ?? '空'}`,
      resolved: false,
      created_at: new Date().toISOString(),
    });
    throw new HttpError(409, '云端与离线记录冲突：该步骤在另一端已有更新，已登记冲突，需人工裁决', {
      code: 'SYNC_CONFLICT', conflictId: conflict.id, serverLastEventId: baseActual,
    });
  }

  const row = await db.insert('step_events', {
    id: newId('evt'),
    work_order_id: woId,
    step_key: ev.stepKey,
    step_no: step.step_no,
    content_hash: step.content_hash,
    action: ev.action === 'uncheck' ? 'uncheck' : 'check',
    base_event_id: baseActual,
    client_event_id: ev.clientEventId,
    technician: ev.technician ?? '',
    note: ev.note ?? '',
    created_at: ev.createdAt ?? new Date().toISOString(),
    synced_at: new Date().toISOString(),
  });
  return { deduped: false, event: row };
}

/** 证据登记：允许晚传（工单 completed 之后补传），只标记 late，绝不丢弃 */
export async function addEvidence(db, woId, ev) {
  const wo = await loadWO(db, woId);
  const dup = await db.findOne('evidence', { client_evidence_id: ev.clientEvidenceId });
  if (dup) return { deduped: true, evidence: dup };

  const late = wo.status === 'completed' || wo.status === 'synced';
  const row = await db.insert('evidence', {
    id: newId('evd'),
    work_order_id: woId,
    step_key: ev.stepKey ?? '',
    filename: ev.filename,
    mime: ev.mime ?? 'application/octet-stream',
    size_bytes: ev.sizeBytes ?? 0,
    sha256: ev.sha256 ?? '',
    client_evidence_id: ev.clientEvidenceId,
    captured_at: ev.capturedAt ?? new Date().toISOString(),
    uploaded_at: new Date().toISOString(),
    late,
  });
  return { deduped: false, evidence: row, late };
}

export async function completeWorkOrder(db, woId, { note = '' } = {}) {
  const wo = await loadWO(db, woId);
  const events = await db.find('step_events', { work_order_id: woId });
  const { done } = foldEvents(events);
  const manual = await getManual(db, wo.manual_id);
  const unchecked = manual.steps.filter((s) => done[s.key_code]?.action !== 'check');
  if (unchecked.length) {
    throw new HttpError(409, '仍有步骤未勾选完成，不能完工；如手册已更新请先做逐项继承判定', {
      code: 'STEPS_UNCHECKED',
      uncheckedKeys: unchecked.map((s) => s.key_code),
    });
  }
  const next = await db.update('work_orders', woId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    completion_note: note,
  });
  return next;
}

/**
 * 批量离线同步：逐项处理，事件冲突登记后继续处理其余项（不因一项冲突丢失其他证据）。
 * 返回 accepted / deduped / conflicts，未同步的原始载荷在响应中原样保留，供客户端重试。
 */
export async function syncBundle(db, woId, payload) {
  const accepted = [];
  const deduped = [];
  const conflicts = [];
  const unsynced = [];
  for (const ev of payload.events ?? []) {
    try {
      const r = await appendStepEvent(db, woId, ev);
      (r.deduped ? deduped : accepted).push(r.event.client_event_id);
    } catch (e) {
      if (e.status === 409 && e.extra?.code === 'SYNC_CONFLICT') {
        conflicts.push({ clientEventId: ev.clientEventId, stepKey: ev.stepKey, conflictId: e.extra.conflictId });
        unsynced.push({ type: 'event', item: ev, reason: e.message });
      } else {
        unsynced.push({ type: 'event', item: ev, reason: e.message });
      }
    }
  }
  for (const ev of payload.evidence ?? []) {
    try {
      const r = await addEvidence(db, woId, ev);
      (r.deduped ? deduped : accepted).push(r.evidence.client_evidence_id);
    } catch (e) {
      unsynced.push({ type: 'evidence', item: ev, reason: e.message });
    }
  }
  return { accepted, deduped, conflicts, unsynced };
}

/**
 * 人工裁决冲突：
 *  - keep_remote：保留云端值，只把冲突标记为已解决（离线载荷由客户端自行丢弃/重报）。
 *  - keep_local：采用离线动作——不是直接覆盖状态，而是以云端最新事件为 base 重放该动作，
 *    重放仍走 content_hash / 步骤存在性校验并落事件流，保证可审计；载荷缺失等失败返回 409。
 */
export async function resolveConflict(db, conflictId, input = {}) {
  const { resolution, note = '' } = input;
  const c = await db.findOne('sync_conflicts', { id: conflictId });
  if (!c) throw new HttpError(404, '冲突不存在');
  if (c.resolved) throw new HttpError(409, '该冲突已裁决');
  if (!['keep_remote', 'keep_local'].includes(resolution)) {
    throw new HttpError(400, '裁决必须是 keep_remote 或 keep_local');
  }

  let appliedEventId = null;
  if (resolution === 'keep_local') {
    if (!c.local_action || !c.local_event_id) {
      throw new HttpError(409, '冲突登记缺少离线载荷，无法采用离线端，请在现场端以最新版本重试提交', {
        code: 'LOCAL_PAYLOAD_UNAVAILABLE',
      });
    }
    const wo = await loadWO(db, c.work_order_id);
    const manual = await getManual(db, wo.manual_id);
    const step = manual.steps.find((s) => s.key_code === c.step_key);
    if (!step) {
      throw new HttpError(409, '离线动作对应的步骤已不在当前快照中，不能采用离线端，请走改版继承流程', {
        code: 'STEP_GONE',
      });
    }
    const events = await db.find('step_events', { work_order_id: wo.id });
    const { lastEventByKey } = foldEvents(events);
    const replay = await db.insert('step_events', {
      id: newId('evt'),
      work_order_id: wo.id,
      step_key: c.step_key,
      step_no: step.step_no,
      content_hash: step.content_hash,
      action: c.local_action === 'uncheck' ? 'uncheck' : 'check',
      base_event_id: lastEventByKey[c.step_key] ?? null,
      client_event_id: `resolve-${c.id}-${c.local_event_id}`,
      technician: 'conflict-resolve',
      note: `人工裁决采用离线端动作（冲突 ${c.id}）：${note || '无备注'}`,
      created_at: new Date().toISOString(),
      synced_at: new Date().toISOString(),
    });
    appliedEventId = replay.id;
  }

  const updated = await db.update('sync_conflicts', conflictId, {
    resolved: true,
    resolution,
    resolve_note: note,
    resolved_at: new Date().toISOString(),
  });
  const remaining = (await db.find('sync_conflicts', { work_order_id: c.work_order_id }))
    .some((x) => !x.resolved);
  await db.update('work_orders', c.work_order_id, {
    status: remaining ? 'conflict' : 'synced',
  });
  return { ...updated, appliedEventId };
}
