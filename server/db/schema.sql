-- 售后手册网站 数据库结构 (PostgreSQL 14+)
-- 关键不变量：
--  1) 故障码含义按 (code, model_id) 唯一，禁止跨机型字符串命中
--  2) 备件替代是有方向、有生效范围的边，不做无条件传递推断
--  3) 工单快照固定手册版本，云端后续改版不静默改变现场已勾选项
--  4) 打印维护单始终可追溯到实际使用的说明版

CREATE TABLE IF NOT EXISTS models (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  series      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 手册修订版（机型修订）：同一手册按 revision 递增；只有 approved 对现场可见
CREATE TABLE IF NOT EXISTS manuals (
  id           TEXT PRIMARY KEY,
  model_id     TEXT NOT NULL REFERENCES models(id),
  code         TEXT NOT NULL,                 -- 手册编号，如 FAN-X1
  revision     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','approved','withdrawn')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at  TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  withdrawn_reason TEXT,
  UNIQUE (model_id, code, revision)
);
CREATE INDEX IF NOT EXISTS idx_manuals_model ON manuals(model_id);

-- 步骤版本：revision 随其所属手册修订固定；content_hash 用于逐项继承比对
CREATE TABLE IF NOT EXISTS steps (
  id                TEXT PRIMARY KEY,
  manual_id         TEXT NOT NULL REFERENCES manuals(id),
  step_no           INTEGER NOT NULL,
  key_code          TEXT NOT NULL,            -- 稳定逻辑键（跨修订识别同一步骤）
  title             TEXT NOT NULL,
  content           TEXT NOT NULL,
  content_hash      TEXT NOT NULL,           -- sha256(title|content|关键约束)
  depends_on_keys   JSONB NOT NULL DEFAULT '[]',
  safety_critical   BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (manual_id, step_no),
  UNIQUE (manual_id, key_code)
);
CREATE INDEX IF NOT EXISTS idx_steps_manual ON steps(manual_id);

-- 故障码条目：码值本身不是全局唯一，(code, model_id) 才确定含义
CREATE TABLE IF NOT EXISTS fault_codes (
  id                TEXT PRIMARY KEY,
  model_id          TEXT NOT NULL REFERENCES models(id),
  code              TEXT NOT NULL,
  meaning           TEXT NOT NULL,
  severity          TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  symptoms          JSONB NOT NULL DEFAULT '[]',
  resolution_summary TEXT NOT NULL DEFAULT '',
  manual_id         TEXT REFERENCES manuals(id),
  status            TEXT NOT NULL DEFAULT 'approved'
                      CHECK (status IN ('draft','approved')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (model_id, code)
);
CREATE INDEX IF NOT EXISTS idx_fault_codes_code ON fault_codes(code);

CREATE TABLE IF NOT EXISTS parts (
  id          TEXT PRIMARY KEY,
  part_no     TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  model_id    TEXT REFERENCES models(id),     -- NULL = 多机型通用
  uom         TEXT NOT NULL DEFAULT '件',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 备件兼容/替代：有方向的边 (from_part -> to_part)，带生效机型/序列/日期范围。
-- 绝不通过该表做无条件传递：A->B、B->C 不能推出 A->C。
CREATE TABLE IF NOT EXISTS part_substitutions (
  id              TEXT PRIMARY KEY,
  from_part_id    TEXT NOT NULL REFERENCES parts(id),
  to_part_id      TEXT NOT NULL REFERENCES parts(id),
  direction_note  TEXT NOT NULL DEFAULT 'forward_only',
                  -- forward_only=仅正向; declared_pair=显式声明的双向互换
  applicable_models JSONB NOT NULL DEFAULT '[]',   -- [] 表示不限机型
  serial_range    JSONB NOT NULL DEFAULT '{}',     -- {from,to} 可空
  effective_from  DATE,
  effective_to    DATE,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','inactive')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_part_id <> to_part_id)
);
CREATE INDEX IF NOT EXISTS idx_subst_from ON part_substitutions(from_part_id, status);

-- 业务服务管理（服务程序）适用范围
CREATE TABLE IF NOT EXISTS service_programs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  applies_models  JSONB NOT NULL DEFAULT '[]',  -- 机型白名单，[]=全部
  applies_serials JSONB NOT NULL DEFAULT '{}',  -- 序列号范围
  warranty_months INTEGER,
  coverage_note   TEXT NOT NULL DEFAULT '',
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS service_program_manuals (
  id         TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES service_programs(id) ON DELETE CASCADE,
  manual_id  TEXT NOT NULL REFERENCES manuals(id),
  UNIQUE (program_id, manual_id)
);

-- 工单：离线勾选时绑定手册快照（manual_revision 固定，不随后续改版漂移）
CREATE TABLE IF NOT EXISTS work_orders (
  id                 TEXT PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE,
  model_id           TEXT NOT NULL REFERENCES models(id),
  serial_no          TEXT NOT NULL DEFAULT '',
  program_id         TEXT REFERENCES service_programs(id),
  manual_id          TEXT NOT NULL REFERENCES manuals(id),
  manual_code        TEXT NOT NULL,           -- 冗余留存，便于打印追溯
  manual_revision    INTEGER NOT NULL,
  snapshot_hash      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','completed','synced','conflict')),
  technician         TEXT NOT NULL DEFAULT '',
  completion_note    TEXT NOT NULL DEFAULT '',
  rebase             JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ
);

-- 现场步骤执行记录（逐项，带客户端去重 ID 与基础版本，用于冲突检测）
CREATE TABLE IF NOT EXISTS step_events (
  id                TEXT PRIMARY KEY,
  work_order_id     TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  step_key          TEXT NOT NULL,
  step_no           INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,            -- 勾选时步骤内容指纹
  action            TEXT NOT NULL CHECK (action IN ('check','uncheck')),
  base_event_id     TEXT,                     -- 乐观并发：客户端看到的最后状态
  client_event_id   TEXT NOT NULL UNIQUE,     -- 离线幂等去重
  technician        TEXT NOT NULL DEFAULT '',
  note              TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_step_events_wo ON step_events(work_order_id);

-- 现场证据（照片等）。允许晚传：工单可先完成，证据后补，不丢失。
CREATE TABLE IF NOT EXISTS evidence (
  id               TEXT PRIMARY KEY,
  work_order_id    TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  step_key         TEXT NOT NULL DEFAULT '',
  filename         TEXT NOT NULL,
  mime             TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes       INTEGER NOT NULL DEFAULT 0,
  sha256           TEXT NOT NULL DEFAULT '',
  client_evidence_id TEXT NOT NULL UNIQUE,
  captured_at      TIMESTAMPTZ NOT NULL,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  late             BOOLEAN NOT NULL DEFAULT false  -- 工单完成后补传标记
);
CREATE INDEX IF NOT EXISTS idx_evidence_wo ON evidence(work_order_id);

-- 任务依赖（按任务打包时的闭包来源），引用步骤逻辑键
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  manual_id   TEXT NOT NULL REFERENCES manuals(id),
  step_key    TEXT NOT NULL,
  label       TEXT NOT NULL,
  depends_on  JSONB NOT NULL DEFAULT '[]',
  UNIQUE (manual_id, step_key)
);

-- 打包记录：整机型包 vs 任务依赖包；撤回不删除，保留状态与原因
CREATE TABLE IF NOT EXISTS packages (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('full_model','task_deps')),
  model_id        TEXT NOT NULL REFERENCES models(id),
  manual_id       TEXT NOT NULL REFERENCES manuals(id),
  manual_revision INTEGER NOT NULL,
  root_task_keys  JSONB NOT NULL DEFAULT '[]',
  included_keys   JSONB NOT NULL DEFAULT '[]',
  manifest_hash   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','withdrawn')),
  withdrawn_reason TEXT,
  withdrawn_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同步冲突登记（云端与离线不一致时显式呈现，不静默覆盖）
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id              TEXT PRIMARY KEY,
  work_order_id   TEXT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL,
  remote_action   TEXT,
  remote_event_id TEXT,
  local_action    TEXT,
  local_event_id  TEXT,
  detail          TEXT NOT NULL DEFAULT '',
  resolved        BOOLEAN NOT NULL DEFAULT false,
  resolution      TEXT,
  resolve_note    TEXT NOT NULL DEFAULT '',
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
