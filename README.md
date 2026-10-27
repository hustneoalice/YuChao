# YuChao 驭潮 · 数据底座

> **观潮者看浪，驭潮者乘流。** —— 从"观"到"驭"，一字之差，境界全开。行情如潮水，底座驭之。

**YuChao (驭潮, "Riding the Tide") is the data foundation of StrategyLens (策略镜头)** — a contract-first market-data API for A-shares. Any frontend (official or third-party) can be built purely against the OpenAPI contract + SSE channel protocol, with zero coupling to the backend implementation.

- **契约先行**：Pydantic 契约 → OpenAPI 文档 →（自动生成）TS 客户端；前端可整体替换
- **只读挂载**：API 进程对 DuckDB 全程 `READ_ONLY`；写全部收敛进 updater 进程（M2）
- **口径单处定义**：不复权存储 + 查询层 ASOF 派生前/后复权（qfq 看盘 / hfq 收益），DDL 只有一份
- **实盘验证的继承**：存储口径、更新编排、数据治理自 1.0（[strategy-lens](https://github.com/hustneoalice/strategy-lens)）原样继承，进程模型按多用户重排

## M1 · API 契约

仅凭本文与 `/docs`（OpenAPI）即可完成 **K线 / 板块 / 核心标** 三页对接。

| 域 | 端点 | 说明 |
|---|---|---|
| 行情 | `GET /api/v1/market/kline?symbol=&period=&adjust=qfq\|hfq\|raw&with=indicator\|vip` | 复权在查询层 ASOF 派生；`with=indicator` 返回 MA5/7/10/20/35/45 + std20 + BOLL；VIP 通道未授权 **403 不返回数据** |
| 行情 | `GET /api/v1/market/quote?symbol=` | 最新日线 + 估值（PE/PB/市值）+ 当日资金流 |
| 行情 | `GET /api/v1/market/search?q=` | 代码 / 名称检索（`{items,total,cursor}` 分页信封） |
| 板块 | `GET /api/v1/sectors?type=industry\|concept` | 板块指数按当日涨跌排序（concept 为 2.0 增补，M1 空集） |
| 板块 | `GET /api/v1/sectors/{id}/members?lookback=5\|10\|20` | 成分股按窗口成交额加权涨幅排序，附窗口主力净流入 |
| 核心标 | `GET /api/v1/corepicks?date=&pool=chase\|dip` | 名单公开；三因子明细 VIP 校验后返回（M1 桩 403） |
| 核心标 | `GET /api/v1/corepicks/{symbol}/factors` | 三因子明细（VIP，M1 一律 403） |
| 底座 | `GET /api/v1/data/status·tasks·updates` · `POST /api/v1/data/update` | 状态机+表清单体检 · 任务清单/落账 · 触发更新（202 经控制通道交 updater） |
| 流 | `GET /api/v1/stream/sse?channels=kline:*` | SSE 事件流（频道协议 v1） |
| 元 | `GET /docs` · `/metrics` · `/healthz` | OpenAPI 文档 · Prometheus · 存活探针 |

**错误规约**：`{"code": "...", "message": "...", "detail": ...}`；已知 code：`not_found` / `invalid_param` / `vip_required` / `not_implemented` / `data_not_ready`。

## Quickstart

```bash
git clone https://github.com/hustneoalice/YuChao.git && cd YuChao
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"

# 行情库：初始数据包（GitHub Release，SHA256 校验）或自行初始化
# 放到 data/stock_research.duckdb 后，补齐 2.0 新表与复权视图：
python scripts/ensure_schema.py

# 终端 1：updater 进程（唯一写者：编排/采集/调度）
python -m app.updater

# 终端 2：API 进程（只读挂载）
uvicorn app.main:app --port 8800
open http://127.0.0.1:8800/docs
```

自定义路径：`YUCHAO_DUCKDB_PATH=/path/to/stock_research.duckdb`。

### 更新机制（M2）

- **调度链**（北京时间，节假日自动跳过）：15:35 板块 → 16:00 行情 → 16:20 估值
  → 16:30 资金流 → 16:50 PE 分位 → 17:00 K 线增量 → 17:30 财务；周六 09:00 复权因子。
- **手动触发**：`curl -XPOST :8800/api/v1/data/update -d '{"kind":"valuation"}'` ——
  API 进程只读，落控制请求由 updater 消费；执行结果以 `GET /data/updates` 落账为准。
- **SSE 频道**：`data:update`（任务进度）· `kline:{symbol}:1d`（K 线增量）·
  `corepicks:daily`。帧内 seq 跳号 → 客户端回退 REST 重拉（06.2 协议）。
- **多源降级**：估值 东财→腾讯；K 线 腾讯↔东财；财务/资金流/复权因子为唯一源，
  兜底靠落账告警 + 次日重试。
- 进程模型：DuckDB 写连接排他，updater 只在任务执行窗口持锁，空闲期让位 API。

## 架构（M1 → M2 路线）

```
┌ 前端 SPA（官方或第三方，可整体替换）──────────────────────┐
│   仅依赖：① OpenAPI REST 契约 ② SSE 频道协议（M2）          │
└──────────────┬─────────────────────────────────────────┘
               ▼
┌ API 进程组（FastAPI · READ_ONLY 挂库）──────────────────┐
│  /api/v1/** REST（Pydantic 契约 → OpenAPI）  /metrics    │
└──────┬─────────────────────────────────────────────────┘
       │ read_only attach
┌──────▼─────────────────────────────────────────────────┐
│ DuckDB 行情底座（文件锁=单写者保证；初始数据包秒级导入）  │
└──────▲─────────────────────────────────────────────────┘
       │ 独占写（M2）
┌──────┴─────────────────────────────────────────────────┐
│ updater 进程：update_orchestrator（串行写队列·去重·冷却）│
│ + APScheduler 全天调度链 + Redis publish → SSE backplane │
└────────────────────────────────────────────────────────┘
```

复权口径（自 1.0 原样继承，[app/foundation/db.py](app/foundation/db.py) 单处定义）：

1. 底层 `daily_ohlcv` 一律存**不复权原始价**；
2. 前复权（qfq，看盘口径）最新因子=1，后复权（hfq，收益口径）最早因子=1，ASOF 派生；
3. 无因子品种（指数等）自动退化为原始价。

## 开发

```bash
pytest -q          # 41 项测试：M1 冒烟（契约+三页端点）+ M2（编排器语义/采集幂等/SSE 总线）
```

目录：`app/contracts/`（Pydantic 契约）· `app/foundation/`（db / indicators / repo）· `app/routers/v1/`（端点）· `app/updater/`（编排器/采集器/调度链，唯一写者）· `app/stream/`（事件总线 + SSE 网关）· `scripts/ensure_schema.py`（幂等初始化）。

## License

[AGPL-3.0](LICENSE)（open-core）：本仓库（契约、存储口径、标准指标）开源；VIP 闭源包（短线/中线操盘通道、核心标打分、license 中间件）另行发布。

---

*StrategyLens · 策略镜头 — 观潮知势，驭潮而行。*
