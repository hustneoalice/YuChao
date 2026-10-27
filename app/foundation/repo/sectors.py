"""板块读取：sector_index 最新日列表 + 成分股成交额加权涨幅排序。"""
from typing import Optional

_WINDOW_COLS = ("symbol", "name", "last_date", "last_close", "lookback_pct", "main_net")


def list_sectors(conn, sector_type: str = "industry", limit: int = 100) -> dict:
    """行业板块按当日涨跌排序（1.0 sector_index 字段原样）。

    概念板块（type=concept）为 2.0 增补口径，M1 数据未采集，返回空集。
    """
    if sector_type != "industry":
        return {"items": [], "total": 0}

    rows = conn.execute(
        """
        SELECT industry, trade_date, close, pct_change, up_count, down_count, leader, leader_change
        FROM sector_index
        WHERE trade_date = (SELECT MAX(trade_date) FROM sector_index)
        ORDER BY pct_change DESC NULLS LAST
        LIMIT ?
        """,
        [limit],
    ).fetchall()
    items = [
        {
            "id": r[0], "name": r[0], "type": "industry", "trade_date": str(r[1]),
            "close": r[2], "pct_change": r[3], "up_count": r[4], "down_count": r[5],
            "leader": r[6], "leader_change": r[7],
        }
        for r in rows
    ]
    return {"items": items, "total": len(items)}


def sector_members(conn, sector_id: str, lookback: int = 5, limit: int = 100) -> dict:
    """成分股：窗口内成交额加权涨幅（sum(amount×pct_chg)/sum(amount)）+ 窗口主力净流入。

    成分 = stock_universe.industry（东财 f100 标签，与 1.0 同口径）。
    """
    total_row = conn.execute(
        "SELECT COUNT(*) FROM stock_universe WHERE industry = ?", [sector_id]
    ).fetchone()
    total = int(total_row[0]) if total_row else 0
    if total == 0:
        return {"items": [], "total": 0}

    rows = conn.execute(
        """
        WITH win AS (
            SELECT DISTINCT date FROM daily_ohlcv ORDER BY date DESC LIMIT ?
        ),
        agg AS (
            SELECT o.symbol,
                   SUM(o.amount * o.pct_chg) / NULLIF(SUM(o.amount), 0) AS lookback_pct,
                   ARG_MAX(o.close, o.date) AS last_close,
                   MAX(o.date) AS last_date
            FROM daily_ohlcv o
            WHERE o.symbol IN (SELECT symbol FROM stock_universe WHERE industry = ?)
              AND o.date IN (SELECT date FROM win)
            GROUP BY o.symbol
        ),
        flow AS (
            SELECT c.symbol, SUM(c.net_main) AS main_net
            FROM capital_flow c
            WHERE c.date IN (SELECT date FROM win)
            GROUP BY c.symbol
        )
        SELECT u.symbol, u.name, a.last_date, a.last_close, a.lookback_pct, f.main_net
        FROM stock_universe u
        JOIN agg a ON a.symbol = u.symbol
        LEFT JOIN flow f ON f.symbol = u.symbol
        WHERE u.industry = ?
        ORDER BY a.lookback_pct DESC NULLS LAST
        LIMIT ?
        """,
        [lookback, sector_id, sector_id, limit],
    ).fetchall()
    items = [
        {
            "symbol": r[0], "name": r[1], "last_date": str(r[2]) if r[2] else None,
            "last_close": r[3], "lookback_pct": r[4], "main_net": r[5],
        }
        for r in rows
    ]
    return {"items": items, "total": total}


def get_sector_meta(conn, sector_id: str) -> Optional[dict]:
    row = conn.execute(
        """
        SELECT industry, trade_date, close, pct_change FROM sector_index
        WHERE industry = ? ORDER BY trade_date DESC LIMIT 1
        """,
        [sector_id],
    ).fetchone()
    if not row:
        return None
    return {"id": row[0], "name": row[0], "trade_date": str(row[1]),
            "close": row[2], "pct_change": row[3]}
