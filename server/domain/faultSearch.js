// 故障码检索领域规则：
// 故障码的含义是 (故障码, 机型[，修订]) 作用域内的，字符串相同不等于含义相同。
// 检索必须带机型作用域；跨机型命中只能作为提示，绝不作为结论给出。
// 系统只返回已审核资料中的释义，不编造维修操作。

export function interpretFaultCode(rows, code, modelCode) {
  const norm = code.trim().toUpperCase();
  const hits = rows.filter((r) => r.code.toUpperCase() === norm);
  if (!modelCode) {
    // 未选机型：列出所有机型下的释义，要求用户先选机型，不做跨机型归并
    return {
      code: norm,
      resolved: false,
      reason: 'AMBIGUOUS_MODEL',
      message: '请先选择机型：同一故障码在不同机型下含义可能不同。',
      matches: hits,
    };
  }
  const inScope = hits.filter((r) => r.model_code === modelCode
    && (!r.model_revision || r.model_revision === '')); // 修订无关释义
  const inScopeRev = hits.filter((r) => r.model_code === modelCode && r.model_revision);
  const others = hits.filter((r) => r.model_code !== modelCode);

  if (inScope.length === 0 && inScopeRev.length === 0) {
    if (hits.length === 0) {
      return {
        code: norm, model: modelCode, resolved: false, reason: 'NOT_FOUND',
        message: `故障码 ${norm} 在机型 ${modelCode} 的审核资料中不存在。系统不提供推测性解释。`,
        crossModel: [],
      };
    }
    // 关键反错机型场景：字符串在别的机型存在，不能命中给结论
    return {
      code: norm, model: modelCode, resolved: false, reason: 'WRONG_MODEL',
      message: `故障码 ${norm} 不属于机型 ${modelCode}。它在其它机型上的含义不得套用到本机。`,
      crossModel: others, // 仅作"为何不能套用"的提示
    };
  }
  return {
    code: norm,
    model: modelCode,
    resolved: true,
    matches: [...inScope, ...inScopeRev],
    crossModelCount: others.length,
  };
}
