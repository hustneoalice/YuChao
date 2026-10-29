"""周六 09:00 复权因子 → adjust_factor（baostock 唯一源，可选依赖）。

1.0 原样：全市场逐只 query_adjust_factor，按库内 MAX(ex_date) 增量。
baostock 未安装/登录失败 → 任务 skipped（留提示，不算失败——
前复权在查询层派生，缺因子只影响长周期复权精度，不影响裸价数据）。
"""
from __future__ import annotations

import logging
import time

from ..writer import writer

logger = logging.getLogger("yuchao.updater")

_BAOSTOCK_SLEEP = 0.05
_COMMIT_EVERY = 200


def update_adjust_factor(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    result: dict = {"task": "adjust_factor", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)   # 允许无进度上报直调
    try:
        try:
            import baostock as bs
        except ImportError:
            result.update(status="skipped",
                          detail="baostock 未安装（pip install baostock），跳过复权因子更新")
            return result

        lg = bs.login()
        if getattr(lg, "error_code", "0") not in ("0", 0):
            result.update(status="skipped",
                          detail=f"baostock 登录失败: {getattr(lg, 'error_msg', '')[:100]}")
            return result

        try:
            conn = writer.conn()
            symbols = [str(r[0]) for r in conn.execute(
                "SELECT symbol FROM stock_universe WHERE symbol ~ '^[0-9]{6}$' "
                "ORDER BY symbol").fetchall()]
            latest = {str(r[0]): str(r[1]) for r in conn.execute(
                "SELECT symbol, MAX(ex_date) FROM adjust_factor GROUP BY symbol"
            ).fetchall()}
            writer.reset()          # baostock 逐只抓取（全市场极慢）期间不持锁
            progress(stage="采集复权因子", total=len(symbols), done=0,
                     message=f"baostock 逐只复权因子，{len(symbols)} 个标的")

            done = failed = 0
            rows_written = 0
            buf: list = []
            for sym in symbols:
                if cancel and cancel():
                    result["detail"] = f"取消于 {done}/{len(symbols)}"
                    break
                # baostock 代码格式：sh.600519 / sz.000001（北交所不支持，跳过）
                from ..collectors.http import market_prefix

                try:
                    pre = market_prefix(sym)
                except ValueError:
                    done += 1
                    continue
                if pre == "bj":
                    done += 1
                    continue
                cut = latest.get(sym)
                start_date = (str(int(cut[:4]) - 1) + cut[4:]) if cut else "2006-01-01"
                try:
                    rs = bs.query_adjust_factor(code=f"{pre}.{sym}",
                                                start_date=start_date)
                    rows = []
                    while getattr(rs, "next", lambda: False)():
                        rows.append(rs.get_row_data())
                    for r in rows:
                        # fields: code, dividOperateDate, foreAdjustFactor, backAdjustFactor
                        ex_date, fore, back = r[1], r[2], r[3]
                        if cut and ex_date <= cut:
                            continue
                        buf.append((sym, ex_date, float(fore), float(back)))
                        rows_written += 1
                except Exception:
                    failed += 1
                done += 1
                if len(buf) >= 5000 or done % _COMMIT_EVERY == 0:
                    if buf:
                        c = writer.conn()    # 写批次：拿锁 → 写 → 立即释放
                        c.executemany(
                            "INSERT OR REPLACE INTO adjust_factor "
                            "(symbol,ex_date,fore_adjust_factor,back_adjust_factor) "
                            "VALUES (?,?,?,?)", buf)
                        c.commit()
                        writer.reset()
                        buf.clear()
                    progress(done=done, rows=rows_written,
                             log=f"复权因子 [{done}/{len(symbols)}] 累计 {rows_written} 行")
                time.sleep(_BAOSTOCK_SLEEP)

            if buf:
                c = writer.conn()
                c.executemany(
                    "INSERT OR REPLACE INTO adjust_factor "
                    "(symbol,ex_date,fore_adjust_factor,back_adjust_factor) "
                    "VALUES (?,?,?,?)", buf)
                c.commit()
                writer.reset()
                buf.clear()

            result.update(status="success", rows=rows_written,
                          detail=f"增量 {rows_written} 条复权因子"
                                 f"（{done}/{len(symbols)} 标的，失败 {failed}）")
        finally:
            try:
                bs.logout()
            except Exception:
                pass
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Adjust] 复权因子更新失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
