// 离线打包：整机型包 vs 按任务依赖打包；比较；撤回提示与未同步证据保留
import { newId, HttpError, sha256 } from '../util.js';
import { getManual, snapshotFingerprint } from './manuals.js';

/** 在任务 DAG 上求根任务的依赖闭包（任务依赖是显式边，这里是打包，不涉及备件兼容推断） */
export function taskClosure(tasks, rootKeys) {
  const byKey = new Map(tasks.map((t) => [t.step_key, t]));
  const included = new Set();
  const missing = [];
  const visit = (key, stack = []) => {
    if (included.has(key)) return;
    if (stack.includes(key)) {
      throw new HttpError(409, `任务依赖存在环：${[...stack, key].join(' -> ')}`, { code: 'TASK_CYCLE' });
    }
    const t = byKey.get(key);
    if (!t) { missing.push(key); return; }
    for (const d of t.depends_on ?? []) visit(d, [...stack, key]);
    included.add(key);
  };
  for (const k of rootKeys) visit(k);
  if (missing.length) {
    throw new HttpError(400, `根任务或依赖不存在：${[...new Set(missing)].join('、')}`);
  }
  return [...included];
}

function buildManifest({ kind, manual, model, rootKeys, stepKeys }) {
  const steps = manual.steps.filter((s) => stepKeys.includes(s.key_code));
  const body = {
    kind,
    model: { id: model.id, name: model.name },
    manual: { code: manual.code, revision: manual.revision, title: manual.title },
    rootTaskKeys: rootKeys,
    steps: steps.map((s) => ({
      key_code: s.key_code, step_no: s.step_no, title: s.title,
      content: s.content, safety_critical: s.safety_critical,
      depends_on_keys: s.depends_on_keys, content_hash: s.content_hash,
    })),
    built_at: new Date().toISOString(),
  };
  return { body, manifest_hash: sha256(JSON.stringify(body)) };
}

export async function buildPackage(db, input) {
  const kind = input.kind === 'task_deps' ? 'task_deps' : 'full_model';
  const manual = await getManual(db, input.manualId);
  if (manual.status !== 'approved') {
    throw new HttpError(409, '只能打包审核通过的手册版本', { code: 'MANUAL_NOT_APPROVED' });
  }
  const model = await db.findOne('models', { id: manual.model_id });
  const tasks = await db.find('tasks', { manual_id: manual.id });

  let rootKeys = [];
  let stepKeys;
  if (kind === 'full_model') {
    stepKeys = manual.steps.map((s) => s.key_code);
  } else {
    rootKeys = input.rootTaskKeys ?? [];
    if (!rootKeys.length) throw new HttpError(400, '任务依赖包必须提供 rootTaskKeys');
    stepKeys = taskClosure(tasks, rootKeys);
  }
  const { body, manifest_hash } = buildManifest({ kind, manual, model, rootKeys, stepKeys });

  const pkg = await db.insert('packages', {
    id: newId('pkg'),
    kind,
    model_id: model.id,
    manual_id: manual.id,
    manual_revision: manual.revision,
    root_task_keys: rootKeys,
    included_keys: stepKeys,
    manifest_hash,
    status: 'active',
    withdrawn_reason: null,
    withdrawn_at: null,
  });
  return { record: pkg, manifest: body, manifest_hash };
}

/** 比较两种打包方式：同手册版本下任务包是整包的严格子集 */
export async function comparePackaging(db, { manualId, rootTaskKeys }) {
  const full = await buildPackage(db, { kind: 'full_model', manualId });
  const task = await buildPackage(db, { kind: 'task_deps', manualId, rootTaskKeys });
  const fullSet = new Set(full.record.included_keys);
  const omitted = [...fullSet].filter((k) => !task.record.included_keys.includes(k));
  return {
    full_model: { packageId: full.record.id, manifestHash: full.record.manifest_hash, size: full.record.included_keys.length },
    task_deps: { packageId: task.record.id, manifestHash: task.record.manifest_hash, size: task.record.included_keys.length },
    omitted_by_task_package: omitted,
    subset: task.record.included_keys.every((k) => fullSet.has(k)),
    same_manual_revision: full.record.manual_revision === task.record.manual_revision,
  };
}

/**
 * 撤回包：已下发且有离线未同步证据的工单受影响 -> 必须返回撤回提示与证据保留清单。
 * 撤回不删除包，也不删除证据；旧工单仍按快照版可打印追溯。
 */
export async function withdrawPackage(db, packageId, reason) {
  const pkg = await db.findOne('packages', { id: packageId });
  if (!pkg) throw new HttpError(404, '包不存在');
  if (pkg.status === 'withdrawn') throw new HttpError(409, '包已撤回');

  const affected = [];
  const wos = await db.find('work_orders', { manual_id: pkg.manual_id });
  for (const wo of wos) {
    const ev = await db.find('evidence', { work_order_id: wo.id });
    const events = await db.find('step_events', { work_order_id: wo.id });
    if (ev.length || events.length) {
      affected.push({
        workOrderId: wo.id, code: wo.code, status: wo.status,
        pinnedManual: `${wo.manual_code} rev${wo.manual_revision}`,
        evidenceCount: ev.length,
        unsyncedEvidenceRetained: true,
        note: '工单绑定快照版，撤回不改变其已做工作；未同步证据继续保留待传。',
      });
    }
  }

  const updated = await db.update('packages', packageId, {
    status: 'withdrawn',
    withdrawn_reason: reason || '未提供原因',
    withdrawn_at: new Date().toISOString(),
  });
  return {
    package: updated,
    warnings: [
      '撤回仅阻止新工单下载该包；已下载副本不被远程删除。',
      '受影响工单仍可按其绑定的手册快照继续离线作业与补传证据。',
      '新建工单必须选择未撤回的新版本包。',
    ],
    affectedWorkOrders: affected,
  };
}
