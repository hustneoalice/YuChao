# 多租户定时任务 + 自然语言设任务：设计与技术选型

日期：2026-11-06。状态：设计定稿，未实施。范围：驭潮的「用户自建定时任务」与「自然语言创建/修改任务」。

> 与 `2026-11-05-yuchao-ai-personal-tenants-proposal.md` 的关系：那篇在"技术结构"一节推荐 LangGraph + Celery + Redis + PostgreSQL，是按 SaaS 规模预设的重方案；本次按实际约束（单机、散户自部署、单进程）改为**轻量路线**，只保留其多租户隔离与任务账本的思想。两者冲突时以本文为准。

---

## 0. 结论摘要

| 决策点 | 选择 | 一句话理由 |
|---|---|---|
| 租户模型 | 一人一租户，`tenant_id` 与 `user_id` 分离但不建团队 | 不预设未提出的团队/成员功能，后续可平滑演进 |
| 任务存储 | SQLite（用户态库）新增 `ai_tasks` / `ai_task_runs` / `delivery_outbox` | 与现有 `users` / `user_prefs` 同库同事务域 |
| 调度器 | 复用进程内 APScheduler + **每分钟到期扫描** | 不给每个用户任务注册 job，避免 job 爆炸 |
| 时间语义 | 支持 `cron`、`after_task`（事件驱动）、`manual`；默认交易日 + Asia/Shanghai | 20:00 是核心标计算时间，不是可推送时间 |
| 编排 | 自研 YAML/JSON 技能执行器 + `pydantic-ai-slim[openai]` 做槽位抽取 | 流程确定性，模型只填参数 |
| 自然语言 | 只出**结构化槽位**，服务端编译 cron；落库前必须预览确认 | 模型不生成 cron/不直接执行 SQL |
| 推送 | 复用 `feishu_send` + webhook，新增 outbox 与幂等键 | 已有凭据、限流与 `push_last` 机制 |
| 升级阈值 | >200 租户 / >5000 任务 / 需分钟级以下 → Celery+Redis 或外置调度 | 明确何时换重方案，避免过早引入 |

---

## 1. 目标与非目标

**要做**

- 用户用自然语言创建/修改/停用/删除定时任务，例如"每个交易日晚上八点把核心标推送飞书"。
- 多租户隔离：每个用户只能看到与操作自己的任务、凭据、运行记录。
- 可解释：每次运行留痕（用了哪个工具、数据截止哪天、为什么没推）。
- 失败可见：数据未就绪、渠道未配置、额度超限都有明确状态，不静默吞掉。

**不做（本阶段）**

- 团队/成员/邀请；共享技能市场（P3 再谈）。
- 任意代码执行、任意 URL 抓取、自由多智能体协商。
- 亚分钟级盯盘（受行情源与采集链水位限制，见 §5.3）。
- 把模型网络等待放进行情写入流程。

---

## 2. 现状核验（已有 vs 缺口）

| 能力 | 现状 | 位置 |
|---|---|---|
| 用户与偏好 | SQLite `users` / `user_prefs`，按 `user_id` 存，深合并写 | `app/auth/store.py`、`app/auth/service.py` |
| 套餐 | `tier` + `effective_tier()`，VIP 过期自动回落 free | `app/auth/service.py` |
| 调度 | APScheduler `BackgroundScheduler`，时区 Asia/Shanghai，`coalesce` + `max_instances=1` | `app/updater/scheduler.py` |
| 交易日守卫 | `is_trading_day(now_cst())` 在提交层拦截，节假日不建账 | `app/updater/scheduler.py` |
| 固定链 | 08:35 推核心标、17:00 K线、17:20 target_scan、20:00 核心标 | `app/updater/registry.py` `CRON_CHAIN` |
| 用户自定义时间 | "两点乾坤"：`push_times` 多个 HH:MM，每分钟探测，只读 SQLite | `scheduler._minute_tick` + `integrations.due_push_users` |
| 推送幂等 | `push_last = "YYYY-MM-DD HH:MM"`，同时段不重复 | `integrations.mark_feishu_pushed` |
| 飞书发送 | `feishu_send(webhook, secret, payload)`，签名校验 | `app/integrations.py` |
| 核心标产物 | DuckDB `corepicks_result`（`date, pool, sector, symbol, rank, fund_score, seg`） | `app/foundation/db.py` |
| 新鲜度守卫 | `fresh_gate(conn, kind)`，日线最多落后 1 个交易日 | `app/foundation/repo/freshness.py` |

