const API = '/api';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const today = new Date().toISOString().slice(0, 10);

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: res.status, ok: res.ok, body };
}
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.className = '', 4500);
}
const alertBox = (cls, msg) => `<div class="alert ${cls}">${esc(msg)}</div>`;

let MODELS = [], PARTS = [], WORK_ORDERS = [];

// ---------------- Tabs ----------------
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
  if (b.dataset.tab === 'workorders') loadWorkOrders();
  if (b.dataset.tab === 'audit') loadAudit();
}));

function modelOptions(sel, { allowEmpty = false } = {}) {
  sel.innerHTML = (allowEmpty ? '<option value="">（未选择）</option>' : '') +
    MODELS.map((m) => `<option value="${esc(m.code)}">${esc(m.code)} · ${esc(m.name)}</option>`).join('');
}
function partOptions(sel) {
  sel.innerHTML = PARTS.map((p) => `<option value="${esc(p.sku)}">${esc(p.sku)} · ${esc(p.name)}</option>`).join('');
}

// ---------------- 初始化公共数据 ----------------
async function init() {
  $('#cp-date').value = today;
  $('#cv-date').value = today;
  $('#sb-validfrom').value = today;
  const [m, p] = await Promise.all([api('/models'), api('/parts')]);
  MODELS = m.body;
  PARTS = p.body;
  for (const id of ['lk-model', 'nv-model', 'cv-model', 'pk-model']) modelOptions($('#' + id), { allowEmpty: id === 'lk-model' });
  for (const id of ['cp-model', 'sb-model']) {
    $('#' + id).innerHTML = '<option value="">不限</option>' + MODELS.map((x) => `<option value="${esc(x.code)}">${esc(x.code)}</option>`).join('');
  }
  partOptions($('#cp-source')); partOptions($('#cp-target'));
  partOptions($('#sb-sku')); partOptions($('#sb-replaces'));
  $('#cp-target').value = 'FAN-01';
  renderModels();
  await lookupFault(true);
  bindEvents();
}

// ---------------- 故障码检索 ----------------
async function lookupFault(silent) {
  const code = $('#lk-code').value.trim();
  const model = $('#lk-model').value;
  if (!code) return;
  const r = await api(`/fault-codes/lookup?code=${encodeURIComponent(code)}&model=${encodeURIComponent(model)}`);
  const d = r.body;
  const box = $('#lk-result');
  if (!model) {
    box.innerHTML = alertBox('warn', d.message) +
      `<table><thead><tr><th>机型</th><th>故障码</th><th>含义</th><th>等级</th><th>审核处置依据</th></tr></thead><tbody>` +
      d.matches.map((x) => `<tr><td>${esc(x.model_code)}</td><td>${esc(x.code)}</td><td>${esc(x.meaning)}</td>
        <td><span class="badge ${esc(x.severity)}">${esc(x.severity)}</span></td><td>${esc(x.advised_action)}</td></tr>`).join('') +
      `</tbody></table>`;
  } else if (d.resolved) {
    box.innerHTML = d.matches.map((x) =>
      `<div class="alert ok"><b>${esc(x.code)} @ ${esc(x.model_code)}</b>：${esc(x.meaning)}
       <span class="badge ${esc(x.severity)}">${esc(x.severity)}</span></div>
       <div class="kv">
         <dt>审核处置依据</dt><dd>${esc(x.advised_action)}</dd>
         <dt>依据步骤</dt><dd>${(x.ref_step_nos ?? []).map(esc).join('、') || '—'}</dd>
         ${d.crossModelCount ? `<dt>跨机型提醒</dt><dd class="muted">该故障码在 ${d.crossModelCount} 个其它机型下另有含义，不得跨机型套用。</dd>` : ''}
       </div>`).join('');
  } else {
    box.innerHTML = alertBox('err', d.message) +
      (d.crossModel?.length ? `<p class="muted">该故障码在以下机型存在，但含义仅属于那些机型，不能作为本机结论：</p>
       <table><tbody>${d.crossModel.map((x) => `<tr><td>${esc(x.model_code)}</td><td>${esc(x.meaning)}</td></tr>`).join('')}</tbody></table>` : '');
  }
  if (!silent) toast(model && d.resolved ? '已按机型作用域解析' : '请确认机型作用域', !d.resolved && !!model);
  $('#lk-faultlist').innerHTML = model
    ? d.resolved ? `<span class="chip">${esc(d.matches[0].code)} · ${esc(d.matches[0].meaning.slice(0, 18))}…</span>`
      : '<span class="muted">本机型审核库中无该故障码，请勿跨机型套用</span>'
    : '<span class="muted">请先选择机型后再检索故障码</span>';
}

