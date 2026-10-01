// API 路由：所有维修结论只来自审核通过的手册/条目；系统不生成手册外操作建议。
import { HttpError, newId } from '../util.js';
import { searchFaults } from '../domain/faults.js';
import { directSubstitutes, addSubstitution, transitiveChains } from '../domain/parts.js';
import {
  createManualRevision, getManual, judgeRebase, validateRebaseDecisions,
} from '../domain/manuals.js';
import { listProgramsForModel, createProgram } from '../domain/programs.js';
import {
  createWorkOrder, getWorkOrderDetail, appendStepEvent, addEvidence,
  completeWorkOrder, syncBundle, resolveConflict, foldEvents,
} from '../domain/workorders.js';
import { buildPackage, comparePackaging, withdrawPackage } from '../domain/packages.js';

const ok = (res, body, status = 200) => send(res, status, body);

const errBody = (e) => ({
  error: e.message || '内部错误',
  code: e.extra?.code ?? e.code ?? 'INTERNAL',
  ...(e.extra ?? {}),
});

export async function handleApi(req, res, url, db) {
  try {
    await route(req, res, url, db);
  } catch (e) {
    if (e instanceof HttpError) {
      send(res, e.status, errBody(e));
    } else if (e.code === 'MODEL_NOT_FOUND') {
      send(res, 404, { error: '机型不存在', code: 'MODEL_NOT_FOUND' });
    } else {
      console.error(e);
      send(res, 500, { error: '内部错误', code: 'INTERNAL' });
    }
  }
}

async function route(req, res, url, db) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1); // 去掉 'api'
  const m = req.method;

  if (seg.length === 1 && seg[0] === 'models' && m === 'GET') {
    return ok(res, { models: await db.find('models') });
  }

  if (seg.length === 1 && seg[0] === 'faults' && m === 'GET') {
    const modelId = url.searchParams.get('modelId');
    const q = url.searchParams.get('q') ?? '';
    return ok(res, await searchFaults({ db }, { modelId, q }));
  }

  if (seg.length === 1 && seg[0] === 'programs' && m === 'POST') {
    const b = await readBody(req);
    return ok(res, { program: await createProgram(db, b) }, 201);
  }
  if (seg.length === 2 && seg[0] === 'programs' && seg[1] === 'for-model' && m === 'GET') {
    const modelId = url.searchParams.get('modelId');
    if (!modelId) throw new HttpError(400, 'modelId 必填');
    return ok(res, {
      programs: await listProgramsForModel(db, {
        modelId, serialNo: url.searchParams.get('serialNo') ?? '',
      }),
    });
  }

  if (seg[0] === 'manuals') return await manuals(req, res, db, seg.slice(1), url, m);
  if (seg[0] === 'parts') return await parts(req, res, db, seg.slice(1), url, m);
  if (seg[0] === 'work-orders') return await workOrders(req, res, db, seg.slice(1), url, m);
  if (seg[0] === 'packages') return await packages(req, res, db, seg.slice(1), url, m);

  throw new HttpError(404, `未知接口 ${url.pathname}`);
}