**缺口**

1. 没有 `ai_tasks` 这类**用户任务表**；现有 `_minute_tick` 只推固定内容"两点乾坤"，不能跑任意技能。
2. 没有 `tenant_id`；所有用户态对象目前仅按 `user_id` 隔离。
3. 没有运行账本（`ai_task_runs`）与投递 outbox，失败无痕。
4. 没有"自然语言 → 结构化任务"的编译与预览确认链路。
5. Webhook 与模型 key 目前为明文存储（旧文已指出），多租户前必须加密。

---

## 3. 领域模型

```
tenant（个人空间，1:1 user）
  └── ai_task（用户任务：一个规则 + 一个时间语义 + 一个动作）
        └── ai_task_run（一次执行，幂等键 = task + trade_date + slot）
              └── delivery_outbox（一次投递，独立幂等键，可重试）
```

**三个关键判定**

- **租户 = 个人**：`tenant_id` 独立字段，默认等于 `user_id` 派生值；查询一律由认证上下文注入，客户端不得传 `tenant_id`。这样将来加团队时只需加 `tenant_members`，不必改表。
- **任务 ≠ 系统采集任务**：`ai_tasks` 只读市场数据，**不写 DuckDB**。需要写（推送、任务状态）只落 SQLite。系统采集链（`registry.TASKS`）保持不动。
- **规则 ≠ 技能**：任务是"某技能 + 某个时间 + 某个投递渠道"的组合；技能是可复用流程（如 `review_daily`），任务引用技能 id，不重复定义流程。

---

## 4. 数据模型（SQLite）

```sql
-- 用户任务
CREATE TABLE ai_tasks (
  id             TEXT PRIMARY KEY,           -- uuid4
  tenant_id      TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  name           TEXT NOT NULL,              -- 用户可读名称，可从话术回填
  skill_id       TEXT NOT NULL,              -- 引用技能，如 corepicks_daily
  skill_ver      INTEGER NOT NULL DEFAULT 1, -- 技能版本，升级后可提示重解析
  spec_json      TEXT NOT NULL,              -- 结构化槽位（见 §6.2）
  schedule_kind  TEXT NOT NULL,              -- cron | after_task | manual
  cron_expr      TEXT,                       -- 仅 cron，服务端编译产物
  after_task     TEXT,                       -- 如 corepicks
  tz             TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  trading_only   INTEGER NOT NULL DEFAULT 1,
  target_json    TEXT NOT NULL,              -- corepicks / 自选分组 / 条件对象
  action_json    TEXT NOT NULL,              -- feishu / inbox / template
  enabled        INTEGER NOT NULL DEFAULT 1,
  next_run_at    TEXT,                       -- 'YYYY-MM-DD HH:MM'，扫描索引
  last_run_at    TEXT,
  last_status    TEXT,                       -- ok | skipped | failed | blocked
  last_message   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX ix_ai_tasks_due ON ai_tasks(enabled, next_run_at);
CREATE INDEX ix_ai_tasks_tenant ON ai_tasks(tenant_id, created_at);

-- 执行账本
CREATE TABLE ai_task_runs (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  trade_date  TEXT NOT NULL,
  slot        TEXT NOT NULL,                 -- '20:00' / 'after:corepicks'
  status      TEXT NOT NULL,                 -- running | ok | skipped | failed
  started_at  TEXT, finished_at TEXT,
  steps_json  TEXT,                          -- [{tool,ms,data_date,rows,status}]
  error       TEXT,
  UNIQUE(task_id, trade_date, slot)          -- 幂等：同一时段只跑一次
);

-- 投递 outbox（与执行解耦，失败可重投）
CREATE TABLE delivery_outbox (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  channel        TEXT NOT NULL,              -- feishu | inbox
  payload_json   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  dedupe_key     TEXT NOT NULL,              -- tenant + task + trade_date + slot
  UNIQUE(tenant_id, dedupe_key)
);
```

