# 上证基金 / 深证基金 清单复刻 Spec

状态：待批准（批准后按 tasks.md 执行）
日期：2026-11-01
范围：后端采集链路 + 数据回填；前端两个 tab 已存在，无需改页面代码。

## 1. 问题与目标

全景页底部 `上证基金` / `深证基金` 两个 tab 无数据（`/api/v1/market/board?tab=fund_sh`
返回 `items: [], total: 0, as_of: 2026-10-30`）。

目标：让这两个 tab 按代码升序展示场内基金全量，口径与参考客户端（众赢全景截图）一致。

数据链路（既有）：

```
fund_universe（清单） ──┐
stock_universe（个股） ──┼→ market_snapshot(kind='fund'/'stock'/'index') → /market/board?tab=fund_sh|fund_sz
INDEX_CATALOG（指数） ──┘
```

## 2. 已确认事实

### 2.1 根因
- `fund_universe` 为空：唯一源是东财 clist `fs=b:MK0021..24`，当前被东财封禁/限流，
  `fetch_etf_list` 拿不到数据，采集器失败后保留空表。
- `market_snapshot` 因此没有 `kind='fund'` 行，`_TAB_WHERE`（`app/foundation/repo/market.py`）
  的 `fund_sh`/`fund_sz` 过滤后为空。
- 周末 `market_snapshot` 非交易时段幂等跳过（当日已有股票行即 `skipped(fresh)`），
  即使补齐清单也无法自动刷新快照 → 需要 `force` 通道。

### 2.2 参考客户端口径（逆向结论）
- 众赢 `zytg` 二进制字符串中无基金清单端点（仅板块 `/api/v2/sc/blocks` 体系）；
  `Allwin.exe` 等 Windows 客户端二进制为 GBK 编码，字符串中无独立基金清单接口。
- 结论：参考客户端的「上证基金 / 深证基金」不是独立接口，而是
  **市场（沪/深）× 场内基金类型（ETF / LOF / REIT / 封闭）** 的分类视图，按代码升序排列。
- 公开等价源（新浪 `Market_Center.getHQNodeData`）实测与截图逐行一致：

| 节点 | 只数 | 沪 | 深 | 代码段 |
|---|---|---|---|---|
| `etf_hq_fund` | 1715 | 947 | 768 | 沪 510010…589990 / 深 158000…159998 |
| `lof_hq_fund` | 359 | 114 | 245 | 沪 501001… / 深 160105…169201 |
| `close_fund` | 94 | 63 | 31 | 沪 508000…508609 / 深 180101…181001 |
| 合计 | 2168 | 1124 | 1044 | — |

`lof_hq_fund` 沪市首行即 `501001 财通精选混合LOF`，与截图 `上证基金` 第一行完全一致；
`crefund` 节点返回 `sys_auth FAILED` 假数据，**不采**。

## 3. 实现方案

### 3.1 `app/updater/collectors/sources.py`：新增新浪基金清单源

新增常量与函数（保留东财 `fetch_etf_list` 作为 fallback，不改其行为）：

```python
_SINA_HQ_NODE = ("https://vip.stock.finance.sina.com.cn"
                 "/quotes_service/api/json_v2.php/Market_Center.getHQNodeData")
_SINA_FUND_NODES = ("etf_hq_fund", "lof_hq_fund", "close_fund")
_SINA_FUND_REFERER = "https://vip.stock.finance.sina.com.cn/"

def fetch_fund_list(progress=None, cancel=None) -> List[Dict[str, str]]:
    """新浪场内基金清单（ETF+LOF+REIT/封闭，实测 2168 只）→ [{symbol,name,market}]。"""
```

算法要点（逐条实现，不做额外抽象）：
1. 逐节点、逐页请求：`page` 从 1，`num=80`，`sort=symbol`，`asc=1`，`node=<节点>`，
   `symbol=""`，`_s_r_a=page`；Referer 用 `_SINA_FUND_REFERER`。
2. 用 `http.client`（httpx 共享客户端）直接取文本，不做 `r.json()`：
   新浪该端点返回**键名不带引号**的 JS 数组，先 `json.loads`，失败则用
   `re.sub(r'([{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:', r'\1"\2":', text)` 补引号后再解析。
3. 终止条件：解析结果为空/`None`（页越界）或 `page > 50`（每节点上限，80×50 远超实际）。
4. 取字段 `symbol`（形如 `sh501001`）、`name`；代码取 `symbol[2:]`：
   - 必须 6 位数字，否则丢弃；
   - `market` 由 `symbol[:2]` 判定（`sh`→`SH`, `sz`→`SZ`），缺前缀时用
     `http.market_prefix(code).upper()`；非 SH/SZ 丢弃；
   - `name` 为空、含 `FAILED`/`sys_auth` 的行丢弃（防假数据）。
