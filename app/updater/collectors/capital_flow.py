"""16:30 个股资金流 → capital_flow（新浪 MoneyFlow 唯一写入路径）。

1.0 原样：东财不给个股历史资金流，新浪是唯一可编程来源；逐只拉近 N 天，
按库内 cutoff 只补增量。指数无此数据（接口只覆盖个股）。

并发口径（与 kline 同规约）：线程只做 HTTP 取数，写库仍在主线程串行——
DuckDB 连接非线程安全，且写窗口必须短，否则 API 只读连接全部被拒。
单只新浪请求实测 p50≈90ms，串行时全市场要 15 分钟以上；8 线程并发后
约 1~2 分钟跑完，实测 800 只 8 线程无失败（p99≈0.3s），不存在限流拐点。
"""
from __future__ import annotations

import logging
import random
import threading
import time

from ...config import settings
from ...foundation.bulk import bulk_upsert
from ..writer import writer
from . import sources

logger = logging.getLogger("yuchao.updater")

_FLOW_COLS = ("symbol", "date", "net_main", "net_super", "net_large",
              "net_medium", "net_small")

_COMMIT_ROWS = 2000         # 缓冲行数上限：到量即写，避免内存堆积
_COMMIT_DONE = 500          # 标的数：批提交节奏（并发下按标的数节流，别每百只敲一次锁）
_HEARTBEAT_S = 4.0          # 无写入时也推进进度（前端速度/倒计时才不会卡住）
_POLITE_S = (0.01, 0.04)    # 单线程礼貌间隔：纯随机抖动，避免固定节律指纹


def _stock_days(cut: str | None) -> int:
    """库内无该标的 → 首次补 8 天底；有 cutoff → 日常增量 5 天足够。"""
    return 5 if cut else 8


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
        writer.reset()          # 抓取期间绝不能持写锁
        total = len(symbols)
        progress(stage="采集资金流", total=total, done=0,
                 message=f"并发拉取资金流，共 {total} 只")

        done = failed = rows_written = 0
        buf: list = []
        stop = threading.Event()
        last_report = time.time()

        def _flush() -> None:
            """主线程写批：拿锁 → 写 → 立即释放（连接不跨线程）。"""
            nonlocal buf
            if not buf:
                return
            c = writer.conn()
            bulk_upsert(c, "capital_flow", _FLOW_COLS, buf, ("symbol", "date"))
            c.commit()
            writer.reset()
            buf.clear()

        def _fetch_one(sym: str):
            """线程内只做 HTTP 取数，绝不碰 DuckDB。"""
            if stop.is_set():
                return sym, [], ""
            cut = latest.get(sym)
            try:
                items = sources.fetch_fund_flow_sina(
                    sym, days=_stock_days(cut), strict=True) or []
            except Exception as e:      # 异常才算失败：空返回多为退市/无数据
                return sym, [], type(e).__name__
            finally:
                time.sleep(random.uniform(*_POLITE_S))
            new = [x for x in items if (cut is None or str(x["date"]) > cut)]
            return sym, new, ""

        from concurrent.futures import ThreadPoolExecutor, as_completed

        workers = max(1, min(int(settings.capital_flow_workers or 8), 16))
        futures = []
        pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="fundflow")
        try:
            futures = [pool.submit(_fetch_one, s) for s in symbols]
            for fut in as_completed(futures):
                if cancel and cancel():
                    result["detail"] = f"取消于 {done}/{total}"
                    stop.set()          # 排队中的 worker 立即返回，不再发请求
                    for f in futures:
                        f.cancel()
                    break
                try:
                    sym, new, err = fut.result()
                except Exception as e:  # worker 自身异常不炸整批
                    sym, new, err = "", [], f"{type(e).__name__}:{str(e)[:60]}"
                done += 1
                if err:
                    failed += 1
                if new:
                    buf.extend((sym, x["date"], x["main_net"], x["super_net"],
                                x["large_net"], x["mid_net"], x["small_net"])
                               for x in new)
                    rows_written += len(new)
                if len(buf) >= _COMMIT_ROWS or done % _COMMIT_DONE == 0:
                    _flush()
                    progress(done=done, rows=rows_written, failed=failed,
                             log=f"资金流 [{done}/{total}] 累计 {rows_written} 行")
                    last_report = time.time()
                elif time.time() - last_report >= _HEARTBEAT_S:
                    progress(done=done, rows=rows_written, failed=failed)
                    last_report = time.time()
        finally:
            stop.set()
            pool.shutdown(wait=False, cancel_futures=True)

        _flush()

        if rows_written == 0 and failed == 0 and done:
            # 全市场零增量：多半是新浪整体拒了（限流/风控），要留痕而不是报成功
            result["detail"] = (f"遍历 {done} 个标的，未取到任何新数据"
                                "（新浪可能限流）")
        result.update(status="success" if rows_written or not failed else "failed",
                      rows=rows_written, total=total, success=done - failed,
                      error=f"{failed} 个标的失败" if failed and not rows_written else "",
                      detail=result.get("detail") or
                      f"增量 {rows_written} 行（{done}/{total} 标的，失败 {failed}）")
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[FundFlow] 资金流更新失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