选 SQLite 而非 PostgreSQL 的理由：用户态本来就在 SQLite，任务与 `user_prefs` 需要同事务；个人版单机并发低。代价是并发写串行，靠 `WAL` + 短事务 + 每分钟批量扫描规避（单批 ≤ 200 行）。

---

## 5. 调度架构

### 5.1 不给每个任务注册一个 APScheduler job

N 租户 × M 任务会让 jobstore 线性膨胀，且每次改任务都要 `add_job/remove_job`，重启丢失风险高。采用**两层**：

```
APScheduler（固定几个系统 job，不变）
  cron:task_tick           每分钟      —— 到期扫描用户任务
  cron:corepicks_done      20:00-23:00 每 10 分钟 —— 核心标完成检测（复用现有 retry 思路）
  cron:outbox_drain        每分钟      —— 投递重试

用户任务 = 一张表 + next_run_at 索引，不注册为 job
```

扫描实现要点：

```python
def _task_tick(orchestrator):
    now = now_cst()
    if not is_trading_day(now):
        return                                   # 节假日不跑、不记
    due = store.due_tasks(now.strftime("%Y-%m-%d %H:%M"))   # 只读 SQLite
    for t in due:
        run_id = store.claim_run(t, trade_date=now.strftime("%Y-%m-%d"))
        if run_id is None:
            continue                             # 唯一键冲突 = 已被别的 tick 认领
        executor.submit(t.skill_id, t.spec_json, run_id=run_id, tenant=t.tenant_id)
```

- **认领靠数据库唯一键**，不靠内存锁，进程重启也不会重复。
- 执行放线程池（`max_workers=4`），只读 DuckDB 用只读连接；重活仍交给 `orchestrator`，避免与采集写入抢锁。

### 5.2 三种时间语义

| kind | 语义 | 适用 |
|---|---|---|
| `cron` | 服务端编译出的 crontab（交易日过滤由 `trading_only` 叠加） | "每个交易日 21:00" |
| `after_task` | 依赖某个系统任务成功后再跑（`corepicks` / `kline_update` / `target_scan`） | "核心标算完就推" |
| `manual` | 仅手动触发（`run-now`） | "先存着，我手动跑" |

**推荐默认 `after_task`**，因为用户口述的时间常常是"数据还没好"的时间。系统任务完成事件由 orchestrator 的 `on_success` 回调触发 `_task_tick(kind=after)`，而无依赖的任务仍走每分钟扫描。

### 5.3 时间与数据语义（最容易出错的地方）

- 时区固定 `Asia/Shanghai`，不做夏令时推断；`now_cst()` 单点取时。
- **交易日**必须过 `is_trading_day`，不能用 `day_of_week=mon-fri` 近似（法定节假日会误推）。
- **推送时间必须晚于数据水位**：17:00 K线 → 17:20 target_scan → 17:30 财务 → 20:00 核心标（失败重试至 23:00）。所以"晚上八点推核心标"应改成 `after_task: corepicks` 或 `21:00` 兜底。
- 每次运行前过 `fresh_gate`；过期就记 `skipped` 并写原因，**不推旧数字**。若用户要求"到点必发"，则发"数据未就绪 + 数据日期"，仍不带旧值。
- 盘中任务只允许用 `market_snapshot` / `minute` 口径，并在卡片标注"盘中，非收盘确认"。