// ---------------- 机型 / 手册 ----------------
function renderModels() {
  $('#models-list').innerHTML = MODELS.map((m) => `
    <div class="step-item">
      <div class="step-head"><b>${esc(m.code)}</b> · ${esc(m.name)}
        <span class="muted">发布 ${String(m.released_at).slice(0, 10)}</span></div>
      <div class="muted">机型修订：${(m.revisions ?? []).map((r) => `${esc(r.revision)}（${String(r.released_at).slice(0, 10)} ${esc(r.notes ?? '')}）`).join('；')}</div>
      <div id="manuals-${esc(m.code)}" class="muted">手册版本加载中…</div>
    </div>`).join('');
  MODELS.forEach(async (m) => {
    const r = await api(`/manuals?model=${encodeURIComponent(m.code)}`);
    const el = $(`#manuals-${CSS.escape(m.code)}`);
    if (!el) return;
    if (!r.body.length) { el.textContent = '尚无已审核手册版本。'; return; }
    el.innerHTML = r.body.map((v) =>
      `<div>📘 <b>${esc(v.version)}</b> <span class="badge ${v.status === 'approved' ? 'ok' : 'withdrawn'}">${esc(v.status)}</span>
       <span class="muted">指纹 ${esc(v.content_hash)}</span>
       <button class="smallbtn" data-manual="${v.id}">查看步骤</button></div>`).join('');
    el.querySelectorAll('[data-manual]').forEach((b) => b.addEventListener('click', () => viewManual(b.dataset.manual)));
  });
}

async function viewManual(id) {
  const r = await api(`/manuals/${id}`);
  const { manual, steps } = r.body;
  toast(`${manual.model_code} ${manual.version}（${manual.status}）`);
  const w = window.open('', '_blank');
  w.document.write(`<!doctype html><meta charset="utf-8"><title>${esc(manual.model_code)} ${esc(manual.version)}</title>
  <body style="font-family:sans-serif;max-width:820px;margin:24px auto;padding:0 16px">
  <h2>服务手册 ${esc(manual.model_code)} · ${esc(manual.version)}</h2>
  <p class="muted">状态 ${esc(manual.status)} ｜ 内容指纹 ${esc(manual.content_hash)}</p>
  <ol>${steps.map((s) => `<li${s.is_key_step ? ' style="font-weight:600"' : ''}>${esc(s.title)}
    <div style="font-weight:400;color:#333">${esc(s.instruction)}</div>
    ${s.required_parts?.length ? `<div style="font-weight:400;color:#666;font-size:13px">所需备件：${s.required_parts.map(esc).join('、')}</div>` : ''}
    ${s.is_key_step ? '<div style="color:#b45309;font-size:12px">关键步骤</div>' : ''}</li>`).join('')}</ol>
  <p class="muted">本页面仅呈现该已审核版本内容，系统不生成任何未审核维修操作。</p></body>`);
}

