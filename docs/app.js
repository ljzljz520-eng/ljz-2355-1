// 现场站前端：在线走 API；离线把工单快照、勾选事件、证据元数据存 IndexedDB，回连后同步。
const app = document.getElementById('app');
const api = async (path, opts = {}) => {
  const r = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const el = (id) => document.getElementById(id);

// ---------- IndexedDB：离线事件/证据队列 ----------
const DB_NAME = 'field-v1';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const name of ['workorders', 'events', 'evidence']) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'localKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(store, row) {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).put(row);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function idbAll(store) {
  const d = await idb();
  return new Promise((res, rej) => {
    const rq = d.transaction(store).objectStore(store).getAll();
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
}
async function idbDel(store, localKey) {
  const d = await idb();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).delete(localKey);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

function setNet() {
  const n = el('net');
  n.textContent = navigator.onLine ? '在线' : '离线（数据存本机，回连后同步）';
  n.className = 'net ' + (navigator.onLine ? 'online' : 'offline');
}
addEventListener('online', () => { setNet(); route(); });
addEventListener('offline', setNet);

let models = [];
async function loadModels() {
  if (!models.length) models = (await api('/models')).body.models || [];
  return models;
}
function fillModelSelect(sel, { allOption = false } = {}) {
  sel.innerHTML = (allOption ? '<option value="">（不指定机型）</option>' : '') +
    models.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
}

// ---------- 视图：故障码 ----------
async function viewFaults() {
  app.innerHTML = el('tpl-faults').innerHTML;
  await loadModels();
  fillModelSelect(el('f-model'), { allOption: true });
  el('f-go').onclick = async () => {
    const { body } = await api(`/faults?modelId=${el('f-model').value}&q=${encodeURIComponent(el('f-q').value)}`);
    renderFaultResult(body);
  };
  el('f-any').onclick = async () => {
    const { body } = await api(`/faults?q=${encodeURIComponent(el('f-q').value)}`);
    renderFaultResult(body);
  };
}

function renderFaultResult(r) {
  const out = el('f-out');
  if (r.warning) out.innerHTML = `<div class="${r.items?.length ? 'warnbox' : 'warnbox'}">${esc(r.warning)}</div>`;
  else out.innerHTML = '';

  if (r.mode === 'disambiguation_only') {
    out.innerHTML += '<p class="hint">同名码出现在以下机型，但系统不展示其机型专属解释，直到你选定机型：</p>' +
      `<table><tr><th>机型</th><th>码</th><th>级别</th><th></th></tr>` +
      r.items.map((i) => `<tr><td>${esc(i.modelName)}</td><td>${esc(i.code)}</td>
        <td class="sev-${i.severity}">${esc(i.severity)}</td><td>${esc(i.note)}</td></tr>`).join('') + '</table>';
    return;
  }
  if (r.otherModels?.length) {
    out.innerHTML += '<div class="badbox">该码在其他机型存在同名条目，<b>仅作消歧提示，不能套用其含义</b>：' +
      r.otherModels.map((o) => esc(o.modelName)).join('、') + '</div>';
  }
  out.innerHTML += (r.items || []).map((i) => `
    <div class="item">
      <b>${esc(i.code)}</b> <span class="sev-${i.severity}">${esc(i.severity)}</span>
      <div>${esc(i.meaning)}</div>
      <div class="kvs">症状：${(i.symptoms || []).map(esc).join('；') || '—'}</div>
      <div class="kvs">处置摘要：${esc(i.resolution_summary) || '—'}（以审核手册全文为准，本站不另造操作）</div>
    </div>`).join('');
}

// ---------- 视图：备件 ----------
async function viewParts() {
  app.innerHTML = el('tpl-parts').innerHTML;
  await loadModels();
  fillModelSelect(el('p-model'), { allOption: true });
  el('p-go').onclick = async () => {
    const qs = new URLSearchParams({
      modelId: el('p-model').value,
      serialNo: el('p-serial').value.trim(),
    });
    const { status, body } = await api(`/parts/${encodeURIComponent(el('p-no').value.trim())}/substitutes?${qs}`);
    const out = el('p-out');
    if (status !== 200) { out.innerHTML = `<div class="badbox">${esc(body.error)}</div>`; return; }
    const renderItem = (s, restricted01 = false) => `
      <div class="item${restricted01 ? ' restricted' : ''}">${esc(s.part.part_no)} ${esc(s.part.name || '')}
        ${restricted01 ? `<span class="badge">${s.serialStatus === 'out_of_range' ? '序列号超范围·禁用' : '需序列号核验'}</span>` : '<span class="badge ok">可直接使用</span>'}
        <div class="kvs">方向：${esc(s.direction)} ｜ 生效机型：${(s.applicableModels || []).join('、') || '不限'} ｜
        序列号区间：${s.serialRange?.from || '不限'} ~ ${s.serialRange?.to || '不限'} ｜
        有效期：${esc(s.effective.from || '不限')} ~ ${esc(s.effective.to || '不限')}</div></div>`;
    if (!body.substitutes.length && !(body.restricted || []).length) {
      out.innerHTML = `<div class="warnbox">没有当前生效的<b>直接</b>替代关系。系统不会沿 A→B→C 推断兼容。</div>`;
      return;
    }
    out.innerHTML = `<p class="hint">${esc(body.note)}</p>` +
      body.substitutes.map((s) => renderItem(s)).join('') +
      (body.restricted || []).map((s) => renderItem(s, true)).join('');
  };
  el('p-chain').onclick = async () => {
    const { body } = await api(`/parts/${encodeURIComponent(el('p-no').value.trim())}/chains`);
    el('p-out').innerHTML = '<div class="warnbox">以下多跳链<b>不构成兼容结论</b>；需要替代时必须补录显式边并定义生效范围。</div>' +
      (body.chains || []).map((c) => `<div class="item">${c.path.map(esc).join(' → ')} ${c.cycle ? '<b class="sev-critical">[成环]</b>' : ''}</div>`).join('');
  };
  el('p-add').onclick = async () => {
    const { status, body } = await api('/parts/substitutions', {
      method: 'POST',
      body: {
        fromPartNo: el('p-from').value, toPartNo: el('p-to').value,
        directionNote: el('p-dir').value,
        applicableModels: el('p-model').value ? [el('p-model').value] : [],
      },
    });
    el('p-addout').innerHTML = status === 201
      ? `<div class="okbox">已登记替代边（有方向，非传递）。</div>`
      : `<div class="badbox">${esc(body.error)}${body.cyclePath ? '<br>环路径：' + body.cyclePath.map(esc).join(' → ') : ''}</div>`;
  };
}

// ---------- 视图：现场工单 ----------
async function viewField() {
  app.innerHTML = el('tpl-field').innerHTML;
  await loadModels();
  fillModelSelect(el('w-model'));
  const refreshManuals = async () => {
    const mid = el('w-model').value;
    const serial = el('w-serial').value.trim();
    const { body } = await api(`/manuals?modelId=${mid}`);
    el('w-manual').innerHTML = (body.manuals || [])
      .map((m) => `<option value="${m.id}">${esc(m.code)} REV ${m.revision}（${esc(m.status)}）</option>`).join('');
    const qs = new URLSearchParams({ modelId: mid });
    if (serial) qs.set('serialNo', serial);
    const progs = await api(`/programs/for-model?${qs}`);
    el('w-program').innerHTML = '<option value="">（不关联服务程序）</option>' +
      (progs.body.programs || []).map((p) =>
        `<option value="${p.id}"${p.appliesTo ? '' : ' disabled'}>${esc(p.name)}（质保 ${p.warranty_months ?? '-'} 月）${p.appliesTo ? '' : '——不适用：' + p.reasons.join('、')}</option>`).join('');
  };
  el('w-model').onchange = refreshManuals;
  el('w-serial').onchange = refreshManuals;
  await refreshManuals();

  el('w-create').onclick = async () => {
    const { status, body } = await api('/work-orders', {
      method: 'POST',
      body: {
        modelId: el('w-model').value, serialNo: el('w-serial').value,
        manualId: el('w-manual').value, programId: el('w-program').value || null,
      },
    });
    if (status !== 201) {
      el('w-detail').innerHTML = `<div class="badbox">${esc(body.error)}</div>`;
      return;
    }
    await idbPut('workorders', { localKey: body.id, ...body, downloadedAt: new Date().toISOString() });
    el('w-detail').innerHTML = `<div class="okbox">已建单 ${esc(body.code)}，快照固定为 ${esc(body.manual.code)} REV ${body.manual.revision}（指纹 ${esc(body.snapshotHash).slice(0, 12)}…）。云端以后改版不会改动这份快照。</div>`;
    await renderWorkOrders();
    await openWorkOrder(body.id);
  };
  await renderWorkOrders();
}

async function renderWorkOrders(openId) {
  const local = await idbAll('workorders');
  const { body } = await api('/work-orders');
  const cloud = new Map((body.workOrders || []).map((w) => [w.id, w]));
  el('w-list').innerHTML = '<h3>工单（本机快照）</h3>' + (local.length ? local.map((w) => `
    <div class="item">
      <b>${esc(w.code)}</b> · 快照 ${esc(w.manual.code)} REV ${w.manual.revision}
      <span class="badge">${esc(cloud.get(w.id)?.status || '仅本机')}</span>
      <button data-open="${w.id}">打开</button>
    </div>`).join('') : '<p class="hint">本机还没有工单快照。</p>');
  el('w-list').querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openWorkOrder(b.dataset.open)));
}

