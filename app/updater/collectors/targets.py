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
from datetime import datetime, time as dtime

from ..writer import writer
from ...foundation.bulk import bulk_insert
from ...foundation.repo import market as repo

logger = logging.getLogger("yuchao.updater")

_SCAN_COLS = ("symbol", "name", "close", "pct_chg", "vol_ma40", "vol_ratio",
              "vol_hit", "short_orange", "mid_orange", "limit_up_20d",
              "limit_up_cnt", "seg", "seg_name", "pullback", "acc_strength",
              "dkx_gold_ago", "dkx_death_ago", "as_of")
_TREND_COLS = ("symbol", "data_date", "trend_value", "cross_date", "cross_ago",
               "above_days", "neg_run", "neg_abs", "money_date", "money_ago",
               "money_cnt", "mine_date", "mine_ago", "mine_cnt")
_TAIL_COLS = ("symbol", "data_date", "snapshot_at", "computed_at", "money_date",
              "money_ago", "money_cnt", "mine_date", "mine_ago", "mine_cnt")


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
                 message="趋势柱线逐股计算（每批 150 只）")
        trend = repo.compute_target_trends(conn)
        if cancel and cancel():
            result.update(status="cancelled")
            return result
        as_of = meta["as_of"]
        conn.execute("DELETE FROM target_scan")
        bulk_insert(conn, "target_scan", _SCAN_COLS,
                    [tuple(r.get(c) for c in _SCAN_COLS[:-1]) + (as_of,) for r in scan])
        conn.execute("DELETE FROM target_trend")
        tr_rows = [(sym, r.get("trend_data_date"), r.get("trend_value"),
                    r.get("trend_cross_date"), r.get("trend_cross_ago"),
                    r.get("trend_above_days"), r.get("neg_run"), r.get("neg_abs"),
                    r.get("money_date"), r.get("money_ago"), r.get("money_cnt"),
                    r.get("mine_date"), r.get("mine_ago"), r.get("mine_cnt"))
                   for sym, r in trend.items()]
        if tr_rows:
            bulk_insert(conn, "target_trend", _TREND_COLS, tr_rows)
        conn.commit()
        result.update(status="completed", rows=len(scan), trend_rows=len(tr_rows), as_of=as_of,
                      detail=f"{as_of}：目标指标 {len(scan)} 只，趋势柱线 {len(tr_rows)} 只")
        logger.info("[Targets] %s", result["detail"])
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Targets] 目标指标预计算失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result


def update_target_scan_live(progress=None, ctx=None) -> dict:
    """盘中每 5 分钟（快照落库后）重算指标层 → target_scan。

    与收盘后 update_target_scan 共用指标层，但只算「快照当日的临时日线」，
    趋势柱线是日级慢变量、沿用收盘后的结果。写表后 /market/targets 直接读
    现成行，不再每次请求都跑全市场窗口 SQL。

    force=True 拿最新快照：表里已有当日行也要重算，否则下一轮会读到旧价。
    非交易时段（9:25–15:05 之外）或快照不足全市场覆盖 → 直接 skipped，
    不覆盖收盘后的正式结果。
    """
    start = time.time()
    progress = progress or (lambda **k: None)
    result: dict = {"task": "target_scan_live", "status": "running", "rows": 0}
    try:
        if not (dtime(9, 25) <= datetime.now().time() <= dtime(15, 5)):
            result.update(status="skipped", detail="非交易时段，盘中重算不执行")
            return result
        conn = writer.conn()
        live = repo._live_overlay(conn, force=True)
        if live is None:
            result.update(status="skipped", detail="当日实时快照未就绪（行数不足/日线已落库）")
            return result
        snap_at = str(live["updated_at"])[11:16]        # HH:MM（快照抓取时刻）
        progress(stage="盘中重算目标指标层",
                 message=f"按 {snap_at} 实时快照重算（日线槽位 {live['date']}）")
        scan, meta = repo.compute_target_scan(conn, live=live)
        if (ctx or {}).get("cancel_check") and ctx["cancel_check"]():
            result.update(status="cancelled")
            return result
        conn.execute("DELETE FROM target_scan")
        bulk_insert(conn, "target_scan", _SCAN_COLS,
                    [tuple(r.get(c) for c in _SCAN_COLS[:-1]) + (meta["as_of"],) for r in scan])
        conn.commit()
        result.update(status="completed", rows=len(scan), as_of=meta["as_of"],
                      detail=f"盘中快照 {live['updated_at'][:16]}：目标指标 {len(scan)} 只")
        # 尾盘估算（14:50 起）：价格基本定型，提前把今日快照当收盘算阶段反转，
        # 写 target_tail 留档（同一日多轮覆盖）。正式 target_trend 收盘后追上当日，
        # API 自动优先正式口径。失败只告警，不影响已完成的指标层。
        if datetime.now().time() >= dtime(14, 50):
            try:
                tail, tmeta = repo.compute_target_tail(conn, live=live)
                if tail:
                    conn.execute("DELETE FROM target_tail WHERE data_date = ?",
                                 [tmeta["as_of"]])
                    bulk_insert(conn, "target_tail", _TAIL_COLS,
                                [tuple(r.get(c) for c in _TAIL_COLS) for r in tail])
                    conn.commit()
                    result["tail_rows"] = len(tail)
                    result["snapshot_at"] = tmeta["snapshot_at"]
                    result["detail"] += (f"，尾盘估算 {len(tail)} 只"
                                         f"（快照 {tmeta['snapshot_at']}）")
            except Exception as e:
                logger.warning("[TargetsLive] 尾盘估算失败（不影响指标层）：%s",
                               f"{type(e).__name__}: {e}")
        logger.info("[TargetsLive] %s", result["detail"])
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[TargetsLive] 盘中目标指标重算失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
