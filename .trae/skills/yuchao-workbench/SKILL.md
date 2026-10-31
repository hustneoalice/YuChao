---
name: yuchao-workbench
description: 驭潮 YuChao A股看盘工作台的构建与扩展指南，沉淀策影对标、DuckDB 底座、东财采集、更新编排四道防线与界面设计的全部踩坑经验。Use when developing inside the YuChao repo — adding data modules, collectors or pages, debugging 采集/更新/界面 issues, or forking it into a personal investment workbench.
---

# 驭潮工作台 · 构建与扩展指南

你在 YuChao（驭潮）仓库内工作：FastAPI + DuckDB 单文件后端（零重型依赖），
vite + 原生 TS + klinecharts v10 前端。设计基线继承自实盘验证的 1.0（strategy-lens），
对标策影 huashu3.0 的成熟逻辑——只参考实现思路，不复制其代码。

## 项目地图

```
app/
  updater/            ← 唯一写者进程（python -m app.updater）
    registry.py         任务注册表：kind 元数据 + 守卫声明 + CRON_CHAIN 单处定义
    orchestrator.py     编排器：前置守卫/写后防线/失败重试/落账
    scheduler.py        交易日 cron 调度链
    selfheal.py         自愈心跳：链位补偿
    trading_calendar.py 交易日历 + calendar_health
    writer.py           写连接：ensure_schema（NEW_TABLES_DDL + MIGRATIONS）
    collectors/
      sources.py        原始采集函数（东财/腾讯/新浪 HTTP 细节全在这）
      http.py           统一请求层：UA池/退避/伪装页检测/域名轮换/symbol 转换
      normalize.py      归一化：单位自证纠偏 + guard_rows 深校验
      <name>.py         各任务采集器 update_xxx(progress, ctx) -> dict
      backup.py         整库快照
  foundation/         ← 只读查询层
    db.py               DDL 单处定义 + ASOF 复权视图
    repo/               纯 SQL 查询（market/sectors/corepicks/data/health）
  contracts/            Pydantic 契约（契约先行的源头）
  routers/              端点（薄壳，调 repo）
  stream/               SSE 事件总线（文件总线/Redis backplane）
  auth/                 SQLite 用户态（与行情库分库）
frontend/
  src/pages/*.ts        每页一个模块（market/kline/watchlist/sectors/corepicks/cards/settings）
  src/api.ts            只依赖 clients/ts/yuchao.d.ts（gen_ts_client.sh 生成）
scripts/
  ensure_schema.py      老库升级入口（幂等）
  audit_data.py         只读数据体检
  gen_ts_client.sh      契约 → TS 客户端
tests/
  conftest.py           duckdb_file 夹具：建视图 + MIGRATIONS + seed 数据
```

## 铁律（全是真实故障换来的，动手前先读）

1. **双进程读写分离**：API 进程对 DuckDB 全程 READ_ONLY；写全部收敛进 updater。
   DuckDB 写锁排他——任务只在执行窗口持锁，写完立刻 `writer.reset()` 让位；
   updater 内调外部 API 用 per-request 连接（线程缓存连接会把写锁耗尽到永久失败）。
2. **契约先行**：加字段 = contracts/ 加声明 → router 暴露 → `bash scripts/gen_ts_client.sh`。
   pydantic response_model 会**静默过滤**未声明字段——契约漏写不报错，前端拿到的就是缺字段。
