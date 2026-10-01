// HTTP API：所有业务硬规则在此落地（路由层编排，判定规则来自 domain/）。
import express from 'express';
import { q, one, withTx, audit } from './db.js';
import { interpretFaultCode } from './domain/faultSearch.js';
import {
  wouldCreateCycle, checkCompatible, edgeScope,
} from './domain/substitution.js';
import { reevaluateWorkAfterRevision, buildTaskManifest } from './domain/reevaluation.js';

export function createApi(db) {
  const r = express.Router();
  r.use(express.json({ limit: '2mb' }));

  // Express 4 不自动捕获 async 处理器异常（会导致请求挂起），统一包装
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    const orig = r[method].bind(r);
    r[method] = (path, ...handlers) => orig(path, ...handlers.map((h) =>
      typeof h === 'function' && h.length !== 4 ? wrap(h) : h));
  }

  function httpError(res, code, error, extra = {}) {
    return res.status(code).json({ error, ...extra });
  }

  // ---------- 机型 / 修订 ----------
  r.get('/models', async (_req, res) => {
    res.json(await q(db, `
      SELECT m.code, m.name, m.released_at,
             (SELECT json_agg(json_build_object('revision', revision, 'released_at', released_at, 'notes', notes)
                              ORDER BY released_at)
              FROM model_revisions mr WHERE mr.model_code = m.code) AS revisions
      FROM machine_models m ORDER BY m.code`));
  });

  // ---------- 故障码检索（必须带机型作用域） ----------
  r.get('/fault-codes/lookup', async (req, res) => {
    const code = String(req.query.code ?? '').trim();
    const model = req.query.model ? String(req.query.model) : null;
    if (!code) return httpError(res, 400, 'MISSING_CODE', { message: '请输入故障码。' });
    const rows = await q(db, 'SELECT * FROM fault_codes WHERE upper(code) = upper($1)', [code]);
    res.json(interpretFaultCode(rows, code, model));
  });

  // ---------- 手册 / 步骤（只呈现已审核版本） ----------
  r.get('/manuals', async (req, res) => {
    const model = req.query.model ? String(req.query.model) : null;
    const sql = `SELECT id, model_code, version, status, content_hash, approved_at,
                        supersedes_id
                 FROM manuals WHERE status = 'approved'
                 ${model ? 'AND model_code = $1' : ''} ORDER BY model_code, id`;
    res.json(await q(db, sql, model ? [model] : []));
  });

  r.get('/manuals/:id', async (req, res) => {
    const m = await one(db, `SELECT * FROM manuals WHERE id = $1 AND status IN ('approved','superseded')`, [req.params.id]);
    if (!m) return httpError(res, 404, 'NOT_FOUND', { message: '手册版本不存在或未通过审核。' });
    const steps = await q(db, 'SELECT * FROM manual_steps WHERE manual_id = $1 ORDER BY step_no', [m.id]);
    res.json({ manual: m, steps });
  });

  // 发布新手册版本（审核动作；关键步骤变更将触发逐项继承判定）
  r.post('/manuals', async (req, res) => {
    const { model_code, version, steps, reviewer } = req.body ?? {};
    if (!model_code || !version || !Array.isArray(steps) || steps.length === 0) {
      return httpError(res, 400, 'BAD_REQUEST', { message: 'model_code、version、steps[] 必填。' });
    }
    try {
      const result = await withTx(db, async (c) => {
        const prev = await one(c,
          `SELECT id FROM manuals WHERE model_code=$1 AND status='approved' ORDER BY id DESC LIMIT 1`,
          [model_code]);
        const { createHash } = await import('node:crypto');
        const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
        const bodies = steps.map((s) => `${s.step_no}:${s.title}|${s.instruction}|${(s.required_parts ?? []).join(',')}`);
        const contentHash = sha(`${model_code}|${version}|${bodies.join('||')}`);
        const ins = await c.query(
          `INSERT INTO manuals(model_code,version,status,supersedes_id,content_hash,approved_at)
           VALUES ($1,$2,'approved',$3,$4, now()) RETURNING *`,
          [model_code, version, prev?.id ?? null, contentHash]);
        const manual = ins.rows[0];
        for (const s of steps) {
          const h = sha(`${s.step_no}|${s.title}|${s.instruction}|${[...(s.required_parts ?? [])].sort().join(',')}`);
          await c.query(
            `INSERT INTO manual_steps(manual_id,step_no,title,instruction,is_key_step,required_parts,step_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [manual.id, s.step_no, s.title, s.instruction, !!s.is_key_step, s.required_parts ?? [], h]);
        }
        if (prev) await c.query(`UPDATE manuals SET status='superseded' WHERE id=$1`, [prev.id]);
        await audit(c, 'manual.approve', 'manuals', manual.id,
          { model_code, version, supersedes: prev?.id ?? null }, reviewer || 'reviewer');
        return manual;
      });
      res.status(201).json(result);
    } catch (e) {
      if (String(e.message).includes('unique') || String(e.message).includes('duplicate')) {
        return httpError(res, 409, 'VERSION_EXISTS', { message: '该机型版本已存在。' });
      }
      throw e;
    }
  });

  // ---------- 备件 ----------
  r.get('/parts', async (_req, res) => res.json(await q(db, 'SELECT * FROM parts ORDER BY sku')));

  r.get('/substitutions', async (_req, res) => {
    res.json(await q(db, 'SELECT * FROM part_substitutions WHERE status=$1 ORDER BY id', ['approved']));
  });

  // 兼容性判定：必须给上下文（机型/序列号/日期），防止越范围传递
  r.get('/substitutions/check', async (req, res) => {
    const source = String(req.query.source ?? '');
    const target = String(req.query.target ?? '');
    const model = req.query.model ? String(req.query.model) : null;
    const serial = req.query.serial != null && req.query.serial !== '' ? Number(req.query.serial) : null;
    const date = req.query.date ? String(req.query.date) : new Date().toISOString().slice(0, 10);
    if (!source || !target) return httpError(res, 400, 'BAD_REQUEST', { message: 'source 与 target 必填。' });
    const edges = await q(db, `SELECT * FROM part_substitutions WHERE status='approved'`);
    res.json({ source, target, context: { modelCode: model, serial, date },
               ...checkCompatible(edges, source, target, { modelCode: model, serial, date }) });
  });

  // 新增替代边：先做有向环检测，成环即拒，绝不落库
  r.post('/substitutions', async (req, res) => {
    const e = req.body ?? {};
    if (!e.sku || !e.replaces_sku || !['forward', 'reverse', 'both'].includes(e.direction)) {
      return httpError(res, 400, 'BAD_REQUEST', { message: 'sku、replaces_sku、direction(forward/reverse/both) 必填。' });
    }
    if (e.sku === e.replaces_sku) {
      return httpError(res, 400, 'SELF_LOOP', { message: '备件不能替代自身。' });
    }
    const edges = await q(db, `SELECT * FROM part_substitutions WHERE status='approved'`);
    const candidate = {
      sku: e.sku, replaces_sku: e.replaces_sku, direction: e.direction,
      model_code: e.model_code ?? null, serial_from: e.serial_from ?? null, serial_to: e.serial_to ?? null,
      valid_from: e.valid_from ?? '1970-01-01', valid_to: e.valid_to ?? '9999-12-31',
    };
    if (wouldCreateCycle(edges, candidate)) {
      await audit(db, 'substitution.reject_cycle', 'part_substitutions', null, candidate);
      return httpError(res, 409, 'SUBSTITUTION_CYCLE', {
        message: '新增关系会在有向替代图中形成环（替代件环），已拒绝。替代关系必须保持无环。',
      });
    }
    const ins = await db.query(
      `INSERT INTO part_substitutions(sku,replaces_sku,direction,model_code,serial_from,serial_to,
                                      valid_from,valid_to,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [candidate.sku, candidate.replaces_sku, candidate.direction, candidate.model_code,
       candidate.serial_from, candidate.serial_to, candidate.valid_from, candidate.valid_to, e.note ?? null]);
    await audit(db, 'substitution.create', 'part_substitutions', ins.rows[0].id, candidate);
    res.status(201).json(ins.rows[0]);
  });

  // ---------- 业务服务管理：适用范围 ----------
  r.get('/coverages', async (req, res) => {
    const model = req.query.model ? String(req.query.model) : null;
    const serial = req.query.serial != null && req.query.serial !== '' ? Number(req.query.serial) : null;
    const date = req.query.date ? String(req.query.date) : new Date().toISOString().slice(0, 10);
    const rows = await q(db, 'SELECT * FROM service_coverages ORDER BY model_code, id', []);
    const applicable = rows.filter((c) =>
      (!model || c.model_code === model) &&
      (serial == null || ((c.serial_from == null || serial >= c.serial_from) &&
                          (c.serial_to == null || serial <= c.serial_to))) &&
      date >= new Date(c.valid_from).toISOString().slice(0, 10) &&
      date <= new Date(c.valid_to).toISOString().slice(0, 10));
    res.json({ queried: { model, serial, date }, applicable, total: rows.length });
  });

  // ---------- 工单 ----------
  r.get('/work-orders', async (_req, res) => res.json(await q(db, 'SELECT * FROM work_orders ORDER BY id')));

  r.post('/work-orders', async (req, res) => {
    const { wo_no, model_code, serial_no, fault_code } = req.body ?? {};
    if (!wo_no || !model_code || serial_no == null) {
      return httpError(res, 400, 'BAD_REQUEST', { message: 'wo_no、model_code、serial_no 必填。' });
    }
    // 工单上的故障码必须在该机型作用域内存在（从源头防错机型）
    if (fault_code) {
      const rows = await q(db, 'SELECT * FROM fault_codes WHERE upper(code)=upper($1)', [fault_code]);
      const interp = interpretFaultCode(rows, fault_code, model_code);
      if (!interp.resolved) {
        return httpError(res, 422, 'FAULT_CODE_OUT_OF_SCOPE', {
          message: interp.message, reason: interp.reason, crossModel: interp.crossModel ?? [],
        });
      }
    }
    const ins = await db.query(
      `INSERT INTO work_orders(wo_no,model_code,serial_no,fault_code,status)
       VALUES ($1,$2,$3,$4,'open') RETURNING *`,
      [wo_no, model_code, serial_no, fault_code ?? null]);
    await audit(db, 'work_order.create', 'work_orders', ins.rows[0].id, { wo_no, model_code, serial_no });
    res.status(201).json(ins.rows[0]);
  });

  r.get('/work-orders/:id', async (req, res) => {
    const wo = await one(db, 'SELECT * FROM work_orders WHERE id=$1', [req.params.id]);
    if (!wo) return httpError(res, 404, 'NOT_FOUND', { message: '工单不存在。' });
    const items = await q(db, 'SELECT * FROM work_order_items WHERE work_order_id=$1 ORDER BY step_no', [wo.id]);
    const evidenceRows = await q(db, 'SELECT * FROM evidence WHERE work_order_id=$1 ORDER BY id', [wo.id]);
    const bound = wo.bound_manual_id
      ? await one(db, 'SELECT id, model_code, version, status, content_hash FROM manuals WHERE id=$1', [wo.bound_manual_id])
      : null;
    const latest = await one(db,
      `SELECT id, version, status, content_hash FROM manuals
       WHERE model_code=$1 AND status='approved' ORDER BY id DESC LIMIT 1`, [wo.model_code]);
    let reevaluation = null;
    if (bound && latest && bound.content_hash !== latest.content_hash) {
      const newSteps = await q(db, 'SELECT step_no, title, step_hash, is_key_step FROM manual_steps WHERE manual_id=$1', [latest.id]);
      reevaluation = { against_version: latest.version, ...reevaluateWorkAfterRevision(items, newSteps) };
    }
    res.json({ work_order: wo, items, evidence: evidenceRows, bound_manual: bound, latest_manual: latest, reevaluation });
  });

  // 现场离线勾选：绑定工单与手册快照（钉版本 + 内容指纹，生成逐项清单）。
  // 若工单已绑定旧版，migrate=true 执行快照迁移：保留已做记录（绝不静默重置），
  // 更新目标指纹并新增步骤项，随后必须逐项裁决（绝不全部算完成）。
  r.post('/work-orders/:id/bind-manual', async (req, res) => {
    const manualId = Number(req.body?.manual_id);
    const migrate = !!req.body?.migrate;
    const wo = await one(db, 'SELECT * FROM work_orders WHERE id=$1', [req.params.id]);
    if (!wo) return httpError(res, 404, 'NOT_FOUND', { message: '工单不存在。' });
    const manual = await one(db,
      `SELECT * FROM manuals WHERE id=$1 AND model_code=$2 AND status IN ('approved','superseded')`,
      [manualId, wo.model_code]);
    if (!manual) return httpError(res, 422, 'MANUAL_NOT_APPLICABLE', { message: '只能绑定本机型的已审核手册版本。' });
    if (wo.bound_manual_id && wo.bound_manual_id !== manual.id && !migrate) {
      return httpError(res, 409, 'SNAPSHOT_ALREADY_BOUND', {
        message: `工单已绑定快照 ${wo.bound_version}。更换说明版属于快照迁移，需显式 migrate=true，且已完成的关键步骤须逐项判定能否继承。`,
        bound_version: wo.bound_version,
      });
    }
    const steps = await q(db, 'SELECT * FROM manual_steps WHERE manual_id=$1 ORDER BY step_no', [manualId]);
    let reevaluation = null;
    await withTx(db, async (c) => {
      await c.query(
        `UPDATE work_orders SET bound_manual_id=$1, bound_version=$2, bound_content_hash=$3,
           bound_at=now(), offline=true, status='in_progress', updated_at=now()
         WHERE id=$4`,
        [manual.id, manual.version, manual.content_hash, wo.id]);

      if (!wo.bound_manual_id) {
        // 首次绑定：生成全新逐项清单
        await c.query('DELETE FROM work_order_items WHERE work_order_id=$1', [wo.id]);
        for (const s of steps) {
          await c.query(
            `INSERT INTO work_order_items(work_order_id,step_no,title,step_hash,is_key_step,state)
             VALUES ($1,$2,$3,$4,$5,'pending')`,
            [wo.id, s.step_no, s.title, s.step_hash, s.is_key_step]);
        }
      } else {
        // 快照迁移：保留既有项与完成证据，仅更新目标指纹/标题；新增步骤补 pending；
        // 删除的步骤保留行并标 removed。已完成项的"能否继承"全部交给逐项裁决。
        const existing = await q(c, 'SELECT * FROM work_order_items WHERE work_order_id=$1', [wo.id]);
        const byNo = new Map(existing.map((i) => [i.step_no, i]));
        for (const s of steps) {
          const old = byNo.get(s.step_no);
          if (!old) {
            await c.query(
              `INSERT INTO work_order_items(work_order_id,step_no,title,step_hash,is_key_step,state)
               VALUES ($1,$2,$3,$4,$5,'pending')`,
              [wo.id, s.step_no, s.title, s.step_hash, s.is_key_step]);
          } else {
            const doneLike = old.state === 'done' || old.state === 'inherited_confirmed';
            if (doneLike) {
              // 已完成项：保留完成基线指纹，仅登记目标指纹并把裁决状态置为待裁
              await c.query(
                `UPDATE work_order_items SET title=$2, target_step_hash=$3, is_key_step=$4,
                   decision_status=COALESCE(decision_status,'pending')
                 WHERE id=$1`,
                [old.id, s.title, s.step_hash, s.is_key_step]);
            } else {
              // 未完成项：清单直接指向新版本内容，无需继承裁决
              await c.query(
                `UPDATE work_order_items SET title=$2, step_hash=$3, target_step_hash=$3,
                   is_key_step=$4, decision_status=NULL
                 WHERE id=$1`,
                [old.id, s.title, s.step_hash, s.is_key_step]);
            }
          }
        }
        for (const old of existing) {
          if (!steps.some((s) => s.step_no === old.step_no)) {
            await c.query(
              `UPDATE work_order_items SET state='removed', decision_status='removed' WHERE id=$1`,
              [old.id]);
          }
        }
        const newStepsLite = steps.map((s) => ({ step_no: s.step_no, title: s.title, step_hash: s.step_hash, is_key_step: s.is_key_step }));
        reevaluation = { from_version: wo.bound_version, to_version: manual.version,
          ...reevaluateWorkAfterRevision(existing, newStepsLite) };
      }
      await audit(c, wo.bound_manual_id ? 'work_order.migrate_snapshot' : 'work_order.bind_snapshot',
        'work_orders', wo.id,
        { manual_id: manual.id, version: manual.version, content_hash: manual.content_hash,
          previous: wo.bound_version, pending_decisions: reevaluation?.pendingDecisions ?? 0 });
    });
    res.status(201).json({
      ok: true,
      bound: { manual_id: manual.id, version: manual.version, content_hash: manual.content_hash },
      items: steps.length,
      reevaluation,
      warning: reevaluation?.warning,
    });
  });

  // 现场逐项勾选完成
  r.post('/work-orders/:id/items/:itemId/complete', async (req, res) => {
    const row = await one(db,
      `SELECT i.* FROM work_order_items i JOIN work_orders w ON w.id=i.work_order_id
       WHERE i.id=$1 AND i.work_order_id=$2`, [req.params.itemId, req.params.id]);
    if (!row) return httpError(res, 404, 'NOT_FOUND', { message: '步骤项不存在。' });
    // 完成时钉住实际执行的目标指纹（迁移/重做后为 target_step_hash）
    const pinnedHash = row.target_step_hash ?? row.step_hash;
    await db.query(
      `UPDATE work_order_items SET state='done', completed_at=now(),
         completed_step_hash=$2, step_hash=$2, decision_status=NULL WHERE id=$1`,
      [row.id, pinnedHash]);
    await audit(db, 'item.complete', 'work_order_items', row.id, { step_no: row.step_no, hash: pinnedHash });
    res.json({ ok: true });
  });

  // 逐项继承裁决：inherit / redo（不能静默重置，也不能全算完成）
  r.post('/work-orders/:id/items/:itemId/decision', async (req, res) => {
    const action = req.body?.action;
    const decidedBy = req.body?.by || 'technician';
    const note = req.body?.note || null;
    if (!['inherit', 'redo'].includes(action)) {
      return httpError(res, 400, 'BAD_REQUEST', { message: 'action 必须是 inherit 或 redo。' });
    }
    const wo = await one(db, 'SELECT * FROM work_orders WHERE id=$1', [req.params.id]);
    const item = await one(db, 'SELECT * FROM work_order_items WHERE id=$1 AND work_order_id=$2',
      [req.params.itemId, req.params.id]);
    if (!wo || !item) return httpError(res, 404, 'NOT_FOUND', { message: '工单或步骤项不存在。' });
    const latest = await one(db,
      `SELECT * FROM manuals WHERE model_code=$1 AND status='approved' ORDER BY id DESC LIMIT 1`, [wo.model_code]);
    const newStep = await one(db, 'SELECT * FROM manual_steps WHERE manual_id=$1 AND step_no=$2',
      [latest.id, item.step_no]);
    if (!newStep) return httpError(res, 422, 'STEP_REMOVED', { message: '该步骤在新版本已删除，适用 removed 处理。' });
    await withTx(db, async (c) => {
      if (action === 'inherit') {
        await c.query(
          `UPDATE work_order_items SET state='inherited_confirmed', decision_status='inheritable',
             decided_at=now(), decided_by=$2, decision_note=$3 WHERE id=$1`,
          [item.id, decidedBy, note]);
      } else {
        await c.query(
          `UPDATE work_order_items SET state='needs_redo', decision_status='needs_redo',
             decided_at=now(), decided_by=$2, decision_note=$3 WHERE id=$1`,
          [item.id, decidedBy, note]);
      }
      await c.query(
        `INSERT INTO work_order_item_decisions(item_id,action,from_hash,to_hash,decided_by,note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [item.id, action, item.completed_step_hash ?? item.step_hash, newStep.step_hash, decidedBy, note]);
      await audit(c, 'item.decision', 'work_order_items', item.id,
        { action, step_no: item.step_no, from: item.completed_step_hash, to: newStep.step_hash }, decidedBy);
    });
    res.json({ ok: true, action, step_no: item.step_no });
  });

  // 工单完成闸门：存在未裁决项或 needs_redo 未重做时拒绝
  r.post('/work-orders/:id/complete', async (req, res) => {
    const wo = await one(db, 'SELECT * FROM work_orders WHERE id=$1', [req.params.id]);
    if (!wo) return httpError(res, 404, 'NOT_FOUND', { message: '工单不存在。' });
    const items = await q(db, 'SELECT * FROM work_order_items WHERE work_order_id=$1', [wo.id]);
    const blockers = [];
    const latest = await one(db,
      `SELECT * FROM manuals WHERE model_code=$1 AND status='approved' ORDER BY id DESC LIMIT 1`, [wo.model_code]);
    const newSteps = latest
      ? await q(db, 'SELECT step_no, title, step_hash, is_key_step FROM manual_steps WHERE manual_id=$1', [latest.id])
      : [];
    const newByNo = new Map(newSteps.map((s) => [s.step_no, s]));

    for (const i of items) {
      if (i.state === 'pending') blockers.push({ item: i.step_no, reason: 'STEP_NOT_DONE' });
      if (i.state === 'needs_redo') blockers.push({ item: i.step_no, reason: 'NEEDS_REDO' });
      const target = newByNo.get(i.step_no);
      if (!target) continue;
      const doneLike = i.state === 'done' || i.state === 'inherited_confirmed';
      // 已完成项：若目标指纹不同于完成基线，必须有针对"该目标"的显式裁决
      const baseline = i.completed_step_hash ?? i.step_hash;
      if (doneLike && baseline !== target.step_hash && i.target_step_hash === target.step_hash
          && !['inheritable', 'needs_redo'].includes(i.decision_status)) {
        blockers.push({ item: i.step_no, reason: target.is_key_step ? 'KEY_STEP_CHANGED' : 'NONKEY_CHANGED' });
      }
    }

    // 绑定快照仍落后于最新版：额外按最新版重算（未迁移场景）
    let reeval = null;
    if (wo.bound_content_hash && latest && wo.bound_content_hash !== latest.content_hash) {
      reeval = reevaluateWorkAfterRevision(items, newSteps);
      for (const d of reeval.decisions) {
        if (d.needs_decision) {
          const it = items.find((x) => x.step_no === d.step_no);
          const decided = it && ['inheritable', 'needs_redo'].includes(it.decision_status);
          if (!decided && !blockers.some((b) => b.item === d.step_no)) {
            blockers.push({ item: d.step_no, reason: d.reason });
          }
        }
      }
    }
    if (blockers.length) {
      return httpError(res, 409, 'WO_NOT_COMPLETABLE', {
        message: '工单尚不能完成：存在未完成步骤或关键步骤更新后未逐项裁决（系统不会静默重置，也不会全部算完成）。',
        blockers, reevaluation: reeval,
      });
    }
    await withTx(db, async (c) => {
      await c.query(
        `UPDATE work_orders SET status='completed', bound_manual_id=$2,
           bound_version=$3, bound_content_hash=$4, updated_at=now(), revision=revision+1 WHERE id=$1`,
        [wo.id, latest.id, latest.version, latest.content_hash]);
      await audit(c, 'work_order.complete', 'work_orders', wo.id,
        { final_manual: latest.version, hash: latest.content_hash });
    });
    res.json({ ok: true });
  });

  // ---------- 证据：晚传允许；撤回只标记、文件与记录保留 ----------
  r.post('/work-orders/:id/evidence', async (req, res) => {
    const { kind = 'photo', filename, mime, bytes, item_id, captured_at } = req.body ?? {};
    if (!['photo', 'signature', 'note'].includes(kind) || !filename) {
      return httpError(res, 400, 'BAD_REQUEST', { message: 'kind 与 filename 必填。' });
    }
    const wo = await one(db, 'SELECT * FROM work_orders WHERE id=$1', [req.params.id]);
    if (!wo) return httpError(res, 404, 'NOT_FOUND', { message: '工单不存在。' });
    const ins = await db.query(
      `INSERT INTO evidence(work_order_id,item_id,kind,filename,mime,bytes,captured_at)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, now())) RETURNING *`,
      [wo.id, item_id ?? null, kind, filename, mime ?? null, bytes ?? null, captured_at ?? null]);
    const late = captured_at && new Date(captured_at) < new Date(Date.now() - 3600e3);
    await audit(db, 'evidence.upload', 'evidence', ins.rows[0].id,
      { kind, filename, captured_at, late_accepted: !!late });
    res.status(201).json({ evidence: ins.rows[0], late_upload: !!late,
      note: late ? '照片晚传已接收：采集时间保留为原始时间，并标记晚传。' : undefined });
  });

  // 撤回前预检：给出影响提示，不直接删除
  r.post('/evidence/:evidenceId/withdraw-preview', async (req, res) => {
    const ev = await one(db, 'SELECT * FROM evidence WHERE id=$1', [req.params.evidenceId]);
    if (!ev) return httpError(res, 404, 'NOT_FOUND', { message: '证据不存在。' });
    const linkedItems = ev.item_id
      ? await q(db, 'SELECT step_no,state FROM work_order_items WHERE id=$1', [ev.item_id]) : [];
    res.json({
      evidence_id: ev.id, filename: ev.filename, status: ev.status,
      warning: '撤回不会删除文件：证据将保留并标记 withdrawn，审计日志与原采集时间不清除；若该证据是关键步骤的唯一佐证，相关步骤可能需要重做。',
      linked_items: linkedItems,
    });
  });

  r.post('/evidence/:evidenceId/withdraw', async (req, res) => {
    const ev = await one(db, 'SELECT * FROM evidence WHERE id=$1', [req.params.evidenceId]);
    if (!ev) return httpError(res, 404, 'NOT_FOUND', { message: '证据不存在。' });
    if (ev.status === 'withdrawn') return httpError(res, 409, 'ALREADY_WITHDRAWN', { message: '证据已撤回（记录仍保留）。' });
    const note = req.body?.note || '现场撤回';
    await withTx(db, async (c) => {
      await c.query(`UPDATE evidence SET status='withdrawn', withdraw_note=$2, withdrawn_at=now() WHERE id=$1`,
        [ev.id, note]);
      await audit(c, 'evidence.withdraw', 'evidence', ev.id,
        { filename: ev.filename, note, retained: true });
    });
    res.json({ ok: true, retained: true, message: '证据已标记撤回并完整保留。' });
  });

  // ---------- 离线包 ----------
  // 整机型包
  r.post('/packages/full', async (req, res) => {
    const model = String(req.body?.model_code ?? '');
    const manual = await one(db,
      `SELECT * FROM manuals WHERE model_code=$1 AND status='approved' ORDER BY id DESC LIMIT 1`, [model]);
    if (!manual) return httpError(res, 404, 'NO_APPROVED_MANUAL', { message: '该机型没有已审核手册。' });
    const steps = await q(db, 'SELECT * FROM manual_steps WHERE manual_id=$1', [manual.id]);
    const faults = await q(db, 'SELECT code, meaning, severity, advised_action, ref_step_nos FROM fault_codes WHERE model_code=$1', [model]);
    const parts = [...new Set(steps.flatMap((s) => s.required_parts))];
    const manifest = {
      kind: 'full', model_code: model, manual_version: manual.version, content_hash: manual.content_hash,
      includes: { all_steps: steps.map((s) => s.step_no), referenced_parts: parts, fault_codes: faults.map((f) => f.code) },
      note: '整机型完整包：体积较大但可离线完成该机全部作业。',
    };
    const ins = await db.query(`INSERT INTO packages(kind,model_code,manifest,content_hash) VALUES ('full',$1,$2,$3) RETURNING *`,
      [model, JSON.stringify(manifest), manual.content_hash]);
    await audit(db, 'package.full', 'packages', ins.rows[0].id, { model, version: manual.version });
    res.status(201).json({ package: ins.rows[0], manifest, payload: { manual, steps, faults } });
  });

  // 按任务依赖打包
  r.post('/work-orders/:id/packages/task', async (req, res) => {
    const wo = await one(db, 'SELECT * FROM work_orders WHERE id=$1', [req.params.id]);
    if (!wo) return httpError(res, 404, 'NOT_FOUND', { message: '工单不存在。' });
    const manual = wo.bound_manual_id
      ? await one(db, 'SELECT * FROM manuals WHERE id=$1', [wo.bound_manual_id])
      : await one(db, `SELECT * FROM manuals WHERE model_code=$1 AND status='approved' ORDER BY id DESC LIMIT 1`, [wo.model_code]);
    if (!manual) return httpError(res, 404, 'NO_MANUAL', { message: '没有可用手册版本。' });
    const steps = await q(db, 'SELECT * FROM manual_steps WHERE manual_id=$1 ORDER BY step_no', [manual.id]);
    const fault = wo.fault_code
      ? await one(db, 'SELECT * FROM fault_codes WHERE code=$1 AND model_code=$2', [wo.fault_code, wo.model_code])
      : null;
    const requiredParts = req.body?.required_parts ?? [];
    const manifest = buildTaskManifest({ manual, steps, fault, requiredParts, workOrderNo: wo.wo_no });
    const ins = await db.query(
      `INSERT INTO packages(kind,model_code,work_order_id,manifest,content_hash) VALUES ('task',$1,$2,$3,$4) RETURNING *`,
      [wo.model_code, wo.id, JSON.stringify(manifest), manual.content_hash]);
    await audit(db, 'package.task', 'packages', ins.rows[0].id, { wo: wo.wo_no, includes: manifest.includes });
    const payloadSteps = steps.filter((s) => manifest.includes.steps.includes(s.step_no));
    res.status(201).json({ package: ins.rows[0], manifest, payload: { manual: { id: manual.id, version: manual.version }, steps: payloadSteps } });
  });

  // ---------- 同步与云端/离线冲突（证据保留，不静默覆盖） ----------
  r.post('/work-orders/:id/sync', async (req, res) => {
    const wo = await one(db, 'SELECT * FROM work_orders WHERE id=$1', [req.params.id]);
    if (!wo) return httpError(res, 404, 'NOT_FOUND', { message: '工单不存在。' });
    const { base_revision, items = [], evidences = [] } = req.body ?? {};
    if (base_revision == null) return httpError(res, 400, 'BAD_REQUEST', { message: '必须携带离线基线 base_revision。' });
    // 云端在离线期间被改过 → 冲突：隔离保留离线证据，不自动合并
    if (Number(base_revision) !== wo.revision) {
      const cloudItems = await q(db, 'SELECT step_no,state FROM work_order_items WHERE work_order_id=$1', [wo.id]);
      const conflict = await withTx(db, async (c) => {
        const ins = await c.query(
          `INSERT INTO sync_conflicts(work_order_id,base_revision,cloud_revision,offline_revision,
             cloud_snapshot,offline_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [wo.id, base_revision, wo.revision, Number(base_revision) + 1,
           JSON.stringify({ items: cloudItems }), JSON.stringify({ items, evidences })]);
        for (const ev of evidences) {
          await c.query(
            `INSERT INTO evidence(work_order_id,kind,filename,mime,bytes,captured_at,status)
             VALUES ($1,$2,$3,$4,$5,COALESCE($6,now()),'quarantined')`,
            [wo.id, ev.kind ?? 'photo', ev.filename ?? 'offline-evidence', ev.mime ?? null,
             ev.bytes ?? null, ev.captured_at ?? null]);
        }
        await c.query(
          `INSERT INTO sync_events(work_order_id,direction,status,payload,detail)
           VALUES ($1,'upload','conflict',$2,$3)`,
          [wo.id, JSON.stringify({ items }), `云端修订 ${wo.revision} 与离线基线 ${base_revision} 分叉；离线证据已隔离保留。`]);
        await audit(c, 'sync.conflict', 'work_orders', wo.id,
          { base_revision, cloud_revision: wo.revision, offline_evidence: evidences.length });
        return ins.rows[0];
      });
      return res.status(409).json({
        conflict: true, sync_conflict_id: conflict.id,
        message: '检测到云端与离线分叉：离线证据已隔离保留（quarantined），未静默覆盖任何一方，请人工裁决解决冲突。',
      });
    }
    await withTx(db, async (c) => {
      for (const it of items) {
        await c.query(
          `UPDATE work_order_items SET state=COALESCE($2,state),
             completed_at=CASE WHEN $2='done' THEN COALESCE(completed_at, now()) ELSE completed_at END,
             completed_step_hash=CASE WHEN $2='done' THEN step_hash ELSE completed_step_hash END
           WHERE work_order_id=$3 AND step_no=$1`,
          [it.step_no, it.state ?? null, wo.id]);
      }
      for (const ev of evidences) {
        await c.query(
          `INSERT INTO evidence(work_order_id,item_id,kind,filename,mime,bytes,captured_at)
           VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now()))`,
          [wo.id, ev.item_id ?? null, ev.kind ?? 'photo', ev.filename, ev.mime ?? null, ev.bytes ?? null, ev.captured_at ?? null]);
      }
      await c.query(`UPDATE work_orders SET revision=revision+1, updated_at=now() WHERE id=$1`, [wo.id]);
      await c.query(
        `INSERT INTO sync_events(work_order_id,direction,status,payload) VALUES ($1,'upload','applied',$2)`,
        [wo.id, JSON.stringify({ items: items.length, evidences: evidences.length })]);
      await audit(c, 'sync.apply', 'work_orders', wo.id, { items: items.length, evidences: evidences.length });
    });
    res.json({ ok: true, new_revision: wo.revision + 1 });
  });

  r.post('/sync-conflicts/:id/resolve', async (req, res) => {
    const resolution = req.body?.resolution; // keep_cloud | keep_offline
    if (!['keep_cloud', 'keep_offline'].includes(resolution)) {
      return httpError(res, 400, 'BAD_REQUEST', { message: 'resolution 必须是 keep_cloud 或 keep_offline。' });
    }
    const cf = await one(db, 'SELECT * FROM sync_conflicts WHERE id=$1', [req.params.id]);
    if (!cf) return httpError(res, 404, 'NOT_FOUND', { message: '冲突不存在。' });
    if (cf.status !== 'open') return httpError(res, 409, 'ALREADY_RESOLVED', { message: '冲突已解决（记录保留）。' });
    await withTx(db, async (c) => {
      if (resolution === 'keep_offline') {
        const offline = cf.offline_snapshot;
        for (const it of offline?.items ?? []) {
          await c.query(
            `UPDATE work_order_items SET state=COALESCE($2,state) WHERE work_order_id=$3 AND step_no=$1`,
            [it.step_no, it.state ?? null, cf.work_order_id]);
        }
        await c.query(`UPDATE evidence SET status='active' WHERE work_order_id=$1 AND status='quarantined'`,
          [cf.work_order_id]);
      } else {
        // keep_cloud：离线证据仍然保留在库（quarantined 可审计），不删除
        await c.query(`UPDATE evidence SET status='withdrawn' WHERE work_order_id=$1 AND status='quarantined'`,
          [cf.work_order_id]);
      }
      await c.query(
        `UPDATE sync_conflicts SET status=$2, resolution_note=$3, resolved_at=now() WHERE id=$1`,
        [cf.id, resolution === 'keep_cloud' ? 'resolved_keep_cloud' : 'resolved_keep_offline', req.body?.note ?? null]);
      await c.query(`UPDATE work_orders SET revision=revision+1, updated_at=now() WHERE id=$1`, [cf.work_order_id]);
      await c.query(
        `INSERT INTO sync_events(work_order_id,direction,status,detail) VALUES ($1,'upload','reverted',$2)`,
        [cf.work_order_id, `冲突人工解决：${resolution}`]);
      await audit(c, 'sync.resolve', 'sync_conflicts', cf.id,
        { resolution, offline_evidence_retained: true }, req.body?.by || 'supervisor');
    });
    res.json({ ok: true, resolution, offline_evidence_retained: true });
  });

  r.get('/work-orders/:id/conflicts', async (req, res) => {
    res.json(await q(db, 'SELECT * FROM sync_conflicts WHERE work_order_id=$1 ORDER BY id', [req.params.id]));
  });

  // ---------- 打印维护单：钉住实际使用的说明版 ----------
  r.post('/work-orders/:id/print', async (req, res) => {
    const wo = await one(db, 'SELECT * FROM work_orders WHERE id=$1', [req.params.id]);
    if (!wo) return httpError(res, 404, 'NOT_FOUND', { message: '工单不存在。' });
    if (!wo.bound_manual_id) {
      return httpError(res, 422, 'NO_SNAPSHOT', { message: '工单尚未绑定手册快照，无法打印可追溯版本的维护单。' });
    }
    const manual = await one(db, 'SELECT * FROM manuals WHERE id=$1', [wo.bound_manual_id]);
    const latest = await one(db,
      `SELECT id, version FROM manuals WHERE model_code=$1 AND status='approved' ORDER BY id DESC LIMIT 1`,
      [wo.model_code]);
    const notice = manual.status === 'superseded' || latest.id !== manual.id
      ? `注意：打印所钉版本 ${manual.version} 已被 ${latest.version} 取代，维护单仍按实际使用的 ${manual.version} 追溯，请核对现场是否需升级。`
      : null;
    const ins = await db.query(
      `INSERT INTO print_records(work_order_id,manual_id,printed_version,content_hash,supersession_notice)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [wo.id, manual.id, manual.version, manual.content_hash, notice]);
    await audit(db, 'print.maintenance_sheet', 'print_records', ins.rows[0].id,
      { wo: wo.wo_no, version: manual.version, hash: manual.content_hash, superseded: !!notice });
    res.status(201).json({ print_record: ins.rows[0], supersession_notice: notice });
  });

  r.get('/work-orders/:id/prints', async (req, res) => {
    res.json(await q(db, 'SELECT * FROM print_records WHERE work_order_id=$1 ORDER BY id', [req.params.id]));
  });

  // ---------- 审计 ----------
  r.get('/audit', async (_req, res) => res.json(await q(db, 'SELECT * FROM audit_log ORDER BY id DESC LIMIT 200')));

  return r;
}
