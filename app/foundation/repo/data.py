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
