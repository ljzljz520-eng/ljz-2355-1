// 关键步骤更新后的"逐项继承判定"。
// 红线：不能静默重置（把已完成项抹掉），也不能全算完成（换版后自动继承）。
// 系统只给出建议与证据，每一项必须由维修人员显式裁决 inherit / redo。
//
// items: 已建的工单逐项记录（钉在旧步骤指纹上）
// newSteps: 目标手册版本的步骤
export function reevaluateWorkAfterRevision(items, newSteps) {
  const newByNo = new Map(newSteps.map((s) => [s.step_no, s]));
  const decisions = [];
  for (const item of items) {
    const next = newByNo.get(item.step_no);
    const wasDone = item.state === 'done' || item.state === 'inherited_confirmed';
    // 比较基准：实际完成时钉住的指纹优先；尚未完成的项退化为其清单项指纹
    const baselineHash = wasDone ? (item.completed_step_hash ?? item.step_hash) : item.step_hash;
    if (!next) {
      decisions.push({
        item_id: item.id, step_no: item.step_no, title: item.title,
        was_done: wasDone,
        suggested: 'removed',
        reason: 'NEW_VERSION_STEP_REMOVED',
        message: `步骤 ${item.step_no}「${item.title}」在新版本中已删除/合并，原有完成记录归档保留，不再计入新版本完成项。`,
        needs_decision: wasDone,
      });
      continue;
    }
    if (!wasDone) {
      decisions.push({
        item_id: item.id, step_no: item.step_no, title: item.title,
        was_done: false,
        suggested: 'pending_new',
        reason: 'NOT_DONE',
        message: `步骤 ${item.step_no} 此前未完成，按新版本内容执行即可，无需继承裁决。`,
        needs_decision: false,
      });
      continue;
    }
    if (next.step_hash === baselineHash) {
      decisions.push({
        item_id: item.id, step_no: item.step_no, title: item.title,
        was_done: true,
        suggested: 'inheritable',
        reason: 'UNCHANGED',
        message: `步骤 ${item.step_no} 内容指纹未变，可继承既有工作（仍需逐项确认）。`,
        needs_decision: true,
      });
    } else if (next.is_key_step) {
      decisions.push({
        item_id: item.id, step_no: item.step_no, title: item.title,
        was_done: true,
        suggested: 'needs_redo',
        reason: 'KEY_STEP_CHANGED',
        message: `关键步骤 ${item.step_no}「${item.title}」已更新（指纹 ${item.completed_step_hash} → ${next.step_hash}），既有工作不能默认继承，须重作或经工程师确认等效。`,
        needs_decision: true,
      });
    } else {
      decisions.push({
        item_id: item.id, step_no: item.step_no, title: item.title,
        was_done: true,
        suggested: 'review',
        reason: 'NONKEY_CHANGED',
        message: `非关键步骤 ${item.step_no} 内容有变更，需逐项复核后决定继承或重作。`,
        needs_decision: true,
      });
    }
  }
  // 新版本新增的步骤
  for (const s of newSteps) {
    if (!items.some((i) => i.step_no === s.step_no)) {
      decisions.push({
        item_id: null, step_no: s.step_no, title: s.title,
        was_done: false,
        suggested: 'added',
        reason: 'NEW_STEP',
        message: `新版本新增步骤 ${s.step_no}「${s.title}」，需纳入执行。`,
        needs_decision: false,
      });
    }
  }
  const pendingDecisions = decisions.filter((d) => d.needs_decision).length;
  return {
    decisions,
    pendingDecisions,
    canComplete: pendingDecisions === 0,
    warning: pendingDecisions > 0
      ? `有 ${pendingDecisions} 项已做工作需要逐项裁决（继承/重作），未裁决前工单不能完成。系统既不会静默重置，也不会全部算作完成。`
      : null,
  };
}

// 按任务依赖打包：从工单故障码相关步骤出发，闭包收集所需步骤与备件，
// 与"整机型包"形成对照。只携带已审核版本。
export function buildTaskManifest({ manual, steps, fault, requiredParts = [], workOrderNo }) {
  const stepNos = new Set(steps.map((s) => s.step_no));
  // 故障引用步骤可能来自更新的手册版本；任务包必须按工单实际绑定的快照裁剪，
  // 只包含该版本中真实存在的步骤，并对缺失步骤给出显式提示（不静默夹带其他版本内容）。
  const requested = fault?.ref_step_nos?.length ? fault.ref_step_nos
    : steps.filter((s) => s.is_key_step).map((s) => s.step_no);
  const picked = new Set();
  const missing = [];
  for (const no of requested) {
    if (stepNos.has(no)) picked.add(no);
    else missing.push(no);
  }
  const parts = new Set(requiredParts);
  for (const s of steps) if (picked.has(s.step_no)) for (const p of s.required_parts ?? []) parts.add(p);
  return {
    kind: 'task',
    work_order_no: workOrderNo,
    model_code: manual.model_code,
    manual_version: manual.version,
    content_hash: manual.content_hash,
    includes: {
      steps: [...picked].sort(),
      parts: [...parts].sort(),
      fault_code: fault?.code ?? null,
      missing_from_bound_version: missing,
    },
    note: missing.length
      ? `本包仅含该工单任务依赖的步骤/备件，非整机型完整手册；注意步骤 ${missing.join(',')} 在所绑定的 ${manual.version} 快照中不存在，未静默夹带其他版本内容。`
      : '本包仅含该工单任务依赖的步骤/备件，非整机型完整手册；离线作业前请确认覆盖范围。',
  };
}
