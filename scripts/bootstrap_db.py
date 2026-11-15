#!/usr/bin/env python
"""本地冷启动建库：1.0 基础表 + 2.0 新表 + 复权视图 + 种子证券清单。

为什么需要它：2.0 仓库只带「增量/覆写」逻辑（NEW_TABLES_DDL 与 PRICE_VIEW_DDL），
1.0 继承表（daily_ohlcv / stock_universe / adjust_factor …）的 DDL 与初始数据包
在 1.0 侧。GitHub Release 目前没有 yuchao_data_*.duckdb，所以本地首次运行用本
脚本建一份空骨架（口径与 tests/conftest.py 夹具一致），再用
POST /api/v1/data/init {"mode":"backfill"} 或界面「更新」把行情灌进来。

用法：
    .venv\\Scripts\\python.exe scripts\\bootstrap_db.py
    .venv\\Scripts\\python.exe scripts\\bootstrap_db.py --db D:\\data\\stock_research.duckdb
    .venv\\Scripts\\python.exe scripts\\bootstrap_db.py --no-seed   # 不写种子清单
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import duckdb  # noqa: E402

from app.config import settings  # noqa: E402
from app.foundation.db import (  # noqa: E402
    MIGRATIONS,
    NEW_TABLES_DDL,
    PRICE_VIEW_DDL,
)

# 1.0 继承表（与 tests/conftest.py 的 DDL 同口径；列定义以仓库查询层为准）
BASE_DDL = """
CREATE TABLE IF NOT EXISTS stock_universe (
    symbol VARCHAR PRIMARY KEY, name VARCHAR, market VARCHAR, industry VARCHAR,
    status VARCHAR, list_date VARCHAR, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS daily_ohlcv (
    symbol VARCHAR, date VARCHAR, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
    volume BIGINT, amount DOUBLE, pct_chg DOUBLE, turnover_rate DOUBLE,
    PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS adjust_factor (
    symbol VARCHAR, ex_date VARCHAR, fore_adjust_factor DOUBLE, back_adjust_factor DOUBLE,
    PRIMARY KEY (symbol, ex_date)
);
CREATE TABLE IF NOT EXISTS capital_flow (
    symbol VARCHAR, date VARCHAR, net_main DOUBLE, net_super DOUBLE, net_large DOUBLE,
    net_medium DOUBLE, net_small DOUBLE, PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS financials (
    symbol VARCHAR, report_date VARCHAR, net_profit DOUBLE, net_profit_yoy DOUBLE,
    roe DOUBLE, debt_ratio DOUBLE, operating_cashflow DOUBLE, audit_opinion INTEGER
);
CREATE TABLE IF NOT EXISTS sector_index (
    industry VARCHAR, trade_date VARCHAR, close DOUBLE, pct_change DOUBLE,
    code VARCHAR, up_count INTEGER, down_count INTEGER, leader VARCHAR, leader_change DOUBLE,
    PRIMARY KEY (industry, trade_date)
);
CREATE TABLE IF NOT EXISTS daily_valuation (
    symbol VARCHAR, date VARCHAR, pe_ttm DOUBLE, pb DOUBLE, ps_ttm DOUBLE,
    pcf_ncf_ttm DOUBLE, total_mv DOUBLE, circ_mv DOUBLE, amount DOUBLE,
    PRIMARY KEY (symbol, date)
);
CREATE TABLE IF NOT EXISTS pe_percentile (
    symbol VARCHAR PRIMARY KEY, pe_ttm DOUBLE, pe_percentile INTEGER,
    industry_pe_median DOUBLE, updated_at VARCHAR
);
"""

# 种子清单：让首屏有东西可看（kline_update 只拉 stock_universe 里的标的）。
# 之后「更新 → 全市场估值」会把东财全市场快照里的新股自动并入 universe。
SEED_UNIVERSE = (
    ("600519", "贵州茅台", "SH", "白酒"),
    ("000858", "五粮液", "SZ", "白酒"),
    ("300750", "宁德时代", "SZ", "电池"),
    ("601318", "中国平安", "SH", "保险"),
    ("600036", "招商银行", "SH", "银行"),
    ("000001", "平安银行", "SZ", "银行"),
    ("601398", "工商银行", "SH", "银行"),
    ("600000", "浦发银行", "SH", "银行"),
    ("002594", "比亚迪", "SZ", "汽车整车"),
    ("000333", "美的集团", "SZ", "家电行业"),
    ("000651", "格力电器", "SZ", "家电行业"),
    ("600276", "恒瑞医药", "SH", "化学制药"),
    ("603259", "药明康德", "SH", "医疗服务"),
    ("601012", "隆基绿能", "SH", "光伏设备"),
    ("600438", "通威股份", "SH", "光伏设备"),
    ("600030", "中信证券", "SH", "证券"),
    ("300059", "东方财富", "SZ", "互联网服务"),
    ("002230", "科大讯飞", "SZ", "软件开发"),
    ("688981", "中芯国际", "SH", "半导体"),
    ("002415", "海康威视", "SZ", "安防设备"),
    ("002475", "立讯精密", "SZ", "消费电子"),
    ("600887", "伊利股份", "SH", "食品饮料"),
    ("601088", "中国神华", "SH", "煤炭行业"),
    ("600900", "长江电力", "SH", "电力行业"),
    ("601857", "中国石油", "SH", "石油行业"),
    ("601899", "紫金矿业", "SH", "小金属"),
    ("600309", "万华化学", "SH", "化学制品"),
    ("000725", "京东方A", "SZ", "光学光电子"),
    ("000002", "万科A", "SZ", "房地产开发"),
    ("601166", "兴业银行", "SH", "银行"),
)

CHECKS = ("stock_universe", "daily_ohlcv", "adjust_factor", "capital_flow",
          "financials", "sector_index", "daily_valuation", "pe_percentile",
          "corepicks_result", "stock_profile", "sector_member", "market_snapshot",
          "fund_universe", "target_scan", "target_trend", "target_tail", "update_log")


def _exec_script(conn, script: str) -> None:
    """按分号切分执行；纯注释片段跳过（DDL 里每条语句前都有中文注释）。"""
    for stmt in script.split(";"):
        code = "\n".join(line for line in stmt.splitlines()
                         if not line.strip().startswith("--")).strip()
        if code:
            conn.execute(code)


def main() -> int:
    parser = argparse.ArgumentParser(description="YuChao 本地建库（骨架 + 种子清单）")
    parser.add_argument("--db", default=None, help="DuckDB 路径（缺省 data/stock_research.duckdb）")
    parser.add_argument("--no-seed", action="store_true", help="不写种子证券清单")
    args = parser.parse_args()

    path = Path(args.db or settings.duckdb_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    existed = path.exists()
    conn = duckdb.connect(str(path))
    try:
        _exec_script(conn, BASE_DDL)
        _exec_script(conn, NEW_TABLES_DDL)
        for stmt in MIGRATIONS:            # 幂等迁移（老库补列）
            try:
                conn.execute(stmt)
            except Exception:
                pass
        _exec_script(conn, PRICE_VIEW_DDL)
        # updater 落账表（writer.ensure_schema 也会建，这里让纯只读部署也有账本）
        from app.updater.writer import UPDATE_LOG_DDL
        _exec_script(conn, UPDATE_LOG_DDL)

        seeded = 0
        if not args.no_seed:
            count = conn.execute("SELECT COUNT(*) FROM stock_universe").fetchone()[0]
            if count == 0:
                conn.executemany(
                    "INSERT INTO stock_universe (symbol,name,market,industry,status) "
                    "VALUES (?,?,?,?,'traded')", SEED_UNIVERSE)
                seeded = len(SEED_UNIVERSE)
        conn.execute("CHECKPOINT")
    finally:
        conn.close()

    print(f"[bootstrap] {'复用已有库' if existed else '新建库'}：{path}")
    print(f"[bootstrap] 种子清单：{seeded} 只（0 = 库内已有数据，未改动）")
    conn = duckdb.connect(str(path), read_only=True)
    try:
        print("[bootstrap] 表行数：")
        for t in CHECKS:
            try:
                n = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                print(f"  - {t:<18} {n:>10,}")
            except Exception:
                print(f"  - {t:<18} {'(缺)':>10}")
    finally:
        conn.close()
    print("[bootstrap] 完成。下一步：scripts\\windows\\start.ps1")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
