// 机型修订 / 步骤版本 / 快照 / 改版后已做工作继承判定
import { sha256, newId, HttpError } from '../util.js';

const HASH_SEP = '';

// content_hash 只覆盖“步骤正文”（标题/内容/安全标记）；前置依赖变化单独判定，
// 这样 dependency_changed（内容没变、依赖变了）才不会被内容变化掩盖。
export const stepHash = (step) =>
  sha256(
    [
      step.key_code,
      step.title?.trim(),
      step.content?.trim(),
      String(step.safety_critical ?? false),
    ].join(HASH_SEP),
  );

export const snapshotFingerprint = (steps) =>
  sha256(
    steps
      .slice()
      .sort((a, b) => a.step_no - b.step_no)
      .map((s) => `${s.step_no}:${s.key_code}:${s.content_hash}`)
      .join('\n'),
  );

/** 发布新手册修订（审核通过后对现场可见）；steps 为步骤定义数组 */
export async function createManualRevision(db, { modelId, code, title, steps, status = 'draft' }) {
  const model = await db.findOne('models', { id: modelId });
  if (!model) throw new HttpError(404, '机型不存在');

  const prior = (await db.find('manuals', { model_id: modelId, code })).sort(
    (a, b) => b.revision - a.revision,
  );
  const revision = prior.length ? prior[0].revision + 1 : 1;

  const manual = await db.insert('manuals', {
    id: newId('man'),
    model_id: modelId,
    code,
    revision,
    title,
    status,
    approved_at: status === 'approved' ? new Date().toISOString() : null,
    withdrawn_at: null,
    withdrawn_reason: null,
  });

  const seenKeys = new Set();
  for (const [i, s] of steps.entries()) {
    if (seenKeys.has(s.key_code)) {
      throw new HttpError(400, `步骤逻辑键重复：${s.key_code}`);
    }
    seenKeys.add(s.key_code);
    const row = {
      id: newId('step'),
      manual_id: manual.id,
      step_no: i + 1,
      key_code: s.key_code,
      title: s.title,
      content: s.content,
      depends_on_keys: s.depends_on_keys ?? [],
      safety_critical: Boolean(s.safety_critical),
    };
    row.content_hash = stepHash(row);
    await db.insert('steps', row);
  }
  return manual;
}

export async function getManual(db, manualId) {
  const manual = await db.findOne('manuals', { id: manualId });
  if (!manual) throw new HttpError(404, '手册不存在');
  const steps = (await db.find('steps', { manual_id: manualId })).sort(
    (a, b) => a.step_no - b.step_no,
  );
  return { ...manual, steps, snapshot_hash: snapshotFingerprint(steps) };
}


/**
 * 改版后逐项继承判定。
 * done: key_code -> { action, content_hash, note }（step_events 折叠出的最终状态）
 * verdict: unchanged / content_changed / dependency_changed / removed / added / not_done
 */
export function judgeRebase({ oldSteps, newSteps, done }) {
  const oldByKey = new Map(oldSteps.map((s) => [s.key_code, s]));
  const newByKey = new Map(newSteps.map((s) => [s.key_code, s]));
  const items = [];

  for (const ns of newSteps) {
    const os = oldByKey.get(ns.key_code);
    const state = done[ns.key_code];
    if (!os) {
      items.push({
        step_key: ns.key_code, step_no: ns.step_no, title: ns.title,
        verdict: 'added', inherited: false, safety_critical: ns.safety_critical,
        rationale: '新版新增步骤，默认未完成，须现场执行。',
        requiredDecision: 'execute',
      });
      continue;
    }
    if (!state || state.action !== 'check') {
      items.push({
        step_key: ns.key_code, step_no: ns.step_no, title: ns.title,
        verdict: 'not_done', inherited: false, safety_critical: ns.safety_critical,
        rationale: '旧版上该项尚未勾选完成，不存在继承问题，按新版执行。',
        requiredDecision: 'execute',
      });
      continue;
    }
    const depsChanged =
      JSON.stringify(os.depends_on_keys.slice().sort()) !==
      JSON.stringify(ns.depends_on_keys.slice().sort());
    if (os.content_hash === ns.content_hash && !depsChanged) {
      items.push({
        step_key: ns.key_code, step_no: ns.step_no, title: ns.title,
        verdict: 'unchanged', inherited: true, safety_critical: ns.safety_critical,
        old_content_hash: os.content_hash, new_content_hash: ns.content_hash,
        rationale: '步骤正文、安全标记与前置依赖均未变化，已做工作可继承。',
        requiredDecision: 'confirm_inherit',
      });
    } else if (os.content_hash !== ns.content_hash) {
      items.push({
        step_key: ns.key_code, step_no: ns.step_no, title: ns.title,
        verdict: 'content_changed', inherited: false, safety_critical: ns.safety_critical,
        old_content_hash: os.content_hash, new_content_hash: ns.content_hash,
        rationale: ns.safety_critical
          ? '关键步骤内容已更新，且为安全关键项：必须按新版重新执行，不允许继承。'
          : '步骤内容已更新：已做记录保留为历史，但需逐项确认/重做，不能静默当作完成。',
        requiredDecision: ns.safety_critical ? 'redo_required' : 'review_each',
      });
    } else {
      items.push({
        step_key: ns.key_code, step_no: ns.step_no, title: ns.title,
        verdict: 'dependency_changed', inherited: false, safety_critical: ns.safety_critical,
        rationale: '步骤内容未变，但前置依赖集合变化，需人工确认后再决定能否继承。',
        requiredDecision: 'manual_review',
      });
    }
  }

  for (const os of oldSteps) {
    if (!newByKey.has(os.key_code) && done[os.key_code]?.action === 'check') {
      items.push({
        step_key: os.key_code, step_no: null, title: os.title,
        verdict: 'removed', inherited: false, safety_critical: os.safety_critical,
        rationale: '该步骤在新版中被删除：历史勾选归档保留，不计入新版完成度。',
        requiredDecision: 'archive',
      });
    }
  }
  return items;
}

/** 用户对继承判定逐项给出的决定校验（显式、可审计，无批量捷径） */
export function validateRebaseDecisions(items, decisions) {
  const byKey = new Map(items.map((i) => [i.step_key, i]));
  const errors = [];
  const applied = [];
  for (const [key, choice] of Object.entries(decisions || {})) {
    const item = byKey.get(key);
    if (!item) { errors.push(`${key}: 不在新版清单中`); continue; }
    if (item.verdict === 'content_changed' && item.safety_critical && choice === 'inherit') {
      errors.push(`${key}: 安全关键步骤已更新，禁止继承，必须重做`);
      continue;
    }
    if (item.verdict === 'removed' && choice !== 'skip') {
      errors.push(`${key}: 已删除步骤只能归档(skip)`);
      continue;
    }
    if (!['inherit', 'redo', 'skip'].includes(choice)) {
      errors.push(`${key}: 决定必须是 inherit/redo/skip`);
      continue;
    }
    applied.push({ step_key: key, choice, verdict: item.verdict });
  }
  const needDecision = new Set(['content_changed', 'dependency_changed', 'removed']);
  const missing = items
    .filter((i) => needDecision.has(i.verdict))
    .filter((i) => !(i.step_key in (decisions || {})))
    .map((i) => i.step_key);
  if (missing.length) errors.push(`缺少逐项决定：${missing.join('、')}`);
  return { ok: errors.length === 0, errors, applied };
}
