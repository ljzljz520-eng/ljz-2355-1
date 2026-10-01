// 备件兼容/替代规则
//  - 替代是“有方向的边”：A 可替代 B，不等于 B 可替代 A（除非显式声明双向互换）
//  - 每条边带生效机型与日期/序列范围
//  - 严禁无条件传递推断：A→B、B→C 绝不自动得到 A→C
//  - 新增边时做环检测：有向环（长度>=3）禁止；长度为 2 的反向必须是显式声明的双向互换

import { newId, todayISO } from '../util.js';
import { inSerialRange } from './programs.js';

/**
 * 当前对指定机型/日期/序列号生效的直接替代件（不展开多跳）。
 * 返回项带 usable 标记：有序列号限制而未提供序列号时 usable=false（不做乐观假设），
 * 调用方可把这类项放进 restricted[] 提示补录序列号，而不是当作可直接使用的兼容件。
 */
export async function directSubstitutes(
  db, partId, { modelId = null, serialNo = '', onDate = todayISO() } = {},
) {
  const edges = await db.find('part_substitutions', { from_part_id: partId, status: 'active' });
  const parts = new Map((await db.find('parts')).map((p) => [p.id, p]));
  return edges
    .filter((e) => inEffect(e, modelId, onDate))
    .map((e) => {
      const to = parts.get(e.to_part_id);
      const range = e.serial_range || {};
      const hasSerialLimit = Boolean(range.from || range.to);
      let serialStatus = 'unrestricted';
      if (hasSerialLimit) {
        serialStatus = serialNo
          ? (inSerialRange(serialNo, range) ? 'in_range' : 'out_of_range')
          : 'serial_required';
      }
      return {
        substitutionId: e.id,
        part: to ? { id: to.id, part_no: to.part_no, name: to.name } : { id: e.to_part_id },
        direction: e.direction_note,
        applicableModels: e.applicable_models,
        serialRange: range,
        serialStatus,
        usable: serialStatus !== 'out_of_range' && serialStatus !== 'serial_required',
        effective: { from: e.effective_from, to: e.effective_to },
        transitivelyInferred: false, // 直接边，且系统从不做传递推断
      };
    });
}

function inEffect(edge, modelId, onDate) {
  if (edge.effective_from && onDate < edge.effective_from) return false;
  if (edge.effective_to && onDate > edge.effective_to) return false;
  if (modelId && edge.applicable_models.length && !edge.applicable_models.includes(modelId)) {
    return false;
  }
  // 序列号区间在 directSubstitutes 中判定（需要 serialNo）；这里只做机型/日期范围过滤。
  return true;
}

/** 管理诊断用：显式计算最多 maxHops 跳路径（API 默认不暴露，绝不作为兼容结论） */
export async function transitiveChains(db, partId, maxHops = 3) {
  const adj = new Map();
  for (const e of await db.find('part_substitutions', { status: 'active' })) {
    if (!adj.has(e.from_part_id)) adj.set(e.from_part_id, []);
    adj.get(e.from_part_id).push(e.to_part_id);
  }
  const chains = [];
  const walk = (node, path, seen) => {
    if (path.length > maxHops) return;
    for (const nxt of adj.get(node) ?? []) {
      if (seen.has(nxt)) {
        chains.push({ chain: [...path.slice(1), nxt], cycle: true });
        continue;
      }
      chains.push({ chain: [...path.slice(1), nxt], cycle: false });
      walk(nxt, [...path, nxt], new Set(seen).add(nxt));
    }
  };
  walk(partId, [partId], new Set([partId]));
  return chains;
}

/**
 * 新增替代边（含校验）。
 * 返回 { ok:true, edge } 或 { ok:false, code, message, path? }
 */
export async function addSubstitution(db, input) {
  const {
    fromPartNo, toPartNo, directionNote = 'forward_only',
    applicableModels = [], effectiveFrom = null, effectiveTo = null,
    serialRange = {},
  } = input;

  const parts = await db.find('parts');
  const byNo = new Map(parts.map((p) => [p.part_no, p]));
  const from = byNo.get(String(fromPartNo ?? '').trim());
  const to = byNo.get(String(toPartNo ?? '').trim());
  if (!from || !to) return reject('PART_NOT_FOUND', '源件或替代件不存在');
  if (from.id === to.id) return reject('SELF_LOOP', '不能建立件号到自身的替代关系');
  if (!['forward_only', 'declared_pair'].includes(directionNote)) {
    return reject('BAD_DIRECTION', '方向标记必须为 forward_only 或 declared_pair');
  }
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
    return reject('BAD_RANGE', '生效起始日晚于失效日');
  }

  const edges = await db.find('part_substitutions');
  if (edges.some((e) => e.from_part_id === from.id && e.to_part_id === to.id && e.status === 'active')) {
    return reject('DUP_EDGE', `已存在 ${from.part_no} → ${to.part_no} 的直接替代关系`);
  }

  // 环检测（在加入假设边后的图上 DFS，找回到 from 的路径）
  const reverseExists = edges.some(
    (e) => e.status === 'active' && e.from_part_id === to.id && e.to_part_id === from.id,
  );
  if (reverseExists) {
    const rev = edges.find(
      (e) => e.status === 'active' && e.from_part_id === to.id && e.to_part_id === from.id,
    );
    // 仅当两边都显式声明为 declared_pair 时才允许 2-环（双向互换）
    if (!(directionNote === 'declared_pair' && rev.direction_note === 'declared_pair')) {
      return reject(
        'CYCLE_2',
        `检测到替代环：${to.part_no} → ${from.part_no} 已存在单向边。` +
          '双向互换必须在两条边上都显式声明 declared_pair，不能靠反推。',
        [to.part_no, from.part_no, to.part_no],
      );
    }
  }

  // 长度 >=3 的有向环：to 能否沿现有 active 边回到 from
  const loop = findPath(edges, to.id, from.id);
  if (loop) {
    const noSeq = parts.reduce((m, p) => m.set(p.id, p.part_no), new Map());
    return reject(
      'SUBST_CYCLE',
      '检测到替代关系有向环，禁止新增（环上任一边失效前不能建立该边）',
      [from.part_no, ...loop.map((id) => noSeq.get(id) ?? id)],
    );
  }

  const edge = await db.insert('part_substitutions', {
    id: newId('sub'),
    from_part_id: from.id,
    to_part_id: to.id,
    direction_note: directionNote,
    applicable_models: applicableModels,
    serial_range: serialRange,
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    status: 'active',
  });
  return { ok: true, edge };
}

/** 广度找一条 active 有向路径 start→goal（仅用于环检测，不用于兼容推断） */
function findPath(edges, start, goal) {
  if (start === goal) return [start];
  const adj = new Map();
  for (const e of edges) {
    if (e.status !== 'active') continue;
    if (!adj.has(e.from_part_id)) adj.set(e.from_part_id, []);
    adj.get(e.from_part_id).push(e.to_part_id);
  }
  const prev = new Map([[start, null]]);
  const q = [start];
  while (q.length) {
    const cur = q.shift();
    for (const nxt of adj.get(cur) ?? []) {
      if (prev.has(nxt)) continue;
      prev.set(nxt, cur);
      if (nxt === goal) {
        const path = [goal];
        let p = cur;
        while (p) { path.unshift(p); p = prev.get(p); }
        return path;
      }
      q.push(nxt);
    }
  }
  return null;
}

const reject = (code, message, path = null) => ({ ok: false, code, message, path });
