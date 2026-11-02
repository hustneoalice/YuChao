"""盘中全市场快照 → market_snapshot（全景大页数据地基）。

qt 一次报文即含快照全字段（价/涨跌/高低开昨收/涨跌停/量额/换手/量比/
振幅/买卖一/内外盘/市值），每 5 分钟一轮覆盖写当日；非交易时段与收盘后
秒跳（interval 触发的幂等语义），指数与股票同表 kind 区分。
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, time as dtime

from ..util import expected_asof
from ..writer import writer
from ...foundation.symbol import INDEX_CATALOG
from . import sources

logger = logging.getLogger("yuchao.updater")

# 单轮快照行数下限（疑似限流/整包垃圾拒绝落库；测试可 monkeypatch 调低）
_MIN_SNAPSHOT_ROWS = 3000


def _in_trading_hours(now: datetime) -> bool:
    """9:25 集合竞价起至 15:05 收盘落定，覆盖一轮。"""
    return dtime(9, 25) <= now.time() <= dtime(15, 5)


def update_market_snapshot(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    # force：非交易时段也强制补一轮（清单扩充/节假日修数时手动触发）
    force = bool((ctx or {}).get("force"))
    result: dict = {"task": "market_snapshot", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)
    try:
        now = datetime.now()
        day = expected_asof()
        if not _in_trading_hours(now):
            # 收盘后当日已有数据 → 幂等秒跳；没有（节假日自愈场景）也允许补一轮
            conn0 = writer.conn()
            have = conn0.execute(
                "SELECT COUNT(*) FROM market_snapshot WHERE trade_date = ?",
                [day]).fetchone()[0]
            if have and not force:
                result.update(status="skipped(fresh)",
                              detail=f"{day} 非交易时段，快照已有 {have} 行")
                result["elapsed"] = round(time.time() - start, 1)
                return result
        conn = writer.conn()
        uni = conn.execute("SELECT symbol, market FROM stock_universe").fetchall()
        funds = conn.execute("SELECT symbol, market FROM fund_universe").fetchall()
        # 股票：裸码 → market 列现成；指数：INDEX_CATALOG 全码（000001.SH 形态）；
        # 基金：fund_universe（ETF，裸码）——三者同一 qt 报文口径
        stock_map = {r[0]: r[1] for r in uni}
        fund_map = {r[0]: r[1] for r in funds}
        stocks = list(stock_map) + list(fund_map)
        indexes = [s for s, _ in INDEX_CATALOG]
        progress(stage="拉取行情", total=len(stocks) + len(indexes), done=0,
                 message=f"{day} 行情 {len(stock_map)} 只股票 + {len(fund_map)} 只基金 + "
                         f"{len(indexes)} 个指数")
        snap = sources.fetch_qt_snapshot(stocks + indexes,
                                         progress=progress, cancel=cancel)
        if len(snap) < _MIN_SNAPSHOT_ROWS:
            raise RuntimeError(f"只取到 {len(snap)} 条行情（少于 {_MIN_SNAPSHOT_ROWS}，"
                               f"可能被数据源限流），本次不写入")
        index_set = set(indexes)
        rows = []
        for full, t in snap.items():
            num, market = full.split(".", 1)
            if full in index_set:
                kind, sym = "index", full        # 指数存全码（与 daily_ohlcv 指数一致）
                # 指数无涨跌停/换手/量比概念：qt 回空，兜 0（总貌只按 stock 统计）
                t = t[:8] + (0.0, 0.0) + t[10:12] + (0.0, 0.0) + t[14:]
            elif num in stock_map:
                kind, sym = "stock", num         # 股票存裸码（与日线主键一致）
            elif num in fund_map:
                kind, sym = "fund", num          # 基金存裸码（与 fund_universe 一致）
            else:
                continue
            rows.append((sym, kind, market) + t + (day,))
        conn.execute("DELETE FROM market_snapshot WHERE trade_date = ?", [day])
        conn.executemany(
            "INSERT OR REPLACE INTO market_snapshot "
            "(symbol, kind, market, name, current, change_amount, change_rate, "
            "open, high, low, pre_close, up_limit, down_limit, volume, amount, "
            "turnover_rate, vol_ratio, amplitude, bid1, bid1_vol, ask1, ask1_vol, "
            "outer_vol, inner_vol, market_value, circ_value, trade_date) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rows)
        conn.commit()
        n_stk = sum(1 for r in rows if r[1] == "stock")
        n_fund = sum(1 for r in rows if r[1] == "fund")
        result.update(status="success", rows=len(rows),
                      detail=f"{day} 股票 {n_stk} / 基金 {n_fund} / "
                             f"指数 {len(rows) - n_stk - n_fund}")
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Snapshot] 全市场快照失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
