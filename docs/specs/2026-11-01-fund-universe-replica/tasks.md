# 执行任务清单：基金清单复刻

前置：spec.md 已批准。按顺序执行，每步完成后记录结果；卡住先报告，不自行改口径。

## [x] T1 采集源：新浪基金清单
- 文件：`app/updater/collectors/sources.py`
- 新增 `_SINA_HQ_NODE` / `_SINA_FUND_NODES` / `_SINA_FUND_REFERER` / `fetch_fund_list`，
  按 spec 3.1 实现（无引号键解析、市场判定、假数据过滤、去重升序、0.2s 间隔、cancel、50 页上限）。
- 自检结果：`fetch_fund_list()` → 2168 行（沪 1124 / 深 1044），与 spec 对照表一致。

## [x] T2 清单任务切换源
- 文件：`app/updater/collectors/fund_universe.py`
- `fetch_fund_list` 优先 + `fetch_etf_list` 回退；守卫 1500；失败不 DELETE；docstring/detail 更新。
- 实测落账：`completed 2168 | 场内基金 2168 只（沪 1124 / 深 1044）`。

## [x] T3 快照 force 通道
- 文件：`app/updater/collectors/market_snapshot.py`
- `force = bool((ctx or {}).get("force"))`；跳过条件 `if have and not force`。
- 实测：`force=true` 全量重写 7733 行（股票 5555 / 基金 2168 / 指数 10），耗时 73s。

## [x] T4 文案同步
- 文件：`app/updater/registry.py`、`app/foundation/db.py`
- 仅改描述/注释，无逻辑。重启后 `/data/tasks` 描述已显示新浪口径。

## [x] T5 测试
- 文件：`tests/test_updater.py`
- 新增 `test_fetch_fund_list_parse`、`test_fund_universe_task`；扩展
  `test_market_snapshot_offhours_skip` 的 force 分支。
- 运行结果：`130 passed`（73.11s）。

## [x] T6 补数据（控制通道）
- 重启 8031 后端加载新采集代码后（uvicorn 无 --reload，旧进程仍持旧模块）：
  1. `POST /api/v1/data/update {"kind":"fund_universe_sync","force":true}` → 2168 行
  2. `POST /api/v1/data/update {"kind":"market_snapshot","force":true}` → 7733 行（基金 2168）
- 说明：未主动抢占 DuckDB 写锁；走内置 updater 控制通道完成。

## [x] T7 接口与 UI 验收
- `GET /api/v1/market/board?tab=fund_sh` → total 1124
- `GET /api/v1/market/board?tab=fund_sz` → total 1044
- `sort=symbol` 升序时：沪市首行 `501001 财通精选混合LOF`（与参考截图一致），深市首行 `158000`
- UI（agent-browser，1440×900）：全景页两个 tab 出表，分页 1/23、1/21；点「代码」表头升序后
  首三行为 501001 / 501005 / 501007，截图 `/tmp/pan-fund-sh.png`、`/tmp/pan-fund-sz.png`
- 验收项：
  - [x] fund_universe ≥ 1500 行，沪/深均 > 900（2168，1124/1044）
  - [x] 两个 tab `total > 0` 且按代码升序（点「代码」表头）
  - [x] 表头各列（最新/涨跌/量/换手/开高低/昨收）非空
  - [x] 个股/指数 tab 不受影响（hsa 5215、index 条正常，行情页截图正常）
