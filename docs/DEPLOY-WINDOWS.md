# Windows 源码部署（本机直跑）

> 目标：clone 下来 → 建 venv → 建库 → 起服务，全程 127.0.0.1，不开 Docker。
> 适用：Windows 10/11 + PowerShell 5.1+，仓库路径 `D:\yuchao`。

## 0. 前置

| 依赖 | 版本 | 检查 |
|---|---|---|
| Python | ≥ 3.11（实测 3.11.9） | `python -V` |
| Node.js | ≥ 18（实测 v24.15.0） | `node -v` |
| Git | 任意 | `git --version` |

## 1. 拉代码

```powershell
git clone https://github.com/hustneoalice/YuChao.git D:\yuchao
cd D:\yuchao
```

国内直连 GitHub 失败时（连接被重置），走本机代理：

```powershell
git -c http.proxy=http://127.0.0.1:7897 clone https://github.com/hustneoalice/YuChao.git .
```

## 2. 后端依赖

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -U pip -i https://pypi.tuna.tsinghua.edu.cn/simple
.\.venv\Scripts\python.exe -m pip install -e ".[dev]" -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## 3. 前端依赖与构建

```powershell
cd frontend
npm install          # 本机 npm 已指向 registry.npmmirror.com
npm run build        # tsc --noEmit + vite build -> frontend/dist
cd ..
```

生产形态不需要 Node 常驻：`frontend/dist` 由后端 8031 直接托管。

## 4. 建库（关键一步）

仓库里没有 `data/stock_research.duckdb`，GitHub Release 也没有初始数据包，
所以本地用 `scripts/bootstrap_db.py` 建「1.0 基础表 + 2.0 新表 + 复权视图 + 种子清单」：

```powershell
.\.venv\Scripts\python.exe scripts\bootstrap_db.py
```

它会建 16 张表 + `v_daily_ohlcv_qfq` / `v_daily_ohlcv_hfq` 两个视图，
并写入 30 只种子股票（库为空时才写；`--no-seed` 可跳过）。幂等，可重复执行。

> 之后也可以走官方路径：`POST /api/v1/data/init {"mode":"import","package":"…duckdb"}`
> 导入带 manifest 的数据包（SHA256→行数→抽样三级校验），或 `{"mode":"backfill"}`
> 多源回补全市场。

## 5. 启动 / 停止 / 查看状态

```powershell
.\scripts\windows\start.ps1          # 生产模式：8031（后端托管 dist）
.\scripts\windows\start.ps1 -Dev     # 开发模式：8031 API + 5178 vite 热更（看 5178）
.\scripts\windows\status.ps1         # 端口 / pid / healthz / 日志尾部
.\scripts\windows\stop.ps1           # 结束 8031 + 5178
```

| 项 | 值 |
|---|---|
| 前端 + API | http://localhost:8031 |
| OpenAPI 文档 | http://127.0.0.1:8031/docs |
| 健康探针 | http://127.0.0.1:8031/healthz |
| 日志 | `.logs\backend.err.log`（应用日志）/ `.logs\backend.out.log`（访问日志） |
| pid | `.logs\backend.pid` / `.logs\frontend.pid` |

`start.ps1` 参数：`-Dev`（起 vite）、`-NoBuild`（不自动构建 dist）、
`-RebuildDb`（重跑建库，幂等）、`-Port` / `-DevPort`（改端口）。

环境变量（可选）：`YUCHAO_DUCKDB_PATH`、`YUCHAO_JWT_SECRET`（生产必设）、
`YUCHAO_API_EMBEDDED_UPDATER=false`（回退成「API 只读 + 独立 updater」双进程）。

## 6. 灌数据

首屏要看到 K 线，得先拉行情。两种方式：

- 界面：底部/设置页「数据底座 → 更新任务」点 K 线增量；
- 命令行：

```powershell
curl.exe -s -X POST http://127.0.0.1:8031/api/v1/data/update `
  -H "Content-Type: application/json" -d "{\"kind\":\"kline_update\",\"force\":true}"
