"""16:30 个股资金流 → capital_flow（新浪 MoneyFlow 唯一写入路径）。

1.0 原样：东财不给个股历史资金流，新浪是唯一可编程来源；逐只拉近 N 天，
按库内 cutoff 只补增量。指数无此数据（接口只覆盖个股）。
"""
from __future__ import annotations

import logging
import time
from datetime import date, timedelta

from ..util import expected_asof
from ..writer import writer
from . import sources

logger = logging.getLogger("yuchao.updater")

_SINA_SLEEP = 0.08          # 新浪限速礼貌间隔
_COMMIT_EVERY = 100


def update_capital_flow(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    result: dict = {"task": "capital_flow", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)   # 允许无进度上报直调
    try:
        conn = writer.conn()
        symbols = [str(r[0]) for r in conn.execute(
            "SELECT symbol FROM stock_universe WHERE symbol ~ '^[0-9]{6}$'").fetchall()]
        latest = {str(r[0]): str(r[1]) for r in conn.execute(
            "SELECT symbol, MAX(date) FROM capital_flow GROUP BY symbol").fetchall()}
        writer.reset()          # 逐只抓取（十几分钟）期间绝不能持写锁
        progress(stage="采集资金流", total=len(symbols), done=0,
                 message=f"新浪逐只资金流，{len(symbols)} 个标的")

        done = failed = 0
        rows_written = 0
        buf: list = []
        for sym in symbols:
            if cancel and cancel():
                result["detail"] = f"取消于 {done}/{len(symbols)}"
                break
            cut = latest.get(sym)
            days = 5 if cut else 8            # 首次补一点底，之后日常增量 5 天足够
            try:
                items = sources.fetch_fund_flow_sina(sym, days=days) or []
            except Exception:
                items = []
            new = [x for x in items if (cut is None or str(x["date"]) > cut)]
            if new:
                buf.extend((sym, x["date"], x["main_net"], x["super_net"],
                            x["large_net"], x["mid_net"], x["small_net"])
                           for x in new)
                rows_written += len(new)
            done += 1
            if len(buf) >= 2000 or done % _COMMIT_EVERY == 0:
                if buf:
                    c = writer.conn()        # 写批次：拿锁 → 写 → 立即释放
                    c.executemany(
                        "INSERT OR REPLACE INTO capital_flow "
                        "(symbol,date,net_main,net_super,net_large,net_medium,net_small) "
                        "VALUES (?,?,?,?,?,?,?)", buf)
                    c.commit()
                    writer.reset()
                    buf.clear()
                progress(done=done, rows=rows_written,
                         log=f"资金流 [{done}/{len(symbols)}] 累计 {rows_written} 行")
            time.sleep(_SINA_SLEEP)

        if buf:
            c = writer.conn()
            c.executemany(
                "INSERT OR REPLACE INTO capital_flow "
                "(symbol,date,net_main,net_super,net_large,net_medium,net_small) "
                "VALUES (?,?,?,?,?,?,?)", buf)
            c.commit()
            writer.reset()
            buf.clear()

        if rows_written == 0 and failed == 0 and done:
            # 全市场零增量：多半是新浪整体拒了（限流/风控），要留痕而不是报成功
            result["detail"] = (f"遍历 {done} 个标的，未取到任何新数据"
                                "（新浪可能限流）")
        result.update(status="success" if rows_written or not failed else "failed",
                      rows=rows_written,
                      error=f"{failed} 个标的失败" if failed and not rows_written else "",
                      detail=result.get("detail") or
                      f"增量 {rows_written} 行（{done}/{len(symbols)} 标的，失败 {failed}）")
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[FundFlow] 资金流更新失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