function localCheckedMap(localWo) {
  // 以本机事件队列折叠显示（含离线未同步）
  const m = {};
  for (const e of (localWo.pendingEvents || [])) m[e.stepKey] = e.action;
  for (const k of localWo.cloudChecked || []) if (!(k in m)) m[k] = 'check';
  return m;
}

async function openWorkOrder(woId) {
  const localWo = (await idbAll('workorders')).find((w) => w.localKey === woId);
  const { body: detail } = await api(`/work-orders/${woId}`).catch(() => ({ body: null }));
  const steps = (detail?.steps || localWo?.snapshot || []);
  if (localWo) {
    localWo.cloudChecked = detail?.checkedKeys || localWo.cloudChecked || [];
    localWo.pendingEvents = (await idbAll('events')).filter((e) => e.workOrderId === woId);
    localWo.pendingEvidence = (await idbAll('evidence')).filter((e) => e.workOrderId === woId);
    await idbPut('workorders', localWo);
  }
  const checked = localCheckedMap(localWo || {});
  const conflicts = detail?.conflicts || [];

  el('w-detail').innerHTML = `
    <div class="item">
      <b>${esc(detail?.code || localWo?.code)}</b>
      <div class="kvs">绑定说明版：<b>${esc(detail?.pinnedManual?.code || localWo?.manual?.code)}
        REV ${detail?.pinnedManual?.revision ?? localWo?.manual?.revision}</b>
        ｜ 快照指纹 ${esc(detail?.pinnedManual?.snapshotHash || localWo?.snapshotHash || '')}</div>
      <div id="rebase-zone"></div>
      ${conflicts.length ? `<div class="badbox">有 ${conflicts.length} 个云端/离线冲突待裁决（未静默覆盖）：
        ${conflicts.map((c) => `${esc(c.step_key)}
          <button data-resolve="${c.id}" data-choice="keep_remote" data-local="${esc(c.local_event_id || '')}">保留云端（丢弃本机该项）</button>
        <button data-resolve="${c.id}" data-choice="keep_local" data-local="${esc(c.local_event_id || '')}">采用离线（服务器按最新基线重放）</button>`).join('<br>')}</div>` : ''}
      <div id="steps"></div>
      <div class="row" style="margin-top:10px">
        <button id="add-photo">登记照片证据（可晚传）</button>
        <button id="complete">完工</button>
        <button id="sync" class="ghost">同步本机数据</button>
        <button id="print" class="ghost">打印维护单</button>
      </div>
      <div id="wo-msg"></div>
    </div>`;

  const stepBox = el('steps');
  stepBox.innerHTML = steps.map((s) => `
    <div class="step ${s.safety_critical ? 'safety' : ''}">
      <input type="checkbox" data-step="${esc(s.key_code)}" data-hash="${esc(s.content_hash)}"
        ${checked[s.key_code] === 'check' ? 'checked' : ''} />
      <div class="body">
        ${String(s.step_no).padStart(2, '0')} ${esc(s.title)}
        ${s.safety_critical ? '<span class="badge safe">安全关键</span>' : ''}
        <div class="kvs">${esc(s.content)}</div>
      </div>
    </div>`).join('');

  stepBox.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.onchange = async () => {
      const row = {
        localKey: uuid(), workOrderId: woId, stepKey: cb.dataset.step,
        action: cb.checked ? 'check' : 'uncheck', contentHash: cb.dataset.hash,
        baseEventId: detail ? (detail.events?.filter((e) => e.step_key === cb.dataset.step).at(-1)?.id ?? null) : null,
        createdAt: new Date().toISOString(),
      };
      if (navigator.onLine) {
        const r = await api(`/work-orders/${woId}/events`, { method: 'POST', body: {
          stepKey: row.stepKey, action: row.action, contentHash: row.contentHash,
          clientEventId: row.localKey, baseEventId: row.baseEventId,
        } });
        if (r.status === 409) {
          cb.checked = !cb.checked;
          el('wo-msg').innerHTML = `<div class="badbox">${esc(r.body.error)}（已登记冲突，请到上方裁决，本次勾选未生效）</div>`;
          return;
        }
      } else {
        await idbPut('events', row);
        el('wo-msg').innerHTML = '<div class="warnbox">离线：勾选已存本机，回连后同步。</div>';
      }
      await openWorkOrder(woId);
    };
  });

  el('add-photo').onclick = async () => {
    const meta = {
      localKey: uuid(), workOrderId: woId,
      filename: `photo-${Date.now()}.jpg`, mime: 'image/jpeg', sizeBytes: 2048,
      clientEvidenceId: uuid(), capturedAt: new Date().toISOString(),
    };
    if (navigator.onLine) {
      await api(`/work-orders/${woId}/evidence`, { method: 'POST', body: meta });
      el('wo-msg').innerHTML = '<div class="okbox">证据已上传。</div>';
    } else {
      await idbPut('evidence', meta);
      el('wo-msg').innerHTML = '<div class="warnbox">离线：证据元数据已存本机；文件本体请保留在设备，回连后补传，系统允许晚传且不会丢弃。</div>';
    }
    await openWorkOrder(woId);
  };

  el('complete').onclick = async () => {
    const r = await api(`/work-orders/${woId}/complete`, { method: 'POST', body: {} });
    el('wo-msg').innerHTML = r.status === 200
      ? '<div class="okbox">工单已完工；之后仍可补传照片（标注晚传）。</div>'
      : `<div class="badbox">${esc(r.body.error)} ${(r.body.uncheckedKeys || []).join('、')}</div>`;
  };

  el('sync').onclick = () => syncLocal(woId);
  el('print').onclick = () => printSheet(woId);

  document.querySelectorAll('[data-resolve]').forEach((b) => {
    b.onclick = async () => {
      const r = await api(`/work-orders/${woId}/conflicts/${b.dataset.resolve}/resolve`, {
        method: 'POST', body: { resolution: b.dataset.choice },
      });
      if (r.status !== 200) {
        el('wo-msg').innerHTML = `<div class="badbox">${esc(r.body.error)}（裁决未生效，请按提示重试）</div>`;
        return;
      }
      // 裁决后处理本机对应未同步载荷：
      //  keep_remote -> 删除本机事件（云端值为准）；keep_local -> 服务器已重放，删除避免重复上报。
      //  找不到对应本机记录（如由其他设备登记）则不动本机数据。
      const localId = b.dataset.local;
      if (localId) {
        const pending = await idbAll('events');
        const hit = pending.find((e) => e.localKey === localId);
        if (hit) {
          await idbDel('events', hit.localKey);
        } else {
          el('wo-msg').innerHTML = '<div class="warnbox">裁决已生效；本机未找到对应未同步载荷（可能来自其他设备），本机数据未改动。</div>';
        }
      }
      await openWorkOrder(woId);
    };
  });

  await renderRebaseZone(woId, detail);
}