3. **口径单处定义**：不复权存储 + 查询层 ASOF 派生前/后复权；DDL 只有一份。
4. **schema 分发三路**：新表进 `db.py NEW_TABLES_DDL`；存量表加列进 `MIGRATIONS`
   （`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 幂等）；`tests/conftest.py` 镜像执行。
   老库靠 `scripts/ensure_schema.py` 与 packaging.import 换库后重建兜底。
5. **守卫声明式**：freshness/needs/min_rows 全在 registry.py 声明，不在代码里散落 if。
6. **每次触发必落账**：update_log 是 freshness 账本模式、体检、自愈的共同依赖；
   落账异常只告警不外抛（外抛会杀死 worker 线程、冻死队列）。
7. **采集数据先自证再入库**：normalize 归一化 + 隐含均价纠偏（防 100 倍量纲脏数据）
   + guard_rows 深校验（防空壳/浅数据/OHLC 非法）。
8. **界面零硬编码色值**：三层 token（原始色板→语义变量→组件），涨跌色方向可切换。

## 拿到项目先跑通（冷启动）

1. README Quickstart：venv + `pip install -e ".[dev]"`。
2. 行情库二选一：Release 下载数据包（`POST /data/init {"mode":"import"}` 三级校验换库）
   或 `{"mode":"backfill"}` 多源回补；然后 `python scripts/ensure_schema.py` 补新表/迁移。
3. 双进程：`python -m app.updater` + `uvicorn app.main:app --port 8800`，`/docs` 验契约。
4. 体检：`python scripts/audit_data.py`（结构/一致性/跨源抽样/日历健康）。

## 新增一个数据模块：七步纵切（照概念板块 commit 41303d8 抄作业）

1. **采集函数** `collectors/sources.py`：`fetch_xxx()` 只管 HTTP——fs= 参数、f 字段映射、
   翻页、0.12s 限流间隔；请求一律走 `http.py`（域名轮换/UA池/symbol 转换）。详见
   [references/data-sources.md](references/data-sources.md)。
2. **采集器** `collectors/<name>.py`：`update_xxx(progress, ctx) -> dict`，返回
   `{"status","rows","detail"}`；快照型 DELETE+INSERT，增量型按 cutoff 补缺口。
   **注意函数内依赖要完整 import**——异常被吞 + 熔断 = 数据静默断供。
3. **schema** `foundation/db.py`：新表进 NEW_TABLES_DDL，存量加列进 MIGRATIONS；
   同步 `tests/conftest.py` 镜像 + seed。
4. **注册** `updater/registry.py`：TASKS 加条目（kind/label/fn 字符串延迟解析/
   freshness/needs/min_rows/description）+ CRON_CHAIN 链位。守卫字段怎么选见
   [references/updater-playbook.md](references/updater-playbook.md)。
5. **查询层** `foundation/repo/<域>.py` 纯 SQL → `contracts/<域>.py` 契约 →
   `routers/` 端点。
6. **前端**：契约定型后 `bash scripts/gen_ts_client.sh`，再写 `src/pages/<page>.ts` +
   index.html + styles.css（只用语义变量，遵守 [references/ui-conventions.md](references/ui-conventions.md)）。
7. **测试**：`test_updater.py` mock 源测采集器（含失败/假成功路径），`test_smoke.py`
   测 API 口径；`.venv/bin/python -m pytest tests/ -q` 全绿 + `npm run build` 再提交。
   可靠性机制必须有回归测试覆盖真实故障场景。

## 踩坑速查（高频 Top 12，完整清单见 references/pitfalls.md）

| 坑 | 对策 |
|---|---|
| DuckDB 写锁排他，长任务持锁 → API 全灭 | 短锁分批写 + writer.reset()；per-request 连接 |
| WAF 假成功（200 但整包垃圾） | min_rows 写后防线 + 伪装页检测 + UA池 + 域名轮换 |
| 东财 push2 keep-alive 短，切股 8s+ | 腾讯批量 GBK 主车道（≤50 只/次）+ 东财兜底缓存 |
| symbol 前缀未转换 → 上游返空误判网络失败 | 一律走 http.py 的 tx_symbol/sina_symbol/market_prefix |
| 单位 100 倍脏数据入库 | normalize 隐含均价自证纠偏 |
| 连续失败不熔断 → 空转 2 小时 | 连续 40 只失败早停 + 车道熔断 300s + 半开探测 |
| klinecharts v10 画布空白无报错 | dataLoader 门控：setSymbol/setPeriod 必须先显式配置 |
| 最新 K 线右侧多 50px 空隙 | offsetRightDistance 显式设 0 |
| 前端拿到的字段缺失 | pydantic response_model 静默过滤未声明字段，契约补全 |
| [hidden] 元素意外显示 | 全局 `[hidden]{display:none!important}` 压过 display:flex |
| 下拉点击被吞 | innerHTML 重渲染吞事件 → 事件委托 + 定点 span 插入 |
| 交易日历依赖包过期 → 幽灵交易日 | calendar_health 断言覆盖当年次年，进体检报警 |

## 深入阅读（按需加载，勿整包读入）

- [references/pitfalls.md](references/pitfalls.md) — 全部 30+ 条踩坑：症状→根因→对策。
  排障、code review、设计评审前先扫对应分区。
- [references/data-sources.md](references/data-sources.md) — 采集手册：东财/腾讯/新浪
  接口模式、f 字段映射、车道轮换、新数据源接入 checklist。写采集代码前读。
- [references/updater-playbook.md](references/updater-playbook.md) — 更新编排：四道防线、
  registry 字段全解、进程模型、备份/体检/数据包。动 orchestrator/registry 前读。
- [references/ui-conventions.md](references/ui-conventions.md) — 界面约定：klinecharts v10
  配置、主题 token、交互细节、移动端。写前端前读。

## 边界

- 只参考策影成熟逻辑与踩坑教训，不复制其代码；保持代码库干净无冗余业务模块。
- 服务端脱敏：VIP 未授权 403 不返回数据，不靠前端隐藏。
- 不引入重型框架（LangGraph/CrewAI/前端大框架）；DuckDB 单文件是特性不是局限。
