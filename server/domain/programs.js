// 业务服务管理：服务程序的适用范围（机型白名单 + 序列号区间 + 质保月数）
import { newId } from '../util.js';

export function inSerialRange(serialNo, range) {
  if (!range || (!range.from && !range.to)) return true;
  if (!serialNo) return false;
  if (range.from && serialNo < range.from) return false;
  if (range.to && serialNo > range.to) return false;
  return true;
}

/** 判定服务程序是否适用于给定机型/序列号；不适用时给出原因，不做“近似适用” */
export async function checkApplicability(db, program, { modelId, serialNo = '' }) {
  if (!program.active) {
    return { appliesTo: false, reasons: ['服务程序已停用'] };
  }
  const reasons = [];
  if (program.applies_models.length && !program.applies_models.includes(modelId)) {
    reasons.push('机型不在适用范围');
  }
  if (!inSerialRange(serialNo, program.applies_serials || {})) {
    reasons.push('序列号不在适用区间');
  }
  return { appliesTo: reasons.length === 0, reasons };
}

export async function listProgramsForModel(db, { modelId, serialNo = '' }) {
  const out = [];
  for (const p of await db.find('service_programs')) {
    const r = await checkApplicability(db, p, { modelId, serialNo });
    out.push({
      id: p.id, name: p.name, warranty_months: p.warranty_months,
      coverage_note: p.coverage_note, appliesTo: r.appliesTo, reasons: r.reasons,
    });
  }
  return out;
}

export async function createProgram(db, input) {
  return db.insert('service_programs', {
    id: newId('prg'),
    name: input.name,
    applies_models: input.appliesModels ?? [],
    applies_serials: input.appliesSerials ?? {},
    warranty_months: input.warrantyMonths ?? null,
    coverage_note: input.coverageNote ?? '',
    active: input.active ?? true,
  });
}