// 改版继承：逐项给结论，不静默重置、不“全算完成”
async function renderRebaseZone(woId, detail) {
  const zone = document.getElementById('rebase-zone');
  if (!zone) return;
  const modelId = detail ? null : null;
  const mid = el('w-model')?.value;
  if (!mid) return;
  const { body: man } = await api(`/manuals?modelId=${mid}`);
  const newer = (man.manuals || []).filter((m) => m.revision > (detail?.pinnedManual?.revision ?? 0));
  if (!newer.length || !detail) { zone.innerHTML = ''; return; }
  zone.innerHTML = '<div class="warnbox">云端已有更新的审核版本：' +
    newer.map((m) => `<button data-target="${m.id}">预览迁移到 REV ${m.revision}</button>`).join(' ') +
    '（不会自动改动已勾选内容）</div><div id="rebase-detail"></div>';
  zone.querySelectorAll('[data-target]').forEach((b) => b.onclick = async () => {
    const { body } = await api(`/manuals/${b.dataset.target}/rebase-preview`, {
      method: 'POST', body: { workOrderId: woId },
    });
    const box = document.getElementById('rebase-detail');
    box.innerHTML = `<div class="kvs">${esc(body.notice)}</div>` + body.items.map((i) => `
      <div class="item">
        ${esc(i.title || i.step_key)}
        <span class="badge ${i.verdict === 'unchanged' ? 'inherit' : 'changed'}">${esc(i.verdict)}</span>
        <div class="kvs">${esc(i.rationale)}</div>
        <div data-decide="${esc(i.step_key)}">${decideControl(i)}</div>
      </div>`).join('') +
      '<button id="apply-rebase">提交逐项决定</button>';
    document.getElementById('apply-rebase').onclick = async () => {
      const decisions = {};
      box.querySelectorAll('[data-decide]').forEach((d) => {
        const sel = d.querySelector('select');
        if (sel) decisions[d.dataset.decide] = sel.value;
      });
      const r = await api(`/work-orders/${woId}/rebase-decisions`, {
        method: 'POST', body: { targetManualId: b.dataset.target, decisions },
      });
      box.innerHTML = r.status === 200
        ? `<div class="okbox">${esc(r.body.notice)}</div>`
        : `<div class="badbox">${esc(r.body.error)}<br>${(r.body.details || []).map(esc).join('<br>')}</div>`;
      if (r.status === 200) setTimeout(() => openWorkOrder(woId), 800);
    };
  });
}
function decideControl(i) {
  if (['unchanged', 'added', 'not_done'].includes(i.verdict)) return '<span class="kvs">系统建议：' + esc(i.rationale) + '</span>';
  if (i.verdict === 'removed') return '<select><option value="skip">归档保留(skip)</option></select>';
  if (i.requiredDecision === 'redo_required') return '<select><option value="">请选择</option><option value="redo">重做(redo)</option></select>';
  return '<select><option value="">逐项决定…</option><option value="inherit">确认继承</option><option value="redo">重做</option><option value="skip">跳过</option></select>';
}