curl.exe -s http://127.0.0.1:8031/api/v1/data/update/state   # 进度
```

`kline_update` 只拉 `stock_universe` 里的标的（种子 30 只，首次每只建底仓 3000 根）。
要全市场：先跑 `valuation`（会从东财全市场快照把 5000+ 只新股并进 universe），
再跑 `kline_update`——耗时以十分钟计，落账见 `GET /api/v1/data/updates`。

调度链（北京时间、节假日跳过）已在内置更新内核里自动跑，无需额外进程。

## 7. 本机实测记录（2026-11-15）

- Python 依赖：duckdb 2.0.0 / fastapi 0.163.1 / uvicorn 0.54.0，`pip install -e ".[dev]"` 通过。
- 前端：`tsc --noEmit` + `vite build` 通过，dist ≈ 474 kB JS + 72 kB CSS。
- `/healthz` 200、`/docs` 200、`/` 200（26708 B），内置更新内核启动（13 条 cron + 控制通道 2s）。
- `pytest -q`：**126 passed / 10 failed**。失败集中在
  ① 断言里写死了英文 kind（`valuation`），而本版本标签是中文；
  ② 与「今天是否交易日 / 数据新鲜度」相关的用例（本次运行是周日）。
  均与部署环境无关，属仓库自带用例漂移。

## 8. 已知坑

1. **GitHub 直连被重置**：git 走代理（`-c http.proxy=…`）；GitHub API 可直连。
2. **没有初始数据包**：`data/*.duckdb` 被 .gitignore 排除，Release 也无资产，
   必须本地建库 + 回补，否则 API 返回 503 `data_not_ready`（属预期）。
3. **DuckDB 单写者**：内置内核模式下 API 与 updater 同进程，无跨进程锁；
   若手动设 `YUCHAO_API_EMBEDDED_UPDATER=false`，要另起 `python -m app.updater`。
4. **日志编码**：Python 侧写 UTF-8；用 `Get-Content -Encoding UTF8` 看，
   否则 PowerShell 5.1 会按 ANSI 解出乱码。
5. **首次写库偏慢**：本机磁盘上 2 万行一批的 `INSERT OR REPLACE` 约 1–2 分钟，
   属磁盘/索引维护开销，不是卡死（看 `data/update_progress.json` 的 `done` 在涨）。

## 9. 切到 `codex/shareholders` 分支（2026-11-15）

最新代码不在 `main`（`main` 停在 2026-11-03 的 `91b6b76`），而在未合并分支
`origin/codex/shareholders`（`4737dca`，比 main 多 19 个提交，282 文件 / +38,649 行）。
本机已切到该分支并跑通，步骤与 main 的差别只有三处：**装依赖带 `ai` extra、
跑一次 schema 迁移、重建前端**。

```powershell
.\scripts\windows\stop.ps1
git fetch --prune --force origin                      # 远端 ref 冲突时先修
git checkout -B codex/shareholders origin/codex/shareholders
.\.venv\Scripts\python.exe -m pip install -e ".[dev,ai]"
.\.venv\Scripts\python.exe scripts\ensure_schema.py   # 关键：补列 + 建 target_tail
cd frontend; npm install; npm run build; cd ..
.\scripts\windows\start.ps1 -NoBuild
```

### 9.1 这个分支在 main 之上加了什么

- **数据库（必须迁移）**：`adjust_factor` 加 `fore_offset` / `back_offset`（场内基金分红
  用加法项，qfq/hfq 视图已改成 `价 * 因子 + offset`）；`target_trend` 加 6 列
  `money_*` / `mine_*`（阶段反转）；`target_scan` 加 `acc_strength` / `dkx_gold_ago` /
  `dkx_death_ago`；新表 `target_tail`（尾盘估算 14:50 后按快照留档）。
  `scripts/bootstrap_db.py` 直接 import `NEW_TABLES_DDL` / `MIGRATIONS` /
  `PRICE_VIEW_DDL`，所以它对新库自动生效；**存量库必须跑 `ensure_schema.py`**。
- **后端新增路由**：`/api/v1/ai/{chat,chat/stream,health,models,indicators,tools}`、
  `/api/v1/market/{mainforce,mainforce-motion,shareholders,depth,intraday,trades,kline}`、
  `/api/v1/corepicks/rotation(/run)`、`/api/v1/admin/users`、`/api/v1/admin/trial`、
  `/api/v1/neo/evaluate`（受签名保护的私有算力路由）。总计 69 条路由。
- **内置管理员**：首次启动自动建 `admin`（`YUCHAO_ADMIN_SEED=false` 可关，
  账号密码用 `YUCHAO_ADMIN_EMAIL` / `YUCHAO_ADMIN_USERNAME` / `YUCHAO_ADMIN_PASSWORD`
  覆盖，默认 `admin/admin123`）。
- **并发采集**：`YUCHAO_KLINE_WORKERS=8`、`YUCHAO_CAPITAL_FLOW_WORKERS=8`
  （线程只做 HTTP，写库仍在主线程串行；设 1 即回退串行）。这是对首次全市场回补
  慢的正解，不需要改 collector。
- **智能问股**：`.[ai]` extra（`pydantic-ai-slim[openai]`）。**不装也能跑**：
  `/ai/health` 返回 `{"mode":"rule"}`，`/ai/chat` 走确定性规则 + 本地指标工具。
  接真模型时用 `YUCHAO_LLM_BASE_URL` / `YUCHAO_LLM_MODEL` / `YUCHAO_LLM_API_KEY`
  （密钥只走环境变量，不入库不入仓），或界面「设置 → 大模型 BYOK」。
- **端侧工程**：`desktop/src-tauri`、`android/`、`harmony/` 是新增目录，
  本机直跑用不到。
- **前端口径**：`package.json` 没变（不需要新 npm 包），但 49 个源码文件有改动，
  dist 必须重建；构建产物 694 kB JS + 169 kB CSS（单 chunk 超 500 kB 有告警，可忽略）。

### 9.2 本机实测（2026-11-15）

- `pip install -e ".[dev,ai]"` 通过：duckdb 2.0.0 / fastapi 0.163.1 / uvicorn 0.54.0 /
  pydantic-ai-slim 2.68.0（`pyproject` 写的是 `>=0.0.40`，pip 会拉最新 2.x）。
- `ensure_schema.py` 幂等跑通，`daily_ohlcv` 86,643 行业务数据未受影响；
  `DESCRIBE` 确认 4 张表的列都已补齐，`target_tail` 已建。
- `npm run build` 通过（tsc + vite，2.05s）。
- `pytest -q`：**196 passed / 9 failed / 1 skipped**（main 是 126 passed / 10 failed；
  分支用例从 136 涨到 206）。9 个失败全是仓库用例漂移或 Windows 特有，不影响服务：
  ① 文案/字段快照过期——`health` 的金融新鲜度徽章改成「三季报 · 最新」、
  `/me/llm` 新增 `prompt` / `prompt_default`、`/me/feishu` 新增 `push_enabled` /
  `push_times`、`/data/update` 的 `available` 已改中文标签且多了 11 种任务、
  离线 503 文案改成「自动更新服务没在运行…」；
  ② 用例读 JSONL 用 `Path.read_text()` 没显式 `encoding="utf-8"`，Windows 默认 GBK
  直接 `UnicodeDecodeError`（`test_orchestrator_publishes_data_update`，Linux 上能过）；
  ③ 依赖「今天是否交易日 / 数据新鲜度」的用例（`test_smoke.py::test_market_targets`、
  `test_target_trend.py`、`test_kline_task_increment` 的 1603≠3）。
  涉及源码侧唯一值得留意的是 `app/foundation/repo/{market,mainforce_cache}.py`
  和 `app/neo/auth.py` 有 4 处 `read_text()` / `json.dump` 没写 `encoding`，
  Windows 下按 GBK 落盘，中文股票名能 round-trip，但遇到 GBK 之外的字符会抛
  `UnicodeEncodeError`（未被 `except OSError` 接住）。本机暂未触发，属于隐患。
- 启动日志：`内置管理员已初始化：admin / admin@yuchao.local`、`编排器就绪：22 种任务`
  （main 是 13 种）、16 条 cron 链 + 控制通道 2s。新增 17:25 主力军情预计算、
  20:00 核心标强轮动、周六 09:15 公司资料、盘中「目标监控重算」interval。
- 冒烟：`/healthz` 200、`/` 200、`/openapi.json`（69 路由）200、
  `/market/kline?symbol=000001` 200、`/market/depth` 200（实时五档，12.07）、
  `/market/mainforce` 200（空列表，需先跑榜单单据）、`/market/shareholders` 200、
  `/corepicks/rotation` 200、`/ai/health` 200（规则模式）、`/ai/chat` 200（规则回答）。
- 登录：`POST /api/v1/auth/login {"identifier":"admin","password":"admin123"}` →
  `{token,user}`；**字段名是 `identifier`，返回的令牌字段是 `token`**（不是
  `access_token`），带 `Authorization: Bearer <token>` 访问 `/auth/me`、`/admin/users` 正常。
- 前端：顶栏出现「规则模式」芯片、「行情数据 · 正常 · 更新至 2026-11-13」；
  行情页工具栏出现 120 分、测距、训练、主图/副图/绘图（黄金分割/支撑压力/浪型结构/
  箱体区间/转折形态）；控制台无错误，仅有未登录时的 `/auth/me` 401。

### 9.3 切回去

```powershell
.\scripts\windows\stop.ps1
git checkout main        # 本地分支 codex/shareholders 保留，随时切回
```

注意：库里已经加了新列/新表，main 的视图仍是纯乘法口径（不读 offset 列），
旧代码不会因为多出来的列报错；但 `fore_offset` 一旦非零，切回 main 后复权价会
与分支不一致——需要就重跑 `scripts\bootstrap_db.py` 重建骨架。

### 9.4 写入性能复测（2026-11-15，分支代码未变）

结论：**新分支的写入路径和 main 完全一样，还是 `executemany + INSERT OR REPLACE`，
一个字没改**。新增的 `YUCHAO_KLINE_WORKERS=8` / `YUCHAO_CAPITAL_FLOW_WORKERS=8`
只让 HTTP 取数并发，写库仍在主线程串行（`kline.py:193` 注释也写明了），所以
首次全市场回补该慢还是慢。

本机实测（`bench_branch.py` / `bench_stage.py` / `bench_csv.py`，临时库预置 80,000 行基线）：

| 写入路径 | 行数 | 耗时 | 吞吐 |
|---|---|---|---|
| 当前代码：`executemany` + `INSERT OR REPLACE`（有主键） | 5,000 | 27.6s | **~180 行/秒** |
| 同上，全部命中主键（纯 UPDATE） | 5,000 | 25.8s | ~194 行/秒 |
| `executemany` → 无主键临时表 → `DELETE`+`INSERT` | 20,000 | 24.4s | ~821 行/秒 |
| Arrow `register` → 临时表 → `DELETE`+`INSERT` | 20,000 | 0.08s | **~266,000 行/秒** |
| CSV `COPY` → 临时表 → `DELETE`+`INSERT`（零新依赖） | 20,000 | 0.21s | ~95,000 行/秒 |

换算到实际任务：

- 首次全市场 K 线回补（5,400 标的 × 3,000 根 ≈ 1,620 万行）：现在光写库约 **25 小时**，
  换成 Arrow/CSV 后 2–3 分钟（瓶颈回到 HTTP）。
- 每日增量（5,400 标的 × 1 根 ≈ 5,400 行）：约 **30 秒**，可接受，不改也能跑。
- 快照 / 估值 / 资金流 / 目标监控：每天各 5,400 行上下，各约 30 秒，可接受。

也就是说：**只跑日常增量不用动；要一次性灌全市场，必须换批量写入**。
`pyproject.toml` 里没有 `pyarrow`（本机是手动装的 26.0.1），CSV COPY 方案不需要
任何新依赖，是改动最小的一条路。

### 9.5 批量写入改造（2026-11-15 深夜，零新依赖）

按 9.4 的结论落地了「CSV → 临时表 → DELETE+INSERT」这条线，**没有引入 pyarrow**。

新增一个文件 `app/foundation/bulk.py`，三个 API（都返回实际写入行数）：

| API | 语义 | 等价于 |
|---|---|---|
| `bulk_upsert(conn, table, columns, rows, keys)` | 按 `keys` 删旧行再灌新行 | `executemany(INSERT OR REPLACE …)` |
| `bulk_insert(conn, table, columns, rows)` | 纯追加（调用方已 DELETE 过） | `executemany(INSERT …)` |
| `bulk_update(conn, table, columns, rows, keys)` | 只更新非键列 | 逐行 `UPDATE … WHERE 键` |

内部流程：`csv` 模块落盘（None 写成 `\N` 哨兵，`NULLSTR` 还原）→ `COPY` 进
无主键 `TEMP` 表 → 一条 `DELETE … WHERE 键 IN (SELECT …)` + 一条 `INSERT SELECT`。
临时表和 CSV 在 `finally` 里清掉；**任何一步失败（磁盘满、COPY 解析、列是数组/
结构体）都自动回退老的 `executemany`** 并打 `[Bulk] … 回退 executemany` warning，
任务不会失败，语义不变。列类型走 `DESCRIBE` 按需缓存，`None`/中文/引号/换行/
DATE/TIMESTAMP/BOOLEAN 都有单测覆盖（float→BIGINT 与老路径一致：`"12345.6"`→12346）。

改造清单（11 个 collector，写库行数最多的那些）：

| 文件 | 表 | 模式 |
|---|---|---|
| `collectors/kline.py` | `daily_ohlcv`（`_flush()`） | upsert (symbol,date) |
| `collectors/capital_flow.py` | `capital_flow` | upsert (symbol,date) |
| `collectors/market_snapshot.py` | `market_snapshot` | insert（先按 trade_date 删） |
| `collectors/valuation.py` | `daily_valuation` / `stock_universe` 行业刷新 / 新股入池 | insert / update / insert |
| `collectors/targets.py` | `target_scan`(×2) `target_trend` `target_tail` | insert（先 DELETE） |
| `collectors/adjust_factor.py` | `adjust_factor`（增量两处 + 基金回补） | upsert / insert |
| `collectors/quotes.py` | `daily_ohlcv.turnover_rate` + `stock_universe.name` | update (symbol,date) / (symbol) |
| `collectors/sector_index.py` | `sector_index` / `sector_member` | insert / upsert (bk_code,symbol) |
| `collectors/zy_blocks.py` | `zy_block` / `zy_block_member` | upsert (block_code) / (block_code,symbol) |
| `collectors/profile.py` | `stock_profile` | insert（全量重建） |
| `collectors/financials.py` | `financials` | insert（先按 report_date 删） |

`sector_member` 之所以用 upsert 而不是 insert：这张表没有「先清空」的步骤，原来靠
`INSERT OR REPLACE` 容忍重复，改成纯 insert 会撞主键。

**本机实测（真实库，非临时表）**：删掉 10 只股票共 29,045 行后重跑 `kline_update`，
回补 **36,900 行 ≈ 1 秒**写库（老的 `executemany + INSERT OR REPLACE` 按 180 行/秒
要 **200–350 秒**），任务 `completed`、失败 0、日志无回退告警；`daily_ohlcv` 由
57,598 行涨到 94,498 行，coverage 100%，最新 2026-11-13。单测 20,000 行 0.17s
（约 116,000 行/秒）。

**测试**：`pytest -q tests` → 196 passed / 9 failed / 1 skipped，与本分支改动前的
基线**完全一致**（9 个失败都是分支自带的文案快照漂移、Windows GBK
`UnicodeDecodeError`、交易日/新鲜度用例），批量写入没有引入新失败。

**没改的地方**（都是小体量，改了收益接近 0）：`auth/service.py` 的会话/审计、
`fund_universe.py`（基金清单几百行）、`kline.py` 停牌自证与 pct 补算（每天几十行）、
`rotation_inputs.py` 的 `ON CONFLICT … DO UPDATE` 条件更新（语义没法用 DELETE+INSERT
表达）、`zy_local.py` 单行写入、`valuation.py` 的 `trade_status_daily` 与补上市日期。

**回退方法**：三个文件都在工作区未提交，`git checkout -- app/updater/collectors`
删掉 `app/foundation/bulk.py` 即回到原样；库里不会留任何临时表（`finally` 清理 +
`TEMP` 表本身随连接消失）。注意 DuckDB 单写者：改完要 `stop.ps1` 再
`start.ps1 -NoBuild` 才生效。

**环境限制（与本改造无关）**：本机 `stock_universe` 只有 30 只种子股，东财
`push2`/`clist` 域名当前被掐（`Server disconnected`），所以 `valuation`（走腾讯备用
车道只拿到 30 行，被 3000 行下限判 failed）、`sector_index`、`market_snapshot`
仍然跑不出数据；等 universe 灌满或网络恢复后才会正常落库。

