-- 售后手册网站 PostgreSQL schema
-- 核心：版本化机型/手册/步骤、有向且带生效范围的备件替代、
--       工单-手册快照绑定、逐项继承判定、证据与冲突保留、打印版本钉版。

CREATE TABLE IF NOT EXISTS machine_models (
  code        text PRIMARY KEY,                 -- 机型编码，如 AC-200
  name        text NOT NULL,
  released_at date NOT NULL
);

-- 机型修订（PG 保存机型修订：名称/适用区间等可演进，故障码挂在具体修订上）
CREATE TABLE IF NOT EXISTS model_revisions (
  id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_code   text NOT NULL REFERENCES machine_models(code),
  revision     text NOT NULL,                   -- Rev A / Rev B
  released_at  date NOT NULL,
  notes        text,
  UNIQUE (model_code, revision)
);

-- 服务手册（每个机型可有多个已审核版本，仅 status=approved 的内容向用户呈现）
CREATE TABLE IF NOT EXISTS manuals (
  id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_code     text NOT NULL REFERENCES machine_models(code),
  version        text NOT NULL,
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','approved','superseded')),
  supersedes_id  int REFERENCES manuals(id),
  content_hash   text NOT NULL,                 -- 完整性指纹，快照/打包/打印均记录
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_at    timestamptz,
  UNIQUE (model_code, version)
);

-- 手册步骤版本：关键步骤更新是"逐项继承判定"的判定对象
CREATE TABLE IF NOT EXISTS manual_steps (
  id               int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  manual_id        int NOT NULL REFERENCES manuals(id) ON DELETE CASCADE,
  step_no          text NOT NULL,
  title            text NOT NULL,
  instruction      text NOT NULL,
  is_key_step      boolean NOT NULL DEFAULT false,
  required_parts   text[] NOT NULL DEFAULT '{}', -- 该步骤所需备件（任务依赖打包用）
  step_hash        text NOT NULL,               -- 步骤内容指纹，变更即不同
  UNIQUE (manual_id, step_no)
);