async function syncLocal(woId) {
  const events = (await idbAll('events')).filter((e) => e.workOrderId === woId);
  const evidence = (await idbAll('evidence')).filter((e) => e.workOrderId === woId);
  const r = await api(`/work-orders/${woId}/sync`, {
    method: 'POST',
    body: {
      events: events.map((e) => ({
        stepKey: e.stepKey, action: e.action, contentHash: e.contentHash,
        clientEventId: e.localKey, baseEventId: e.baseEventId, createdAt: e.createdAt,
      })),
      evidence: evidence.map((e) => ({
        stepKey: e.stepKey, filename: e.filename, mime: e.mime, sizeBytes: e.sizeBytes,
        clientEvidenceId: e.clientEvidenceId, capturedAt: e.capturedAt,
      })),
    },
  });
  const msg = el('wo-msg');
  if (r.status === 200) {
    for (const e of events) await idbDel('events', e.localKey);
    for (const e of evidence) await idbDel('evidence', e.localKey);
    msg.innerHTML = '<div class="okbox">同步完成，本机队列已清空。</div>';
  } else {
    // 仅清理已接受/去重项；未同步载荷继续留在本机
    const done = new Set([...(r.body.accepted || []), ...(r.body.deduped || [])]);
    for (const e of events) if (done.has(e.localKey)) await idbDel('events', e.localKey);
    for (const e of evidence) if (done.has(e.clientEvidenceId)) await idbDel('evidence', e.localKey);
    msg.innerHTML = `<div class="badbox">${r.body.conflicts?.length || 0} 项冲突已登记；` +
      `${r.body.unsynced?.length || 0} 项未同步，原始数据保留在本机待裁决/重试。</div>`;
  }
  await openWorkOrder(woId);
}

