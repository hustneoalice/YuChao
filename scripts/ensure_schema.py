#!/usr/bin/env python
"""对本地 DuckDB 补齐 2.0 新表与复权视图（幂等，可写运行一次即可）。

用法：python scripts/ensure_schema.py [db_path]
缺省路径取 YUCHAO_DUCKDB_PATH 或 data/stock_research.duckdb。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import duckdb  # noqa: E402

from app.config import settings  # noqa: E402
from app.foundation.db import PRICE_VIEW_DDL, NEW_TABLES_DDL  # noqa: E402


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else settings.duckdb_path)
    if not path.exists():
        print(f"[ensure_schema] 库不存在：{path}（初始化/导入初始数据包属 M2）")
        raise SystemExit(1)
    conn = duckdb.connect(str(path))  # 可写
    try:
        for stmt in NEW_TABLES_DDL.split(";"):
            if stmt.strip():
                conn.execute(stmt)
        for stmt in PRICE_VIEW_DDL.split(";"):
            if stmt.strip():
                conn.execute(stmt)
        conn.execute("CHECKPOINT")
        print(f"[ensure_schema] 完成：{path}")
        for table in ("corepicks_result", "stock_profile", "v_daily_ohlcv_qfq", "v_daily_ohlcv_hfq"):
            print("  -", table)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
