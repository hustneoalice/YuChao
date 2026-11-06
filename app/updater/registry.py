"""任务注册表：kind 元数据单处定义（API 校验 / updater 注册共用）。

fn 用「模块:函数」字符串延迟解析——API 进程只读这份元数据，
不 import 任何 DuckDB/采集器代码，读写分进程约束不被破坏。

守卫元数据（2.x，orchestrator._precheck / 写后防线消费）：
  freshness  新鲜度前置：{"table","col"} 目标表当日已落 → 秒跳；
             {"log": True} update_log 有当日成功账 → 秒跳。
             增量型任务（capital_flow/kline_update）不声明——它们靠 cutoff
             增量语义天然幂等，重跑是补缺口，不能拦。
  needs      上游依赖：上游今日 update_log 有 failed 账 → 下游 skip
             （拒绝拿旧截面硬算；策影只靠 cron 时间错开，上游失败下游照跑）。
  min_rows   写后行数下限（快照/重建型任务专属）：成功但行数低于下限 = 疑似
             数据源整包异常（WAF 假成功类），按失败处理进自动重试。
"""

TASKS: tuple[dict, ...] = (
    {"kind": "market_snapshot", "label": "盘中行情",
     "fn": "app.updater.collectors.market_snapshot:update_market_snapshot",
     "min_rows": 3000,
     "cooldown_s": 0,     # interval 自带 5min 节律，冷却会拦掉一半轮次
     "description": "盘中每 5 分钟刷新一次全市场实时行情（价格/涨跌幅/成交额/"
                    "换手率/量比/振幅/市值 + 10 个指数）；非交易时段自动跳过，"
                    "供全景大表、指数条和市场总貌使用"},
    {"kind": "sector_index", "label": "板块行情",
     "fn": "app.updater.collectors.sector_index:update_sector_index",
     "freshness": {"table": "sector_index", "col": "trade_date"},
     "min_rows": 300,
     "description": "收盘后更新行业板块、概念板块的行情，以及概念板块的成分股"},
    {"kind": "zy_block_sync", "label": "众赢板块同步",
     "fn": "app.updater.collectors.zy_blocks:update_zy_blocks",
     "freshness": {"table": "zy_block", "col": "sync_date"},
     "description": "收盘后更新众赢板块体系（地域/行业/概念/风格/题材等 1000 多个"
                    "板块）和成分股；板块涨跌按盘中实时行情汇总"},
    {"kind": "fund_universe_sync", "label": "基金清单同步",
     "fn": "app.updater.collectors.fund_universe:update_fund_universe",
     "freshness": {"table": "fund_universe", "col": "sync_date"},
     "description": "开盘前更新场内基金清单（ETF/LOF/REIT，供盘中行情和日线采集使用）"},
    {"kind": "quotes", "label": "实时行情",
     "fn": "app.updater.collectors.quotes:update_quotes",
     "freshness": {"log": True},
     "description": "收盘后补充换手率、刷新证券简称"},
    {"kind": "valuation", "label": "全市场估值",
     "fn": "app.updater.collectors.valuation:update_valuation",
     "freshness": {"table": "daily_valuation", "col": "date"},
     "min_rows": 3000,
     "description": "收盘后更新全市场估值（市盈率/市净率/市值等）"},
    {"kind": "capital_flow", "label": "个股资金流",
     "fn": "app.updater.collectors.capital_flow:update_capital_flow",
     "description": "收盘后更新每只股票的资金流向（主力净流入等）"},
    {"kind": "pe_percentile", "label": "PE 分位重建",
     "fn": "app.updater.collectors.pe_percentile:rebuild_pe_percentile",
     "needs": ["valuation"],
     "freshness": {"table": "pe_percentile", "col": "updated_at"},
     "min_rows": 2000,
     "description": "收盘后重算全市场市盈率排名和行业中位数"},
    {"kind": "kline_update", "label": "K 线增量",
     "fn": "app.updater.collectors.kline:update_kline",
     "description": "收盘后补齐当日日线行情（全市场股票和场内基金）；"
                    "新上市标的自动补历史 K 线"},
    {"kind": "target_scan", "label": "目标监控预计算",
     "fn": "app.updater.collectors.targets:update_target_scan",
     "needs": ["kline_update"],
     # 新鲜度看趋势柱线（盘中重算只写 target_scan 且 as_of=当日，用 as_of 会把
     # 收盘后的正式预计算误判为「今日已完成」而秒跳，趋势柱线就永远停在昨天）
     "freshness": {"table": "target_trend", "col": "data_date"},
     "min_rows": 3000,
     "description": "收盘后预先算好目标监控要用的指标（均线/量比/六分段/涨停"
                    "次数/趋势柱线）；打开页面即用，改条件立刻重筛"},
    {"kind": "target_scan_live", "label": "目标监控盘中重算",
     "fn": "app.updater.collectors.targets:update_target_scan_live",
     "cooldown_s": 0,     # interval 自带 5min 节律；新鲜度秒跳也会拦掉盘中刷新
     "description": "交易时段每 5 分钟用最新快照重算目标指标层（页面直接读表，"
                    "现价/涨跌幅/量比跟行情页一致）；非交易时段自动跳过"},
    {"kind": "mainforce_cache", "label": "主力军情预计算",
     "fn": "app.updater.collectors.mainforce:update_mainforce",
     "needs": ["capital_flow", "valuation", "kline_update", "zy_block_sync"],
     "description": "收盘后预生成行业、概念、地域与个股的六个周期资金排行，打开即读缓存"},
    {"kind": "financials", "label": "财务数据",
     "fn": "app.updater.collectors.financials:update_financials",
     "freshness": {"log": True},
     "min_rows": 500,
     "description": "收盘后更新最新两期财务报表"},
    {"kind": "backup", "label": "数据备份",
     "fn": "app.updater.collectors.backup:run_backup",
     "description": "收盘后给数据库做整库备份（保留最近 7 份，并校验备份可读）"},
    {"kind": "adjust_factor", "label": "复权因子",
     "fn": "app.updater.collectors.adjust_factor:update_adjust_factor",
     "freshness": {"log": True},
     "description": "每周六更新复权因子（用于计算前复权 K 线）"},
    {"kind": "corepicks", "label": "核心标强轮动计算",
     "fn": "app.updater.collectors.corepicks:update_corepicks",
     "description": "每日20:00依据行业、题材、地域涨幅与资金优选最多4只核心标，支持手动计算"},
    {"kind": "feishu_push", "label": "飞书推送",
     "fn": "app.updater.collectors.feishu_push:push_corepicks",
     "notify": True,
     "description": "每个交易日早间把核心标名单推送到飞书（按用户设置，名单为空则不发）"},
    {"kind": "target_push", "label": "两点乾坤推送",
     "fn": "app.updater.collectors.target_push:push_target_signals",
     "notify": True,
     "cooldown_s": 0,     # 每分钟探测：冷却会拦掉相邻时段
     "description": "按用户设置的时间点（每天可多个）计算「两点乾坤」信号并推送到"
                    "飞书；没有符合条件的股票就不发"},
    {"kind": "package_export", "label": "导出数据包",
     "fn": "app.updater.packaging:run_export",
     "description": "把全部数据导出成离线数据包（用于备份或迁移）"},
    {"kind": "package_import", "label": "导入数据包",
     "fn": "app.updater.packaging:run_import",
     "description": "导入离线数据包（先校验完整性，通过后才替换现有数据）"},
    {"kind": "backfill", "label": "历史回补",
     "fn": "app.updater.packaging:run_backfill",
     "description": "补齐历史数据（行情→估值→资金流→日线依次回补）"},
)

_KINDS = {t["kind"] for t in TASKS}

# 调度链（北京时间；元数据单处定义，API /data/tasks 直接读这里，
# 不 import apscheduler——API 进程与调度器解耦）
CRON_CHAIN: tuple[tuple[str, int, int], ...] = (
    ("feishu_push", 8, 35),       # 盘前推送最新核心标名单（F10）
    ("fund_universe_sync", 9, 5), # 盘前刷新场内基金清单（新上市 ETF 当日进快照）
    ("sector_index", 15, 35),
    ("zy_block_sync", 16, 5),     # 众赢板块清单+成分（交易日收盘后，成分接口才有数据）
    ("quotes", 16, 0),
    ("valuation", 16, 20),
    ("capital_flow", 16, 30),
    ("pe_percentile", 16, 50),
    ("kline_update", 17, 0),
    ("target_scan", 17, 20),      # 目标页指标层预计算（K 线落库后）
    ("mainforce_cache", 17, 25),
    ("financials", 17, 30),
    ("backup", 18, 10),           # 更新链收尾后快照；策影零备份，这是超越点
    ("corepicks", 20, 0),
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