async function manuals(req, res, db, seg, url, m) {
  // GET /api/manuals?modelId=..  仅返回审核通过版（现场可见）
  if (!seg.length && m === 'GET') {
    const modelId = url.searchParams.get('modelId');
    let rows = await db.find('manuals');
    if (modelId) rows = rows.filter((x) => x.model_id === modelId);
    rows = rows.filter((x) => x.status === 'approved');
    return ok(res, { manuals: rows.map(publicManual) });
  }
  // POST /api/manuals 发布修订（审核/管理动作）
  if (!seg.length && m === 'POST') {
    const b = await readBody(req);
    const manual = await createManualRevision(db, {
      modelId: b.modelId, code: b.code, title: b.title,
      steps: b.steps, status: b.status === 'approved' ? 'approved' : 'draft',
    });
    return ok(res, { manual: { id: manual.id, revision: manual.revision, status: manual.status } }, 201);
  }
  // GET /api/manuals/:id  非草稿才可读；草稿需走 reviewer 入口
  if (seg.length === 1 && m === 'GET') {
    const detail = await getManual(db, seg[0]);
    if (detail.status === 'draft') {
      throw new HttpError(403, '该手册版本为草稿，尚未审核通过，现场端不呈现其内容', { code: 'DRAFT_HIDDEN' });
    }
    return ok(res, { manual: publicDetail(detail) });
  }
  // PATCH /api/manuals/:id/status 审核通过 / 撤回
  if (seg.length === 2 && seg[1] === 'status' && m === 'PATCH') {
    const b = await readBody(req);
    const cur = await db.findOne('manuals', { id: seg[0] });
    if (!cur) throw new HttpError(404, '手册不存在');
    const patch = {};
    if (b.status === 'approved') {
      patch.status = 'approved'; patch.approved_at = new Date().toISOString();
    } else if (b.status === 'withdrawn') {
      patch.status = 'withdrawn'; patch.withdrawn_at = new Date().toISOString();
      patch.withdrawn_reason = b.reason ?? '未提供原因';
    } else throw new HttpError(400, 'status 只能为 approved 或 withdrawn');
    const updated = await db.update('manuals', cur.id, patch);
    return ok(res, { manual: publicManual(updated) });
  }
  // POST /api/manuals/:id/rebase-preview  改版后逐项继承判定（不改变工单）
  if (seg.length === 2 && seg[1] === 'rebase-preview' && m === 'POST') {
    const b = await readBody(req);
    const target = await getManual(db, seg[0]);
    if (target.status !== 'approved') throw new HttpError(409, '只能向审核通过版做继承判定');
    const wo = await db.findOne('work_orders', { id: b.workOrderId });
    if (!wo) throw new HttpError(404, '工单不存在');
    const old = await getManual(db, wo.manual_id);
    const events = await db.find('step_events', { work_order_id: wo.id });
    const { done } = foldEvents(events);
    const items = judgeRebase({ oldSteps: old.steps, newSteps: target.steps, done });
    return ok(res, {
      from: { manualCode: old.code, revision: old.revision, snapshotHash: wo.snapshot_hash },
      to: { manualCode: target.code, revision: target.revision },
      items,
      notice: '请逐项决定；系统不会静默重置，也不会把未判定的项算成完成。',
    });
  }
  throw new HttpError(404, '未知 manuals 接口');
}

async function parts(req, res, db, seg, url, m) {
  // GET /api/parts 列表
  if (!seg.length && m === 'GET') {
    return ok(res, { parts: await db.find('parts') });
  }
  // POST /api/parts/substitutions 新增有向替代边（含环检测）
  if (seg.length === 1 && seg[0] === 'substitutions' && m === 'POST') {
    const b = await readBody(req);
    const result = await addSubstitution(db, b);
    if (!result.ok) {
      return send(res, 409, {
        error: result.message, code: result.code,
        ...(result.path ? { cyclePath: result.path } : {}),
      });
    }
    return ok(res, { substitution: result.edge }, 201);
  }
  // GET /api/parts/:partNo/substitutes?modelId=&serialNo=&onDate= 只返回生效的直接边
  if (seg.length === 2 && seg[1] === 'substitutes' && m === 'GET') {
    const part = await db.findOne('parts', { part_no: seg[0] });
    if (!part) throw new HttpError(404, '件号不存在');
    const modelId = url.searchParams.get('modelId');
    const serialNo = url.searchParams.get('serialNo') ?? '';
    const list = await directSubstitutes(db, part.id, {
      modelId,
      serialNo,
      onDate: url.searchParams.get('onDate') ?? undefined,
    });
    const usable = list.filter((s) => s.usable);
    const restricted = list.filter((s) => !s.usable);
    const notes = ['仅列直接、当前生效的替代关系；系统不做跨边传递推断。'];
    if (restricted.some((s) => s.serialStatus === 'serial_required')) {
      notes.push('有替代边带序列号生效范围：未提供序列号时不判定为可直接使用（不做乐观假设），请补录现场序列号核验。');
    }
    if (restricted.some((s) => s.serialStatus === 'out_of_range')) {
      notes.push('有替代边的序列号区间不覆盖当前序列号，禁止用于本机。');
    }
    return ok(res, {
      partNo: part.part_no,
      substitutes: usable,
      restricted,
      note: notes.join(' '),
    });
  }
  // 管理诊断：显式多跳链（默认标注为“未经验证，不可作为兼容结论”）
  if (seg.length === 2 && seg[1] === 'chains' && m === 'GET') {
    const part = await db.findOne('parts', { part_no: seg[0] });
    if (!part) throw new HttpError(404, '件号不存在');
    const chains = await transitiveChains(db, part.id, 3);
    const parts = new Map((await db.find('parts')).map((p) => [p.id, p.part_no]));
    return ok(res, {
      partNo: part.part_no,
      chains: chains.map((c) => ({
        path: c.chain.map((id) => parts.get(id) ?? id),
        cycle: c.cycle,
        verifiedCompatible: false,
        warning: '多跳链不构成兼容结论；如需替代必须补录显式边并定义生效范围。',
      })),
    });
  }
  throw new HttpError(404, '未知 parts 接口');
}