-- 故障码释义：唯一键含 model_code —— 同一故障码跨机型可以有不同含义
CREATE TABLE IF NOT EXISTS fault_codes (
  id               int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code             text NOT NULL,
  model_code       text NOT NULL REFERENCES machine_models(code),
  model_revision   text,                        -- 可限定具体机型修订
  meaning          text NOT NULL,
  severity         text NOT NULL DEFAULT 'info'
                   CHECK (severity IN ('info','warning','critical')),
  advised_action   text NOT NULL,               -- 仅呈现已审核资料，系统不自造操作
  manual_id        int REFERENCES manuals(id),  -- 指向审核通过的手册依据
  ref_step_nos     text[] NOT NULL DEFAULT '{}', -- 处置依据步骤（任务打包入口）
  UNIQUE (code, model_code, model_revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fault_code_scope
  ON fault_codes(code, model_code, COALESCE(model_revision, ''));

-- 备件主数据
CREATE TABLE IF NOT EXISTS parts (
  sku         text PRIMARY KEY,
  name        text NOT NULL,
  category    text
);

-- 备件替代关系：有向边 + 生效范围 + 方向性。
-- direction: forward = 本 SKU 可替代 replaces_sku；reverse = 本 SKU 可被 replaces_sku 替代；
--            both = 双向可互换。绝不允许无条件传递：传递只在范围交集非空时成立。
CREATE TABLE IF NOT EXISTS part_substitutions (
  id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku          text NOT NULL REFERENCES parts(sku),
  replaces_sku text NOT NULL REFERENCES parts(sku),
  direction    text NOT NULL CHECK (direction IN ('forward','reverse','both')),
  model_code   text REFERENCES machine_models(code),  -- NULL = 不限机型
  serial_from  int,
  serial_to    int,
  valid_from   date NOT NULL DEFAULT '1970-01-01',
  valid_to     date NOT NULL DEFAULT '9999-12-31',
  status       text NOT NULL DEFAULT 'approved'
               CHECK (status IN ('approved','rejected')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (sku <> replaces_sku),
  CHECK (serial_from IS NULL OR serial_to IS NULL OR serial_from <= serial_to)
);

-- 业务服务管理：适用范围（保修/延保/服务包 → 机型 + 序列号区间 + 时间窗）
CREATE TABLE IF NOT EXISTS service_coverages (
  id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  program      text NOT NULL,                   -- 标准保修 / 延保包 等
  model_code   text NOT NULL REFERENCES machine_models(code),
  serial_from  int,
  serial_to    int,
  valid_from   date NOT NULL,
  valid_to     date NOT NULL,
  terms        text NOT NULL
);

-- 工单（现场记录的载体）
CREATE TABLE IF NOT EXISTS work_orders (
  id                 int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wo_no              text UNIQUE NOT NULL,
  model_code         text NOT NULL REFERENCES machine_models(code),
  serial_no          int NOT NULL,
  fault_code         text,
  status             text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','in_progress','blocked','completed','withdrawn')),
  offline            boolean NOT NULL DEFAULT false,
  bound_manual_id    int REFERENCES manuals(id),   -- 现场离线勾选时绑定的手册快照
  bound_version      text,
  bound_content_hash text,
  bound_at           timestamptz,
  base_revision      int NOT NULL DEFAULT 0,       -- 离线基线修订号（并发冲突检测）
  revision           int NOT NULL DEFAULT 0,       -- 当前修订号（乐观锁）
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- 现场逐项记录（钉在具体步骤指纹上）
CREATE TABLE IF NOT EXISTS work_order_items (
  id                       int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_order_id            int NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  step_no                  text NOT NULL,
  title                    text NOT NULL,
  step_hash                text NOT NULL,
  target_step_hash         text,                        -- 快照迁移后的目标版本指纹（基线指纹保留在 step_hash/completed_step_hash）
  is_key_step              boolean NOT NULL DEFAULT false,
  state                    text NOT NULL DEFAULT 'pending'
                           CHECK (state IN ('pending','done','inherited_confirmed','needs_redo','removed','skipped')),
  completed_at             timestamptz,
  completed_step_hash      text,
  decision_status          text CHECK (decision_status IN ('pending','inheritable','needs_redo','removed', NULL)),
  decided_at               timestamptz,
  decided_by               text,
  decision_note            text,
  UNIQUE (work_order_id, step_no)
);
CREATE TABLE IF NOT EXISTS work_order_item_decisions (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     int NOT NULL REFERENCES work_order_items(id) ON DELETE CASCADE,
  action      text NOT NULL CHECK (action IN ('inherit','redo')),
  from_hash   text NOT NULL,
  to_hash     text NOT NULL,
  decided_by  text NOT NULL,
  note        text,
  decided_at  timestamptz NOT NULL DEFAULT now()
);

-- 证据（照片/签字/备注）：晚传允许，撤回需提示且文件与审计记录保留
CREATE TABLE IF NOT EXISTS evidence (
  id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_order_id int NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  item_id       int REFERENCES work_order_items(id),
  kind          text NOT NULL CHECK (kind IN ('photo','signature','note')),
  filename      text NOT NULL,
  mime          text,
  bytes         int,
  captured_at   timestamptz NOT NULL DEFAULT now(),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','withdrawn','quarantined')),
  withdraw_note text,
  withdrawn_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_evidence_wo ON evidence(work_order_id);

-- 同步事件与离线冲突（冲突证据默认隔离保留，绝不静默丢弃）
CREATE TABLE IF NOT EXISTS sync_events (
  id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_order_id int NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  direction     text NOT NULL CHECK (direction IN ('upload','download')),
  status        text NOT NULL CHECK (status IN ('applied','conflict','reverted')),
  payload       jsonb,
  detail        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id               int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_order_id    int NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  base_revision    int NOT NULL,
  cloud_revision   int NOT NULL,
  offline_revision int NOT NULL,
  status           text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','resolved_keep_cloud','resolved_keep_offline')),
  cloud_snapshot   jsonb,
  offline_snapshot jsonb,
  resolution_note  text,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- 离线包：full = 整机型包；task = 按任务依赖打包
CREATE TABLE IF NOT EXISTS packages (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('full','task')),
  model_code  text NOT NULL,
  work_order_id int REFERENCES work_orders(id),
  manifest    jsonb NOT NULL,
  content_hash text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 打印维护单：钉住实际使用的说明版；版本被取代后重打会给出取代提示
CREATE TABLE IF NOT EXISTS print_records (
  id              int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_order_id   int NOT NULL REFERENCES work_orders(id),
  manual_id       int NOT NULL REFERENCES manuals(id),
  printed_version text NOT NULL,
  content_hash    text NOT NULL,
  supersession_notice text,
  printed_at      timestamptz NOT NULL DEFAULT now()
);

-- 审计日志：撤回、决策、冲突解决等全部留痕
CREATE TABLE IF NOT EXISTS audit_log (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor       text NOT NULL DEFAULT 'technician',
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  detail      jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
