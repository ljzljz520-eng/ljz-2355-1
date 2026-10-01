# 售后手册网站（After-Sales Manual Site）

从空仓库建立的售后手册平台：

- **根 `docs/` 工程**：无构建步骤的静态网站，做故障码与机型检索、备件兼容判定、
  业务服务适用范围查询、工单现场记录（离线勾选/证据/逐项继承裁决/同步冲突/打印追溯）。
- **PostgreSQL 持久层**：保存机型修订、手册步骤版本、有向且限范围的备件替代、
  工单与手册快照绑定、证据、冲突、打印记录与审计日志。
  本地/测试使用 [PGlite](https://github.com/electric-sql/pglite)（进程内真实 PostgreSQL），
  生产可通过同一套 SQL（`server/schema.sql`）部署到外部 PG。

## 快速开始

```bash
npm install
npm run seed     # 初始化 .data/pglite 并写入演示数据（AC-200/AC-300、手册版本、故障码、替代关系、工单 WO-1001）
npm start        # http://localhost:3000  （API 前缀 /api，静态站点为 docs/）
npm test         # node:test 全量测试（每个用例使用独立内存 PG）
```

重置本地库：`npm run reset`。

## 领域硬规则（实现位置）

| 要求 | 落地方式 |
| --- | --- |
| 故障码跨机型含义不同，搜索不能只按字符串命中 | 故障码唯一作用域是 `(code, model_code, revision)`；检索必须选机型，未选机型只列出各机型释义要求用户先选；错机型返回 `WRONG_MODEL`（跨机型记录仅作"不得套用"提示）；建单时故障码越作用域即拒绝。见 `server/domain/faultSearch.js` |
| 备件替代有方向、有生效范围，禁止无条件传递 | 每条边含 `direction(forward/reverse/both)` 与机型/序列号区间/日期窗；传递路径的范围取**交集**，交集为空或不覆盖现场上下文即剪枝；新增边先做有向**环检测**，成环返回 `SUBSTITUTION_CYCLE` 不落库。见 `server/domain/substitution.js` |
| 离线勾选绑定工单与手册快照 | 绑定时钉住 `manual_id + version + content_hash` 并生成逐项清单；换版必须显式 `migrate=true`，迁移保留已做记录、新增步骤补 pending、删除步骤标 removed |
| 关键步骤更新后逐项判断能否继承 | `reevaluateWorkAfterRevision` 对每项输出 `inheritable / needs_redo / review / removed / pending_new / added`；必须由维修人员**逐项显式裁决** inherit/redo；完成闸门对未裁决/needs_redo 未重做/未完成步骤阻断——**不静默重置、不全算完成** |
| 整机型包 vs 按任务依赖打包 | `/packages/full` 给全量已审核内容；`/work-orders/:id/packages/task` 从工单故障码引用步骤出发、按所绑快照裁剪并收集所需备件；引用步骤在所绑版本不存在时列入 `missing_from_bound_version` 显式提示，不夹带其它版本内容 |
| 撤回提示 + 未同步证据保留 | 撤回前 `withdraw-preview` 返回影响提示；撤回只把证据置 `withdrawn`，行/文件元数据/采集时间/审计不删除；同步分叉时离线证据置 `quarantined`，云端不被覆盖，冲突人工解决后证据仍保留（active 或 withdrawn） |
| 打印维护单可追到实际使用的说明版 | `print_records` 记录 manual_id/version/content_hash；所钉版被取代时打印同时返回取代提示；未绑快照禁止打印 |
| 只呈现审核资料，不编造维修操作 | 列表接口仅返回 `status='approved'`；未知故障码不提供推测解释；页面与维护单均标注内容来自所绑已审核版本 |

## 数据模型要点（`server/schema.sql`）

- `machine_models / model_revisions`：机型与修订
- `manuals / manual_steps`：手册版本与步骤版本（内容指纹 `content_hash/step_hash`；
  步骤指纹只覆盖步骤内容，因此"内容未变的步骤跨版本指纹一致"，继承判定才能识别 UNCHANGED）
- `fault_codes`：机型作用域故障码释义 + 审核处置依据步骤 `ref_step_nos`
- `parts / part_substitutions`：备件与有向限范围替代边（CHECK 约束 + 应用层环检测）
- `service_coverages`：服务适用范围（机型 + 序列号区间 + 时间窗）
- `work_orders / work_order_items / work_order_item_decisions`：工单、逐项清单（含
  完成基线指纹 `completed_step_hash` 与迁移目标指纹 `target_step_hash`）、逐项裁决留痕
- `evidence`：照片/签字/备注，状态机 `active → withdrawn`，冲突隔离 `quarantined`
- `sync_events / sync_conflicts`：同步事件与分叉快照（云端/离线 JSON 快照均留存）
- `packages`：整机型包 / 任务包清单
- `print_records`：打印维护单的版本钉版与取代提示
- `audit_log`：全部敏感动作留痕

## HTTP API 摘要

```
GET  /models
GET  /fault-codes/lookup?code=&model=
GET  /manuals?model=        GET /manuals/:id      POST /manuals
GET  /parts                 GET /substitutions
GET  /substitutions/check?source=&target=&model=&serial=&date=
POST /substitutions
GET  /coverages?model=&serial=&date=
GET/POST /work-orders       GET /work-orders/:id
POST /work-orders/:id/bind-manual            {manual_id, migrate?}
POST /work-orders/:id/items/:itemId/complete
POST /work-orders/:id/items/:itemId/decision {action: inherit|redo}
POST /work-orders/:id/complete
POST /work-orders/:id/evidence               # 支持晚传（captured_at 早于上传时间）
POST /evidence/:id/withdraw-preview  POST /evidence/:id/withdraw
POST /packages/full {model_code}
POST /work-orders/:id/packages/task
POST /work-orders/:id/sync {base_revision, items, evidences}
POST /sync-conflicts/:id/resolve {resolution: keep_cloud|keep_offline}
GET  /work-orders/:id/conflicts
POST /work-orders/:id/print   GET /work-orders/:id/prints
GET  /audit
```

## 测试场景（`test/`）

1. **错机型**：E-410 在 AC-200=过热、AC-300=总线丢帧；未选机型不归并；越机型建单 422
2. **替代件环 / 方向性 / 范围 / 非无条件传递**：成环 409 不落库；反向不成立；
   FAN-03→FAN-02→FAN-01 跨机型交集为空传递中断；序列号越界/日期未生效判 OUT_OF_SCOPE
3. **照片晚传**：补交可接收、保留原始采集时间并标记晚传；撤回有预检提示且证据保留
4. **打印中改步骤**：打印钉 v1.0 可追溯并给取代提示；v1.2 发布后逐项判定
   （关键步骤 030 必须重作）；迁移不重置已做项、不把新步骤算完成；全部裁决/重做/补完后才能完成
5. **云端与离线冲突**：旧基线同步 → 冲突 409，离线证据 quarantined 保留、云端不被覆盖；
   keep_offline/keep_cloud 两种解决都不删证据
6. 整机型包 vs 任务包裁剪；服务适用范围按机型/序列号/日期窗判定
7. 领域纯函数：五类逐项判定；范围交集与环检测

## 工程结构

```
docs/                 根静态站点（index.html / styles.css / app.js）
server/
  schema.sql          PostgreSQL 建表（真实约束/检查/外键）
  db.js               PGlite 访问层（内存库用于测试）+ 事务/审计助手
  seed.js             演示数据（含跨机型异义故障码、限范围有向替代、钉旧快照工单）
  domain/
    faultSearch.js    机型作用域故障码释义
    substitution.js   有向图 + 范围交集 + 环检测
    reevaluation.js   逐项继承判定 + 任务依赖打包清单
  api.js              HTTP 路由（全部硬规则编排）
  app.js/index.js     Express 装配 / 启动
test/                 node:test 场景测试（每用例独立内存 PG + 临时 HTTP 服务）
```
