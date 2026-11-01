# 众赢财富通（zytg）行情 HTTP API 逆向归档

日期：2026-11-01。汇总多次逆向的结论与实测，作为驭潮接入众赢板块体系的数据源契约。
产物样本：`/tmp/zy_blocks.json`（板块清单全量）、`/tmp/zy_members.json`（周五成分样本，51 只，临时文件可能已清理）。

## 目标应用与内核

- Mac 客户端：`/Applications/众赢财富通.app/Wrapper/zytg.app/zytg`（iOS App 跑在 Mac 上）。
- 内核为通达信系：板块代码段（H1/TC/G/D/F 前缀）、分时走势布局、行业树结构均与通达信一致。
- Windows 版另见 `zhongying-windows/`（缠论 DLL 逆向，属于另一条线）。

## 通用契约

- 行情 API 主机：`https://api.zhongyingtougu.com`。
- 匿名 GET 即可用，无需登录/token；UA 未校验（实测标准 httpx UA 也放行）。
- 响应信封：`{"code": 0, "msg": "...", "data": {...}}`，非 0 即错误。
- 端点格式串提取自二进制 `__ustring`/ASCII 段：`%@/api/v2/sc/blocks/%@/symbols?sortType=%ld` 等。

## 端点清单（实测状态 2026-11-01）

### GET /api/v2/sc/blocks —— 板块清单（可用，周日也有数据）

返回 5 组共 1075 个板块（通达信系全量）：

| typeCode | 类别 | 数量 | blockCode 前缀示例 |
|---|---|---|---|
| 1 | 地域 | 32 | D181319 |
| 2 | 概念 | 750 | G000021（大飞机） |
| 4 | 行业 | 39（含内嵌子级） | H110000（农林牧渔）→ H110700（养殖业） |
| 8 | 风格 | 32 | F003491 |
| 9 | 题材 | 222 | TC000001（光刻机） |

- 字段：`blockCode` / `blockName` / `oldBlockCode` / `superBlock`。
- 行业（type=4）一级板块带 `block[]` 子级数组，需摊平为两行（parent_code 挂一级）。
- 题材（TC 前缀）是稀缺货：BC电池/AI硬件/小米汽车等，比东财概念更细。

### GET /api/v2/sc/blocks/{blockCode}/symbols?sortType=1 —— 板块成分

- 成分 symbol 带 `.SZ`/`.SH` 后缀，入库需剥裸码（与 market_snapshot 主键同口径）。
- **非交易日返回空数组**（周五样本 51 只正常）——同步任务须容忍空成分静默跳过。
- 字段超全（远超驭潮快照所需）：五档 bid/ask 字符串、amount_in/out（资金流入流出）、min5_change、entrust_rate（委比）等。

### POST /api/v2/sc/fundflow/sectors/new —— 板块资金流（未接入）

- 返回空，疑需特定头/token；非交易日无法验证。P2 待办。

## 东财 ETF 清单（基金分类数据源）

- `https://push2.eastmoney.com/api/qt/clist/get?fs=b:MK0021,b:MK0022,b:MK0023,b:MK0024&fields=f12,f13,f14&pz=100&fid=f12`：实测 1655 只全量 ETF；`f13=1` 沪 / `0` 深。
- LOF 在 `b:MK0026`（26 只），本次未采。
- **限流教训**：短时高频 clist 请求触发东财 IP 风控（RemoteProtocolError / 全空响应），push2delay 备用域名同样断连；封禁以小时计。同步任务须设下限防线（<500 只拒绝覆盖）且只在日级 cron 跑（驭潮：9:05）。

## 驭潮接入映射（本仓库）

- 表：`zy_block`（清单 + sync_date 新鲜度守卫）/ `zy_block_member`（成分裸码）/ `fund_universe`（ETF 清单）。
- 采集任务：`zy_block_sync`（日 16:05，清单+1075 成分逐拉，pause 0.15s）、`fund_universe_sync`（日 9:05，东财全量翻页）。
- API：`/api/v1/market/zy_blocks`（type_code ∈ {1,2,4,8,9}）、`/market/zy_blocks/{block_code}/members`。
- **行情零上游原则**：板块行情 = zy_block_member × market_snapshot 查询时本地聚合（AVG 涨跌幅、ARG_MAX 领涨股），不依赖众赢行情端点；众赢源只做日级清单。
- 代码：`app/updater/collectors/zy_source.py`（源适配层）、`zy_blocks.py` / `fund_universe.py`（任务）、`app/foundation/repo/zyblock.py`（聚合查询）。

## 待办

- [ ] 周一验证成分接口有数据后，确认 1075 板块全量成分入库。
- [ ] fundflow/sectors/new 补头/token 逆向（P2）。
- [ ] 东财解封后 fund_universe_sync 全量 1655 自动恢复（cron 自愈，无需人工）。
