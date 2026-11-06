"""只读工具：口径全部复用 DuckDB 现有表，不新增计算。"""
from __future__ import annotations

from .registry import ToolSpec, register

_PROFILE_COLS = ("symbol", "name", "main_business", "industry", "updated_at")
_QUOTE_COLS = ("symbol", "current", "change_rate", "turnover_rate", "amount",
               "trade_date", "updated_at")


def stock_profile(conn, symbol: str) -> dict:
    """个股主营业务 + 所属行业（本地资料表）。"""
    row = conn.execute(
        "SELECT " + ",".join(_PROFILE_COLS) + " FROM stock_profile WHERE symbol = ?",
        [symbol],
    ).fetchone()
    if not row:
        return {"symbol": symbol, "missing": True, "reason": "本地未收录该标的资料"}
    d = dict(zip(_PROFILE_COLS, row))
    d["updated_at"] = str(d.get("updated_at") or "")[:10]
    d["missing"] = not str(d.get("main_business") or "").strip()
    return d


register(ToolSpec(
    id="stock_profile",
    name="个股主营",
    cat="财务",
    desc="查询个股主营业务与所属行业（本地资料库）",
    params={"symbol": "6 位股票代码"},
    returns="{symbol,name,main_business,industry,updated_at,missing}",
    source="stock_profile（AKShare 采集）",
), stock_profile)


def stock_quote(conn, symbol: str) -> dict:
    """最新快照：现价、涨跌幅、换手率、成交额。"""
    row = conn.execute(
        "SELECT " + ",".join(_QUOTE_COLS) + " FROM market_snapshot"
        " WHERE symbol = ? ORDER BY trade_date DESC LIMIT 1",
        [symbol],
    ).fetchone()
    if not row:
        return {"symbol": symbol, "missing": True, "reason": "当日快照未采集"}
    d = dict(zip(_QUOTE_COLS, row))
    d["trade_date"] = str(d.get("trade_date") or "")[:10]
    d["updated_at"] = str(d.get("updated_at") or "")
    d["missing"] = False
    return d


register(ToolSpec(
    id="stock_quote",
    name="个股快照",
    cat="行情",
    desc="查询个股最新价、涨跌幅、换手率与成交额",
    params={"symbol": "6 位股票代码"},
    returns="{symbol,current,change_rate,turnover_rate,amount,trade_date}",
    source="market_snapshot（东财快照）",
    freshness="ohlcv",
), stock_quote)