async function workOrders(req, res, db, seg, url, m) {
  // POST /api/work-orders  建单时固定审核通过版手册快照（错机型拒绝）
  if (!seg.length && m === 'POST') {
    const b = await readBody(req);
    const result = await createWorkOrder(db, b);
    return send(res, 201, {
      ...shapeWO(result.workOrder),
      snapshot: result.snapshot.steps.map((s) => ({
        key_code: s.key_code, step_no: s.step_no, title: s.title,
        content: s.content, safety_critical: s.safety_critical,
        depends_on_keys: s.depends_on_keys, content_hash: s.content_hash,
      })),
      snapshot_hash: result.snapshot.snapshot_hash,
    });
  }
  // GET /api/work-orders 列表
  if (!seg.length && m === 'GET') {
    const rows = await db.find('work_orders');
    return ok(res, { workOrders: rows.map(shapeWO) });
  }
  // GET /api/work-orders/:id 详情
  if (seg.length === 1 && m ==='GET') {
    const d = await getWorkOrderDetail(db, seg[0]);
    return ok(res, {
      ...shapeWO(d.workOrder),
      pinnedManual: d.pinnedManual,
      steps: d.steps,
      checkedKeys: d.checkedKeys,
      events: d.events,
      evidence: d.evidence,
      conflicts: d.conflicts,
    });
  }
  // POST /api/work-orders/:id/events  勾选/取消（含 content_hash 与并发校验）
  if (seg.length === 2 && seg[1] === 'events' && m === 'POST') {
    const b = await readBody(req);
    if (!b.clientEventId || !b.stepKey || !b.action) {
      throw new HttpError(400, 'clientEventId/stepKey/action 必填');
    }
    const r = await appendStepEvent(db, seg[0], {
      stepKey: b.stepKey, action: b.action, contentHash: b.contentHash,
      clientEventId: b.clientEventId,
      baseEventId: b.baseEventId ?? null, technician: b.typist ?? b.technician ?? '',
      note: b.note ?? '', createdAt: b.createdAt,
    });
    return ok(res, r, r.deduped ? 200 : 201);
  }
  // POST /api/work-orders/:id/complete
  if (seg.length === 2 && seg[1] === 'complete' && m === 'POST') {
    const b = await readBody(req);
    return ok(res, shapeWO(await completeWorkOrder(db, seg[0], { note: b.note })));
  }
  // POST /api/work-orders/:id/evidence  照片等证据；完工后也可晚传
  if (seg.length === 2 && seg[1] === 'evidence' && m === 'POST') {
    const b = await readBody(req);
    if (!b.clientEvidenceId || !b.filename) throw new HttpError(400, 'clientEvidenceId/filename 必填');
    const r = await addEvidence(db, seg[0], {
      stepKey: b.stepKey, filename: b.filename, mime: b.mime,
      sizeBytes: b.sizeBytes, sha256: b.sha256,
      clientEvidenceId: b.clientEvidenceId, capturedAt: b.capturedAt,
    });
    return send(res, r.deduped ? 200 : 201, r);
  }
  // POST /api/work-orders/:id/sync  离线批量同步（事件+证据），冲突登记并保留未同步载荷
  if (seg.length === 2 && seg[1] === 'sync' && m === 'POST') {
    const b = await readBody(req);
    const result = await syncBundle(db, seg[0], b);
    const status = result.conflicts.length ? 409 : 200;
    return send(res, status, {
      ...result,
      notice: result.unsynced.length
        ? '存在未同步项，原始载荷已在 unsynced 中返回，请保留现场证据后重试。'
        : '同步完成',
    });
  }
  // GET /api/work-orders/:id/print  打印维护单：固定快照版本信息可追溯
  if (seg.length === 2 && seg[1] === 'print' && m === 'GET') {
    const d = await getWorkOrderDetail(db, seg[0]);
    const program = d.workOrder.program_id
      ? await db.findOne('service_programs', { id: d.workOrder.program_id })
      : null;
    return ok(res, buildPrintSheet(d, program));
  }
  // POST /api/work-orders/:id/rebase-decisions  提交逐项决定（校验但不伪造勾选）
  if (seg.length === 2 && seg[1] === 'rebase-decisions' && m === 'POST') {
    const b = await readBody(req);
    const target = await getManual(db, b.targetManualId);
    if (target.status !== 'approved') throw new HttpError(409, '目标版本必须审核通过');
    const wo = await db.findOne('work_orders', { id: seg[0] });
    if (!wo) throw new HttpError(404, '工单不存在');
    const old = await getManual(db, wo.manual_id);
    const events = await db.find('step_events', { work_order_id: wo.id });
    const { done } = foldEvents(events);
    const items = judgeRebase({ oldSteps: old.steps, newSteps: target.steps, done });
    const v = validateRebaseDecisions(items, b.decisions);
    if (!v.ok) return send(res, 400, { error: '逐项决定不完整或不合法', code: 'BAD_DECISIONS', details: v.errors });

    // redo / skip 的旧勾选必须被显式失效：写一条带审计说明的 uncheck 事件，
    // 绝不能让旧版勾选在新版里残留成 √（那等于静默“全算完成”）。
    const lastByKey = new Map();
    for (const e of events) lastByKey.set(e.step_key, e.id);
    const invalidated = [];
    for (const a of v.applied) {
      if (a.choice === 'redo' || a.choice === 'skip') {
        if (done[a.step_key]?.action === 'check') {
          const ns = target.steps.find((s) => s.key_code === a.step_key);
          await db.insert('step_events', {
            id: newId('evt'),
            work_order_id: wo.id,
            step_key: a.step_key,
            step_no: ns ? ns.step_no : 0,
            content_hash: ns ? ns.content_hash : done[a.step_key].content_hash,
            action: 'uncheck',
            base_event_id: lastByKey.get(a.step_key) ?? null,
            client_event_id: `rebase-r${target.revision}-${a.choice}-${wo.id}-${a.step_key}`,
            technician: 'system-rebase',
            note: a.choice === 'redo'
              ? `手册迁移至 REV ${target.revision}：该步骤判定 ${a.verdict}，旧勾选显式失效，须按新版重做后重新勾选。`
              : `手册迁移至 REV ${target.revision}：该步骤已删除/跳过，旧勾选归档失效。`,
            created_at: new Date().toISOString(),
            synced_at: new Date().toISOString(),
          });
          invalidated.push(a.step_key);
        }
      }
    }

    await db.update('work_orders', wo.id, {
      manual_id: target.id, manual_code: target.code, manual_revision: target.revision,
      snapshot_hash: target.snapshot_hash,
      status: invalidated.length ? 'open' : wo.status,
      rebase: { from_manual: wo.manual_id, decisions: v.applied, invalidated, at: new Date().toISOString() },
    });
    return ok(res, {
      ok: true, applied: v.applied, invalidatedKeys: invalidated,
      notice: `工单已指向 REV ${target.revision}。inherit 项保留勾选；${invalidated.length ? invalidated.join('、') + ' 的旧勾选已显式失效，须重做后逐项勾选' : '无失效项'}。系统未替任何人勾选新步骤。`,
    });
  }
  // POST /api/work-orders/:id/conflicts/:cid/resolve
  if (seg.length === 4 && seg[1] === 'conflicts' && seg[3] === 'resolve' && m === 'POST') {
    const b = await readBody(req);
    return ok(res, await resolveConflict(db, seg[2], { resolution: b.resolution, note: b.note }));
  }
  throw new HttpError(404, '未知 work-orders 接口');
}