async function printSheet(woId) {
  const { body } = await api(`/work-orders/${woId}/print`);
  const w = window.open('', '_blank');
  w.document.write(`<!doctype html><meta charset="utf-8"><title>维护单 ${esc(body.workOrder.code)}</title>
    <pre style="font:13px/1.6 system-ui;white-space:pre-wrap">${esc(body.text)}</pre>`);
  w.document.close();
  setTimeout(() => w.print(), 300);
}

// ---------- 视图：业务服务（服务程序适用范围） ----------
async function viewPrograms() {
  app.innerHTML = el('tpl-programs').innerHTML;
  await loadModels();
  fillModelSelect(el('sp-model'));
  el('sp-go').onclick = async () => {
    const qs = new URLSearchParams({ modelId: el('sp-model').value });
    if (el('sp-serial').value.trim()) qs.set('serialNo', el('sp-serial').value.trim());
    const { body } = await api(`/programs/for-model?${qs}`);
    el('sp-out').innerHTML = '<table><tr><th>服务程序</th><th>质保</th><th>是否适用</th><th>不适用原因</th></tr>' +
      (body.programs || []).map((p) => `<tr>
        <td>${esc(p.name)}</td>
        <td>${esc(p.warranty_months ?? '-')} 月</td>
        <td>${p.appliesTo ? '<span class="okbox" style="display:inline-block">适用</span>' : '<span class="badge">不适用</span>'}</td>
        <td>${p.appliesTo ? '—' : esc((p.reasons || []).join('、'))}</td>
      </tr>`).join('') + '</table>';
  };
  el('sp-add').onclick = async () => {
    const months = Number(el('sp-months').value);
    const r = await api('/programs', {
      method: 'POST',
      body: {
        name: el('sp-name').value.trim(),
        appliesModels: [el('sp-model').value],
        appliesSerials: {
          from: el('sp-serfrom').value.trim() || '',
          to: el('sp-serto').value.trim() || '',
        },
        warrantyMonths: Number.isFinite(months) ? months : null,
      },
    });
    el('sp-addout').innerHTML = r.status === 201
      ? '<div class="okbox">服务程序已登记。</div>'
      : `<div class="badbox">${esc(r.body.error)}</div>`;
  };
}

