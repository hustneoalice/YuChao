"""15:35 板块快照 → sector_index + 概念成分映射 → sector_member（幂等）。

2.1 起一次任务采两类清单：行业板块（东财 t:2）+ 概念板块（t:3），并为概念
逐板块拉成分（fs=b:BKxxxx）。行业成分不采集——stock_universe.industry
（东财 f100）已是现成归属口径。历史缺口本地重建（1.0 repair_sector_index）
属自愈层，M3 迁。
"""
from __future__ import annotations

import logging
import time
from datetime import datetime

from ..util import expected_asof
from ..writer import writer
from . import sources

logger = logging.getLogger("yuchao.updater")


def update_sector_index(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    result: dict = {"task": "sector_index", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)   # 允许无进度上报直调
    try:
        day = expected_asof()
        d0 = datetime.strptime(day, "%Y-%m-%d").date()
        counts: dict[str, int] = {}
        members_n = 0
        conn = writer.conn()
        for kind in ("industry", "concept"):
            sectors = sources.fetch_sector_snapshot(
                board_type=kind, progress=progress, cancel=cancel)
            if not sectors:
                raise RuntimeError(f"{kind} 板块快照为空（接口可能被限流）")
            progress(stage="写入板块", total=len(sectors), done=len(sectors),
                     message=f"{day} {kind} {len(sectors)} 个板块")
            conn.execute("DELETE FROM sector_index WHERE trade_date = ? AND kind = ?",
                         [day, kind])
            conn.executemany(
                "INSERT OR REPLACE INTO sector_index "
                "(industry, trade_date, close, pct_change, code, up_count, down_count, "
                " leader, leader_change, kind) VALUES (?,?,?,?,?,?,?,?,?,?)",
                [(s["industry"], day, s["close"], s["pct_change"], s["code"],
                  s["up_count"], s["down_count"], s["leader"], s["leader_change"], kind)
                 for s in sectors])
            conn.commit()
            counts[kind] = len(sectors)
            if kind == "concept":
                members_n = _sync_concept_members(conn, sectors, progress, cancel)
        result.update(status="success", rows=sum(counts.values()),
                      detail=f"{day} 行业 {counts.get('industry', 0)} / "
                             f"概念 {counts.get('concept', 0)}，概念成分映射 {members_n} 行")
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[SectorIndex] 板块快照失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result


def _sync_concept_members(conn, concepts: list[dict], progress, cancel) -> int:
    """概念成分全量重建（成分是慢变量：DELETE + INSERT 每日一次，幂等）。"""
    conn.execute("DELETE FROM sector_member")
    n = 0
    for i, s in enumerate(concepts):
        if cancel and cancel():
            break
        code = s.get("code")
        if not code:
            continue
        members = sources.fetch_board_members(code)
        if members:
            conn.executemany(
                "INSERT OR REPLACE INTO sector_member "
                "(bk_code, bk_name, symbol, stock_name) VALUES (?,?,?,?)",
                [(code, s["industry"], m["symbol"], m["stock_name"])
                 for m in members])
            n += len(members)
        if i % 20 == 0:
            conn.commit()                       # 分批提交：370 板块中途失败不整包丢
            progress(stage="概念成分", total=len(concepts), done=i + 1,
                     message=f"成分映射 {i + 1}/{len(concepts)} 板块")
    conn.commit()
    return n