async function packages(req, res, db, seg, url, m) {
  // POST /api/packages  { kind, manualId, rootTaskKeys? }
  if (!seg.length && m === 'POST') {
    const b = await readBody(req);
    const r = await buildPackage(db, b);
    return send(res, 201, { package: r.record, manifest: r.manifest, manifest_hash: r.manifest_hash });
  }
  // GET /api/packages?modelId=
  if (!seg.length && m === 'GET') {
    let rows = await db.find('packages');
    const modelId = url.searchParams.get('modelId');
    if (modelId) rows = rows.filter((p) => p.model_id === modelId);
    return ok(res, { packages: rows });
  }
  // POST /api/packages/compare { manualId, rootTaskKeys }
  if (seg.length === 1 && seg[0] === 'compare' && m === 'POST') {
    const b = await readBody(req);
    return ok(res, await comparePackaging(db, b));
  }
  // POST /api/packages/:id/withdraw  返回撤回提示 + 未同步证据保留清单
  if (seg.length === 2 && seg[1] === 'withdraw' && m === 'POST') {
    const b = await readBody(req);
    return ok(res, await withdrawPackage(db, seg[0], b.reason));
  }
  throw new HttpError(404, '未知 packages 接口');
}

// ---------- helpers ----------
function publicManual(m) {
  return {
    id: m.id, modelId: m.model_id, code: m.code, revision: m.revision,
    title: m.title, status: m.status,
    approvedAt: m.approved_at ?? null, withdrawnAt: m.withdrawn_at ?? null,
  };
}
function publicDetail(d) {
  return { ...publicManual(d), steps: d.steps, snapshot_hash: d.snapshot_hash };
}
function shapeWO(wo) {
  return {
    id: wo.id, code: wo.code, modelId: wo.model_id, serialNo: wo.serial_no,
    programId: wo.program_id, status: wo.status,
    manual: { id: wo.manual_id, code: wo.manual_code, revision: wo.manual_revision },
    snapshotHash: wo.snapshot_hash,
    createdAt: wo.created_at, completedAt: wo.completed_at ?? null,
    technician: wo.technician ?? '',
  };
}

