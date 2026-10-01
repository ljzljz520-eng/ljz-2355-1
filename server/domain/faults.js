// 故障码检索：码值不携带全局语义，(code, model) 才决定含义。
// 同一字符串码在不同机型下可以对应完全不同的维修含义，搜索绝不只按字符串命中。

export const normalizeCode = (raw) =>
  String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/**
 * 检索故障码
 * @param {object} deps
 * @param modelId  必须明确机型（核心防错维度）；为空时只允许做“跨机型同名码消歧提示”
 * @param q        码值（可带分隔符）或症状关键词
 * @param opts     { keywordFallback: boolean }
 */
export async function searchFaults(deps, { modelId = null, q = '' } = {}) {
  const { db } = deps;
  const term = String(q ?? '').trim();
  const code = normalizeCode(term);
  const models = new Map((await db.find('models')).map((m) => [m.id, m]));

  // 只有明确机型才能给出“含义/处置”命中，这是本系统与纯字符串搜索的根本区别
  if (modelId) {
    if (!models.has(modelId)) throw new Error('MODEL_NOT_FOUND');

    if (code) {
      const exact = (await db.find('fault_codes', { model_id: modelId }))
        .filter((f) => f.status === 'approved')
        .filter((f) => normalizeCode(f.code) === code);

      if (exact.length) {
        return {
          mode: 'model_scoped_exact',
          modelId,
          items: exact.map(withModelName(models)),
          warning: null,
        };
      }

      // 该码在“其他机型”存在但在当前机型不存在：显式提示，不返回别机型含义
      const otherModels = (await db.find('fault_codes'))
        .filter((f) => f.status === 'approved')
        .filter((f) => f.model_id !== modelId && normalizeCode(f.code) === code);

      const others = otherModels.map(withModelName(models));
      return {
        mode: 'code_unknown_for_model',
        modelId,
        items: [],
        warning:
          `码 ${term.toUpperCase()} 在当前机型 ${models.get(modelId).name} 下没有记录。` +
          (others.length
            ? ` 它在 ${others.map((o) => o.modelName).join('、')} 上存在，但含义不能套用。`
            : ''),
        otherModels: others.map((o) => ({
          modelId: o.model_id,
          modelName: o.modelName,
          code: o.code,
          note: '仅作消歧提示，非本机结论',
        })),
      };
    }

    // 无码时走症状关键词（仍严格限定机型）
    const kw = term.toLowerCase();
    const items = kw
      ? (await db.find('fault_codes', { model_id: modelId }))
          .filter((f) => f.status === 'approved')
          .filter(
            (f) =>
              f.meaning.toLowerCase().includes(kw) ||
              f.symptoms.some((s) => String(s).toLowerCase().includes(kw)) ||
              (f.resolution_summary || '').toLowerCase().includes(kw),
          )
          .map(withModelName(models))
      : [];
    return { mode: 'model_scoped_keyword', modelId, items, warning: null };
  }

  // 未选机型：只做消歧展示，不输出任何机型专属维修结论
  if (!code) {
    return {
      modelId: null,
      items: [],
      warning: '请先选择机型：故障码含义按机型解释，不能只按字符串命中。',
    };
  }
  const sameCode = (await db.find('fault_codes'))
    .filter((f) => f.status === 'approved')
    .filter((f) => normalizeCode(f.code) === code)
    .map(withModelName(models));

  return {
    mode: 'disambiguation_only',
    modelId: null,
    items: sameCode.map((o) => ({
      ...o,
      meaning: undefined,
      resolution_summary: undefined,
      note: '请确认机型后查看该机型下的解释',
    })),
    distinctModels: new Set(sameCode.map((f) => f.model_id)).size,
    warning:
      sameCode.length === 0
        ? '未找到该故障码，请确认机型后检索。'
        : `同一故障码出现在 ${new Set(sameCode.map((f) => f.model_id)).size} 个机型，含义不同，请先选择机型。`,
  };
}

const withModelName =
  (models) =>
  (f) => ({ ...f, modelName: models.get(f.model_id)?.name ?? f.model_id });
