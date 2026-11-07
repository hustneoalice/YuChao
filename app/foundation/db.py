"""DuckDB 行情底座 · 访问层。

进程模型（2.1 起默认内置更新内核，api_embedded_updater=true）：
  - API 进程同时承担读与写（更新内核见 updater/embedded），连接全部以
    读写模式打开——同进程同实例共享，读写并发由 DuckDB 内部管理；
  - 回退模式（api_embedded_updater=false）：API 一律 READ_ONLY 挂载，
    写收敛进独立 updater 进程（DuckDB 多进程只允许全 read_only）。
  - 连接生命周期：每请求新建、读完即关（get_conn 生成器依赖 + finally close），
    请求间隙天然存在无锁窗口（回退模式下 updater 写锁重试依赖它）。

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

    -- 个股资料（主营问答 F16 与个股资料页共用；东财 F10 采集）
    CREATE TABLE IF NOT EXISTS stock_profile (
        symbol VARCHAR PRIMARY KEY,
        name VARCHAR,
        main_business VARCHAR,
        industry VARCHAR,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 板块成分映射（2.1 概念板块成分快照，每日全量重建；行业成分沿用
    -- stock_universe.industry 口径不进此表——东财 f100 标签已是现成归属）
    CREATE TABLE IF NOT EXISTS sector_member (
        bk_code VARCHAR,
        bk_name VARCHAR,
        symbol VARCHAR,
        stock_name VARCHAR,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (bk_code, symbol)
    );

    -- 当日全市场快照（2.2 全景大页地基；股票+指数+ETF 同表 kind 区分）。
    -- 盘中 5 分钟一轮覆盖写（按 trade_date DELETE+INSERT），收盘后最后一轮
    -- 即当日收盘快照；派生层（指数条/市场总貌/板块聚合）全部查询时算，不落表。
    CREATE TABLE IF NOT EXISTS market_snapshot (
        symbol        VARCHAR NOT NULL,   -- 600519 / 000001（指数裸码，与日线一致）
        kind          VARCHAR NOT NULL,   -- 'stock' | 'index'
        market        VARCHAR NOT NULL,   -- SH / SZ / BJ
        name          VARCHAR,
        current       DOUBLE, change_amount DOUBLE, change_rate DOUBLE,
        open          DOUBLE, high DOUBLE, low DOUBLE, pre_close DOUBLE,
        up_limit      DOUBLE, down_limit DOUBLE,
        volume        DOUBLE, amount DOUBLE,           -- 手 / 元
        turnover_rate DOUBLE, vol_ratio DOUBLE, amplitude DOUBLE,
        bid1 DOUBLE, bid1_vol DOUBLE, ask1 DOUBLE, ask1_vol DOUBLE,
        outer_vol DOUBLE, inner_vol DOUBLE,
        market_value  DOUBLE, circ_value DOUBLE,      -- 元
        trade_date    DATE NOT NULL,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (symbol, trade_date)
    );

    -- 众赢板块体系（1075 板块清单：地域 32/行业 39+细分/概念 750/风格 32/题材 222）。
    -- 清单与成分是慢变量，日级任务同步（匿名 GET，低频）；板块行情不落表——
    -- 查询时以 zy_block_member × market_snapshot 本地聚合（零上游，符合
    -- 「小厂源只做低频清单、行情一律自有源」的边界）。
    CREATE TABLE IF NOT EXISTS zy_block (
        block_code  VARCHAR PRIMARY KEY,   -- H110000/G000021/TC000001/F003491/D181319
        block_name  VARCHAR NOT NULL,
        type_code   INTEGER NOT NULL,      -- 1 地域 / 2 概念 / 4 行业 / 8 风格 / 9 题材
        parent_code VARCHAR,               -- 行业一级代码（type=4 子级挂一级），其余空
        sort_no     INTEGER,
        sync_date   DATE DEFAULT current_date   -- 新鲜度守卫（当日已同步 → 秒跳）
    );
    CREATE TABLE IF NOT EXISTS zy_block_member (
        block_code VARCHAR NOT NULL,
        symbol     VARCHAR NOT NULL,       -- 裸码（与 market_snapshot 主键同口径）
        stock_name VARCHAR,
        PRIMARY KEY (block_code, symbol)
    );

    -- 场内基金清单（ETF/LOF/REIT，新浪节点日级同步，东财 ETF 为 fallback）：
    -- 不进 stock_universe（避免污染选股宇宙），快照任务读此表拉行情
    -- kind='fund' 落 market_snapshot。
    CREATE TABLE IF NOT EXISTS fund_universe (
        symbol VARCHAR PRIMARY KEY,        -- 510300 / 159915（裸码）
        name   VARCHAR,
        market VARCHAR NOT NULL,           -- SH / SZ
        sync_date DATE DEFAULT current_date   -- 新鲜度守卫
    );

    -- 目标页指标层（后台定时预计算，见 updater/collectors/targets）：全市场
    -- 均线/量比/六分段/涨停次数一次算好落表；端点只做条件过滤（改条件毫秒级，
    -- 打开页面不再触发全市场窗口 SQL）。as_of = 数据日，供新鲜度守卫使用。
    CREATE TABLE IF NOT EXISTS target_scan (
        symbol        VARCHAR PRIMARY KEY,
        name          VARCHAR,
        close         DOUBLE, pct_chg DOUBLE,
        vol_ma40      DOUBLE, vol_ratio DOUBLE, vol_hit BOOLEAN,
        short_orange  BOOLEAN, mid_orange BOOLEAN,
        limit_up_20d  BOOLEAN, limit_up_cnt INTEGER,
        seg           INTEGER, seg_name VARCHAR, pullback BOOLEAN,
        acc_strength  DOUBLE,              -- 主力吸筹强度（个股内 250 日百分位 0-100）
        as_of         VARCHAR
    );

    -- 目标页趋势柱线 STICKV（预计算）：逐股分块算 2000 根 qfq，避免单条全市场
    -- 窗口查询打满 DuckDB 内存上限（1.5GiB，2026-11-02 请求内直算实测 OOM）。
    CREATE TABLE IF NOT EXISTS target_trend (
        symbol      VARCHAR PRIMARY KEY,
        data_date   VARCHAR, trend_value DOUBLE,
        cross_date  VARCHAR, cross_ago INTEGER, above_days INTEGER,
        neg_run     INTEGER,   -- 连续负柱收窄天数（绿柱缩短，提前捕捉上穿零轴）
        neg_abs     DOUBLE,    -- 当前负柱距零轴幅度 |STICKV|（正值时为 NULL）
        money_date  VARCHAR,   -- 最近一次钱袋（ZigZag 低点）日期
        money_ago   INTEGER,   -- 距今天数（0=今日；None=近20日未出现）
        money_cnt   INTEGER,   -- 近 20 个交易日出现次数
        mine_date   VARCHAR,   -- 最近一次地雷（ZigZag 高点回落）日期
        mine_ago    INTEGER,   -- 距今天数（0=今日；None=近20日未出现）
        mine_cnt    INTEGER    -- 近 20 个交易日出现次数
    );

    -- 尾盘估算（14:50 后用实时快照价充当当日收盘算钱袋/地雷，按日留档）。
    -- 只供目标页「尾盘估算」开关展示，收盘后正式 target_trend 一旦追上当日
    -- 自动让位；PK 保证同日多轮（14:50/14:55/15:00/15:05）覆盖不叠加。
    CREATE TABLE IF NOT EXISTS target_tail (
        symbol       VARCHAR NOT NULL,
        data_date    VARCHAR NOT NULL,   -- 估算所用日线槽位（快照 trade_date）
        snapshot_at  VARCHAR,            -- 快照抓取时刻 HH:MM（审计）
        computed_at  VARCHAR,            -- 估算写入时刻（审计）
        money_date   VARCHAR, money_ago INTEGER, money_cnt INTEGER,
        mine_date    VARCHAR, mine_ago  INTEGER, mine_cnt INTEGER,
        PRIMARY KEY (symbol, data_date)
    );
"""

