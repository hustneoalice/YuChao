"""冒烟夹具：临时 DuckDB（含 1.0 继承表 + 2.0 新表 + 复权视图）+ 少量样例数据。"""
import duckdb
import pytest

from app.config import settings
from app.foundation.db import MIGRATIONS, NEW_TABLES_DDL, PRICE_VIEW_DDL

DDL = """
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
    fore_offset DOUBLE, back_offset DOUBLE,
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


def _bars(symbol: str, days: int, base: float, pct_base: float = 1.0):
    # 60 个交易日：2026-09-01 起跨 9/10 两月（每月 30 天编号）
    rows = []
    for i in range(days):
        d = f"2026-{9 + i // 30:02d}-{i % 30 + 1:02d}"
        close = base + i * 0.1
        rows.append((symbol, d, close * 0.99, close * 1.01,
                     close * 0.98, close, 1_000_000.0, 20_000_000.0 + i * 10_000,
                     pct_base + i * 0.01, 2.5))
    return rows


@pytest.fixture()
def duckdb_file(tmp_path):
    path = tmp_path / "test.duckdb"
    conn = duckdb.connect(str(path))
    for stmt in DDL.split(";"):
        if stmt.strip():
            conn.execute(stmt)
    for stmt in NEW_TABLES_DDL.split(";"):
        if stmt.strip():
            conn.execute(stmt)
    for stmt in PRICE_VIEW_DDL.split(";"):
        if stmt.strip():
            conn.execute(stmt)
    for stmt in MIGRATIONS:                 # 存量表迁移（sector_index 补 kind 列）
        conn.execute(stmt)

    conn.executemany(
        "INSERT OR REPLACE INTO stock_universe VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)",
        [
            ("600519", "贵州茅台", "SH", "白酒", "traded", "2001-08-27"),
            ("000858", "五粮液", "SZ", "白酒", "traded", "1998-04-27"),
            ("300750", "宁德时代", "SZ", "电池", "traded", "2018-06-11"),
        ],
    )
    conn.executemany(
        "INSERT OR REPLACE INTO daily_ohlcv VALUES (?,?,?,?,?,?,?,?,?,?)",
        _bars("600519", 60, 1500.0, 1.0) + _bars("000858", 60, 120.0, 0.5)
        + _bars("300750", 60, 200.0, 2.0),
    )
    # 复权因子（1.0 口径：fore 最新=1，back 最早=1）
    conn.executemany(
        "INSERT INTO adjust_factor "
        "(symbol, ex_date, fore_adjust_factor, back_adjust_factor) VALUES (?,?,?,?)",
        [("600519", "2026-09-05", 0.9, 1.0), ("600519", "2026-09-20", 1.0, 1.1)],
    )
    conn.executemany(
        "INSERT OR REPLACE INTO capital_flow VALUES (?,?,?,?,?,?,?)",
        [
            ("600519", "2026-10-30", 1.2e8, 0.4e8, 0.8e8, -0.3e8, -0.9e8),
            ("000858", "2026-10-30", -0.5e8, -0.1e8, -0.4e8, 0.1e8, 0.4e8),
        ],
    )
    conn.executemany(
        "INSERT OR REPLACE INTO daily_valuation VALUES (?,?,?,?,?,?,?,?,?)",
        [
            ("600519", "2026-10-30", 22.5, 7.8, 15.2, 18.0, 2.1e12, 2.1e12, 3.0e10),
            ("000858", "2026-10-30", 18.1, 4.2, 5.5, 12.0, 5.6e11, 5.6e11, 8.0e9),
        ],
    )
    conn.executemany(
        "INSERT OR REPLACE INTO sector_index "
        "(industry, trade_date, close, pct_change, code, up_count, down_count, "
        " leader, leader_change, kind) VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
            ("白酒", "2026-10-30", 3150.5, 1.85, "BK0477", 18, 2, "贵州茅台", 2.1, "industry"),
            ("电池", "2026-10-30", 1980.2, -0.62, "BK0428", 8, 12, "宁德时代", -0.9, "industry"),
            ("免税概念", "2026-10-30", 2850.0, 3.42, "BK0580", 30, 2, "中国中免", 5.2, "concept"),
        ],
    )
    conn.executemany(
        "INSERT OR REPLACE INTO sector_member "
        "(bk_code, bk_name, symbol, stock_name) VALUES (?,?,?,?)",
        [
            ("BK0580", "免税概念", "600519", "贵州茅台"),
            ("BK0580", "免税概念", "300750", "宁德时代"),        ],
    )
    conn.execute(
        "INSERT INTO corepicks_result VALUES "
        "('2026-10-30', 'chase', '白酒', '600519', 1, 86.5, 'strong', "
        "'{\"trend\": 0.82, \"volume\": 0.77, \"position\": 0.91}')"
    )
    # 众赢板块体系 + 成分（清单 × 快照聚合的夹具：概念板块命中 2 股）
    conn.executemany(
        "INSERT OR REPLACE INTO zy_block "
        "(block_code, block_name, type_code, parent_code, sort_no) VALUES (?,?,?,?,?)",
        [
            ("G000021", "大飞机", 2, None, 0),
            ("TC000001", "光刻机概念", 9, None, 1),
            ("H110000", "农林牧渔", 4, None, 2),
            ("H110700", "养殖业", 4, "H110000", 3),
        ],
    )
    conn.executemany(
        "INSERT OR REPLACE INTO zy_block_member (block_code, symbol, stock_name) "
        "VALUES (?,?,?)",
        [
            ("G000021", "600519", "贵州茅台"),
            ("G000021", "000858", "五粮液"),
            ("TC000001", "300750", "宁德时代"),
        ],
    )
    # 场内基金清单（快照任务拉行情 kind='fund' 的口径来源）
    conn.executemany(
        "INSERT OR REPLACE INTO fund_universe (symbol, name, market) VALUES (?,?,?)",
        [("510300", "沪深300ETF", "SH"), ("159915", "创业板ETF", "SZ")],
    )
    # 全市场快照（2.2 全景大页：2 股 + 1 指数；涨跌停精确判定用例用 000858）
    conn.executemany(
        "INSERT OR REPLACE INTO market_snapshot "
        "(symbol, kind, market, name, current, change_amount, change_rate, "
        "open, high, low, pre_close, up_limit, down_limit, volume, amount, "
        "turnover_rate, vol_ratio, amplitude, bid1, bid1_vol, ask1, ask1_vol, "
        "outer_vol, inner_vol, market_value, circ_value, trade_date) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            ("600519", "stock", "SH", "贵州茅台", 1510.0, 10.0, 0.67,
             1502.0, 1520.0, 1498.0, 1500.0, 1650.0, 1350.0, 25000, 3.78e9,
             0.31, 0.9, 1.47, 1509.8, 100, 1510.2, 80, 13000, 12000,
             1.9e12, 1.9e12, "2026-10-30"),
            ("000858", "stock", "SZ", "五粮液", 132.0, 12.0, 10.0,
             120.0, 132.0, 119.5, 120.0, 132.0, 108.0, 800000, 1.06e10,
             6.72, 2.4, 10.42, 132.0, 5000, None, 0, 410000, 390000,
             5.13e11, 5.13e11, "2026-10-30"),
            ("300750", "stock", "SZ", "宁德时代", 251.0, -3.0, -1.18,
             254.0, 255.0, 250.1, 254.0, 279.4, 228.6, 300000, 7.5e9,
             0.45, 1.1, 1.92, 251.0, 200, 251.1, 150, 80000, 70000,
             1.15e12, 1.15e12, "2026-10-30"),
            ("000001.SH", "index", "SH", "上证指数", 3599.02, -52.6, -1.44,
             3651.6, 3651.6, 3594.1, 3651.62, 0.0, 0.0, 6.2e8, 8.9e11,
             0.0, 0.0, 1.57, 0, 0, 0, 0, 0, 0,
             None, None, "2026-10-30"),
            ("510300", "fund", "SH", "沪深300ETF", 4.12, 0.02, 0.49,
             4.1, 4.13, 4.09, 4.1, 0.0, 0.0, 1.2e6, 4.9e8,
             0.0, 0.0, 0.98, 0, 0, 0, 0, 0, 0,
             None, None, "2026-10-30"),
        ],
    )
    conn.execute("CHECKPOINT")
    conn.close()
    return path


@pytest.fixture(autouse=True)
def _freeze_realtime(monkeypatch):
    """默认冻结实时行情：K 线「今日 bar 合并」与 quote 实时覆盖测试不联网
    （2026-10-28 实测 kline 合并会引入腾讯真实价，冲掉夹具尾根导致断言失真）。
    需要实时段的用例自行 monkeypatch 覆盖本冻结。"""
    monkeypatch.setattr("app.foundation.live.realtime_quote", lambda *a, **k: None)
    monkeypatch.setattr("app.foundation.live.realtime_quotes", lambda *a, **k: {})


@pytest.fixture()
def updater_env(duckdb_file, tmp_path, monkeypatch):
    """writer → 临时库（含 update_log 落账表）；总线/快照/控制通道 → 临时文件。

    定义在 conftest（原 test_updater 本地夹具）：采集/编排/自愈多文件共用。"""
    from app.updater.writer import writer

    writer.db_path = duckdb_file
    writer.reset()
    writer.ensure_schema()
    monkeypatch.setattr("app.config.settings.stream_events_path",
                        tmp_path / "events.jsonl")
    monkeypatch.setattr("app.config.settings.update_snapshot_path",
                        tmp_path / "progress.json")
    monkeypatch.setattr("app.config.settings.control_requests_path",
                        tmp_path / "control.jsonl")
    yield duckdb_file
    writer.reset()
    # 恢复指向真实库：writer 是模块级单例，db_path 残留夹具路径会让后续
    # 走真实 lifespan 的用例（内核启动/降级）摸错库
    from app.config import settings as _settings
    writer.db_path = _settings.duckdb_path


@pytest.fixture()
def client(duckdb_file, monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(settings, "duckdb_path", duckdb_file)
    # 测试不启动内置更新内核（编排器/调度链/控制线程），保持夹具库只被请求只读访问
    monkeypatch.setattr(settings, "api_embedded_updater", False)
    from app.main import app

    with TestClient(app) as c:
        yield c