/** 打印维护单：完整版本追溯信息；只复述已审核手册内容，不编造维修操作 */
function buildPrintSheet(d, program) {
  const wo = d.workOrder;
  const checked = new Set(d.checkedKeys);
  const lines = [
    `维护单 ${wo.code}`,
    `机型：${wo.model_id}  序列号：${wo.serial_no || '未填'}`,
    `服务程序：${program ? `${program.name}（质保 ${program.warranty_months ?? '-'} 月）` : '未关联'}`,
    `实际使用说明版：${wo.manual_code} REV ${wo.manual_revision}`,
    `手册记录ID：${wo.manual_id}`,
    `工单创建时快照指纹：${wo.snapshot_hash}`,
    `打印时间：${new Date().toISOString()}`,
    '',
    '步骤执行记录（按快照版）：',
    ...d.steps.map(
      (s) => `[${checked.has(s.key_code) ? '√' : ' '}] ${String(s.step_no).padStart(2, '0')} ${s.title}${s.safety_critical ? '（安全关键）' : ''}`,
    ),
    '',
    `证据材料：${d.evidence.length} 份` +
      (d.evidence.some((e) => e.late) ? `（含晚传 ${d.evidence.filter((e) => e.late).length} 份，已标注）` : ''),
    ...d.evidence.map((e) => `  - ${e.filename} 采集于 ${e.captured_at}${e.late ? ' [晚传]' : ''}`),
    '',
    '注：本单仅复述审核通过手册中的步骤与实际执行记录；如说明版已撤回/更新，以工单绑定快照为准并可凭指纹追溯。',
  ];
  return {
    workOrder: shapeWO(wo),
    versionTrace: {
      manualCode: wo.manual_code,
      revision: wo.manual_revision,
      manualRecordId: wo.manual_id,
      snapshotHash: wo.snapshot_hash,
      manualStatusNow: d.pinnedManual.status,
    },
    evidenceCount: d.evidence.length,
    lateEvidenceCount: d.evidence.filter((e) => e.late).length,
    text: lines.join('\n'),
  };
}

async function readBody(req) {
  const { readJsonBody } = await import('../util.js');
  return readJsonBody(req);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}
