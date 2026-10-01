# 售后手册网站

从空仓库搭建的售后服务现场系统：`docs/` 为根站点工程，Node 内置 HTTP 提供 API 与静态站，
PostgreSQL 保存机型修订、备件兼容（有向替代边）和步骤版本；无 `DATABASE_URL` 时自动使用
同构内存库跑测试与演示。

## 运行

```bash
npm install          # pg 为可选依赖，装不上也能用内存库
npm start           # http://localhost:4173  （空库自动播种演示数据）
npm test             # 42 项测试（node:test）
DATABASE_URL=postgres://… npm run seed   # 向 PG 初始化并播种
```

页面：`#/faults` 故障码检索 ｜ `#/parts` 备件替代 ｜ `#/field` 现场工单 ｜
`#/programs` 业务服务适用范围 ｜ `#/packages` 离线打包/撤回 ｜ `#/review` 审核资料。
Service Worker 缓存应用壳，接口数据永不缓存。

## 业务不变量（也是测试红线）

1. **故障码语义按机型解释，不能只按字符串命中。**
   `(code, model_id)` 才确定含义；种子数据中 `E404` 在 X1 是“温度传感器通信丢失（critical）”，
   在 X2 是“固件未标定（info，无需换件）”。未选机型只返回消歧列表且不携带任何机型专属结论；
   码在其他机型存在时仅提示、不套用；草稿故障码不参与检索。见 `server/domain/faults.js`。

2. **备件替代是有方向、有生效范围的边，禁止无条件传递推断。**
   `part_substitutions(from_part→to_part)` 带 `direction_note / applicable_models /
   serial_range / effective_from~to`。查询只返回**当前生效的直接边**：TC-110→TC-100 成立
   不代表 TC-100→TC-110 成立；TC-120→TC-110→TC-100 不推出 TC-120 兼容 TC-100
   （多跳链只在显式“诊断”接口中展示，并标注 `verifiedCompatible:false`）。
   序列号区间同样是生效条件：未提供序列号时带区间的边进入 `restricted`（标记
   `serial_required`，不乐观放行），区间外为 `out_of_range`（禁用），仅区间内 `usable`。
   新增边做环检测：长度≥3 的有向环拒绝并回传环路径；2-环只有两边都显式
   `declared_pair`（双向互换）才允许。见 `server/domain/parts.js`。

3. **现场离线勾选绑定工单与手册快照。**
   建单即固定 `manual_id + manual_revision + snapshot_hash`，云端再发新版不改变该工单看到的
   步骤。错机型建单（手册不属于该机型）409；草稿版不可下发；绑定服务程序时校验适用范围
   （机型白名单 + 序列号区间，不近似适用）。前端把离线事件/证据存 IndexedDB，
   回连后经 `/sync` 批量上传：`client_event_id` 幂等去重，`base_event_id` 乐观并发——
   云端与离线不一致时登记 `sync_conflicts`、返回 409，**不静默覆盖任何一端**，
   未同步原始载荷在 `unsynced` 中返回并继续保留在本机。冲突必须人工裁决：
   `keep_remote` 仅消解冲突、保留云端值；`keep_local` 由服务器以云端最新事件为基线
   **重放**离线动作（重放仍走 hash/步骤校验并落事件流），可重复裁决被拒绝。

4. **业务服务管理适用范围。** 服务程序带机型白名单与序列号区间；无序列号时对有序列号
   限制的程序判定为不适用（不做乐观假设），建单时不适用程序返回 409 `OUT_OF_SCOPE`。
   见 `server/domain/programs.js`。

5. **更新关键步骤后逐项判断已做工作能否继承——不静默重置，也不全算完成。**
   步骤以 `key_code` 跨修订对齐，`content_hash` 只覆盖正文（依赖变化单独判为
   `dependency_changed`）。`/rebase-preview` 对每项给出
   `unchanged / content_changed / dependency_changed / removed / added / not_done` 与理由：
   安全关键项内容变化一律 `redo_required`（禁止 inherit）；提交决定必须逐项齐全。
   对 `redo/skip` 项，系统写入一条显式 `uncheck` 审计事件使旧勾选失效、工单回到 open，
   只有 `unchanged` 项保留勾选——绝不让旧 √ 在新版残留。审计事件 `client_event_id`
   带目标 REV，同一工单可连续多次迁移而不撞唯一键。

6. **照片证据可晚传且不丢失。** 工单完工后补传的证据标记 `late=true`，仍可在打印单列出。

7. **整机型包 vs 按任务依赖打包。** 任务包按显式任务 DAG 求依赖闭包（有环报错），
   `/packages/compare` 证明任务包是同版本整包的严格子集并列省略项。撤回包不删除数据：
   返回撤回提示、受影响工单清单及其未同步证据保留说明；已建工单始终按绑定快照作业与打印。

8. **打印维护单可追溯实际使用的说明版。** `/work-orders/:id/print` 输出版本追溯块
  （手册编号、REV、手册记录 ID、建单时快照指纹、手册当前状态）与实际勾选/晚传证据。

9. **系统只呈现审核资料，不编造维修操作。** 草稿手册 403 不呈现内容，草稿故障码不进检索，
   未知名码返回“无记录 + 消歧”；所有处置文案只复述 `approved` 手册/条目，接口与页面均不
   生成手册外操作建议。

## 测试与题目场景对应（`tests/`，42 项）

| 场景 | 测试 |
| --- | --- |
| 错机型（同码跨含义、错机型建单） | `01-faults`、`05-api` |
| 替代件环 / 反向不成立 / 超范围失效 / 序列号区间 / 不传递 | `02-parts`、`05-api` |
| 照片晚传、离线同步冲突与证据保留 | `04-workorders`、`05-api` |
| 打印中改步骤（hash 不符拒勾）、改版继承逐项判定、二次迁移不撞键 | `03-manuals`、`04-workorders`、`05-api` |
| 云端与离线冲突（乐观并发/登记/keep_remote·keep_local 裁决） | `04-workorders`、`05-api` |
| 整包 vs 任务包、撤回提示、未同步证据保留 | `07-packages`、`04-workorders`、`05-api` |
| 打印单追溯实际说明版 | `04-workorders`、`05-api` |
| 服务程序适用范围（机型/序列号）、建单范围校验 | `06-programs`、`05-api` |

## 目录

```
docs/            根静态站点（离线应用壳：index/app/styles/sw/manifest）
server/
  index.js       HTTP 服务：静态 + /api
  api/router.js  路由（版本追溯打印、迁移失效事件等）
  domain/        faults parts manuals workorders programs packages
  db/            schema.sql(PG) / pg.js / mem.js / store.js / seed.js
tests/           node:test 领域级 + HTTP 端到端
```