// ---------- 视图：打包与撤回 ----------
async function viewPackages() {
  app.innerHTML = el('tpl-packages').innerHTML;
  await loadModels();
  fillModelSelect(el('pk-model'));
  const refresh = async () => {
    const mid = el('pk-model').value;
    const { body } = await api(`/manuals?modelId=${mid}`);
    el('pk-manual').innerHTML = (body.manuals || [])
      .map((m) => `<option value="${m.id}">${esc(m.code)} REV ${m.revision}</option>`).join('');
    const list = await api(`/packages?modelId=${mid}`);
    el('pk-list').innerHTML = `<table><tr><th>类型</th><th>版本</th><th>步骤数</th><th>状态</th><th>操作</th></tr>` +
      (list.body.packages || []).map((p) => `<tr>
        <td>${p.kind === 'full_model' ? '整机型包' : '任务依赖包'}</td>
        <td>REV ${p.manual_revision}</td><td>${p.included_keys.length}</td>
        <td>${p.status === 'active' ? '可用' : '<span class="sev-warning">已撤回</span>'}</td>
        <td>${p.status === 'active' ? `<button data-wd="${p.id}">撤回</button>` : `<span class="kvs">${esc(p.withdrawn_reason)}</span>`}</td>
      </tr>`).join('') + '</table>';
    el('pk-list').querySelectorAll('[data-wd]').forEach((b) => b.onclick = async () => {
      const reason = prompt('撤回原因（将提示受影响工单并保留其未同步证据）');
      if (reason === null) return;
      const { body } = await api(`/packages/${b.dataset.wd}/withdraw`, { method: 'POST', body: { reason } });
      let html = body.warnings.map((w) => `• ${esc(w)}`).join('<br>');
      html += '<h4>受影响工单（证据保留）</h4>' + (body.affectedWorkOrders || []).map((w) =>
        `<div class="item">${esc(w.code)} · ${esc(w.pinnedManual)} · 证据 ${w.evidenceCount} 份
        <div class="kvs">${esc(w.note)}</div></div>`).join('');
      el('pk-out').innerHTML = `<div class="warnbox">${html}</div>`;
      refresh();
    });
  };
  el('pk-model').onchange = refresh;
  await refresh();

  el('pk-full').onclick = async () => {
    const { body } = await api('/packages', { method: 'POST', body: { kind: 'full_model', manualId: el('pk-manual').value } });
    downloadJson(`package-full-rev${body.package.manual_revision}.json`, body);
    el('pk-out').innerHTML = `<div class="okbox">整机型包已生成（${body.package.included_keys.length} 个步骤，manifest ${esc(body.manifest_hash).slice(0, 12)}…）。</div>`;
    refresh();
  };
  el('pk-task').onclick = async () => {
    const roots = el('pk-roots').value.split(',').map((s) => s.trim()).filter(Boolean);
    const { status, body } = await api('/packages', {
      method: 'POST', body: { kind: 'task_deps', manualId: el('pk-manual').value, rootTaskKeys: roots },
    });
    if (status !== 201) { el('pk-out').innerHTML = `<div class="badbox">${esc(body.error)}</div>`; return; }
    downloadJson(`package-task-${roots.join('_')}-rev${body.package.manual_revision}.json`, body);
    el('pk-out').innerHTML = `<div class="okbox">任务依赖包只含显式依赖闭包（${body.package.included_keys.length} 个步骤）：${body.package.included_keys.map(esc).join('、')}</div>`;
    refresh();
  };
  el('pk-cmp').onclick = async () => {
    const roots = el('pk-roots').value.split(',').map((s) => s.trim()).filter(Boolean);
    const { body } = await api('/packages/compare', { method: 'POST', body: { manualId: el('pk-manual').value, rootTaskKeys: roots } });
    el('pk-out').innerHTML = `<div class="item">整机型包 ${body.full_model.size} 步 ↔ 任务包 ${body.task_deps.size} 步；
      任务包省略：${(body.omitted_by_task_package || []).map(esc).join('、')}；严格子集=${body.subset}；同版本=${body.same_manual_revision}</div>`;
  };
}
function downloadJson(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 视图：审核资料 ----------
async function viewReview() {
  app.innerHTML = el('tpl-review').innerHTML;
  const [modelsR, mans, faults, parts] = await Promise.all([
    api('/models'), api('/manuals'), api('/faults?q='), api('/parts'),
  ]);
  const ms = new Map(modelsR.body.models.map((m) => [m.id, m.name]));
  el('rv-out').textContent = JSON.stringify({
    现场可见手册: mans.body.manuals.map((m) => `${ms.get(m.modelId)} / ${m.code} REV${m.revision} [${m.status}]`),
    备件清单: parts.body.parts.map((p) => p.part_no),
    说明: '草稿手册/草稿故障码不在任何现场接口返回；检索未知名码返回“无记录+消歧”，不编造操作。',
  }, null, 2);
}

// ---------- 路由 ----------
async function route() {
  const hash = location.hash || '#/faults';
  setNet();
  if (hash.startsWith('#/parts')) return viewParts();
  if (hash.startsWith('#/field')) return viewField();
  if (hash.startsWith('#/programs')) return viewPrograms();
  if (hash.startsWith('#/packages')) return viewPackages();
  if (hash.startsWith('#/review')) return viewReview();
  return viewFaults();
}
addEventListener('hashchange', route);
setNet();
route();
