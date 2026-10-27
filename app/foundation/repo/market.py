"""行情读取：K 线（复权派生视图）/ 快照 / 搜索。"""
from typing import Optional

from .. import db
from ..symbol import normalize_symbol
from ...errors import not_found
from ...contracts.common import Adjust
from ...foundation.indicators import standard_indicators

_UNIVERSE_COLS = "symbol, name, market, industry, status"


def universe_entry(conn, symbol: str) -> Optional[dict]:
    row = conn.execute(
        f"SELECT {_UNIVERSE_COLS} FROM stock_universe WHERE symbol = ?", [symbol]
    ).fetchone()
    if not row:
        return None
    return dict(zip(_UNIVERSE_COLS.replace(", ", ",").split(","), row))


def get_kline(
    conn,
    symbol: str,
    adjust: Adjust = Adjust.qfq,
    with_param: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 500,
) -> dict:
    """K 线：复权口径由 PRICE_VIEW_DDL 的视图保证（qfq 看盘 / hfq 收益 / raw 原始价）。"""
    symbol = normalize_symbol(symbol)
    meta = universe_entry(conn, symbol)
    if meta is None:
        # 指数等池外品种：daily_ohlcv 有数据即放行，名称留空
        if not conn.execute(
            "SELECT 1 FROM daily_ohlcv WHERE symbol = ? LIMIT 1", [symbol]
        ).fetchone():
            raise not_found(f"未收录标的：{symbol}", {"symbol": symbol})

    src = db.source_for(adjust.value)
    conds, params = ["symbol = ?"], [symbol]
    if start:
        conds.append("date >= ?")
        params.append(start)
    if end:
        conds.append("date <= ?")
        params.append(end)
    rows = conn.execute(
        f"""
        SELECT symbol, date, open, high, low, close, volume, amount, pct_chg, turnover_rate
        FROM {src}
        WHERE {' AND '.join(conds)}
        ORDER BY date
        LIMIT ?
        """,
        [*params, limit],
    ).fetchall()

    closes = [r[5] for r in rows]
    inds = standard_indicators(closes) if with_param == "indicator" else None
    bars = []
    for i, r in enumerate(rows):
        bar = {
            "date": str(r[1]), "open": r[2], "high": r[3], "low": r[4], "close": r[5],
            "volume": r[6], "amount": r[7], "pct_chg": r[8], "turnover_rate": r[9],
        }
        if inds is not None:
            bar["indicators"] = {k: v[i] for k, v in inds.items()}
        bars.append(bar)
    return {
        "symbol": symbol,
        "name": meta["name"] if meta else None,
        "period": "day",
        "adjust": adjust.value,
        "with": with_param,
        "bars": bars,
    }


def get_quote(conn, symbol: str) -> dict:
    """快照 = 最新日线（qfq 口径）+ 估值 + 当日资金流 + 池内档案。"""
    symbol = normalize_symbol(symbol)
    meta = universe_entry(conn, symbol)
    bar_row = conn.execute(
        """
        SELECT date, open, high, low, close, volume, amount, pct_chg, turnover_rate
        FROM v_daily_ohlcv_qfq WHERE symbol = ? ORDER BY date DESC LIMIT 1
        """,
        [symbol],
    ).fetchone()
    if meta is None and bar_row is None:
        raise not_found(f"未收录标的：{symbol}", {"symbol": symbol})

    out = {"symbol": symbol, **(meta or {})}
    if bar_row:
        keys = ["date", "open", "high", "low", "close", "volume", "amount", "pct_chg", "turnover_rate"]
        out.update(dict(zip(keys, bar_row)))
        out["date"] = str(out["date"])

    val = conn.execute(
        """
        SELECT date, pe_ttm, pb, ps_ttm, total_mv, circ_mv FROM daily_valuation
        WHERE symbol = ? ORDER BY date DESC LIMIT 1
        """,
        [symbol],
    ).fetchone()
    if val:
        out["valuation"] = {"date": str(val[0]), "pe_ttm": val[1], "pb": val[2],
                            "ps_ttm": val[3], "total_mv": val[4], "circ_mv": val[5]}

    flow = conn.execute(
        """
        SELECT date, net_main, net_super, net_large, net_medium, net_small FROM capital_flow
        WHERE symbol = ? ORDER BY date DESC LIMIT 1
        """,
        [symbol],
    ).fetchone()
    if flow:
        fkeys = ["date", "net_main", "net_super", "net_large", "net_medium", "net_small"]
        out["capital_flow"] = dict(zip(fkeys, flow))
        out["capital_flow"]["date"] = str(out["capital_flow"]["date"])
    return out


def search(conn, q: str, limit: int = 10) -> list[dict]:
    """代码 / 名称 / 拼音检索（M1：代码与名称前缀+包含；拼音 M2 接入）。"""
    like = f"%{q.upper()}%"
    rows = conn.execute(
        f"""
        SELECT {_UNIVERSE_COLS} FROM stock_universe
        WHERE UPPER(symbol) LIKE ? OR UPPER(name) LIKE ?
        ORDER BY CASE WHEN UPPER(symbol) = ? THEN 0
                       WHEN UPPER(name) = ? THEN 1
                       ELSE 2 END, symbol
        LIMIT ?
        """,
        [like, like, q.upper(), q.upper(), limit],
    ).fetchall()
    keys = _UNIVERSE_COLS.replace(", ", ",").split(",")
    return [dict(zip(keys, r)) for r in rows]
