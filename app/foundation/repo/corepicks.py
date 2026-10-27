"""核心标读取：corepicks_result 名单公开；三因子明细 VIP（M1 桩 403）。"""
import json
from typing import Optional

from ...errors import not_found


def _guard_table(conn, sql: str, params: list):
    try:
        return conn.execute(sql, params).fetchall()
    except Exception as exc:  # 表未建（初始包未含 2.0 新表）→ 空集而非 500
        if "does not exist" in str(exc).lower() or "not found" in str(exc).lower():
            return []
        raise


def list_corepicks(conn, date: Optional[str] = None, pool: Optional[str] = None,
                   limit: int = 100) -> dict:
    conds, params = [], []
    if date:
        conds.append("date = ?")
        params.append(date)
    if pool:
        conds.append("pool = ?")
        params.append(pool)
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    # 未指定日期 → 取库内最新结果日
    if not date:
        latest = _guard_table(
            conn,
            "SELECT MAX(date) FROM corepicks_result"
            + (" WHERE pool = ?" if pool else ""),
            [pool] if pool else [],
        )
        latest_date = latest[0][0] if latest and latest[0][0] else None
        if latest_date is None:
            return {"date": None, "items": [], "total": 0}
        conds.append("date = ?")
        params.append(latest_date)
        where = f"WHERE {' AND '.join(conds)}"

    rows = _guard_table(
        conn,
        f"""
        SELECT r.date, r.pool, r.sector, r.symbol, COALESCE(u.name, r.sector), r.rank,
               r.fund_score, r.seg
        FROM corepicks_result r
        LEFT JOIN stock_universe u ON u.symbol = r.symbol
        {where}
        ORDER BY r.rank
        LIMIT ?
        """,
        [*params, limit],
    )
    items = [
        {"date": str(r[0]), "pool": r[1], "sector": r[2], "symbol": r[3],
         "name": r[4], "rank": r[5], "fund_score": r[6], "seg": r[7]}
        for r in rows
    ]
    result_date = str(items[0]["date"]) if items else (date or None)
    return {"date": result_date, "items": items, "total": len(items)}


def get_factors(conn, symbol: str, date: Optional[str] = None,
                pool: Optional[str] = None) -> dict:
    """取单标的记录行（factors_json 解析留给路由层做 VIP 门控）。"""
    conds, params = ["symbol = ?"], [symbol]
    if pool:
        conds.append("pool = ?")
        params.append(pool)
    where = f"WHERE {' AND '.join(conds)}"
    rows = _guard_table(
        conn,
        f"""
        SELECT r.date, r.pool, r.sector, r.symbol, r.rank, r.fund_score, r.seg, r.factors_json
        FROM corepicks_result r
        WHERE {' AND '.join(conds)}
        ORDER BY r.date DESC
        LIMIT 1
        """,
        params,
    )
    if not rows:
        raise not_found(f"核心标无记录：{symbol}", {"symbol": symbol, "date": date, "pool": pool})
    r = rows[0]
    try:
        factors = json.loads(r[7]) if r[7] else None
    except (TypeError, ValueError):
        factors = None
    return {"date": str(r[0]), "pool": r[1], "sector": r[2], "symbol": r[3],
            "rank": r[4], "fund_score": r[5], "seg": r[6], "factors": factors}
