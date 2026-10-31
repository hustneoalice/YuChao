"""板块读取：sector_index 最新日列表（行业/概念）+ 成分股成交额加权涨幅排序。

成分口径按板块 kind 自动分流：行业 = stock_universe.industry（东财 f100，
1.0 继承）；概念 = sector_member 映射（2.1，fs=b:BKxxxx 采集）。
"""
from typing import Optional

_WINDOW_COLS = ("symbol", "name", "last_date", "last_close", "lookback_pct", "main_net")


def list_sectors(conn, sector_type: str = "industry", limit: int = 100) -> dict:
    """板块按当日涨跌排序 + 板块级资金/成分聚合（策影板块强度表核心列）。

    主力净流入按成分归属 rollup capital_flow（行业走 f100 口径、概念走
    sector_member 口径，members CTE 参数化统一两套来源，不引申万依赖）。
    """
    if sector_type not in ("industry", "concept"):
        return {"items": [], "total": 0}

    rows = conn.execute(
        """
        WITH secs AS (
            SELECT industry, trade_date, close, pct_change, up_count, down_count,
                   leader, leader_change
            FROM sector_index
            WHERE trade_date = (SELECT MAX(trade_date) FROM sector_index)
              AND kind = ?
            LIMIT ?
        ),
        members AS (
            SELECT industry AS ind, symbol FROM stock_universe WHERE ? = 'industry'
            UNION ALL
            SELECT bk_name AS ind, symbol FROM sector_member WHERE ? = 'concept'
        ),
        flow1 AS (
            SELECT m.ind AS ind, SUM(c.net_main) AS net
            FROM capital_flow c JOIN members m ON m.symbol = c.symbol
            WHERE c.date = (SELECT MAX(date) FROM capital_flow)
            GROUP BY 1
        ),
        win AS (SELECT DISTINCT date FROM capital_flow ORDER BY date DESC LIMIT 5),
        flow5 AS (
            SELECT m.ind AS ind, SUM(c.net_main) AS net
            FROM capital_flow c JOIN members m ON m.symbol = c.symbol
            WHERE c.date IN (SELECT date FROM win)
            GROUP BY 1
        ),
        cnt AS (SELECT ind, COUNT(*) AS n FROM members GROUP BY 1)
        SELECT s.industry, s.trade_date, s.close, s.pct_change, s.up_count,
               s.down_count, s.leader, s.leader_change, f1.net, f5.net, c.n
        FROM secs s
        LEFT JOIN flow1 f1 ON f1.ind = s.industry
        LEFT JOIN flow5 f5 ON f5.ind = s.industry
        LEFT JOIN cnt c ON c.ind = s.industry
        ORDER BY s.pct_change DESC NULLS LAST
        """,
        [sector_type, limit, sector_type, sector_type],
    ).fetchall()
    items = [
        {
            "id": r[0], "name": r[0], "type": sector_type, "trade_date": str(r[1]),
            "close": r[2], "pct_change": r[3], "up_count": r[4], "down_count": r[5],
            "leader": r[6], "leader_change": r[7],
            "main_net_today": r[8], "main_net_5d": r[9], "member_count": r[10],
        }
        for r in rows
    ]
    return {"items": items, "total": len(items)}


def _member_kind(conn, sector_id: str) -> str:
    """板块归属类型：industry | concept（同名时取最新，行业优先）。"""
    row = conn.execute(
        "SELECT kind FROM sector_index WHERE industry = ? OR code = ? "
        "ORDER BY trade_date DESC, kind DESC LIMIT 1",
        [sector_id, sector_id],
    ).fetchone()
    return row[0] if row else "industry"


def sector_members(conn, sector_id: str, lookback: int = 5, limit: int = 100) -> dict:
    """成分股：窗口内成交额加权涨幅（sum(amount×pct_chg)/sum(amount)）+ 窗口主力净流入。

    成分来源按 kind 分流（行业 f100 / 概念 sector_member），加权与资金逻辑共用。
    """
    kind = _member_kind(conn, sector_id)
    if kind == "industry":
        members_sql = "SELECT symbol FROM stock_universe WHERE industry = ?"
    else:
        members_sql = "SELECT symbol FROM sector_member WHERE bk_name = ?"

    total_row = conn.execute(
        f"SELECT COUNT(*) FROM ({members_sql})", [sector_id]
    ).fetchone()
    total = int(total_row[0]) if total_row else 0
    if total == 0:
        return {"items": [], "total": 0}

    rows = conn.execute(
        f"""
        WITH win AS (
            SELECT DISTINCT date FROM daily_ohlcv ORDER BY date DESC LIMIT ?
        ),
        agg AS (
            SELECT o.symbol,
                   SUM(o.amount * o.pct_chg) / NULLIF(SUM(o.amount), 0) AS lookback_pct,
                   ARG_MAX(o.close, o.date) AS last_close,
                   MAX(o.date) AS last_date
            FROM daily_ohlcv o
            WHERE o.symbol IN ({members_sql})
              AND o.date IN (SELECT date FROM win)
            GROUP BY o.symbol
        ),
        flow AS (
            SELECT c.symbol, SUM(c.net_main) AS main_net
            FROM capital_flow c
            WHERE c.date IN (SELECT date FROM win)
              AND c.symbol IN ({members_sql})
            GROUP BY c.symbol
        )
        SELECT u.symbol, u.name, a.last_date, a.last_close, a.lookback_pct, f.main_net
        FROM stock_universe u
        JOIN agg a ON a.symbol = u.symbol
        LEFT JOIN flow f ON f.symbol = u.symbol
        WHERE u.symbol IN ({members_sql})
        ORDER BY a.lookback_pct DESC NULLS LAST
        LIMIT ?
        """,
        [lookback, sector_id, sector_id, sector_id, limit],
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
        SELECT industry, trade_date, close, pct_change, kind FROM sector_index
        WHERE industry = ? OR code = ? ORDER BY trade_date DESC, kind DESC LIMIT 1
        """,
        [sector_id, sector_id],
    ).fetchone()
    if not row:
        return None
    return {"id": row[0], "name": row[0], "trade_date": str(row[1]),
            "close": row[2], "pct_change": row[3], "kind": row[4]}