// 新手册版本编辑
function stepRow(s = { step_no: '', title: '', instruction: '', is_key_step: false, required_parts: '' }) {
  return `<div class="step-item" data-step>
    <div class="row">
      <label>步骤号 <input data-f="step_no" value="${esc(s.step_no)}" style="min-width:80px" /></label>
      <label>标题 <input data-f="title" value="${esc(s.title)}" /></label>
      <label class="muted"><input type="checkbox" data-f="is_key_step" ${s.is_key_step ? 'checked' : ''} style="min-width:auto" /> 关键步骤</label>
      <button class="danger smallbtn" data-rm>删除</button>
    </div>
    <label>操作说明（仅可填写已审核资料原文）<textarea data-f="instruction" rows="2" style="width:100%;background:#1f2937;color:#e7edf5;border:1px solid #2b3648;border-radius:7px;padding:8px">${esc(s.instruction)}</textarea></label>
    <label>所需备件（逗号分隔） <input data-f="required_parts" value="${esc(Array.isArray(s.required_parts) ? s.required_parts.join(',') : s.required_parts)}" /></label>
  </div>`;
}
function collectSteps() {
  return $$('#nv-steps [data-step]').map((el) => {
    const get = (f) => el.querySelector(`[data-f="${f}"]`);
    return {
      step_no: get('step_no').value.trim(),
      title: get('title').value.trim(),
      instruction: get('instruction').value.trim(),
      is_key_step: get('is_key_step').checked,
      required_parts: get('required_parts').value.split(',').map((x) => x.trim()).filter(Boolean),
    };
  }).filter((s) => s.step_no && s.title && s.instruction);
}

// ---------------- 备件 ----------------
async function checkCompatibility() {
  const qs = new URLSearchParams({
    source: $('#cp-source').value, target: $('#cp-target').value,
    model: $('#cp-model').value, serial: $('#cp-serial').value, date: $('#cp-date').value,
  });
  const r = await api('/substitutions/check?' + qs);
  const d = r.body;
  const box = $('#cp-result');
  if (d.compatible) {
    box.innerHTML = alertBox('ok', `${d.source} 可替代 ${d.target}：${esc(d.note)}`) +
      d.paths.map((p) => `<div class="kv">
        <dt>路径（${p.hops.length} 跳）</dt><dd>${p.hops.map((h) => `${esc(h.sku)} —${esc(h.direction)}→ ${esc(h.replaces_sku)}`).join(' ；')}</dd>
        <dt>交集生效范围</dt><dd>机型 ${esc(p.effectiveScope.model_code ?? '不限')}，序列号 ${p.effectiveScope.serial_from ?? '−'}~${p.effectiveScope.serial_to ?? '−'}，${esc(p.effectiveScope.valid_from ?? '−')} 至 ${esc(p.effectiveScope.valid_to ?? '−')}</dd>
      </div>`).join('');
  } else {
    box.innerHTML = alertBox('err', `${d.source} 不能替代 ${d.target}：${esc(d.note)}`) +
      (d.paths?.length ? `<p class="muted">存在越范围路径：${JSON.stringify(d.paths.map((p) => p.hops))}，其交集不覆盖现场上下文，系统未据此推断兼容。</p>` : '');
  }
}
async function loadSubstitutions() {
  const r = await api('/substitutions');
  $('#sb-table tbody').innerHTML = r.body.map((e) => `<tr>
    <td>${esc(e.sku)}</td><td>${esc(e.direction)}</td><td>${esc(e.replaces_sku)}</td>
    <td>${esc(e.model_code ?? '不限')}</td><td>${e.serial_from ?? '−'}~${e.serial_to ?? '−'}</td>
    <td>${String(e.valid_from).slice(0, 10)}</td><td>${esc(e.note ?? '')}</td></tr>`).join('');
}
async function addSubstitution() {
  const body = {
    sku: $('#sb-sku').value, replaces_sku: $('#sb-replaces').value, direction: $('#sb-dir').value,
    model_code: $('#sb-model').value || null,
    serial_from: $('#sb-from').value ? Number($('#sb-from').value) : null,
    serial_to: $('#sb-to').value ? Number($('#sb-to').value) : null,
    valid_from: $('#sb-validfrom').value || null,
  };
  const r = await api('/substitutions', { method: 'POST', body });
  if (!r.ok) { toast(r.body.message || '登记被拒绝', true); }
  else { toast('替代关系已登记（有向、限范围、无环校验通过）'); loadSubstitutions(); }
}