# 存量表迁移（幂等；writer.ensure_schema / scripts/ensure_schema.py 共用执行）。
# 1.0 继承库没有 kind 列——概念板块接入（2.1）统一在此补齐，老库/导入包全兼容。
MIGRATIONS = (
    "ALTER TABLE sector_index ADD COLUMN IF NOT EXISTS kind VARCHAR DEFAULT 'industry'",
    "ALTER TABLE target_trend ADD COLUMN IF NOT EXISTS neg_run INTEGER",
    "ALTER TABLE target_trend ADD COLUMN IF NOT EXISTS neg_abs DOUBLE",
    "ALTER TABLE target_trend ADD COLUMN IF NOT EXISTS money_date VARCHAR",
    "ALTER TABLE target_trend ADD COLUMN IF NOT EXISTS money_ago INTEGER",
    "ALTER TABLE target_trend ADD COLUMN IF NOT EXISTS money_cnt INTEGER",
    "ALTER TABLE target_trend ADD COLUMN IF NOT EXISTS mine_date VARCHAR",
    "ALTER TABLE target_trend ADD COLUMN IF NOT EXISTS mine_ago INTEGER",
    "ALTER TABLE target_trend ADD COLUMN IF NOT EXISTS mine_cnt INTEGER",
    "ALTER TABLE target_scan ADD COLUMN IF NOT EXISTS acc_strength DOUBLE",
)

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
    """DuckDB 文件不存在 —— 连接无法建立，需先初始化/导入数据包。"""