### 5.4 幂等与防重

四层：

1. `ai_task_runs UNIQUE(task_id, trade_date, slot)` — 同一时段只跑一次。
2. `delivery_outbox UNIQUE(tenant_id, dedupe_key)` — 同一内容只投一次。
3. `integrations.push_last` — 兼容现有"两点乾坤"路径。
4. 变更接口的 `Idempotency-Key` — 双击/网络重试不会建出两个任务。

---

## 6. 自然语言 → 任务

### 6.1 链路

```
用户话术
  → 意图识别（create / update / pause / delete / list / explain）
  → 槽位抽取（结构化输出，只填枚举与数字，允许多轮追问）
  → 服务端编译（选择 skill、生成 cron 或依赖任务、套模板）
  → 校验（时间 / 交易日 / 渠道 / 配额 / 数据依赖 / 权限）
  → 草稿预览卡（下次运行时间、依赖、推送到哪、样例内容）
  → 用户确认（写库，返回 task_id）
```

**模型不产出**：cron 字符串、SQL、Python、webhook 地址、租户 id。这些一律由服务端从白名单生成。

### 6.2 槽位 schema

```json
{
  "intent": "create",
  "when":   { "type": "after_task", "task": "corepicks", "fallback": "21:00" },
  "days":   { "trading_only": true, "exclude_holidays": true },
  "target": { "kind": "corepicks", "pool": ["chase", "dip"] },
  "content":{ "template": "corepicks_card",
              "fields": ["name", "score", "sector", "seg"] },
  "channel":{ "kind": "feishu", "bind": "primary" },
  "limits": { "max_items": 10, "min_interval_min": 15 }
}
```

槽位白名单（枚举化，越界直接拒绝）：

| 槽位 | 取值 | 缺省 |
|---|---|---|
| `when.type` | `cron` / `after_task` / `manual` | `after_task`（若话术含具体时刻则 `cron`） |
| `when.task` | `corepicks` / `kline_update` / `target_scan` / `financials` | — |
| `target.kind` | `corepicks` / `watch_group` / `conds` | `corepicks` |
| `content.template` | `corepicks_card` / `review_card` / `target_card` / `text` | 按 skill 默认 |
| `channel.kind` | `feishu` / `inbox` | `inbox`（未配置 webhook 时的降级） |

### 6.3 校验规则（服务端，非提示词）

| 校验 | 规则 | 失败返回 |
|---|---|---|
| 时间合法性 | hour ∈ 0–23、minute ∈ 0–59；"晚上八点"→ 20，不得落成 8 | `invalid_time` + 建议值 |
| 时区 | 仅 `Asia/Shanghai` | `invalid_tz` |
| 交易日 | `trading_only` 默认 true；显式要求周末则告警 | `warn` |
| 数据依赖 | `after_task` 的任务必须存在于系统任务表 | `unknown_dependency` |
| 数据水位 | cron 时间早于依赖产物水位时给出**硬提示** | `too_early` + 建议改 `after_task` |
| 渠道 | `push_enabled` + `webhook_url` 存在，否则建任务但 `blocked` | `channel_not_configured` |
| 配额 | free ≤ 3 个任务、pro ≤ 20；最小间隔 ≥ 15 分钟；每日推送 ≤ 30 条 | `quota_exceeded` |
| 目标合法性 | `pool` 必须属于 `chase` / `dip`；自定义条件必须过 `list_conditions` | `invalid_target` |
| 权限 | 任务引用的技能/工具在租户套餐内 | `plan_required` |

### 6.4 多轮追问

缺槽位时一次只问一个，且给默认值："核心标两个池（打板 chase / 低吸 dip），你要都推，还是只推 chase？" 用户答"都要"即补齐。**不允许模型自行假设**。

### 6.5 变更与删除

