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
                          detail="复权因子数据源没有装好，本次跳过（不影响看盘）")
            return _with_funds(result, progress, cancel)

        lg = bs.login()
        if getattr(lg, "error_code", "0") not in ("0", 0):
            result.update(status="skipped",
                          detail="复权因子数据源连接失败，本次跳过")
            return _with_funds(result, progress, cancel)

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
                     message=f"逐只更新复权因子，共 {len(symbols)} 个标的")

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
                    progress(done=done, rows=rows_written, failed=failed,
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
                          total=len(symbols), success=done - failed,
                          detail=f"增量 {rows_written} 条复权因子"
                                 f"（{done}/{len(symbols)} 标的，失败 {failed}）")
            _with_funds(result, progress, cancel)
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


# ═══ 场内基金（ETF/LOF/REIT）复权因子 ═══
# baostock 的 query_adjust_factor 只覆盖个股，基金一直没有因子 → qfq 视图退化
# 为原始价。遇到份额拆分（如银行ETF 512800 于 2025-07-07 1:2 拆分）图上就是
# 一根 -50% 的断崖，拆分后的 K 线被压到全图底部。这里用东财「原始 / 前复权 /
# 后复权」三条同源序列反推因子：factor(date) = 复权收盘 / 原始收盘，只在因子
# 发生变化的日期落一行，口径与 v_daily_ohlcv_qfq / _hfq 的 ASOF 连接完全一致。
_FUND_JUMP = 0.05           # 单日收盘跳变阈值：只有拆分/大额分红才需要因子
_FUND_BARS = 3000           # 回看根数：因子必须覆盖库内全部历史，否则更早的段仍是无因子


def _with_funds(result: dict, progress, cancel) -> dict:
    """个股因子跑完（或源不可用）后补场内基金因子，失败不影响个股结果。"""
    try:
        rows = _funds_pass(progress, cancel)
    except Exception:
        logger.exception("[Adjust] 场内基金复权因子更新失败")
        return result
    if not rows:
        return result
    result["rows"] = int(result.get("rows") or 0) + rows
    result["fund_rows"] = rows
    if result.get("status") == "skipped":
        result["status"] = "success"
    result["detail"] = f"{result.get('detail') or ''}；场内基金因子 {rows} 条".lstrip("；")
    return result


def _funds_pass(progress, cancel) -> int:
    """给「原始价出现过 ≥5% 单日跳变」的场内基金重算复权因子。"""
    conn = writer.conn()
    try:
        cands = [str(r[0]) for r in conn.execute(
            """
            WITH j AS (
              SELECT symbol, close,
                     lag(close) OVER (PARTITION BY symbol ORDER BY date) AS pc
              FROM daily_ohlcv
              WHERE symbol IN (SELECT symbol FROM fund_universe)
            )
            SELECT DISTINCT symbol FROM j
            WHERE pc IS NOT NULL AND pc > 0 AND abs(close / pc - 1) >= ?
            ORDER BY symbol
            """, [_FUND_JUMP]).fetchall()]
    finally:
        writer.reset()

    written = 0
    for i, sym in enumerate(cands, 1):
        if cancel and cancel():
            break
        rows = _em_factor_rows(sym)
        if rows:
            c = writer.conn()        # 写批次：拿锁 → 写 → 立即释放
            c.execute("DELETE FROM adjust_factor WHERE symbol = ?", [sym])
            c.executemany(
                "INSERT OR REPLACE INTO adjust_factor "
                "(symbol,ex_date,fore_adjust_factor,back_adjust_factor) "
                "VALUES (?,?,?,?)", rows)
            c.commit()
            writer.reset()
            written += len(rows)
        progress(stage="场内基金复权因子", total=len(cands), done=i, rows=written,
                 message=f"已写因子 {written} 条")
    return written


def _em_factor_rows(sym: str) -> list:
    """东财三条序列反推因子行：[(symbol, ex_date, fore, back), ...]。"""
    from . import sources

    raw = sources.fetch_kline_em(sym, _FUND_BARS, fqt=0)
    base = {str(r["t"]): float(r["c"]) for r in raw if r.get("c")}
    if not base:
        return []

    def ratio(rows) -> dict:
        out = {}
        for r in rows:
            b = base.get(str(r["t"]))
            c = float(r["c"] or 0)
            if b and b > 0 and c > 0:
                out[str(r["t"])] = round(c / b, 6)
        return out

    fore = ratio(sources.fetch_kline_em(sym, _FUND_BARS, fqt=1))
    back = ratio(sources.fetch_kline_em(sym, _FUND_BARS, fqt=2))
    rows, prev = [], None
    for d in sorted(base):
        f = fore.get(d)
        if f is None:
            continue
        # 东财复权序列只保留 2~3 位小数，比值天天有 1e-5 级抖动；
        # 按 1% 台阶判定真实事件（拆分/大额分红），避免因子行写成噪声
        f = round(f, 4)
        bk = round(back.get(d, f), 4)
        if prev is None or abs(f - prev[0]) >= 0.01 or abs(bk - prev[1]) >= 0.01:
            rows.append((sym, d, f, bk))
            prev = (f, bk)
    return rows
