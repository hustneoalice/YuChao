"""15:35 行业板块快照 → sector_index（当日东财行业板块清单，幂等）。

M2 简化：当日远端快照（先删当日再插，与估值同规约）；历史缺口本地重建
（1.0 repair_sector_index）属自愈层，M3 迁。
"""
from __future__ import annotations

import time
from datetime import datetime

from ..util import expected_asof
from ..writer import writer
from . import sources


def update_sector_index(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    result: dict = {"task": "sector_index", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)   # 允许无进度上报直调
    try:
        day = expected_asof()
        d0 = datetime.strptime(day, "%Y-%m-%d").date()
        sectors = sources.fetch_sector_snapshot(progress=progress, cancel=cancel)
        if not sectors:
            raise RuntimeError("板块快照为空（接口可能被限流）")
        progress(stage="写入板块", total=len(sectors), done=0,
                 message=f"{day} {len(sectors)} 个行业板块")
        conn = writer.conn()
        conn.execute("DELETE FROM sector_index WHERE trade_date = ?", [day])
        conn.executemany(
            "INSERT OR REPLACE INTO sector_index "
            "(industry, trade_date, close, pct_change, code, up_count, down_count, "
            " leader, leader_change) VALUES (?,?,?,?,?,?,?,?,?)",
            [(s["industry"], day, s["close"], s["pct_change"], s["code"],
              s["up_count"], s["down_count"], s["leader"], s["leader_change"])
             for s in sectors])
        conn.commit()
        result.update(status="success", rows=len(sectors),
                      detail=f"{day} 写入 {len(sectors)} 个行业板块")
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[SectorIndex] 板块快照失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
