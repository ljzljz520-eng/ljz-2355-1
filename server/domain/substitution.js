// 备件替代领域规则：
// 1) 替代是有向的（forward/reverse/both），A 能替 B 不代表 B 能替 A；
// 2) 每条边带生效范围（机型/序列号区间/日期窗）；
// 3) 传递只在"整条路径的范围交集仍然非空且覆盖现场上下文"时成立——
//    严禁无条件传递推断兼容；
// 4) 新增边若在有向图上成环则拒绝（替代件环）。

export const UNIVERSE = { model_code: null, serial_from: null, serial_to: null, valid_from: null, valid_to: null };

// 日期归一化为 YYYY-MM-DD（PGlite 的 date 列返回 Date 对象，直接 toString 不是 ISO）
export function day(v) {
  if (v == null) return null;
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}
function maxDate(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}
function minDate(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return a < b ? a : b;
}

// 两个生效范围取交集；空集返回 null
export function intersectScopes(a, b) {
  if (!a || !b) return null;
  let model_code = null;
  if (a.model_code && b.model_code) {
    if (a.model_code !== b.model_code) return null; // 机型不相交
    model_code = a.model_code;
  } else {
    model_code = a.model_code ?? b.model_code ?? null;
  }
  const serial_from = (a.serial_from == null || b.serial_from == null)
    ? (a.serial_from ?? b.serial_from ?? null)
    : Math.max(a.serial_from, b.serial_from);
  const serial_to = (a.serial_to == null || b.serial_to == null)
    ? (a.serial_to ?? b.serial_to ?? null)
    : Math.min(a.serial_to, b.serial_to);
  if (serial_from != null && serial_to != null && serial_from > serial_to) return null;
  const valid_from = maxDate(a.valid_from, b.valid_from);
  const valid_to = minDate(a.valid_to, b.valid_to);
  if (valid_from && valid_to && valid_from > valid_to) return null;
  return { model_code, serial_from, serial_to, valid_from, valid_to };
}

// 判断范围是否允许给定现场上下文（机型/序列号/日期）
export function scopeAllows(scope, ctx = {}) {
  if (!scope) return false;
  if (ctx.modelCode && scope.model_code && scope.model_code !== ctx.modelCode) return false;
  if (ctx.serial != null) {
    if (scope.serial_from != null && ctx.serial < scope.serial_from) return false;
    if (scope.serial_to != null && ctx.serial > scope.serial_to) return false;
  }
  if (ctx.date) {
    if (scope.valid_from && ctx.date < scope.valid_from) return false;
    if (scope.valid_to && ctx.date > scope.valid_to) return false;
  }
  return true;
}

export function edgeScope(e) {
  return {
    model_code: e.model_code ?? null,
    serial_from: e.serial_from ?? null,
    serial_to: e.serial_to ?? null,
    valid_from: day(e.valid_from),
    valid_to: day(e.valid_to),
  };
}

// 依据 direction 展开有向弧：弧 x->y 表示"x 可以替代 y"
export function directedArcs(edge) {
  const a = edge.sku;
  const b = edge.replaces_sku;
  if (edge.direction === 'forward') return [{ from: a, to: b }];
  if (edge.direction === 'reverse') return [{ from: b, to: a }];
  return [{ from: a, to: b }, { from: b, to: a }];
}

// 新增边是否会在有向图上成环（忽略被拒绝的边）
export function wouldCreateCycle(existing, candidate) {
  const edges = existing.filter((e) => e.status !== 'rejected');
  const adj = new Map();
  for (const e of edges) {
    for (const arc of directedArcs(e)) {
      if (!adj.has(arc.from)) adj.set(arc.from, []);
      adj.get(arc.from).push(arc.to);
    }
  }
  for (const arc of directedArcs(candidate)) {
    if (arc.from === arc.to) return true;
    // 加入有向弧 from→to 成环，当且仅当现有图上 to 已经能沿弧回到 from。
    const seen = new Set();
    const stack = [arc.to];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === arc.from) return true; // 存在 to⤳…→from，补弧即闭环
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of adj.get(cur) ?? []) if (!seen.has(nxt)) stack.push(nxt);
    }
  }
  return false;
}

// 在上下文约束下搜索 source 可替代的全部备件；路径范围 = 各边范围交集
export function findSubstitutions(edges, source, ctx = {}) {
  const approved = edges.filter((e) => e.status !== 'rejected');
  const adj = new Map();
  for (const e of approved) {
    for (const arc of directedArcs(e)) {
      if (!adj.has(arc.from)) adj.set(arc.from, []);
      adj.get(arc.from).push({ to: arc.to, edge: e });
    }
  }
  const results = [];
  // BFS：携带路径、路径交集范围；交集为空即剪枝
  const queue = [{ node: source, path: [], scope: UNIVERSE, edges: [] }];
  const best = new Map(); // node -> 已经找到的最宽有效范围
  while (queue.length) {
    const cur = queue.shift();
    for (const { to, edge } of adj.get(cur.node) ?? []) {
      if (cur.path.includes(edge.id)) continue; // 不重复走同一条边
      const nextScope = intersectScopes(cur.scope, edgeScope(edge));
      if (!nextScope) continue; // 范围不交：传递在此中断
      const step = {
        node: to,
        path: [...cur.path, edge.id],
        edges: [...cur.edges, edge],
        scope: nextScope,
      };
      const prev = best.get(to);
      const usable = scopeAllows(nextScope, ctx);
      if (!prev || (usable && !prev.usable)) best.set(to, step);
      // 仍继续扩展以寻找更长（可能换型后才可达）的路径，但避免无限深入
      if (step.path.length <= 6) queue.push(step);
      if (usable && (!prev || !prev.usable)) {
        results.push({
          sku: to,
          edgeIds: step.path,
          hops: step.edges.map((e) => ({ id: e.id, sku: e.sku, replaces_sku: e.replaces_sku, direction: e.direction })),
          effectiveScope: nextScope,
        });
      }
    }
  }
  return results;
}

export function checkCompatible(edges, source, target, ctx = {}) {
  const direct = edges.find(
    (e) => e.status !== 'rejected' &&
      directedArcs(e).some((a) => a.from === source && a.to === target)
  );
  const paths = findSubstitutions(edges, source, ctx).filter((p) => p.sku === target);
  if (paths.length) {
    return {
      compatible: true,
      direct: !!direct,
      paths,
      note: direct
        ? '存在方向与生效范围均匹配的直接替代关系。'
        : '经有向路径传递，且整条路径的生效范围交集覆盖现场上下文；非无条件传递。',
    };
  }
  // 给出不能兼容的原因，便于排查
  const unscoped = findSubstitutions(edges, source, {}).filter((p) => p.sku === target);
  if (unscoped.length) {
    return {
      compatible: false,
      reason: 'OUT_OF_SCOPE',
      paths: unscoped,
      note: '存在替代路径，但其生效范围（机型/序列号/日期）交集不覆盖现场上下文，不能据此推断兼容。',
    };
  }
  return { compatible: false, reason: 'NO_DIRECTED_PATH', note: '不存在覆盖该上下文的有向替代路径。' };
}