# -- 进程级锚连接 ------------------------------------------------------------
# 内置内核模式专用：进程内常驻一条读写连接（不参与请求），让 DuckDB 的
# instance cache 稳定命中——否则并发「每请求 connect+close」会撞 attach 竞态
# （ResourceInUse: Unique file handle conflict，实测 6 线程×300 次失败 21 次，
# 有锚 0 次）。回退模式绝不能持锚：常驻只读连接会钉死共享锁，updater 写锁
# 永远拿不到（1.0 真实踩坑）。
_anchor = None


def hold_anchor() -> None:
    """内置模式启动时调用一次；进程生命周期内持有，随进程退出释放。"""
    global _anchor
    if _anchor is None:
        _anchor = duckdb.connect(str(Path(settings.duckdb_path)), read_only=False)


def open_conn() -> duckdb.DuckDBPyConnection:
    """新建连接（被写锁挡住时短重试）。调用方负责 close()。

    连接模式跟随运行形态：内置内核模式（api_embedded_updater=true）读写
    打开（同实例共享，编排器写连接同配置可并存）；回退模式只读挂载，
    跨进程写锁由重试协调。API 端点请用 get_conn（FastAPI 依赖，自动关闭）；
    open_conn 供非请求上下文（后台任务、测试）显式管理连接时使用。
    """
    path = Path(settings.duckdb_path)
    if not path.exists():
        raise DataSourceMissing(f"DuckDB 文件不存在：{path}")
    import time
    read_only = not settings.api_embedded_updater
    gap, tries = _READ_RETRY
    for i in range(tries):
        try:
            return duckdb.connect(str(path), read_only=read_only)
        except duckdb.IOException as e:      # 回退模式：写锁持有中（updater 任务执行窗口）
            if "Could not set lock" not in str(e) or i == tries - 1:
                raise
            time.sleep(gap)
    raise duckdb.IOException("unreachable")  # 循环内必 return 或 raise


def get_conn():
    """FastAPI 依赖：每请求一条连接，请求结束即关。"""
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
