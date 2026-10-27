"""DuckDB 行情底座 · 只读访问层。

进程模型（设计文档 03/05 节）：
  - API 进程对 DuckDB 一律 READ_ONLY 挂载（DuckDB 多进程只允许全 read_only），
    写全部收敛进 updater 进程（M1 暂单进程只读跑通，updater 属 M2）。
  - 连接按线程缓存：FastAPI 同步端点跑在线程池里，DuckDB 连接非线程安全，
    每线程一条只读连接，读与读互不排队。

复权口径（自 1.0 database.py 原样继承，单处定义）：
  - 底层 daily_ohlcv 一律存不复权原始价；
  - 前复权（qfq，看盘口径）最新因子=1 / 后复权（hfq，收益口径）最早因子=1，
    由 PRICE_VIEW_DDL 中的 ASOF 派生视图实现；
  - 无因子品种（指数等）由 COALESCE 自动退化为原始价。
"""
import threading
from pathlib import Path

import duckdb

from ..config import settings

# ----------------------------------------------------------------------------
# 前复权 / 后复权视图 DDL（1.0 原样继承 —— 口径只有这一处定义）
# ----------------------------------------------------------------------------
# init 脚本与测试夹具共用同一份字符串，避免副本漂移。仓库查询层直接读视图。
PRICE_VIEW_DDL = """
    -- 前复权视图（看盘口径，K线默认输出）：无因子记录的品种（指数等）自动退化为原始价
    CREATE OR REPLACE VIEW v_daily_ohlcv_qfq AS
    SELECT
        o.symbol, o.date,
        o.open  * COALESCE(af.fore_adjust_factor, 1) AS open,
        o.high  * COALESCE(af.fore_adjust_factor, 1) AS high,
        o.low   * COALESCE(af.fore_adjust_factor, 1) AS low,
        o.close * COALESCE(af.fore_adjust_factor, 1) AS close,
        o.volume, o.amount, o.pct_chg, o.turnover_rate
    FROM daily_ohlcv o
    ASOF LEFT JOIN adjust_factor af
        ON o.symbol = af.symbol AND CAST(o.date AS DATE) >= CAST(af.ex_date AS DATE);

    -- 后复权视图（收益计算口径，无未来函数）
    CREATE OR REPLACE VIEW v_daily_ohlcv_hfq AS
    SELECT
        o.symbol, o.date,
        o.open  * COALESCE(af.back_adjust_factor, 1) AS open,
        o.high  * COALESCE(af.back_adjust_factor, 1) AS high,
        o.low   * COALESCE(af.back_adjust_factor, 1) AS low,
        o.close * COALESCE(af.back_adjust_factor, 1) AS close,
        o.volume, o.amount, o.pct_chg, o.turnover_rate
    FROM daily_ohlcv o
    ASOF LEFT JOIN adjust_factor af
        ON o.symbol = af.symbol AND CAST(o.date AS DATE) >= CAST(af.ex_date AS DATE);
"""

# 2.0 新增表（schema 与 1.0 继承表无关；updater 写入，API 只读）
NEW_TABLES_DDL = """
    -- 核心标结果按日缓存（口径 PRD 十三；打分在闭源包，updater 21:00 落表后推送）
    CREATE TABLE IF NOT EXISTS corepicks_result (
        date VARCHAR,
        pool VARCHAR,          -- chase | dip
        sector VARCHAR,
        symbol VARCHAR,
        rank INTEGER,
        fund_score DOUBLE,
        seg VARCHAR,
        factors_json VARCHAR,  -- 三因子明细（闭源打分包产出）
        PRIMARY KEY (date, pool, symbol)
    );

    -- 个股资料（主营问答 F16 与个股资料页共用；采集源 AKShare）
    CREATE TABLE IF NOT EXISTS stock_profile (
        symbol VARCHAR PRIMARY KEY,
        name VARCHAR,
        main_business VARCHAR,
        industry VARCHAR,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
"""

_ADJUST_VIEW = {"qfq": "v_daily_ohlcv_qfq", "hfq": "v_daily_ohlcv_hfq", "raw": "daily_ohlcv"}


def source_for(adjust: str) -> str:
    """按复权口径返回读取源（视图已由 PRICE_VIEW_DDL 保证存在）。"""
    return _ADJUST_VIEW[adjust]


_local = threading.local()


class DataSourceMissing(RuntimeError):
    """DuckDB 文件不存在 —— API 进程只读挂载无法自建，需先初始化/导入数据包。"""


def get_conn() -> duckdb.DuckDBPyConnection:
    """当前线程的只读连接（懒建，随线程缓存）。"""
    conn = getattr(_local, "conn", None)
    if conn is None:
        path = Path(settings.duckdb_path)
        if not path.exists():
            raise DataSourceMissing(f"DuckDB 文件不存在：{path}")
        conn = duckdb.connect(str(path), read_only=True)
        _local.conn = conn
    return conn


def reset_conn() -> None:
    """关闭当前线程连接（测试换库 / 换路径时用）。"""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
        _local.conn = None


def ensure_schema(conn: duckdb.DuckDBPyConnection) -> None:
    """可写连接上补齐 2.0 新表与复权视图（幂等）。

    1.0 继承表的建表 DDL 不在此处：init 链路以初始数据包/1.0 库为准，
    API 进程只读挂载，无建表职责。
    """
    conn.execute("BEGIN")
    try:
        for stmt in NEW_TABLES_DDL.split(";"):
            stmt = stmt.strip()
            if stmt:
                conn.execute(stmt)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    for stmt in PRICE_VIEW_DDL.split(";"):
        stmt = stmt.strip()
        if stmt:
            conn.execute(stmt)
