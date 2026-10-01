import { createServer } from 'node:http';
import { createMemoryDB } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seed } from '../server/seed.js';

export async function startHarness() {
  const db = await createMemoryDB();
  await seed(db);
  const server = createServer(createApp(db));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;
  const api = async (path, opts = {}) => {
    const res = await fetch(base + path, {
      method: opts.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    return { status: res.status, body: json };
  };
  const stop = () => new Promise((resolve) => server.close(resolve));
  return { db, api, stop };
}

// 发布 AC-200 v1.1（与种子数据等价的关键步骤修订），用于测试中重新触发判定
export async function publishAc200V12(api) {
  const steps = [
    { step_no: '010', title: '断电挂牌上锁', instruction: '关闭主电源并挂"禁止合闸"牌，验电后作业。', is_key_step: true, required_parts: [] },
    { step_no: '020', title: '拆卸冷凝器护板', instruction: '拧下护板 4 颗 M5 螺钉，取下护板（改为免工具快拆）。', is_key_step: false, required_parts: [] },
    { step_no: '030', title: '更换散热风机', instruction: '【v1.2 关键修订】风机固定改为扭矩 4.0N·m 并涂抹导热硅脂。', is_key_step: true, required_parts: ['FAN-01'] },
    { step_no: '040', title: '通电自检', instruction: '恢复供电，执行自检程序并记录电流值。', is_key_step: true, required_parts: [] },
    { step_no: '050', title: '复测出口温度', instruction: '满载运行 10 分钟，记录冷凝器出口温度曲线。', is_key_step: false, required_parts: [] },
  ];
  return api('/manuals', { method: 'POST', body: { model_code: 'AC-200', version: 'v1.2', steps, reviewer: 'qa-lead' } });
}
