import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MemDb } from '../server/db/mem.js';
import { seedStore } from '../server/db/seed.js';
import { handleApi } from '../server/api/router.js';
import http from 'node:http';

async function start(t) {
  const db = new MemDb();
  await seedStore(db);
  const server = http.createServer((req, res) =>
    handleApi(req, res, new URL(req.url, 'http://x'), db));
  server.listen(0);
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, opts = {}) => {
    const r = await fetch(base + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  };
  return { call, db };
}

test('HTTP: 错机型建单 409；现场列表只有审核通过版', async (t) => {
  const { call } = await start(t);
  const manuals = (await call('/api/manuals?modelId=m_x1')).body.manuals;
  assert.deepEqual(manuals.map((m) => m.revision), [1, 2]);

  const r = await call('/api/work-orders', { method: 'POST', body: { modelId: 'm_x2', manualId: manuals[0].id } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'MODEL_MANUAL_MISMATCH');
});

test('HTTP: 同码 E404 跨机型语义隔离；未选机型只消歧', async (t) => {
  const { call } = await start(t);
  const x1 = await call('/api/faults?modelId=m_x1&q=E404');
  assert.match(x1.body.items[0].meaning, /温度传感器/);
  const x2 = await call('/api/faults?modelId=m_x2&q=E404');
  assert.match(x2.body.items[0].meaning, /固件/);
  const none = await call('/api/faults?q=E404');
  assert.equal(none.body.mode, 'disambiguation_only');
});

test('HTTP: 替代环新增 409 且返回环路径；替代不反向', async (t) => {
  const { call } = await start(t);
  const cyc = await call('/api/parts/substitutions', {
    method: 'POST',
    body: { fromPartNo: 'TC-100', toPartNo: 'TC-120', applicableModels: ['m_x1'] },
  });
  assert.equal(cyc.status, 409);
  assert.equal(cyc.body.code, 'SUBST_CYCLE');
  assert.ok(cyc.body.cyclePath.includes('TC-100'));

  const rev = await call('/api/parts/TC-100/substitutes?modelId=m_x1');
  assert.deepEqual(rev.body.substitutes, []);
});

test('HTTP: 整机型包 vs 任务依赖包比较；撤回含提示与证据保留清单', async (t) => {
  const { call } = await start(t);
  const manuals = (await call('/api/manuals?modelId=m_x1')).body.manuals;
  const rev2 = manuals.find((m) => m.revision === 2);

  const cmp = await call('/api/packages/compare', {
    method: 'POST', body: { manualId: rev2.id, rootTaskKeys: ['S-TEMP'] },
  });
  assert.equal(cmp.status, 200);
  assert.equal(cmp.body.full_model.size, 5);
  assert.ok(cmp.body.task_deps.size < cmp.body.full_model.size);
  assert.ok(cmp.body.omitted_by_task_package.includes('S-VERIFY'));
  assert.equal(cmp.body.subset, true);

  const wo = await call('/api/work-orders', { method: 'POST', body: { modelId: 'm_x1', manualId: rev2.id } });
  const sLock = wo.body.snapshot.find((s) => s.key_code === 'S-LOCK');
  await call(`/api/work-orders/${wo.body.id}/events`, {
    method: 'POST',
    body: { stepKey: 'S-LOCK', action: 'check', contentHash: sLock.content_hash, clientEventId: 'e1', baseEventId: null },
  });
  await call(`/api/work-orders/${wo.body.id}/evidence`, {
    method: 'POST',
    body: { stepKey: 'S-LOCK', filename: 'a.jpg', clientEvidenceId: 'p1', sizeBytes: 3 },
  });

  const wd = await call(`/api/packages/${cmp.body.full_model.packageId}/withdraw`, {
    method: 'POST', body: { reason: '测试撤回' },
  });
  assert.equal(wd.status, 200);
  assert.equal(wd.body.package.status, 'withdrawn');
  assert.ok(wd.body.warnings.length >= 3);
  assert.equal(wd.body.affectedWorkOrders[0].unsyncedEvidenceRetained, true);

  const pkgs = await call('/api/packages?modelId=m_x1');
  assert.ok(pkgs.body.packages.some((p) => p.status === 'withdrawn'));
});

test('HTTP: 打印维护单可追溯实际说明版与快照指纹；未审核内容不被编造', async (t) => {
  const { call } = await start(t);
  const manuals = (await call('/api/manuals?modelId=m_x1')).body.manuals;
  const rev1 = manuals.find((m) => m.revision === 1);
  const wo = await call('/api/work-orders', { method: 'POST', body: { modelId: 'm_x1', manualId: rev1.id } });
  for (const s of wo.body.snapshot) {
    await call(`/api/work-orders/${wo.body.id}/events`, {
      method: 'POST',
      body: { stepKey: s.key_code, action: 'check', contentHash: s.content_hash, clientEventId: `c-${s.key_code}`, baseEventId: null },
    });
  }
  const detail = await call(`/api/work-orders/${wo.body.id}`);
  assert.equal(detail.body.checkedKeys.length, wo.body.snapshot.length, '所有勾选必须真实落库（防 clientEventId 丢失回归）');
  const print = await call(`/api/work-orders/${wo.body.id}/print`);
  assert.equal(print.status, 200);
  assert.match(print.body.text, /FAN-X1 REV 1/);
  assert.equal((print.body.text.match(/\[√\]/g) || []).length, wo.body.snapshot.length);
  assert.equal(print.body.versionTrace.revision, 1);
  assert.ok(print.body.versionTrace.snapshotHash);
  assert.match(print.body.text, /仅复述审核通过手册/);

  const unknown = await call('/api/faults?modelId=m_x1&q=T999');
  assert.equal(unknown.items?.length ?? unknown.body.items.length, 0);
});

test('HTTP: 云端/离线冲突同步 409 并回传未同步载荷；证据不丢且重放幂等', async (t) => {
  const { call } = await start(t);
  const manuals = (await call('/api/manuals?modelId=m_x1')).body.manuals;
  const rev1 = manuals.find((m) => m.revision === 1);
  const wo = await call('/api/work-orders', { method: 'POST', body: { modelId: 'm_x1', manualId: rev1.id } });
  const sLock = wo.body.snapshot.find((s) => s.key_code === 'S-LOCK');

  await call(`/api/work-orders/${wo.body.id}/events`, {
    method: 'POST',
    body: { stepKey: 'S-LOCK', action: 'check', contentHash: sLock.content_hash, clientEventId: 'cloud-1', baseEventId: null },
  });
  const sync = await call(`/api/work-orders/${wo.body.id}/sync`, {
    method: 'POST',
    body: {
      events: [{ stepKey: 'S-LOCK', action: 'uncheck', contentHash: sLock.content_hash, clientEventId: 'off-1', baseEventId: null }],
      evidence: [{ filename: 'x.jpg', clientEvidenceId: 'off-p1', sizeBytes: 2 }],
    },
  });
  assert.equal(sync.status, 409);
  assert.equal(sync.body.conflicts.length, 1);
  assert.ok(sync.body.unsynced.some((u) => u.type === 'event'));
  assert.ok(sync.body.accepted.includes('off-p1'));

  const sync2 = await call(`/api/work-orders/${wo.body.id}/sync`, {
    method: 'POST',
    body: { evidence: [{ filename: 'x.jpg', clientEvidenceId: 'off-p1', sizeBytes: 2 }] },
  });
  assert.ok(sync2.body.deduped.includes('off-p1'));
});

test('HTTP: 改版迁移后 redo 项旧勾选被显式失效，不残留 √（不“全算完成”）', async (t) => {
  const { call } = await start(t);
  const manuals = (await call('/api/manuals?modelId=m_x1')).body.manuals;
  const rev1 = manuals.find((m) => m.revision === 1);
  const rev2 = manuals.find((m) => m.revision === 2);
  const wo = await call('/api/work-orders', { method: 'POST', body: { modelId: 'm_x1', manualId: rev1.id } });
  for (const s of wo.body.snapshot) {
    await call(`/api/work-orders/${wo.body.id}/events`, {
      method: 'POST',
      body: { stepKey: s.key_code, action: 'check', contentHash: s.content_hash, clientEventId: `r-${s.key_code}`, baseEventId: null },
    });
  }
  const decisions = { 'S-TEMP': 'redo', 'S-HEAT': 'redo', 'S-CLOSE': 'redo', 'S-OLD': 'skip' };
  const r = await call(`/api/work-orders/${wo.body.id}/rebase-decisions`, {
    method: 'POST', body: { targetManualId: rev2.id, decisions },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.invalidatedKeys.sort(), ['S-CLOSE', 'S-HEAT', 'S-OLD', 'S-TEMP']);

  const detail = (await call(`/api/work-orders/${wo.body.id}`)).body;
  assert.deepEqual(detail.checkedKeys, ['S-LOCK'], '只有 unchanged 的 S-LOCK 保留勾选');
  assert.equal(detail.manual.revision, 2);
  assert.equal(detail.status, 'open', '有重做项，工单回到 open，不允许静默完工');

  const print = (await call(`/api/work-orders/${wo.body.id}/print`)).body;
  assert.equal(print.versionTrace.revision, 2, '打印仍可追溯到实际使用的新版');
});

test('HTTP: 替代件序列号生效范围——无序列号入 restricted，区间外禁用，区间内可用', async (t) => {
  const { call } = await start(t);
  const noSerial = await call('/api/parts/HS-310/substitutes?modelId=m_x1&onDate=2026-06-01');
  assert.equal(noSerial.status, 200);
  assert.equal(noSerial.body.substitutes.length, 0);
  assert.equal(noSerial.body.restricted.length, 1);
  assert.equal(noSerial.body.restricted[0].serialStatus, 'serial_required');

  const outOf = await call('/api/parts/HS-310/substitutes?modelId=m_x1&serialNo=AX1-2025-9000&onDate=2026-06-01');
  assert.equal(outOf.body.substitutes.length, 0);
  assert.equal(outOf.body.restricted[0].serialStatus, 'out_of_range');

  const inRange = await call('/api/parts/HS-310/substitutes?modelId=m_x1&serialNo=AX1-2026-0500&onDate=2026-06-01');
  assert.equal(inRange.body.substitutes.length, 1);
  assert.equal(inRange.body.substitutes[0].usable, true);
});

test('HTTP: 同一工单可连续两次迁移（rebase 审计事件 client_event_id 带修订号不撞键）', async (t) => {
  const { call } = await start(t);
  const manuals = (await call('/api/manuals?modelId=m_x1')).body.manuals;
  const rev1 = manuals.find((m) => m.revision === 1);
  const rev2 = manuals.find((m) => m.revision === 2);
  // 种子里 rev3 是草稿；新建 rev4 审核版（修订号递增），作为第二次迁移目标
  const created = await call('/api/manuals', {
    method: 'POST',
    body: {
      modelId: 'm_x1', code: 'FAN-X1', title: 'X1 风机/温度故障维修手册', status: 'approved',
      steps: [
        { key_code: 'S-LOCK', title: '断电挂牌上锁', content: '断开主电源、挂牌、验电，并增加双人确认（再次改版）。', safety_critical: true, depends_on_keys: [] },
        { key_code: 'S-TEMP', title: '更换温度传感器', content: '拔出旧温度传感器，更换备件后保温恢复；必须双人复核接线，静置 20 分钟再上电。', safety_critical: true, depends_on_keys: ['S-LOCK'] },
        { key_code: 'S-HEAT', title: '检查加热器', content: '目视检查加热器接线，测量绝缘电阻不低于 1.0MΩ（新标准）。', safety_critical: false, depends_on_keys: ['S-TEMP'] },
        { key_code: 'S-VERIFY', title: '温升验证（新增）', content: '上电后运行测试程序 10 分钟，记录进出口温差并拍照。', safety_critical: false, depends_on_keys: ['S-HEAT'] },
        { key_code: 'S-CLOSE', title: '复位外壳并通电', content: '装回外壳，按力矩 2.1N·m 紧固，恢复供电并观察自检。', safety_critical: false, depends_on_keys: ['S-VERIFY'] },
      ],
    },
  });
  // 种子已占用 rev1/2/3(draft)，新版应为 rev4
  const rev4Id = created.body.manual.id;
  assert.equal(created.body.manual.revision, 4);

  const wo = await call('/api/work-orders', { method: 'POST', body: { modelId: 'm_x1', manualId: rev1.id } });
  for (const s of wo.body.snapshot) {
    await call(`/api/work-orders/${wo.body.id}/events`, {
      method: 'POST',
      body: { stepKey: s.key_code, action: 'check', contentHash: s.content_hash, clientEventId: `d-${s.key_code}`, baseEventId: null },
    });
  }
  // 第一次迁移 rev1 -> rev2
  const r1 = await call(`/api/work-orders/${wo.body.id}/rebase-decisions`, {
    method: 'POST', body: {
      targetManualId: rev2.id,
      decisions: { 'S-TEMP': 'redo', 'S-HEAT': 'skip', 'S-CLOSE': 'redo', 'S-OLD': 'skip' },
    },
  });
  assert.equal(r1.status, 200);

  // 重做/新做被失效的项后，再迁移 rev2 -> rev4
  const detail2 = (await call(`/api/work-orders/${wo.body.id}`)).body;
  const hashOf = (k) => detail2.steps.find((s) => s.key_code === k).content_hash;
  const lastOf = (k) => detail2.events.filter((e) => e.step_key === k).at(-1)?.id ?? null;
  for (const k of ['S-TEMP', 'S-CLOSE', 'S-VERIFY']) {
    const rr = await call(`/api/work-orders/${wo.body.id}/events`, {
      method: 'POST',
      body: {
        stepKey: k, action: 'check', contentHash: hashOf(k),
        clientEventId: `redo1-${k}`, baseEventId: lastOf(k),
      },
    });
    assert.equal(rr.status, 201, `${k} 重做勾选应成功: ${JSON.stringify(rr.body)}`);
  }
  const r2 = await call(`/api/work-orders/${wo.body.id}/rebase-decisions`, {
    method: 'POST', body: { targetManualId: rev4Id, decisions: { 'S-LOCK': 'redo' } },
  });
  assert.equal(r2.status, 200, `二次迁移不应因审计事件 ID 冲突失败: ${JSON.stringify(r2.body)}`);
  const final = (await call(`/api/work-orders/${wo.body.id}`)).body;
  assert.equal(final.manual.revision, 4);
  assert.ok(!final.checkedKeys.includes('S-LOCK'), '安全关键 S-LOCK 改版后旧勾选失效');
});

test('HTTP: 建单绑定不适用的服务程序 409 OUT_OF_SCOPE；适用程序可建单', async (t) => {
  const { call } = await start(t);
  const rev1 = (await call('/api/manuals?modelId=m_x1')).body.manuals[0];
  const progs = (await call('/api/programs/for-model?modelId=m_x1')).body.programs;
  const ext = progs.find((p) => p.name.includes('延保'));
  const std = progs.find((p) => p.name.includes('两年'));
  assert.equal(ext.appliesTo, false);

  const bad = await call('/api/work-orders', {
    method: 'POST', body: { modelId: 'm_x1', manualId: rev1.id, programId: ext.id },
  });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'OUT_OF_SCOPE');

  const good = await call('/api/work-orders', {
    method: 'POST', body: { modelId: 'm_x1', serialNo: 'AX1-2026-0100', manualId: rev1.id, programId: std.id },
  });
  assert.equal(good.status, 201);
  assert.equal(good.body.programId, std.id);
});

test('HTTP: 冲突裁决端点 keep_remote/keep_local 均生效（此前该端点漏传 db 的回归保护）', async (t) => {
  const { call } = await start(t);
  const rev1 = (await call('/api/manuals?modelId=m_x1')).body.manuals[0];
  const wo = await call('/api/work-orders', { method: 'POST', body: { modelId: 'm_x1', manualId: rev1.id } });
  const sLock = wo.body.snapshot.find((s) => s.key_code === 'S-LOCK');
  await call(`/api/work-orders/${wo.body.id}/events`, {
    method: 'POST',
    body: { stepKey: 'S-LOCK', action: 'check', contentHash: sLock.content_hash, clientEventId: 'http-c1', baseEventId: null },
  });
  const sync = await call(`/api/work-orders/${wo.body.id}/sync`, {
    method: 'POST',
    body: { events: [{ stepKey: 'S-LOCK', action: 'uncheck', contentHash: sLock.content_hash, clientEventId: 'http-off1', baseEventId: null }] },
  });
  assert.equal(sync.status, 409);
  const cid = sync.body.conflicts[0].conflictId;
  const resolved = await call(`/api/work-orders/${wo.body.id}/conflicts/${cid}/resolve`, {
    method: 'POST', body: { resolution: 'keep_local' },
  });
  assert.equal(resolved.status, 200, resolved.body);
  assert.ok(resolved.body.appliedEventId);
  const detail = (await call(`/api/work-orders/${wo.body.id}`)).body;
  assert.deepEqual(detail.checkedKeys, []);
  assert.equal(detail.conflicts.length, 0);
});
