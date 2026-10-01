// 演示/初始化数据：直接跑 `npm run seed`，或由服务在空库时自动调用。
import { createManualRevision } from '../domain/manuals.js';
import { newId } from '../util.js';
import { createStore } from './store.js';

export async function seedStore(db) {
  if ((await db.count('models')) > 0) return false;

  const m1 = await db.insert('models', { id: 'm_x1', name: 'Aurora X1 热泵', series: 'Aurora' });
  const m2 = await db.insert('models', { id: 'm_x2', name: 'Boreas X2 热泵', series: 'Boreas' });

  // ---- 手册：X1 rev1（老版，现场可能已下载） ----
  const rev1Steps = [
    { key_code: 'S-LOCK', title: '断电挂牌上锁', content: '断开主电源并挂“禁止合闸”牌，验电确认无电。', safety_critical: true, depends_on_keys: [] },
    { key_code: 'S-TEMP', title: '更换温度传感器', content: '拔出旧温度传感器，更换备件后保温恢复，静置 15 分钟再上电。', safety_critical: true, depends_on_keys: ['S-LOCK'] },
    { key_code: 'S-HEAT', title: '检查加热器', content: '目视检查加热器接线，测量绝缘电阻不低于 0.5MΩ。', safety_critical: false, depends_on_keys: ['S-TEMP'] },
    { key_code: 'S-OLD', title: '旧版排气操作（rev1 专有）', content: '按旧工艺手动排气两次。', safety_critical: false, depends_on_keys: ['S-HEAT'] },
    { key_code: 'S-CLOSE', title: '复位外壳并通电', content: '装回外壳，按力矩 2.1N·m 紧固，恢复供电并观察自检。', safety_critical: false, depends_on_keys: ['S-HEAT'] },
  ];
  const man1 = await createManualRevision(db, {
    modelId: 'm_x1', code: 'FAN-X1', title: 'X1 风机/温度故障维修手册',
    steps: rev1Steps, status: 'approved',
  });

  // ---- 手册：X1 rev2（新版：关键步骤内容更新、依赖调整、删除旧步骤、新增验证） ----
  const rev2Steps = [
    { key_code: 'S-LOCK', title: '断电挂牌上锁', content: '断开主电源并挂“禁止合闸”牌，验电确认无电。', safety_critical: true, depends_on_keys: [] },
    { key_code: 'S-TEMP', title: '更换温度传感器', content: '拔出旧温度传感器，更换备件后保温恢复；必须双人复核接线，静置 20 分钟再上电。', safety_critical: true, depends_on_keys: ['S-LOCK'] },
    { key_code: 'S-HEAT', title: '检查加热器', content: '目视检查加热器接线，测量绝缘电阻不低于 1.0MΩ（新标准）。', safety_critical: false, depends_on_keys: ['S-TEMP'] },
    { key_code: 'S-VERIFY', title: '温升验证（新增）', content: '上电后运行测试程序 10 分钟，记录进出口温差并拍照。', safety_critical: false, depends_on_keys: ['S-HEAT'] },
    { key_code: 'S-CLOSE', title: '复位外壳并通电', content: '装回外壳，按力矩 2.1N·m 紧固，恢复供电并观察自检。', safety_critical: false, depends_on_keys: ['S-VERIFY'] },
  ];
  const man2 = await createManualRevision(db, {
    modelId: 'm_x1', code: 'FAN-X1', title: 'X1 风机/温度故障维修手册',
    steps: rev2Steps, status: 'approved',
  });

  // X1 rev3 草稿：演示“系统只呈现审核资料”，草稿现场不可见
  await createManualRevision(db, {
    modelId: 'm_x1', code: 'FAN-X1', title: 'X1 风机/温度故障维修手册',
    steps: rev2Steps, status: 'draft',
  });

  // ---- X2 手册 rev1 ----
  const x2 = await createManualRevision(db, {
    modelId: 'm_x2', code: 'FAN-X2', title: 'X2 控制板维修手册',
    steps: [
      { key_code: 'X2-PREP', title: '进入维修模式', content: '按住设置键 5 秒进入维修模式，记录原参数。', safety_critical: false, depends_on_keys: [] },
      { key_code: 'X2-FW', title: '固件核对与标定', content: '核对固件版本不低于 3.1，按向导完成传感器标定。', safety_critical: false, depends_on_keys: ['X2-PREP'] },
    ],
    status: 'approved',
  });

  // ---- 故障码：同一码 E404 在两机型含义完全不同 ----
  await db.insert('fault_codes', {
    id: newId('fc'), model_id: 'm_x1', code: 'E404',
    meaning: '温度传感器通信丢失：线束断路或探头失效',
    severity: 'critical',
    symptoms: ['显示 E404 且风机停转', '温度读数为 --'],
    resolution_summary: '按 FAN-X1 流程更换温度传感器并双人复核',
    manual_id: man2.id, status: 'approved',
  });
  await db.insert('fault_codes', {
    id: newId('fc'), model_id: 'm_x2', code: 'E404',
    meaning: '控制板固件参数未标定：非硬件故障',
    severity: 'info',
    symptoms: ['显示 E404 但设备可运行', '设置菜单提示未标定'],
    resolution_summary: '按 FAN-X2 流程进入维修模式完成标定，无需换件',
    manual_id: x2.id, status: 'approved',
  });
  await db.insert('fault_codes', {
    id: newId('fc'), model_id: 'm_x1', code: 'H204',
    meaning: '加热器绝缘老化预警',
    severity: 'warning',
    symptoms: ['跳闸次数增多', '绝缘偏低'],
    resolution_summary: '按 FAN-X1 检查加热器，必要时更换加热芯',
    manual_id: man2.id, status: 'approved',
  });
  // 草稿故障码：不应出现在现场检索
  await db.insert('fault_codes', {
    id: newId('fc'), model_id: 'm_x1', code: 'T999',
    meaning: '内部试验码（草稿，未审核）',
    severity: 'info', symptoms: [], resolution_summary: '',
    manual_id: man2.id, status: 'draft',
  });

  // ---- 备件 ----
  const parts = [
    ['p_tc100', 'TC-100', '温度传感器 10k', 'm_x1'],
    ['p_tc110', 'TC-110', '温度传感器 10k 耐候型', 'm_x1'],
    ['p_tc120', 'TC-120', '温度传感器 12k 自适应', 'm_x1'],
    ['p_hs300', 'HS-300', '加热芯 800W', 'm_x1'],
    ['p_hs310', 'HS-310', '加热芯 900W 低耗', 'm_x1'],
  ];
  for (const [id, part_no, name, model_id] of parts) {
    await db.insert('parts', { id, part_no, name, model_id, uom: '件' });
  }

  // 有方向、有范围的替代边（注意：不构成系统自动传递）
  await db.insert('part_substitutions', {
    id: newId('sub'), from_part_id: 'p_tc110', to_part_id: 'p_tc100',
    direction_note: 'forward_only', applicable_models: ['m_x1'],
    serial_range: {}, effective_from: '2025-01-01', effective_to: '2026-12-31',
    status: 'active',
  });
  await db.insert('part_substitutions', {
    id: newId('sub'), from_part_id: 'p_tc120', to_part_id: 'p_tc110',
    direction_note: 'forward_only', applicable_models: ['m_x1'],
    serial_range: {}, effective_from: '2025-06-01', effective_to: null,
    status: 'active',
  });
  await db.insert('part_substitutions', {
    id: newId('sub'), from_part_id: 'p_hs310', to_part_id: 'p_hs300',
    direction_note: 'forward_only', applicable_models: ['m_x1'],
    serial_range: { from: 'AX1-2026-0001', to: '' },
    effective_from: '2026-01-01', effective_to: null,
    status: 'active',
  });

  // ---- 服务程序（业务服务管理适用范围） ----
  const prg1 = await db.insert('service_programs', {
    id: newId('prg'), name: '标准两年保修', applies_models: ['m_x1', 'm_x2'],
    applies_serials: {}, warranty_months: 24,
    coverage_note: '覆盖硬件缺陷，人为损坏除外', active: true,
  });
  const prg2 = await db.insert('service_programs', {
    id: newId('prg'), name: 'X2 延保五年', applies_models: ['m_x2'],
    applies_serials: { from: 'BX2-2025-0001', to: '' }, warranty_months: 60,
    coverage_note: '仅 X2 指定批次，含控制板', active: true,
  });
  for (const pid of [prg1.id, prg2.id]) {
    await db.insert('service_program_manuals', { id: newId('pm'), program_id: pid, manual_id: man2.id });
  }

  // ---- 任务 DAG（按任务依赖打包） ----
  const taskRows = [
    ['S-LOCK', '上锁挂牌', []],
    ['S-TEMP', '换温度传感器', ['S-LOCK']],
    ['S-HEAT', '检查加热器', ['S-TEMP']],
    ['S-VERIFY', '温升验证', ['S-HEAT']],
    ['S-CLOSE', '复位通电', ['S-VERIFY']],
  ];
  for (const [step_key, label, depends_on] of taskRows) {
    await db.insert('tasks', { id: newId('tsk'), manual_id: man2.id, step_key, label, depends_on });
  }

  return true;
}

// 独立执行：npm run seed
if (import.meta.url === `file://${process.argv[1]}`) {
  const { db, close } = await createStore();
  const seeded = await seedStore(db);
  console.log(seeded ? `seed complete (${db.kind})` : `data already present (${db.kind})`);
  await close?.();
  if (db.kind === 'postgres') process.exit(0);
}