5. 全部节点结果按 `symbol` 去重（保留首条），按 `symbol` 升序返回。
6. 每页 `time.sleep(0.2)`；每页后 `_emit(progress, done=len(out), total=None,
   log=f"基金清单 [{len(out)}]")`；`cancel()` 为真即退出（保留已取部分）。

### 3.2 `app/updater/collectors/fund_universe.py`：切换数据源

- 首次优先 `sources.fetch_fund_list(...)`；异常或结果 `< 1500` 时回退
  `sources.fetch_etf_list(...)`（记录 `logger.warning` 说明回退原因）。
- 两源都失败或仍 `< 1500` → `RuntimeError`，**不执行 DELETE**（保留上一份清单）。
- 行数守卫从 `500` 调整为 `1500`（全量 2168，1500 可容纳单节点失败但拒绝整包垃圾）。
- DELETE+INSERT 逻辑、`detail` 文案沿用（detail 改为
  `场内基金 N 只（沪 X / 深 Y）`，可附类型计数不必）。
- 模块 docstring 改为「新浪节点（ETF/LOF/REIT）+ 东财 fallback」。

### 3.3 `app/updater/collectors/market_snapshot.py`：支持 force 补数据

- 顶部读取 `force = bool((ctx or {}).get("force"))`。
- 非交易时段跳过条件加 `and not force`：

```python
if not _in_trading_hours(now):
    ...
    if have and not force:
        result.update(status="skipped(fresh)", ...)
        return result
```

其余逻辑不变（`_MIN_SNAPSHOT_ROWS` 保持 3000；基金并入 `stocks` 后仍远超下限）。
`force` 由既有控制通道传入（`POST /data/update` 的 `force` → orchestrator `ctx`），无需改 orchestrator。

### 3.4 文案同步（仅注释/描述，无逻辑）
- `app/updater/registry.py`：`fund_universe_sync` description 改为
  「场内基金清单（ETF/LOF/REIT，新浪节点 + 东财 fallback）」。
- `app/foundation/db.py`：`fund_universe` 上方注释同步。

### 3.5 测试（`tests/test_updater.py`）
1. `test_fetch_fund_list_parse`：monkeypatch 共享客户端返回
   带无引号键的 JS 数组（含 `sh501001`、`sz160105`、`FAILED` 假行、非法代码），
   断言只保留合法 SH/SZ 行、去重、升序。
2. `test_fund_universe_task`（若不存在则新增）：monkeypatch `sources.fetch_fund_list`
   返回 1600+ 行 → 断言 `fund_universe` 行数、`mark=True`、`detail` 含沪/深计数；
   再 monkeypatch 返回 10 行 → 断言 `failed` 且原表行数不变。
3. `test_market_snapshot_offhours_skip`：补一个 `force=True` 分支断言会调用上游
   （沿用现有 monkeypatch 结构）。

## 4. 验证步骤（执行后逐条记录结果）

1. `.venv/bin/python -m pytest tests/ -q` 全绿。
2. 直连源快速校验（一次性脚本，不落盘）：
   `fetch_fund_list()` 返回 2100~2250 行，沪/深均 > 900。
3. 走控制通道补数据（API 8031 在跑，`api_embedded_updater=true`）：
   - `POST /api/v1/data/update {"kind": "fund_universe_sync", "force": true}`
   - 等落账成功（`GET /api/v1/data/updates`）
   - `POST /api/v1/data/update {"kind": "market_snapshot", "force": true}`
   - 等落账且 `rows` > 4000、`detail` 含基金行数 > 2000。
4. 接口验证：
   - `GET /api/v1/market/board?tab=fund_sh` → `total ≈ 1124`，首行 `501001 财通精选混合LOF`
   - `GET /api/v1/market/board?tab=fund_sz` → `total ≈ 1044`，首行落在 `158000…160105` 段
5. UI 验证（agent-browser 打开 `http://localhost:8031` → 全景 → 点上证基金/深证基金）：
   表格出数据、排序按代码升序、涨跌幅/最新价等列非空，截图留证。

## 5. 风险与边界
- 新浪单节点失败：整包仍可能 ≥1500（ETF 单节点就 1715），不会误覆盖；若 ETF 节点也失败 → 回退东财。
- 分页参数改变（若新浪调整 `num` 上限）→ 单页返回不足 80 条但非空不会提前终止，靠空页收尾，安全。
- 周末 `force` 补快照：qt 周末返回周五收盘值，`expected_asof()` 给到 2026-10-30，不会写入错误日期。
- 基金代码判定沿用 `market_prefix`（5→SH、1→SZ），与 qt 裸码口径一致，不影响个股/指数。
- 不新增表、不改前端、不引入新依赖。

## 6. 批准项（需用户确认）
1. 采用新浪 `etf_hq_fund/lof_hq_fund/close_fund` 作为复刻源（东财 fallback）。
2. 清单行数守卫 500 → 1500。
3. `market_snapshot` 增加 `force` 绕过非交易时段幂等跳过。
4. 测试新增/调整范围如上。
