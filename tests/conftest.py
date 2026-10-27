"""冒烟夹具：临时 DuckDB（含 1.0 继承表 + 2.0 新表 + 复权视图）+ 少量样例数据。"""
import duckdb
import pytest

from app.config import settings
from app.foundation.db import NEW_TABLES_DDL, PRICE_VIEW_DDL

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
        "INSERT INTO adjust_factor VALUES (?,?,?,?)",
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
        "INSERT OR REPLACE INTO sector_index VALUES (?,?,?,?,?,?,?,?,?)",
        [
            ("白酒", "2026-10-30", 3150.5, 1.85, "BK0477", 18, 2, "贵州茅台", 2.1),
            ("电池", "2026-10-30", 1980.2, -0.62, "BK0428", 8, 12, "宁德时代", -0.9),
        ],
    )
    conn.execute(
        "INSERT INTO corepicks_result VALUES "
        "('2026-10-30', 'chase', '白酒', '600519', 1, 86.5, 'strong', "
        "'{\"trend\": 0.82, \"volume\": 0.77, \"position\": 0.91}')"
    )
    conn.execute("CHECKPOINT")
    conn.close()
    return path


@pytest.fixture()
def client(duckdb_file, monkeypatch):
    from fastapi.testclient import TestClient

    from app.foundation import db as fdb

    fdb.reset_conn()
    monkeypatch.setattr(settings, "duckdb_path", duckdb_file)
    from app.main import app

    with TestClient(app) as c:
        yield c
    fdb.reset_conn()
