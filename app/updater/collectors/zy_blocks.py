"""众赢板块体系日级同步 → zy_block（清单）+ zy_block_member（成分映射）。

清单 1075 个（地域/概念/行业/风格/题材）匿名 GET 一次拉齐；成分逐板块
拉（~1075 请求/天，低频日级）。行情不在此采——查询时成分 × market_snapshot
本地聚合。优先使用Windows本地分类快照；远端空响应保留原板块成分。
"""
from __future__ import annotations

import logging
import time

from ..writer import writer
from ...foundation.bulk import bulk_upsert
from . import zy_source
from .zy_local import LOCAL_CONFIG, import_config

logger = logging.getLogger("yuchao.updater")

_BLOCK_COLS = ("block_code", "block_name", "type_code", "parent_code", "sort_no")
_BLOCK_MEMBER_COLS = ("block_code", "symbol", "stock_name")


def update_zy_blocks(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    result: dict = {"task": "zy_block_sync", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)
    try:
        conn = writer.conn()
        if LOCAL_CONFIG and LOCAL_CONFIG.exists():
            detail = import_config(conn, LOCAL_CONFIG)
            result.update(status="success", rows=detail['members'],
                          detail=f"Windows板块快照：{detail['blocks']}板块 / {detail['members']}关系 / {detail['stocks']}只股票")
            result['elapsed'] = round(time.time() - start, 1)
            return result
        blocks = zy_source.fetch_zy_blocks(progress=progress, cancel=cancel)
        if not blocks:
            raise RuntimeError("板块清单为空（接口可能变更/被限流）")
        progress(stage="写板块清单", total=len(blocks), done=len(blocks),
                 message=f"众赢板块清单 {len(blocks)} 个")
        bulk_upsert(conn, "zy_block", _BLOCK_COLS,
                    [(b["block_code"], b["block_name"], b["type_code"],
                      b["parent_code"], b["sort_no"]) for b in blocks],
                    ("block_code",))
        conn.commit()

        codes = [b["block_code"] for b in blocks]
        members = zy_source.fetch_zy_block_members_all(
            codes, progress=progress, cancel=cancel)
        rows = [(code, m["symbol"], m.get("stock_name"))
                for code, ms in members.items() for m in ms]
        if rows:
            conn.execute("BEGIN TRANSACTION")
            try:
                for code in members:
                    if members[code]:
                        conn.execute("DELETE FROM zy_block_member WHERE block_code=?", [code])
                bulk_upsert(conn, "zy_block_member", _BLOCK_MEMBER_COLS, rows,
                            ("block_code", "symbol"))
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        else:
            logger.warning("[ZyBlocks] 上游成分全为空，保留上一版成分映射")
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
