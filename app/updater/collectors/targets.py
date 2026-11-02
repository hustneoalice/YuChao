"""17:15 目标页指标层预计算 → target_scan / target_trend。

目标监控的指标（均线/量比/六分段/涨停次数 + 趋势柱线 STICKV）是「数据日级」
慢变量：K 线增量落库后算一次即可。此任务在后台统一重算落表，用户打开目标页
只读现成结果（条件过滤是毫秒级内存操作，改条件即时重筛）。

为什么要落表而不是请求内顺手算：全市场 STICKV 是一次 5550×2000 根 qfq 的窗口
查询，DuckDB 默认内存上限 1.5GiB 下会 OOM，且失败后连带拖垮并发的 quotes
（2026-11-02 线上实测 500）。分块计算放进定时任务，请求路径彻底不碰重活。
"""
from __future__ import annotations

import logging
import time

from ..writer import writer
from ...foundation.repo import market as repo

logger = logging.getLogger("yuchao.updater")

_SCAN_COLS = ("symbol", "name", "close", "pct_chg", "vol_ma40", "vol_ratio",
              "vol_hit", "short_orange", "mid_orange", "limit_up_20d",
              "limit_up_cnt", "seg", "seg_name", "pullback", "as_of")


def update_target_scan(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    progress = progress or (lambda **k: None)
    result: dict = {"task": "target_scan", "status": "running", "rows": 0}
    try:
        conn = writer.conn()
        progress(stage="计算目标指标层", message="全市场均线 / 量比 / 六分段 / 涨停次数")
        scan, meta = repo.compute_target_scan(conn)
        if cancel and cancel():
            result.update(status="cancelled")
            return result
        progress(stage="计算趋势柱线", total=len(scan), done=0,
                 message="STICKV 逐股分块（每块 150 只）")
        trend = repo.compute_target_trends(conn)
        if cancel and cancel():
            result.update(status="cancelled")
            return result
        as_of = meta["as_of"]
        conn.execute("DELETE FROM target_scan")
        conn.executemany(
            "INSERT OR REPLACE INTO target_scan (" + ",".join(_SCAN_COLS) + ") "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [tuple(r.get(c) for c in _SCAN_COLS[:-1]) + (as_of,) for r in scan])
        conn.execute("DELETE FROM target_trend")
        tr_rows = [(sym, r.get("trend_data_date"), r.get("trend_value"),
                    r.get("trend_cross_date"), r.get("trend_cross_ago"),
                    r.get("trend_above_days")) for sym, r in trend.items()]
        if tr_rows:
            conn.executemany(
                "INSERT OR REPLACE INTO target_trend "
                "(symbol,data_date,trend_value,cross_date,cross_ago,above_days) "
                "VALUES (?,?,?,?,?,?)", tr_rows)
        conn.commit()
        result.update(status="completed", rows=len(scan), trend_rows=len(tr_rows), as_of=as_of,
                      detail=f"{as_of}：目标指标 {len(scan)} 只，趋势柱线 {len(tr_rows)} 只")
        logger.info("[Targets] %s", result["detail"])
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Targets] 目标指标预计算失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