- "改成九点" → `update` 只改 `cron_expr` 与 `next_run_at`，保留 `spec_json` 其余字段。
- "先停掉" → `enabled=0`，保留运行历史。
- "删掉" → 二次确认后软删（`deleted_at`），outbox 中未投递的置 `cancelled`。
- 每次变更都返回**差异卡**（旧值 → 新值），不做静默修改。

### 6.6 必须同时提供表单

纯对话不可维护：规则卡必须可在页面上编辑（时间、标的池、字段、渠道），对话只是快捷入口。否则用户改一个字段要重新描述整段话。

---

## 7. 多租户隔离与安全

### 7.1 隔离矩阵

| 资源 | 隔离键 | 强制点 |
|---|---|---|
| `ai_tasks` / `ai_task_runs` / `delivery_outbox` | `tenant_id` | 仓储层强制参数 + 路由层从认证注入 |
| 用户偏好 / webhook / 模型 key | `user_id`（1:1 tenant） | `auth.service`，禁止跨用户读取 |
| 市场数据（DuckDB） | 共享只读 | 只读连接，任务不可写 |
| 缓存 | `public:*` 与 `t:{tenant}:*` 前缀 | 命中前校验前缀 |
| SSE 会话 | `tenant_id` 绑定 | 建流时写入上下文，事件不跨流复用 |
| 渠道身份 | `channel_bindings(open_id → user_id)` | 一次性绑定，不信任消息里的 tenant_id |

### 7.2 凭据

- Webhook URL 与 secret、模型 key 加密存储（`cryptography` Fernet，主密钥来自环境变量），接口回显脱敏（只露末尾 6 位）。
- 日志与异常信息统一脱敏：URL 中的 `hook/` 后内容、`Bearer`、`sk-` 前缀。
- 出站地址白名单：仅 `open.feishu.cn` 与明确的推送端点；SSRF 防护在客户端层做。

### 7.3 提示注入与内容安全

- 卡片内容**只由结构化数据渲染**；网页/公告原文只在正文段落引用并标注来源，不进模板变量。
- 任务名、字段值做长度与字符集约束，防止伪造卡片按钮。
- 模型不接触 webhook、租户 id、其他用户数据；工具入参在服务端二次校验。

---

## 8. 失败处理与可观测

| 情形 | 处理 | 用户看到 |
|---|---|---|
| 数据未就绪（`fresh_gate` 拒绝） | 记 `skipped`，不投递；若当日有重试窗口则 10 分钟后重试 1 次 | "11-05 数据未就绪，已跳过，21:10 重试" |
| 系统依赖任务失败（corepicks） | `after_task` 等下一轮（20:00–23:00 每 10 分钟），超 23:00 记 `blocked` | "核心标计算未完成，今日未推送" |
| 飞书发送失败（网络/限流） | outbox 退避重试 1/5/15 分钟，最多 3 次 | "推送失败 3 次：飞书返回 9499 限流" |
| 渠道未配置 | 任务可建，状态 `blocked`，走 `inbox` 降级 | "未配置飞书，已改存站内消息" |
| 额度超限 | 拒绝创建或暂停执行，不偷跑 | "free 版最多 3 个任务，已用 3" |
| 进程重启/错过窗口 | `coalesce=True` + 启动补扫：当日未跑且未过期则立即补一次 | 运行记录里标 `late_run` |

可观测最小集：

- `ai_tasks.last_status / last_message`（列表页直接显示"为什么没推"）。
- `ai_task_runs.steps_json`（每步工具、耗时、数据日期、行数），前端技能时间线直接渲染。
- 管理视图：按租户统计任务数、运行次数、失败率、投递失败原因 Top 3。
- 日志字段统一：`tenant_id / task_id / run_id / slot / status`，便于 grep 与后续接入指标。

---

## 9. 接口设计

