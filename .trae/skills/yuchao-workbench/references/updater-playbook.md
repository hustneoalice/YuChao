# 更新编排手册 · 四道防线与进程模型

动 `orchestrator.py` / `registry.py` / `scheduler.py` / `writer.py` 前先读本篇。
对标基线：策影的四类已证漏洞——失败即终局、依赖=纯 cron 错开、新鲜度不前置、零备份。
驭潮的四道防线 + 备份 + 日历体检逐条对应补齐。

## 进程模型（先理解这个，一切都顺了）

- **双进程**：`python -m app.updater`（唯一写者）与 `uvicorn app.main:app`（只读挂载）。
- fn 用「模块:函数」字符串延迟解析（`registry.resolve_fn`）——API 进程只读元数据，
  不 import 任何 DuckDB/采集器代码，读写分进程约束不被破坏。
- **锁纪律**：DuckDB 写连接排他。任务执行窗口持锁，结束即 `writer.reset()`；
  updater 内调外部 API 一律 per-request 连接（线程缓存 + 空闲收割 + 前端轮询
  = 150s 写锁耗尽永久失败，pitfalls 10）。
- 手动触发：API `POST /data/update` 只落控制请求，updater 消费执行；
  结果以 `GET /data/updates` 落账为准。

## 任务生命周期（orchestrator._run_task）

```
submit(kind, trigger, params)                    # force=True 会合入 params
  → scheduler（cron 链）→ 交易日守卫（非交易日秒跳落账）
  → worker 出队 → _precheck 前置守卫
      freshness 两模式 → 已新即 skipped(fresh)（force 越过）
      needs 上游失败传播 → skipped（拒绝拿旧截面硬算）
      预检自身失败一律放行（守卫是优化，不能卡死任务）
  → spec["fn"](progress, ctx)                     # ctx 带 task_id/cancel_check/bus
  → 写后防线：min_rows（快照型专属；增量型 0 行合法）
  → 终态落账：update_log 每次触发必留一行（落账异常只告警不外抛）
  → on_record 回调（selfheal 心跳记账）
  → 失败自动重试：trigger ∈ {cron,selfheal,startup,retry} 且 attempt<2
      threading.Timer(300/900s) → submit(trigger="retry", attempt=n, force=True)
  → writer.reset()                                # 无条件释放写锁
```

skipped/cancelled 是正常终态：落账 level=info 不是 error（避免运维查不存在的问题）。

## registry 字段全解（app/updater/registry.py TASKS 条目）

| 字段 | 语义 | 何时声明 |
|---|---|---|
| `kind` | 任务类型唯一键，API 校验/落账/链位共用 | 必须 |
| `label` | 展示名 | 必须 |
| `fn` | `"模块:函数"` 字符串，延迟解析 | 必须 |
| `freshness` | `{"table","col"}` 表日期比对 或 `{"log": True}` 账本校验 | 快照/重建型 |
| `needs` | 上游 kind 列表，上游当日 failed → 下游 skip | 有依赖时 |
| `min_rows` | 写后行数下限，低于即判失败进重试 | 快照/重建型 |
| `notify` | `True` = 通知类任务，跳过自愈链位补偿 | feishu_push 等非数据任务 |
| `description` | 一句话说明（链位/来源/口径） | 必须 |

**freshness/min_rows 判断口诀**：快照型（当日全量重建，如板块/估值/PE分位）两个都设；
增量型（cutoff 补缺口，如 K线/资金流/复权因子）都不设——重跑是补缺口，拦了反而坏事。
参考现值：valuation 3000 / sector_index 300 / pe_percentile 2000 / financials 500。

## CRON_CHAIN 与调度

- 北京时间交易日链：08:35 飞书推送 → 15:35 板块 → 16:00 行情 → 16:20 估值 →
  16:30 资金流 → 16:50 PE分位 → 17:00 K线增量 → 17:30 财务 → 18:10 备份 → 21:00 核心标。
- 周六 09:00 复权因子（WEEKLY）。
- 链位元数据单处定义，API `/data/tasks` 直接读 registry，不 import apscheduler。

## 自愈 / 体检 / 备份（运维三件套）

- **selfheal**：心跳记账 + 指数退避补偿（2/10/30 分钟 × 3）；链位超过 15 分钟
  无成功账自动补跑；notify 任务跳过（防止白天重复推送）。
- **calendar_health**：ok / degraded（holidays 未装）/ stale（未覆盖当年或次年），
  进 `scripts/audit_data.py` 体检第 6 项；holidays 包过期 fail-open 是策影实证漏洞。
- **backup**：每日 18:10 CHECKPOINT → copy2 → 副本 read_only 可读校验（数表）→
  滚动保留 7 份（`BACKUP_KEEP`）。热拷贝不 CHECKPOINT = 半写页 = 审计自相矛盾。

## 数据包与冷启动（packaging.py）

- `package_export`：全量快照 `.duckdb` + SHA256 manifest。
- `package_import`：三级校验（SHA256 → 行数 → 抽样）→ 换库（原库 `.bak`）→
  重建 schema（writer.ensure_schema → 迁移全链路覆盖）。
- `backfill`：行情→估值→资金流→K线 串行多源回补（`/data/init {"mode":"backfill"}`）。
- 老库升级：`python scripts/ensure_schema.py` 幂等执行 NEW_TABLES_DDL + MIGRATIONS
  （与 writer.ensure_schema、conftest 镜像同源，schema 永远三路一致）。

## 测试基建（改编排器必配回归）

- `tests/conftest.py`：`duckdb_file` 夹具建 PRICE_VIEW + 跑 MIGRATIONS + seed；
  `updater_env` 隔离模块级单例。
- 失败重试用 `FakeTimer` 捕获参数不真等；`_drain(o)` 轮询队列排空——
  注意 Timer 在落账之后才创建，断言前要短暂轮询（时序竞态教训）。
- freshness 测试用 monkeypatch `expected_asof` 控制日期（夹具数据别落在
  「恰好等于 expected_asof 回退日」的坑里）。
- 每道防线一条「策影真实故障复现」用例：假成功行数不足、上游失败传播、
  交易日幽灵日期、备份可读性。
