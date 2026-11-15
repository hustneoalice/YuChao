"""周六 09:00 复权因子 → adjust_factor（baostock 唯一源，可选依赖）。

1.0 原样：全市场逐只 query_adjust_factor，按库内 MAX(ex_date) 增量。
baostock 未安装/登录失败 → 任务 skipped（留提示，不算失败——
前复权在查询层派生，缺因子只影响长周期复权精度，不影响裸价数据）。
"""
from __future__ import annotations

import logging
import time
from datetime import date

from ..writer import writer
from ...foundation.bulk import bulk_insert, bulk_upsert

logger = logging.getLogger("yuchao.updater")

_BAOSTOCK_SLEEP = 0.05
_COMMIT_EVERY = 200
_QFACTOR_COLS = ("symbol", "ex_date", "fore_adjust_factor", "back_adjust_factor")


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
                        bulk_upsert(c, "adjust_factor", _QFACTOR_COLS, buf,
                                    ("symbol", "ex_date"))
                        c.commit()
                        writer.reset()
                        buf.clear()
                    progress(done=done, rows=rows_written, failed=failed,
                             log=f"复权因子 [{done}/{len(symbols)}] 累计 {rows_written} 行")
                time.sleep(_BAOSTOCK_SLEEP)

            if buf:
                c = writer.conn()
                bulk_upsert(c, "adjust_factor", _QFACTOR_COLS, buf, ("symbol", "ex_date"))
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
# 为原始价。份额折算（512800 于 2025-07-07 1:2 拆分）在图上是一根 -50% 断崖；
# 现金分红则是「减法复权」——qfq = 原始价 - 累计分红（159919 在 2021-12-13 之后
# 累计分红 0.184 元/份，券商前复权高 4.963 = 5.147 - 0.184）。
# 单一乘数表达不了减法（按收盘比价缩放只得 4.961），因此每段写成仿射
#     qfq = raw × a + b
# a 吸收份额折算（段内恒定）、b 吸收累计分红（除息日切换水位），ASOF 连接后
# 逐日精确。序列用腾讯 fqkline 前复权（东财已封服务器 IP）。
_FUND_BARS = 5000           # 回看根数上限：因子必须覆盖库内全部历史
_FUND_SPLIT_JUMP = 0.05     # 前复权/原始 比值日间跳变 ≥5% 判为份额折算（分红最多约 4%）
_FUND_SEG_SHIFT = 0.002     # 水位 b 位移 ≥0.002 元判为新的除息段（价格 3 位小数，噪声 ≤0.001）
_FUND_MIN_ROWS = 10         # 重叠日期太少，无法判断
_FUND_SLOPE_WIN = 40        # 段内斜率局部窗口（根）
_FUND_SLOPE_MIN = 15        # 局部窗口最少样本


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
    """给全部场内基金重算前复权因子（腾讯前复权序列 vs 库内原始价反推）。

    遍历 fund_universe 全部标的，不按裸价跳变筛：ETF 年分红约 1%~2%，除息日
    只是普通小跌，永远进不了 ≥5% 的名单（159919 因此长期无因子）。无分红无
    拆分的基金算出全段 a=1、b=0，直接跳过不写噪声行。
    """
    conn = writer.conn()
    try:
        cands = [(str(r[0]), str(r[1])) for r in conn.execute(
            """
            SELECT symbol, MIN(date) FROM daily_ohlcv
            WHERE symbol IN (SELECT symbol FROM fund_universe)
            GROUP BY symbol ORDER BY symbol
            """).fetchall()]
    finally:
        writer.reset()

    written = 0
    failed = 0
    done = 0
    # 网络阶段并发（每只 1~2 条序列）、读库写库仍在主线程串行
    from concurrent.futures import ThreadPoolExecutor, as_completed
    chunk = 6
    for start in range(0, len(cands), chunk):
        if cancel and cancel():
            break
        batch = cands[start:start + chunk]
        with ThreadPoolExecutor(max_workers=chunk) as pool:
            futs = {pool.submit(_fund_qfq_series, s, f): s for s, f in batch}
            for fut in as_completed(futs):
                sym = futs[fut]
                done += 1
                rows: list = []
                try:
                    qfq = fut.result()
                    c = writer.conn()
                    raw = {str(r[0]): float(r[1]) for r in c.execute(
                        "SELECT date, close FROM daily_ohlcv WHERE symbol = ?",
                        [sym]).fetchall()}
                    rows = _fund_factor_rows(sym, raw, qfq)
                    c.execute("DELETE FROM adjust_factor WHERE symbol = ?", [sym])
                    if rows:
                        bulk_insert(c, "adjust_factor",
                                    ("symbol", "ex_date", "fore_adjust_factor",
                                     "fore_offset", "back_adjust_factor", "back_offset"),
                                    rows)
                    c.commit()
                except Exception:   # 单只接口抖动不中断全量（限流偶发，下次调度会补齐）
                    failed += 1
                    rows = []
                finally:
                    writer.reset()
                written += len(rows)
                progress(stage="场内基金复权因子", total=len(cands), done=done, rows=written,
                         message=f"已核对 {done}/{len(cands)} 只场内基金，写入因子 {written} 条"
                                 + (f"，{failed} 只接口失败" if failed else ""))
    return written


