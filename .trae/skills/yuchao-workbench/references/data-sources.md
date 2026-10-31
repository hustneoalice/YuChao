# 数据源手册 · 东财/腾讯/新浪采集模式

写任何采集代码前先读本篇。原始 HTTP 细节全部收敛在
`app/updater/collectors/sources.py`（采集函数）与 `http.py`（统一请求层），
采集器（`collectors/<name>.py`）只做编排、落库和进度上报。

## 请求层规约（http.py，禁止绕过）

- `get_json(url, params, referer)` / `get_json_hosts(path, params, hosts)`：
  统一 UA 池随机、指数退避、伪装页检测、多域名轮换。东财必须带 Referer。
- symbol 转换函数表（各车道格式不同，透传裸代码 = 上游返空 + 误判网络失败）：
  | 函数 | 目标格式 | 示例 |
  |---|---|---|
  | `pure_of(symbol)` | 裸 6 位码 | `600519` |
  | `market_prefix(pure)` | 东财 secid 前缀 | `1.600519` / `0.000001` |
  | `suffixed_symbol(pure)` | sh/sz 后缀 | `600519.SH` |
  | `tx_symbol(symbol)` | 腾讯前缀 | `sh600519` |
  | `sina_symbol(symbol)` | 新浪前缀 | `sh600519` |
- 限流：翻页/逐只请求间隔 ≥0.12s；指数退避 + 连续失败熔断见 pitfalls 3/7。

## 东财 push2 模式（清单/成分/估值/财务）

`fs=` 参数是板块语义的核心：

| fs 值 | 含义 | 现用场景 |
|---|---|---|
| `m:90+t:2` | 东财行业板块清单 | `fetch_sector_snapshot(board_type="industry")` |
| `m:90+t:3` | 东财概念板块清单 | `fetch_sector_snapshot(board_type="concept")` |
| `b:BK0580` | 单板块成分股 | `fetch_board_members(bk_code)` |
| `m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23` | 沪深 A 全市场 | `fetch_valuation_snapshot()` |

- f 字段映射（常用）：`f12` 代码、`f14` 名称、`f2` 最新价、`f3` 涨跌幅、
  `f5` 成交量、`f6` 成交额、`f8` 换手率、`f9` PE(动)、`f20` 总市值、
  `f23` PB、`f26` 上市日期（`_parse_f26` 处理 YYYYMMDD）、`f100` 所属行业、
  `f115` PE(TTM)。字段值常为 `"-"` 占位——一律经 `_num()` 归 None。
- 翻页：`pn`（页码,从1起）+ `pz`（页大小，估值用 5000 级一把梭，
  成分股 ≤100/页并翻页上限 40 页防爆量）。
- 返回结构：`data.diff` / `data.total`；`diff` 可能是 dict（按索引键）也可能是
  list——两种都兼容。

## 腾讯车道

- **批量实时** `fetch_qt_batch(codes)`：GBK 编码、≤50 只/次、毫秒级响应。
  实时报价主车道（东财 push2 keep-alive 短，切股 8s+ 延迟，弃为主用）。
  响应 `v_sh600519="1~贵州茅台~600519~价格~..."` 按 `~` 切片取位。
- **日K主车道** `fetch_kline_tx(code)`：`fqkline/get`，3200 根上限，
  前复权参数内置；`_tx_rows` 解析。

## 多车道降级矩阵（现状）

| 数据 | 主车道 | 备用 | 说明 |
|---|---|---|---|
| 实时报价 | 腾讯 qt 批量 | 东财快照 + 10s 缓存 | |
| 日K增量 | 腾讯 fqkline | 东财 push2his | 均经 normalize |
| 全市场估值 | 东财 clist | 腾讯 | min_rows 3000 兜假成功 |
| 资金流 | 新浪逐只 | 无 | 唯一源，靠落账告警+次日重试 |
| 财务三表 | 东财报告期 | 无 | `fetch_financial_period` |
| 复权因子 | baostock | 无 | 可选依赖，缺失则 skipped 不报错 |

唯一源 = 高风险：任务失败只靠 update_log 落账告警 + 次日重试兜底，
新增唯一源前先想清楚备用车道或降级展示。

## 归一化与入库前校验（normalize.py，必经）

1. `normalize_rows(rows, source)`：源字段 → 统一 schema，单位换算单处定义。
2. `_selfcheck_volume`：隐含均价 = 成交额 ÷ 成交量，与收盘价比对，
   识别 100 倍量纲错误（纠偏或拒收）。
3. `guard_rows(buf)`：OHLC 关系合法性、空壳/浅数据拒收，返回 (合法行, 拒收数)。

任何绕过 normalize 直写 DuckDB 的新代码都是 bug。

## 新数据源接入 checklist

- [ ] `sources.py` 加 `fetch_xxx`：只管 HTTP（fs/f 字段/翻页/限流），可测可 mock
- [ ] symbol 转换走 `http.py` 现成函数，不手写前缀
- [ ] 数据过 `normalize_rows` + 相关 guard
- [ ] `db.py` 新表进 NEW_TABLES_DDL / 存量加列进 MIGRATIONS，conftest 镜像
- [ ] `registry.py` 注册：freshness（快照型）/ min_rows（快照型）/ needs（有上游）
      / CRON_CHAIN 链位；增量型不声明 freshness
- [ ] 采集器返回 `{"status","rows","detail"}`；子项失败写进 error 别吞
- [ ] 测试：mock 源的成功路径 + 失败路径 + 假成功（行数不足）路径
- [ ] 依赖导入完整自检（防静默断供，pitfalls 6）
