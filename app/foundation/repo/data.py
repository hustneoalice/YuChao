"""数据底座状态：表清单体检（行数 / 最新日期）+ 状态机。"""
from datetime import datetime

_INVENTORY = (
    "daily_ohlcv", "adjust_factor", "capital_flow", "financials",
    "stock_universe", "sector_index", "daily_valuation",
    "corepicks_result", "stock_profile",
)


def table_status(conn, table: str) -> dict:
    date_col = _DATE_COL.get(table)
    date_expr = f"MAX({date_col})" if date_col else "NULL"
    try:
        row = conn.execute(f"SELECT COUNT(*), {date_expr} FROM {table}").fetchone()
    except Exception:
        return {"table": table, "rows": None, "latest_date": None}
    return {"table": table, "rows": int(row[0]) if row else 0,
            "latest_date": str(row[1]) if row and row[1] else None}


# 各表"最新日期"列名（1.0 schema 原样；无日期维度 → None）
_DATE_COL = {
    "daily_ohlcv": "date", "adjust_factor": "ex_date", "capital_flow": "date",
    "financials": "report_date", "stock_universe": None, "sector_index": "trade_date",
    "daily_valuation": "date", "corepicks_result": "date", "stock_profile": None,
}


def get_status(conn, duckdb_path) -> dict:
    tables = [table_status(conn, t) for t in _INVENTORY]
    ohlcv = next(t for t in tables if t["table"] == "daily_ohlcv")
    stage = "ready" if (ohlcv["rows"] or 0) > 0 else "uninitialized"
    return {
        "stage": stage,
        "duckdb_path": str(duckdb_path),
        "tables": tables,
        "generated_at": datetime.now().isoformat(),
    }


def file_missing_status(duckdb_path) -> dict:
    return {
        "stage": "uninitialized",
        "duckdb_path": str(duckdb_path),
        "tables": [],
        "generated_at": datetime.now().isoformat(),
    }


# ---------------------------------------------------------------------------
# M2：编排器落账查询（update_log 表由 updater 进程写入，此处只读）
# ---------------------------------------------------------------------------

def list_update_log(conn, limit: int = 50, data_type: str | None = None,
                    status: str | None = None) -> list[dict]:
    sql = ("SELECT id, data_type, trade_date, status, rows, error, detail, "
           "duration_s, trigger, created_at FROM update_log")
    conds, params = [], []
    if data_type:
        conds.append("data_type = ?")
        params.append(data_type)
    if status:
        conds.append("status = ?")
        params.append(status)
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(min(int(limit), 200))
    rows = conn.execute(sql, params).fetchall()
    return [{
        "id": r[0], "data_type": r[1], "trade_date": r[2], "status": r[3],
        "rows": int(r[4] or 0), "error": r[5], "detail": r[6],
        "duration_s": r[7], "trigger": r[8], "created_at": str(r[9]),
    } for r in rows]