// ---------------- 适用范围 ----------------
async function checkCoverage() {
  const qs = new URLSearchParams({ model: $('#cv-model').value, serial: $('#cv-serial').value, date: $('#cv-date').value });
  const r = await api('/coverages?' + qs);
  const d = r.body;
  $('#cv-result').innerHTML = d.applicable.length
    ? `<div class="alert ok">该设备在 ${esc(d.queried.date)} 适用以下 ${d.applicable.length} 项服务：</div>` +
      `<table><thead><tr><th>服务</th><th>序列号区间</th><th>有效期</th><th>条款</th></tr></thead><tbody>` +
      d.applicable.map((c) => `<tr><td>${esc(c.program)}</td><td>${c.serial_from ?? '−'}~${c.serial_to ?? '−'}</td>
        <td>${String(c.valid_from).slice(0, 10)} ~ ${String(c.valid_to).slice(0, 10)}</td><td>${esc(c.terms)}</td></tr>`).join('') +
      `</tbody></table>`
    : alertBox('warn', '当前机型/序列号/日期下没有适用的服务项目。');
}

// ---------------- 工单 ----------------
async function loadWorkOrders(pickId) {
  const r = await api('/work-orders');
  WORK_ORDERS = r.body;
  $('#pk-wo').innerHTML = WORK_ORDERS.map((w) => `<option value="${w.id}">${esc(w.wo_no)} · ${esc(w.model_code)}</option>`).join('');
  $('#wo-select').innerHTML = WORK_ORDERS.map((w) =>
    `<option value="${w.id}" ${String(pickId) === String(w.id) ? 'selected' : ''}>${esc(w.wo_no)} · ${esc(w.model_code)} · ${esc(w.status)}</option>`).join('');
  if (WORK_ORDERS.length) renderWorkOrder(pickId ?? WORK_ORDERS[0].id);
}

