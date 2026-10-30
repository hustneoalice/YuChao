"""DuckDB 行情底座 · 只读访问层。

进程模型（设计文档 03/05 节）：
  - API 进程对 DuckDB 一律 READ_ONLY 挂载（DuckDB 多进程只允许全 read_only），
    写全部收敛进 updater 进程（M1 暂单进程只读跑通，updater 属 M2）。
  - 连接生命周期：每请求新建、读完即关（get_conn 生成器依赖 + finally close）。

为什么是「每请求开关」而不是「线程缓存 + 空闲 reaper」（2026-10-30 实测教训）：
  看盘工具永远在被前端轮询（行情/状态每 3s 一次），线程缓存连接的
  「空闲 90s 让锁」被轮询无限刷新——updater 写连接重试 150s 仍拿不到锁，
  增量更新永远失败。改为每请求开关后，请求间隙天然存在无锁窗口
  （连接仅存活毫秒级），updater 的 3s 重试必能拿到写锁；
  代价是每请求一次 connect 开销（实测 ~10ms 量级，单用户 QPS 下可忽略）。

复权口径（自 1.0 database.py 原样继承，单处定义）：
  - 底层 daily_ohlcv 一律存不复权原始价；
  - 前复权（qfq，看盘口径）最新因子=1 / 后复权（hfq，收益口径）最早因子=1，
    由 PRICE_VIEW_DDL 中的 ASOF 派生视图实现；
  - 无因子品种（指数等）由 COALESCE 自动退化为原始价。
"""
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


# -- 跨进程锁协调 -----------------------------------------------------------
# DuckDB 跨进程：一个写者 或 多个读者，互斥。API 只读连接若跨请求常驻持有
# 共享锁，updater 的写连接永远拿不到锁（真实踩坑两轮：① uvicorn 常驻连接
# → updater 起不来；② 线程缓存 + 空闲 reaper → 被前端 3s 轮询钉死 → 增量
# 更新 150s 重试耗尽）。因此：① 连接每请求开关（见模块 docstring）；
# ② 连接失败短重试等待写锁释放（updater 写任务限时，API 读重试足以等到）。
_READ_RETRY = (2.0, 12)  # 读连接被写锁挡住：间隔 2s × 至多 12 次（覆盖写任务尾段）


class DataSourceMissing(RuntimeError):
    """DuckDB 文件不存在 —— API 进程只读挂载无法自建，需先初始化/导入数据包。"""


def open_conn() -> duckdb.DuckDBPyConnection:
    """新建只读连接（被写锁挡住时短重试）。调用方负责 close()。

    API 端点请用 get_conn（FastAPI 依赖，自动关闭）；
    open_conn 供非请求上下文（后台任务、测试）显式管理连接时使用。
    """
    path = Path(settings.duckdb_path)
    if not path.exists():
        raise DataSourceMissing(f"DuckDB 文件不存在：{path}")
    import time
    gap, tries = _READ_RETRY
    for i in range(tries):
        try:
            return duckdb.connect(str(path), read_only=True)
        except duckdb.IOException as e:      # 写锁持有中（updater 任务执行窗口）
            if "Could not set lock" not in str(e) or i == tries - 1:
                raise
            time.sleep(gap)
    raise duckdb.IOException("unreachable")  # 循环内必 return 或 raise


def get_conn():
    """FastAPI 依赖：每请求一条只读连接，请求结束即关（让锁给 updater）。"""
    conn = open_conn()
    try:
        yield conn
    finally:
        try:
            conn.close()
        except Exception:
            pass


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
