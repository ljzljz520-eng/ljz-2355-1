// 复用路由里的打印单构造（通过 HTTP 集成测试也覆盖；此处供领域测试直接调用）
export function build(detail, program) {
  const wo = detail.workOrder;
  const checked = new Set(detail.checkedKeys);
  const lines = [
    `维护单 ${wo.code}`,
    `实际使用说明版：${wo.manual_code} REV ${wo.manual_revision}`,
    `工单创建时快照指纹：${wo.snapshot_hash}`,
    '',
    ...detail.evidence.map((e) => `  - ${e.filename} 采集于 ${e.captured_at}${e.late ? ' [晚传]' : ''}`),
  ];
  return {
    versionTrace: { revision: wo.manual_revision, snapshotHash: wo.snapshot_hash },
    text: lines.join('\n'),
  };
}