def _fund_qfq_series(sym: str, floor: str) -> dict:
    """腾讯前复权日线收盘 {date: close}（只回看到该基金库内最早日期，省翻页）。"""
    from . import sources

    span = (date.today() - date.fromisoformat(floor)).days * 5 // 7 + 80
    # 腾讯 fqkline 的 count 有个怪门槛：≤2048 左右只回 640 根（约 2.5 年），
    # ≥3000 才给全历史。少于 3000 根会让上市 3~6 年的基金只算出最近一段水位，
    # 更早的除息段整段丢失（515210 补到 2020 年后才暴露）。因此至少请求 3000 根。
    cnt = max(3000, min(span, _FUND_BARS))
    bars = sources.fetch_kline_tx(sym, cnt, fqt="qfq")
    return {str(b["t"])[:10]: float(b["c"]) for b in bars if b.get("c")}


def _fund_factor_rows(sym: str, raw: dict, qfq: dict) -> list:
    """原始收盘 + 前复权收盘 → [(symbol, ex_date, a, b), ...]（分段仿射）。

    先在「比值跳变 ≥5%」处切段（份额折算段界），段内回归出 a；再按水位
    b = qfq - a×raw 的位移切出除息段。每段首日落一行，与 v_daily_ohlcv_qfq
    的 ASOF 连接口径一致。无分红无拆分 → 返回 []。
    """
    dates = [d for d in sorted(raw) if d in qfq and raw[d] > 0 and qfq[d] > 0]
    if len(dates) < _FUND_MIN_ROWS:
        return []

    stretches: list = []
    cur: list = []
    prev = None
    for d in dates:
        ratio = qfq[d] / raw[d]
        if prev is not None and abs(ratio / prev - 1) >= _FUND_SPLIT_JUMP:
            stretches.append(cur)
            cur = []
        cur.append(d)
        prev = ratio
    stretches.append(cur)

    rows: list = []
    for seg in stretches:
        a = _affine_slope(seg, raw, qfq)
        start, level, buf = None, None, []
        for d in seg:
            b = qfq[d] - a * raw[d]
            if level is None or abs(b - level) >= _FUND_SEG_SHIFT:
                if buf:
                    rows.append((sym, start, a, round(_median(buf), 3)))
                start, level, buf = d, b, [b]
            else:
                buf.append(b)
                level = _median(buf)
        if buf:
            rows.append((sym, start, a, round(_median(buf), 3)))

    # 腾讯复权序列比库内历史短时，把最早一段向前铺到库内首日，避免老数据段
    # 无因子、在交界处出现台阶
    if rows:
        rows[0] = (sym, min(raw), rows[0][2], rows[0][3])

    # 全程 a=1、b≈0 = 上市至今无分红/拆分，不写噪声行
    if all(a == 1.0 and abs(b) < 0.0005 for _, _, a, b in rows):
        return []

    # 后复权：同一套分段仿射，锚定最早一根（首日 hfq = 原始价）——
    # hfq = (a/a0)×raw + (b-b0)/a0，纯分红场景 a=1 → hfq = raw + (b-b0)，
    # 即把「已发生的累计分红」加回价格，与乘法因子口径的个股共用同一张视图。
    a0, b0 = rows[0][2], rows[0][3]
    out = []
    for sym_, d, a, b in rows:
        out.append((sym_, d, a, round(b, 3),
                    a / a0 if a0 else 1.0, round((b - b0) / a0, 3) if a0 else 0.0))
    return out


def _affine_slope(seg: list, raw: dict, qfq: dict) -> float:
    """段内等比系数 a：按 40 根滚动窗口各拟合一次、取中位数（抗水位台阶）。

    整段一次回归会被「分红水位随时间下移」带偏——价格趋势与水位变化同向时
    斜率虚高（159919 的 2019 段会被算成 1.068），局部窗口只含单一水位才稳。
    """
    slopes = []
    for i in range(0, len(seg), _FUND_SLOPE_WIN):
        win = seg[i:i + _FUND_SLOPE_WIN]
        if len(win) < _FUND_SLOPE_MIN:
            continue
        xs = [raw[d] for d in win]
        lo, hi = min(xs), max(xs)
        if hi <= 0 or (hi - lo) / hi < 0.01:   # 价格几乎不动，斜率不可辨
            continue
        n = len(win)
        mx = sum(xs) / n
        my = sum(qfq[d] for d in win) / n
        sxx = sum((x - mx) ** 2 for x in xs)
        sxy = sum((raw[d] - mx) * (qfq[d] - my) for d in win)
        if sxx > 1e-9:
            slopes.append(sxy / sxx)
    if not slopes:
        return 1.0
    slopes.sort()
    a = slopes[len(slopes) // 2]
    if abs(a - 1.0) < 0.01:      # 无拆分：钉 1，避免回归噪声把水位 b 带偏
        return 1.0
    return round(a, 4)


def _median(vals: list) -> float:
    s = sorted(vals)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
