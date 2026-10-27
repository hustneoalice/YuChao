"""任务注册表：kind 元数据单处定义（API 校验 / updater 注册共用）。

fn 用「模块:函数」字符串延迟解析——API 进程只读这份元数据，
不 import 任何 DuckDB/采集器代码，读写分进程约束不被破坏。
"""

TASKS: tuple[dict, ...] = (
    {"kind": "sector_index", "label": "行业板块快照",
     "fn": "app.updater.collectors.sector_index:update_sector_index",
     "description": "15:35 东财行业板块清单 → sector_index（含涨跌家数/领涨股）"},
    {"kind": "quotes", "label": "行情快照",
     "fn": "app.updater.collectors.quotes:update_quotes",
     "description": "16:00 腾讯 qt 批量报价：换手率补写 + 证券简称刷新"},
    {"kind": "valuation", "label": "全市场估值",
     "fn": "app.updater.collectors.valuation:update_valuation",
     "description": "16:20 东财 clist 全市场估值 → daily_valuation（腾讯备用车道）"},
    {"kind": "capital_flow", "label": "个股资金流",
     "fn": "app.updater.collectors.capital_flow:update_capital_flow",
     "description": "16:30 新浪逐只资金流 → capital_flow（唯一源）"},
    {"kind": "pe_percentile", "label": "PE 分位重建",
     "fn": "app.updater.collectors.pe_percentile:rebuild_pe_percentile",
     "description": "16:50 基于最新估值截面重建全市场 PE 分位与行业中位"},
    {"kind": "kline_update", "label": "K 线增量",
     "fn": "app.updater.collectors.kline:update_kline",
     "description": "17:00 腾讯 fqkline 日线增量 → daily_ohlcv（东财备用）"},
    {"kind": "financials", "label": "财务数据",
     "fn": "app.updater.collectors.financials:update_financials",
     "description": "17:30 东财财务三表按报告期 → financials（覆盖近两期）"},
    {"kind": "adjust_factor", "label": "复权因子",
     "fn": "app.updater.collectors.adjust_factor:update_adjust_factor",
     "description": "周六 09:00 baostock 复权因子（可选依赖，缺失则 skipped）"},
    {"kind": "corepicks", "label": "核心标推送",
     "fn": "app.updater.collectors.corepicks:update_corepicks",
     "description": "21:00 核心标引擎占位（应用层迁移后接入）"},
    {"kind": "package_export", "label": "导出数据包",
     "fn": "app.updater.packaging:run_export",
     "description": "底座全量快照 → 离线数据包 + SHA256 manifest（F14，与更新互斥）"},
    {"kind": "package_import", "label": "导入数据包",
     "fn": "app.updater.packaging:run_import",
     "description": "校验（SHA256→行数→抽样）→ 换库（原库 .bak）→ 重建 schema"},
    {"kind": "backfill", "label": "历史回补",
     "fn": "app.updater.packaging:run_backfill",
     "description": "行情→估值→资金流→K线 串行回补（多源降级，init mode=backfill）"},
)

_KINDS = {t["kind"] for t in TASKS}

# 调度链（北京时间；元数据单处定义，API /data/tasks 直接读这里，
# 不 import apscheduler——API 进程与调度器解耦）
CRON_CHAIN: tuple[tuple[str, int, int], ...] = (
    ("sector_index", 15, 35),
    ("quotes", 16, 0),
    ("valuation", 16, 20),
    ("capital_flow", 16, 30),
    ("pe_percentile", 16, 50),
    ("kline_update", 17, 0),
    ("financials", 17, 30),
    ("corepicks", 21, 0),
)
WEEKLY: tuple[tuple[str, int, int], ...] = (
    ("adjust_factor", 9, 0),      # 周六
)


def describe_chain() -> list[dict]:
    labels = {t["kind"]: t["label"] for t in TASKS}
    out = [{"kind": k, "label": labels.get(k, k), "cron": f"交易日 {h:02d}:{m:02d}"}
           for k, h, m in CRON_CHAIN]
    out += [{"kind": k, "label": labels.get(k, k), "cron": f"周六 {h:02d}:{m:02d}"}
            for k, h, m in WEEKLY]
    return out


def is_valid_kind(kind: str) -> bool:
    return kind in _KINDS


def resolve_fn(spec: dict):
    """「模块:函数」→ 可调用（仅 updater 进程调用）。"""
    import importlib

    mod, name = spec["fn"].split(":", 1)
    return getattr(importlib.import_module(mod), name)