```
POST   /api/v1/ai/tasks/draft        # 只解析+校验，返回草稿、next_run_at、warnings（不落库）
POST   /api/v1/ai/tasks              # 确认落库（Idempotency-Key；body = draft_id + 用户最终确认）
GET    /api/v1/ai/tasks              # 当前租户任务列表（含 last_status）
PATCH  /api/v1/ai/tasks/{id}         # 改时间/标的/渠道，返回差异卡
DELETE /api/v1/ai/tasks/{id}         # 软删
POST   /api/v1/ai/tasks/{id}/run-now # 手动跑一次（同样走 run 幂等键）
GET    /api/v1/ai/tasks/{id}/runs    # 运行历史 + steps
GET    /api/v1/ai/tools              # 能力清单（能力页数据源）
GET    /api/v1/ai/skills             # 技能清单（技能页数据源）
POST   /api/v1/ai/chat               # SSE：intent → tool_start → tool_end → token → done
```

SSE 事件与任务卡对齐（前端按事件点亮工具卡）：

```json
{"type":"tool_start","tool":"screen_targets","args":{...}}
{"type":"tool_end","tool":"screen_targets","ms":41,"data_date":"2026-11-05","rows":37}
{"type":"draft","task":{...},"next_run_at":"2026-11-06 21:00","warnings":["20:00 早于核心标完成"]}
```

对话中的写操作（创建/修改/删除）一律先返回 `draft` 事件，前端渲染确认卡后才调 `POST /ai/tasks`。

---

## 10. 技术选型对比

### 10.1 调度

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **APScheduler 进程内 + 到期扫描** | 零新增依赖（已有）、单进程、改任务无需重建 job | 不能水平扩展；多实例需外部锁 | **选用** |
| Celery beat + Redis | 多 worker、重试成熟 | 多两个常驻服务；散户部署成本高 | 超过阈值再上 |
| Temporal | 工作流可恢复、恰好一次语义 | 运维重、学习成本高 | 不采用 |
| system cron + 脚本 | 最简单 | 无 UI 状态、无租户、无幂等 | 不采用 |

**升级阈值**（任一命中即迁移）：>200 活跃租户、>5000 条启用任务、任务需要 <1 分钟粒度、需要多实例部署。迁移时只换"派发层"，`ai_tasks` / `runs` / `outbox` 三张表与执行器保持不变。

### 10.2 Agent / 编排

| 方案 | 结论 | 说明 |
|---|---|---|
| **pydantic-ai-slim[openai]** | 选用 | 只做结构化槽位抽取与工具选择；依赖小；schema 从类型注解生成 |
| 自研 YAML 执行器 | 选用 | 顺序/条件/扇出/降级；流程可控可测；约 300 行 |
| LangGraph | 不用 | 状态机与 checkpointer 对"定时任务"是过重；旧文的该建议在本阶段被取代 |
| openai-agents | 不用 | 与 pydantic-ai 能力重叠，且绑定更深 |
| Dify / Langflow | 不用 | 需要额外服务与运维，与单机 pip 部署冲突 |

**边界**：技能流程由声明决定；模型只在 `max_steps=6` 的白名单内选工具、填参数。超步数或槽位缺失时降级为追问，不自由发挥。

### 10.3 其他

| 维度 | 选择 | 备注 |
|---|---|---|
| 用户态存储 | SQLite（WAL） | 与 `users` / `user_prefs` 同库 |
| 市场数据 | DuckDB 只读 | 任务只读，写入仍由 updater 独占 |
| 流式 | FastAPI SSE | 单机无需 WebSocket |
| 时间 | `zoneinfo` + `now_cst()` | 固定 Asia/Shanghai |
| 交易日 | 现有 `trading_calendar.is_trading_day` | 不近似为周一至周五 |
| 加密 | `cryptography` Fernet | 主密钥走环境变量，不进库 |
| 前端 | 现有原生 TS + 轮询/SSE | 不引入新框架 |

