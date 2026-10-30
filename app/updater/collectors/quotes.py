"""16:00 行情快照：当日 turnover_rate 与 stock_universe.name 的唯一自动写入路径。

1.0 语义：该任务在线程里直调曾与编排器互不感知，收进统一队列后与其它写任务
串行。M2 用腾讯 qt 批量报价（最稳车道）取名称与换手率，写当日 daily_ohlcv。
"""
from __future__ import annotations

import logging
import time

from ..util import expected_asof
from ..writer import writer
from . import sources

logger = logging.getLogger("yuchao.updater")


def update_quotes(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    result: dict = {"task": "quotes", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)   # 允许无进度上报直调
    try:
        day = expected_asof()
        conn = writer.conn()
        symbols = [str(r[0]) for r in conn.execute(
            "SELECT symbol FROM stock_universe WHERE symbol ~ '^[0-9]{6}$' "
            "ORDER BY symbol").fetchall()]
        writer.reset()          # 批量抓取（1-3 分钟）期间绝不能持写锁
        progress(stage="采集行情快照", total=len(symbols), done=0,
                 message=f"{day} 全市场 {len(symbols)} 只（腾讯 qt）")

        raw = sources.fetch_qt_batch(symbols, progress=progress, cancel=cancel)
        if not raw:
            raise RuntimeError("行情快照为空（腾讯 qt 不可达）")

        conn = writer.conn()    # 抓完再拿锁，写完立即释放
        # 换手率：当日 daily_ohlcv 行的 turnover_rate 补写（K线车道不带换手率）
        turn_rows = [(v[7], s, day) for s, v in raw.items()
                     if v[7] is not None]
        n_turn = 0
        if turn_rows:
            conn.executemany(
                "UPDATE daily_ohlcv SET turnover_rate = ? "
                "WHERE symbol = ? AND date = ?", turn_rows)
            n_turn = len(turn_rows)

        # 名称刷新：证券简称会变（ST/摘帽/更名），universe.name 唯一自动写入路径
        name_rows = [(v[0], s) for s, v in raw.items() if v[0]]
        if name_rows:
            conn.executemany(
                "UPDATE stock_universe SET name = ?, updated_at = CURRENT_TIMESTAMP "
                "WHERE symbol = ?", name_rows)
        conn.commit()
        writer.reset()

        result.update(status="success", rows=n_turn,
                      detail=f"{day} 行情快照 {len(raw)}/{len(symbols)} 只"
                             f"（换手率 {n_turn} 行、名称 {len(name_rows)} 只）")
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Quotes] 行情快照失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
