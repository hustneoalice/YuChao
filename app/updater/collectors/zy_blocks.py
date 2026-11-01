"""众赢板块体系日级同步 → zy_block（清单）+ zy_block_member（成分映射）。

清单 1075 个（地域/概念/行业/风格/题材）匿名 GET 一次拉齐；成分逐板块
拉（~1075 请求/天，低频日级）。行情不在此采——查询时成分 × market_snapshot
本地聚合。非交易日清单照拉（静态），成分接口返回空则该板块跳过（容忍，
周一交易时段自动补齐）。
"""
from __future__ import annotations

import logging
import time

from ..writer import writer
from . import zy_source

logger = logging.getLogger("yuchao.updater")


def update_zy_blocks(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    result: dict = {"task": "zy_block_sync", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)
    try:
        conn = writer.conn()
        blocks = zy_source.fetch_zy_blocks(progress=progress, cancel=cancel)
        if not blocks:
            raise RuntimeError("板块清单为空（接口可能变更/被限流）")
        progress(stage="写板块清单", total=len(blocks), done=len(blocks),
                 message=f"众赢板块清单 {len(blocks)} 个")
        conn.execute("DELETE FROM zy_block")
        conn.executemany(
            "INSERT OR REPLACE INTO zy_block "
            "(block_code, block_name, type_code, parent_code, sort_no) "
            "VALUES (?,?,?,?,?)",
            [(b["block_code"], b["block_name"], b["type_code"],
              b["parent_code"], b["sort_no"]) for b in blocks])
        conn.commit()

        codes = [b["block_code"] for b in blocks]
        members = zy_source.fetch_zy_block_members_all(
            codes, progress=progress, cancel=cancel)
        conn.execute("DELETE FROM zy_block_member")
        rows = [(code, m["symbol"], m.get("stock_name"))
                for code, ms in members.items() for m in ms]
        if rows:
            conn.executemany(
                "INSERT OR REPLACE INTO zy_block_member "
                "(block_code, symbol, stock_name) VALUES (?,?,?)", rows)
        conn.commit()
        n_by_type: dict[int, int] = {}
        for b in blocks:
            n_by_type[b["type_code"]] = n_by_type.get(b["type_code"], 0) + 1
        result.update(status="success", rows=len(rows) + len(blocks),
                      detail=f"板块 {len(blocks)}（概念 {n_by_type.get(2, 0)} / "
                             f"题材 {n_by_type.get(9, 0)} / 行业 {n_by_type.get(4, 0)} / "
                             f"地域 {n_by_type.get(1, 0)} / 风格 {n_by_type.get(8, 0)}），"
                             f"成分映射 {len(rows)} 行 / {len(members)} 板块")
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[ZyBlocks] 众赢板块同步失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