---

## 11. 分期与验收

### P0 · 单租户闭环（先把链路跑通）

1. `ai_tasks` 表 + 仓储（CRUD、`due_tasks`、`claim_run`）。
2. `cron:task_tick` + 执行器 + `feishu_send` 投递 + `ai_task_runs` 留痕。
3. 四个工具：`create_schedule_task` / `list_schedule_tasks` / `update_schedule_task` / `delete_schedule_task`。
4. `draft` / 确认 / `run-now` 三个接口。

**验收**：说"每个交易日晚上八点把核心标推飞书"，系统回答"20:00 是计算时间，建议算完即推或 21:00"，给出草稿卡；确认后次日收到卡片；同日重复 tick 不重复推送；数据过期时记 `skipped` 而非推旧数。

### P1 · 多租户隔离

1. 全表加 `tenant_id`，认证上下文注入；客户端不可指定。
2. 凭据加密 + 脱敏回显 + 日志脱敏。
3. 配额（任务数 / 最小间隔 / 每日推送）按 `tier` 生效。

**验收**：A 用户拿到 B 用户的 `task_id` 请求返回 404 而非 403 泄漏存在性；A 的 webhook 不出现在 B 的响应/日志；free 用户第 4 个任务被拒。

### P2 · 事件驱动与通知治理

1. `after_task` 依赖触发（核心标完成 → 推送）。
2. 冷却与合并：同一标的同一事件 24 小时内不重复；多条任务合并为一条日报。
3. 每日上限与静默时段。

**验收**：核心标 20:40 才算完，21:00 的任务仍能取到当日数据；采集失败当日只推一条"未就绪"，不刷屏。

### P3 · 渠道扩展

- 飞书应用机器人（菜单、卡片按钮回调）与微信服务号入口；按钮事件进同一权限与任务服务。
- 与旧文"六、渠道"一致，本轮不承诺具体消息额度。

---

## 12. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| 用户口中的时间早于数据水位 | 推空/推旧 | 编译期硬提示 + 默认 `after_task` |
| DuckDB 读写争用 | 任务读卡住采集写 | 只读连接 + 限并发 + 采集窗口内不跑重任务 |
| 任务爆炸（每用户几十条） | 扫描变慢 | 配额 + `next_run_at` 索引 + 批量扫描 |
| 飞书限流 | 批量推送失败 | outbox 退避 + 每日上限 + 合并推送 |
| 凭据明文 | 多租户泄露 | P1 前必须完成加密迁移 |
| 技能版本升级 | 老任务字段失配 | `skill_ver` 记录，启动时标记"需重解析"，不静默改语义 |
| "核心标"口径歧义 | 推错池 | `target_json` 强制枚举 `chase`/`dip`，追问补齐 |

**开放问题**

1. 免费版是否允许飞书推送，还是只给站内 inbox（涉及滥用成本）。
2. 合并日报的粒度：按租户一天一条，还是按任务分别发。
3. 是否允许用户把任务导出成技能分享（P3 的生态入口），以及导出时的凭据剥离方式。

---

## 13. 实施顺序（最小改动面）

```
app/foundation/db_user.py     + ai_tasks / ai_task_runs / delivery_outbox DDL
app/tasks/                    + store.py / compile.py / executor.py / dispatch.py
app/updater/scheduler.py      + cron:task_tick / cron:outbox_drain（复用 is_trading_day）
app/updater/embedded.py       + 注册回调（corepicks 成功后触发 after_task 扫描）
app/ai/tools/schedule.py      + 四个任务工具（写操作走确认）
app/routers/v1/ai.py          + draft / tasks CRUD / runs / SSE
frontend/src/pages/ai.ts      + 任务列表、规则卡编辑、运行时间线
```

先做 P0 的 3 张表 + `task_tick` + 一个 `corepicks_daily` 技能，即可端到端验证；其余按分期推进。