function reevalBlock(re) {
  if (!re) return '<div class="muted">已绑定快照为当前最新版，无需继承判定。</div>';
  const rows = re.decisions.map((d) => `<tr>
    <td>${esc(d.step_no)}</td><td>${esc(d.title)}</td><td>${esc(d.suggested)}</td>
    <td>${d.needs_decision ? '<b style="color:#f59e0b">需人工逐项裁决</b>' : '—'}</td><td class="muted">${esc(d.message)}</td></tr>`).join('');
  return `<div class="reeval">
    <h3>逐项继承判定（对照 ${esc(re.against_version ?? re.to_version)}）${re.pendingDecisions ? ` · 待裁决 ${re.pendingDecisions} 项` : ''}</h3>
    ${re.warning ? alertBox('warn', re.warning) : ''}
    <table><thead><tr><th>步骤</th><th>名称</th><th>系统建议</th><th>裁决</th><th>依据</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

async function renderWorkOrder(id) {
  const r = await api(`/work-orders/${id}`);
  if (!r.ok) { $('#wo-detail').innerHTML = alertBox('err', r.body.message ?? '加载失败'); return; }
  const d = r.body;
  const w = d.work_order;
  const manuals = await api(`/manuals?model=${encodeURIComponent(w.model_code)}`);
  const bindOptions = manuals.body.map((v) => `<option value="${v.id}" ${v.id === w.bound_manual_id ? 'selected' : ''}>${esc(v.version)}（${esc(v.status)}）</option>`).join('');

  const itemsHtml = d.items.map((it) => {
    const evs = d.evidence.filter((e) => e.item_id === it.id);
    return `<div class="step-item">
      <div class="step-head">
        <span class="step-no">${esc(it.step_no)}</span> ${esc(it.title)}
        ${it.is_key_step ? '<span class="badge warning">关键</span>' : ''}
        <span class="badge ${esc(it.state)}">${esc(it.state)}</span>
        ${it.decision_status ? `<span class="muted">裁决：${esc(it.decision_status)}</span>` : ''}
        <span style="flex:1"></span>
        <button class="smallbtn good" data-complete="${it.id}">勾选完成</button>
        <button class="smallbtn" data-inherit="${it.id}">裁决：继承</button>
        <button class="smallbtn danger" data-redo="${it.id}">裁决：重作</button>
      </div>
      <div class="muted">清单指纹 ${esc(it.step_hash)}${it.target_step_hash && it.target_step_hash !== it.step_hash ? ` ｜ 目标版指纹 ${esc(it.target_step_hash)}` : ''}${it.completed_step_hash ? ` ｜ 完成指纹 ${esc(it.completed_step_hash)}` : ''}</div>
      <div class="ev-list">
        ${evs.map((e) => `<div class="ev-row">📎 ${esc(e.filename)}
          <span class="badge ${esc(e.status)}">${esc(e.status)}</span>
          <span class="muted">采集 ${String(e.captured_at).slice(0, 16)} ｜ 上传 ${String(e.uploaded_at).slice(0, 16)}</span>
          ${e.withdraw_note ? `<span class="muted">撤回原因：${esc(e.withdraw_note)}</span>` : ''}
          ${e.status === 'active' ? `<button class="smallbtn danger" data-withdraw-preview="${e.id}">撤回…</button>` : ''}
        </div>`).join('')}
      </div>
      <div class="row" style="margin-top:6px">
        <input placeholder="照片文件名.jpg" data-ev-name="${it.id}" />
        <input type="datetime-local" data-ev-time="${it.id}" />
        <button class="smallbtn" data-ev-upload="${it.id}">上传/补交照片（支持晚传）</button>
      </div>
    </div>`;
  }).join('');

  const conflicts = await api(`/work-orders/${id}/conflicts`);
  const conflictHtml = conflicts.body.length ? `<h3>同步冲突（离线证据已隔离保留）</h3>` +
    conflicts.body.map((c) => `<div class="step-item">
      <div>冲突 #${c.id} · <span class="badge ${c.status === 'open' ? 'needs_redo' : 'inherited_confirmed'}">${esc(c.status)}</span>
        <span class="muted">基线 r${c.base_revision} ｜ 云端 r${c.cloud_revision} ｜ 离线 r${c.offline_revision}</span></div>
      ${c.status === 'open' ? `<div class="row" style="margin-top:8px">
        <button class="smallbtn good" data-resolve="${c.id}" data-way="keep_offline">采用离线（隔离证据恢复 active）</button>
        <button class="smallbtn" data-resolve="${c.id}" data-way="keep_cloud">以云端为准（离线证据 withdrawn 保留）</button>
      </div>` : `<div class="muted">解决：${esc(c.status)}${c.resolution_note ? ' · ' + esc(c.resolution_note) : ''}；证据未删除。</div>`}
    </div>`).join('') : '';

  $('#wo-detail').innerHTML = `
    <div class="kv" style="margin-bottom:10px">
      <dt>工单</dt><dd><b>${esc(w.wo_no)}</b> · ${esc(w.model_code)} / 序列号 ${w.serial_no} · 故障码 ${esc(w.fault_code ?? '—')}</dd>
      <dt>状态</dt><dd><span class="badge ${w.status === 'completed' ? 'done' : 'warning'}">${esc(w.status)}</span> · 离线 ${w.offline ? '是' : '否'} · 修订 r${w.revision}（离线基线 r${w.base_revision}）</dd>
      <dt>绑定快照</dt><dd>${w.bound_version ? `${esc(w.bound_version)} · 指纹 ${esc(w.bound_content_hash)} · ${String(w.bound_at).slice(0, 16)}` : '未绑定'}</dd>
      <dt>最新审核版</dt><dd>${d.latest_manual ? esc(d.latest_manual.version) : '—'} ${d.latest_manual && d.latest_manual.content_hash !== w.bound_content_hash ? '<span class="badge needs_redo">快照已落后</span>' : '<span class="badge done">一致</span>'}</dd>
    </div>
    <div class="row">
      <label>绑定/迁移手册快照 <select id="wo-bind-manual">${bindOptions}</select></label>
      <button class="smallbtn" id="wo-bind">绑定快照</button>
      <button class="smallbtn" id="wo-migrate">显式迁移（保留已做记录）</button>
      <button class="smallbtn good" id="wo-complete">尝试完成工单</button>
      <button class="smallbtn primary" id="wo-print">打印维护单（钉实际使用版）</button>
    </div>
    ${reevalBlock(d.reevaluation)}
    <h3>逐项现场记录</h3>${itemsHtml}
    ${conflictHtml}
    <h3>同步</h3>
    <div class="row">
      <input id="sync-base" type="number" value="${w.revision}" style="min-width:90px" title="离线基线修订号" />
      <span class="muted">↑ 离线端基线（改成旧号可模拟云端/离线分叉）</span>
      <button id="sync-upload">上传离线勾选（含照片）</button>
    </div>
    <h3>打印记录（可追溯到实际说明版）</h3>
    <div id="wo-prints" class="muted">加载中…</div>`;

  // 事件绑定
  $('#wo-bind').onclick = () => bindManual(id, $('#wo-bind-manual').value, false);
  $('#wo-migrate').onclick = () => bindManual(id, $('#wo-bind-manual').value, true);
  $('#wo-complete').onclick = async () => {
    const x = await api(`/work-orders/${id}/complete`, { method: 'POST' });
    if (x.ok) toast('工单已完成并钉到最新审核版指纹');
    else toast(x.body.message + (x.body.blockers ? '：' + x.body.blockers.map((b) => b.item).join(',') : ''), true);
    loadWorkOrders(id);
  };
  $('#wo-print').onclick = () => printSheet(id);
  $('#sync-upload').onclick = () => syncUpload(id);
  $$('#wo-detail [data-complete]').forEach((b) => b.onclick = async () => {
    await api(`/work-orders/${id}/items/${b.dataset.complete}/complete`, { method: 'POST' });
    renderWorkOrder(id);
  });
  const decide = (itemId, action) => async () => {
    const note = prompt(action === 'inherit' ? '确认继承的依据（逐项裁决不会自动完成）' : '重作原因');
    if (note === null) return;
    const x = await api(`/work-orders/${id}/items/${itemId}/decision`, { method: 'POST', body: { action, note, by: 'field-tech' } });
    if (!x.ok) toast(x.body.message, true); else toast(`已记录逐项裁决：${action}`);
    renderWorkOrder(id);
  };
  $$('#wo-detail [data-inherit]').forEach((b) => b.onclick = decide(b.dataset.inherit, 'inherit'));
  $$('#wo-detail [data-redo]').forEach((b) => b.onclick = decide(b.dataset.redo, 'redo'));
  $$('#wo-detail [data-ev-upload]').forEach((b) => b.onclick = async () => {
    const name = $(`[data-ev-name="${b.dataset.evUpload}"]`).value || 'field-photo.jpg';
    const tval = $(`[data-ev-time="${b.dataset.evUpload}"]`).value;
    const captured_at = tval ? new Date(tval).toISOString() : new Date().toISOString();
    const x = await api(`/work-orders/${id}/evidence`, { method: 'POST', body: {
      kind: 'photo', filename: name, mime: 'image/jpeg', bytes: 120000,
      item_id: Number(b.dataset.evUpload), captured_at,
    }});
    toast(x.body.late_upload ? '晚传照片已接收（保留原始采集时间并标记）' : '证据已上传');
    renderWorkOrder(id);
  });
  $$('#wo-detail [data-withdraw-preview]').forEach((b) => b.onclick = async () => {
    const prev = await api(`/evidence/${b.dataset.withdrawPreview}/withdraw-preview`, { method: 'POST' });
    if (!confirm(prev.body.warning + '\n\n关联步骤：' + prev.body.linked_items.map((i) => i.step_no + '(' + i.state + ')').join(',') + '\n\n确认撤回？（文件与审计记录保留）')) return;
    const note = prompt('撤回原因（留痕）', '现场撤回');
    if (!note) return;
    const x = await api(`/evidence/${b.dataset.withdrawPreview}/withdraw`, { method: 'POST', body: { note } });
    toast(x.body.message || '已撤回（证据保留）');
    renderWorkOrder(id);
  });
  $$('#wo-detail [data-resolve]').forEach((b) => b.onclick = async () => {
    const x = await api(`/sync-conflicts/${b.dataset.resolve}/resolve`, { method: 'POST',
      body: { resolution: b.dataset.way, by: 'supervisor' } });
    if (!x.ok) toast(x.body.message, true); else toast('冲突已人工解决，离线证据保留未删');
    renderWorkOrder(id);
  });
  loadPrints(id);
}

async function bindManual(id, manualId, migrate) {
  const x = await api(`/work-orders/${id}/bind-manual`, { method: 'POST', body: { manual_id: Number(manualId), migrate } });
  if (!x.ok) { toast(x.body.message, true); return; }
  toast(migrate ? `快照已迁移：${x.reevaluation?.pendingDecisions ?? 0} 项需逐项裁决（记录未重置）` : '已绑定手册快照');
  loadWorkOrders(id);
}

async function syncUpload(id) {
  const base = Number($('#sync-base').value);
  // 离线勾选：把当前各项状态整体带回（现场简化模型），并附带一张离线照片
  const r = await api(`/work-orders/${id}`);
  const items = r.body.items.map((i) => ({ step_no: i.step_no, state: i.state }));
  const x = await api(`/work-orders/${id}/sync`, { method: 'POST', body: {
    base_revision: base, items, evidences: [{ kind: 'photo', filename: `offline-${Date.now()}.jpg`, bytes: 88888, captured_at: new Date().toISOString() }],
  }});
  if (x.status === 409) { toast(x.body.message, true); }
  else toast('离线数据已应用，修订号推进');
  renderWorkOrder(id);
}

async function printSheet(id) {
  const x = await api(`/work-orders/${id}/print`, { method: 'POST' });
  if (!x.ok) { toast(x.body.message, true); return; }
  if (x.body.supersession_notice) toast(x.body.supersession_notice);
  const d = (await api(`/work-orders/${id}`)).body;
  const w = d.work_order;
  const win = window.open('', '_blank');
  win.document.write(`<!doctype html><meta charset="utf-8"><title>维护单 ${esc(w.wo_no)}</title>
  <body style="font-family:sans-serif;max-width:820px;margin:24px auto;padding:0 16px">
  <h2>设备维护作业单</h2>
  <table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">
    <tr><td>工单号</td><td><b>${esc(w.wo_no)}</b></td><td>机型/序列号</td><td>${esc(w.model_code)} / ${w.serial_no}</td></tr>
    <tr><td>故障码</td><td>${esc(w.fault_code ?? '—')}</td><td>打印时间</td><td>${new Date(x.body.print_record.printed_at).toLocaleString('zh-CN')}</td></tr>
    <tr><td>实际使用说明版</td><td><b>${esc(x.body.print_record.printed_version)}</b></td>
        <td>内容指纹</td><td><code>${esc(x.body.print_record.content_hash)}</code></td></tr>
  </table>
  ${x.body.supersession_notice ? `<p style="border:1px solid #b45309;background:#fff7ed;padding:8px"><b>版本提示：</b>${esc(x.body.supersession_notice)}</p>` : ''}
  <h3>执行步骤（${esc(w.bound_version)} 快照）</h3>
  <ol>${d.items.map((i) => `<li>${esc(i.step_no)} ${esc(i.title)} ${i.is_key_step ? '（关键步骤）' : ''} <span>[${esc(i.state)}]</span></li>`).join('')}</ol>
  <p class="muted">本单仅复述工单所绑定的已审核手册版本内容；系统未生成任何手册之外的维修操作。</p>
  </body>`);
  loadPrints(id);
}
async function loadPrints(id) {
  const r = await api(`/work-orders/${id}/prints`);
  const el = $('#wo-prints');
  if (!el) return;
  el.innerHTML = r.body.length ? `<table><tbody>${r.body.map((p) => `<tr>
    <td>${String(p.printed_at).slice(0, 16)}</td><td><b>${esc(p.printed_version)}</b></td>
    <td><code>${esc(p.content_hash)}</code></td>
    <td>${p.supersession_notice ? '<span class="badge needs_redo">已被取代仍可追溯</span>' : '<span class="badge done">当前版</span>'}</td></tr>`).join('')}</tbody></table>`
    : '尚无打印记录。';
}

// ---------------- 离线包 ----------------
async function packageFull() {
  const r = await api('/packages/full', { method: 'POST', body: { model_code: $('#pk-model').value } });
  $('#pk-result').textContent = JSON.stringify({ manifest: r.body.manifest, steps: r.body.payload?.steps?.length, faults: r.body.payload?.faults?.length }, null, 2);
  toast('整机型包已生成（含全部已审核步骤/故障码/引用备件）');
}
async function packageTask() {
  const id = $('#pk-wo').value;
  const r = await api(`/work-orders/${id}/packages/task`, { method: 'POST', body: {} });
  $('#pk-result').textContent = JSON.stringify(r.body.manifest, null, 2);
  toast('任务依赖包已生成（仅含该工单所绑快照中被引用的步骤/备件）');
}

// ---------------- 审计 ----------------
async function loadAudit() {
  const r = await api('/audit');
  $('#au-table tbody').innerHTML = r.body.map((l) => `<tr>
    <td class="muted">${String(l.created_at).slice(0, 16)}</td><td>${esc(l.actor)}</td>
    <td>${esc(l.action)}</td><td>${esc(l.entity)}#${esc(l.entity_id)}</td>
    <td class="muted"><code>${esc(JSON.stringify(l.detail))}</code></td></tr>`).join('');
}

// ---------------- 事件 ----------------
function bindEvents() {
  $('#lk-go').onclick = () => lookupFault(false);
  $('#lk-code').addEventListener('keydown', (e) => e.key === 'Enter' && lookupFault(false));
  $('#lk-model').onchange = () => lookupFault(true);

  $('#nv-addstep').onclick = () => $('#nv-steps').insertAdjacentHTML('beforeend', stepRow());
  $('#nv-steps').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) b.closest('[data-step]').remove(); });
  $('#nv-publish').onclick = async () => {
    const steps = collectSteps();
    if (!steps.length) return toast('请至少填写一个完整步骤', true);
    const r = await api('/manuals', { method: 'POST', body: {
      model_code: $('#nv-model').value, version: $('#nv-version').value.trim(), steps, reviewer: 'web-reviewer',
    }});
    if (!r.ok) return toast(r.body.message, true);
    toast('新版本已审核发布，旧版置为 superseded；相关工单需逐项继承判定');
    renderModels();
  };
  // 预填一版示例步骤
  $('#nv-steps').innerHTML = [
    { step_no: '010', title: '断电挂牌上锁', instruction: '关闭主电源并挂"禁止合闸"牌，验电后作业。', is_key_step: true, required_parts: '' },
    { step_no: '030', title: '更换散热风机', instruction: '【示例】请在此粘贴已审核通过的工艺原文。', is_key_step: true, required_parts: 'FAN-01' },
  ].map(stepRow).join('');

  $('#cp-check').onclick = checkCompatibility;
  $('#sb-add').onclick = addSubstitution;
  loadSubstitutions();

  $('#cv-go').onclick = checkCoverage;

  $('#wo-refresh').onclick = () => loadWorkOrders($('#wo-select').value);
  $('#wo-select').onchange = (e) => renderWorkOrder(e.target.value);

  $('#pk-full').onclick = packageFull;
  $('#pk-task').onclick = packageTask;
  $('#au-refresh').onclick = loadAudit;
}

init();
