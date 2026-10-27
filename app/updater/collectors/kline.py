"""17:00 K 线增量 → daily_ohlcv（腾讯 fqkline 主车道，东财 push2his 备用）。

增量口径（1.0 原样）：
  · 每标的 cutoff = 库内 MAX(date)，只拉缺口：count = 缺口天数×1.6+20
    （周末节假日折算，下限 30 上限 3000）——全市场每天只补 1~2 根，不重拉全史；
  · 覆盖写 INSERT OR REPLACE：(symbol,date) 主键，幂等可重跑；
  · 新上市标的（库内无任何 K 线）拉 3000 根建底仓；
  · 单标的两个车道都失败 → 记 failed 继续下一个，不炸整批；
  · 每 50 标的 commit 一次（1.0 节奏），进度条跟随推进；
  · 落库后对近期 pct_chg 缺失行按前收盘补算（腾讯车道不带涨跌幅）。

写库后逐标的 publish kline:{symbol}:1d（最后一根 bar，closed=true），
驱动前端图表增量刷新（设计文档 06 频道协议）。
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta

from ..util import expected_asof
from ..writer import writer
from . import sources

logger = logging.getLogger("yuchao.updater")

_COMMIT_EVERY = 50          # 标的数：批提交节奏（1.0 同款）
_PCT_FILL_DAYS = 45         # pct 补算回看窗口（天）：只补近期缺口，不全表扫


def _gap_count(cutoff: str | None, target: str) -> int:
    """缺口 → 请求根数：自然日×1.6（覆盖周末节假日）+20 安全边际。"""
    if not cutoff:
        return 3000                              # 新标的：建底仓
    d1 = datetime.strptime(cutoff, "%Y-%m-%d").date()
    d2 = datetime.strptime(target, "%Y-%m-%d").date()
    days = max((d2 - d1).days, 0)
    return min(max(int(days * 1.6) + 20, 30), 3000)


def update_kline(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    bus = (ctx or {}).get("bus")
    result: dict = {"task": "kline_update", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)   # 允许无进度上报直调
    try:
        target = expected_asof()
        conn = writer.conn()

        # 目标集：个股（universe 6位码）+ 指数/ETF（daily_ohlcv 里带后缀的 symbol）
        stocks = [str(r[0]) for r in conn.execute(
            "SELECT symbol FROM stock_universe WHERE symbol ~ '^[0-9]{6}$'").fetchall()]
        others = [str(r[0]) for r in conn.execute(
            "SELECT DISTINCT symbol FROM daily_ohlcv WHERE symbol LIKE '%.%'").fetchall()]
        targets = sorted(set(stocks) | set(others))

        # per-symbol cutoff（1.0 原样 group by，不逐个查）
        latest = {str(r[0]): str(r[1]) for r in conn.execute(
            "SELECT symbol, MAX(date) FROM daily_ohlcv GROUP BY symbol").fetchall()}

        pending = []
        for s in targets:
            cut = latest.get(s)
            if cut is None or cut < target:
                pending.append((s, cut))
        progress(stage="增量拉取", total=len(pending), done=0,
                 message=f"{target} 待增量 {len(pending)}/{len(targets)} 个标的"
                         + ("（已全部最新）" if not pending else ""))

        done = failed = 0
        rows_written = 0
        event_rows = 0
        buf: list = []
        touched: list = []          # (symbol, last_bar) 供事件发布

        for i, (sym, cut) in enumerate(pending):
            if cancel and cancel():
                result["detail"] = f"取消于 {done}/{len(pending)}"
                break
            count = _gap_count(cut, target)
            # 主车道腾讯；东财 push2his 备用（本机 IP 被其 kline 端点风控时靠它兜不住，
            # 但部署到别机时双向都能用——车道顺序是运维可调的，代码两侧都在）
            rows = None
            for fetch in (sources.fetch_kline_tx, sources.fetch_kline_em):
                try:
                    rows = fetch(sym, count)
                    if rows:
                        break
                except Exception as e:
                    logger.debug("[Kline] %s 拉取失败（%s）: %s",
                                 sym, fetch.__name__, type(e).__name__)
            if not rows:
                failed += 1
                done += 1
                continue

            new = [r for r in rows if (cut is None or r["t"] > cut)]
            if new:
                buf.extend((sym, r["t"], r["o"], r["h"], r["l"], r["c"],
                            r["v"], r["amount"], r["pct_chg"], r["turnover_rate"])
                           for r in new)
                rows_written += len(new)
                touched.append((sym, new[-1]))

            done += 1
            if len(buf) >= 20000 or done % _COMMIT_EVERY == 0:
                if buf:
                    conn.executemany(
                        "INSERT OR REPLACE INTO daily_ohlcv "
                        "(symbol,date,open,high,low,close,volume,amount,pct_chg,turnover_rate) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?)", buf)
                    conn.commit()
                    buf.clear()
                progress(done=done, rows=rows_written,
                         log=f"K线增量 [{done}/{len(pending)}] 累计 {rows_written} 根")

        if buf:
            conn.executemany(
                "INSERT OR REPLACE INTO daily_ohlcv "
                "(symbol,date,open,high,low,close,volume,amount,pct_chg,turnover_rate) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)", buf)
            conn.commit()
            buf.clear()

        # 近期 pct_chg 缺失行补算（腾讯车道不带涨跌幅；窗口外不动）
        filled = 0
        try:
            window = (date.today() - timedelta(days=_PCT_FILL_DAYS)).isoformat()
            cur = conn.execute("""
                UPDATE daily_ohlcv o SET pct_chg = ROUND((o.close / p.prev - 1) * 100, 4)
                FROM (
                    SELECT symbol, date,
                           LAG(close) OVER (PARTITION BY symbol ORDER BY date) AS prev
                    FROM daily_ohlcv WHERE date >= ?
                ) p
                WHERE o.symbol = p.symbol AND o.date = p.date
                  AND o.pct_chg IS NULL AND p.prev IS NOT NULL AND p.prev > 0
            """, [window])
            filled = cur.fetchone()[0] if cur.description else 0
            conn.commit()
        except Exception as e:
            logger.warning("[Kline] pct 补算失败: %s", e)

        # kline:{symbol}:1d 事件（最后一根 bar；事件量 ≈ 标的数，文件总线可承载）
        if bus is not None:
            for sym, bar in touched:
                try:
                    bus.publish(f"kline:{sym}:1d", "kline.update", {
                        "symbol": sym, "period": "1d", "closed": True,
                        "bar": {"t": bar["t"], "o": bar["o"], "h": bar["h"],
                                "l": bar["l"], "c": bar["c"], "v": bar["v"],
                                "amount": bar["amount"]},
                    })
                except Exception:                # 单条事件失败不影响落库
                    pass
            event_rows = len(touched)

        result.update(
            status="success" if failed == 0 or rows_written else
                   ("success" if rows_written else "failed"),
            rows=rows_written,
            error=f"{failed} 个标的拉取失败" if failed and not rows_written else "",
            detail=f"增量 {rows_written} 根 K 线（{done}/{len(pending)} 标的，"
                   f"失败 {failed}，pct 补算 {filled} 行，事件 {event_rows} 条）")
        if failed:
            result["failed_symbols"] = failed
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Kline] 增量更新失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
