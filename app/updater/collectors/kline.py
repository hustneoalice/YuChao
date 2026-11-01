"""17:00 K 线增量 → daily_ohlcv（腾讯 fqkline 主车道，东财 push2his 备用）。

目标集 = stock_universe 个股 + fund_universe 场内基金（ETF/LOF/REIT）+
daily_ohlcv 中带后缀的其他品种；基金与个股同一车道、同一口径（无复权因子
时 qfq 视图自动退化为原始价）。

增量口径（1.0 原样）：
  · 每标的 cutoff = 库内 MAX(date)，只拉缺口：count = 缺口天数×1.6+20
    （周末节假日折算，下限 30 上限 3000）——全市场每天只补 1~2 根，不重拉全史；
  · 覆盖写 INSERT OR REPLACE：(symbol,date) 主键，幂等可重跑；
  · 库内无任何 K 线的标的建底仓：个股 3000 根、场内基金 800 根（≈3 年，
    季线 12 根；后续随日增量向前累积），避免基金全史首拉拖垮整批；
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

from ...config import settings
from ..util import expected_asof
from ..writer import writer
from . import sources
from .normalize import guard_rows

logger = logging.getLogger("yuchao.updater")

_COMMIT_EVERY = 50          # 标的数：批提交节奏（1.0 同款）
_PCT_FILL_DAYS = 45         # pct 补算回看窗口（天）：只补近期缺口，不全表扫

#: 车道序列（1.0 kline_lanes 语义）：腾讯 4 端点轮换主车道 → 新浪备车道 →
#: 东财 push2his 兜底。任一车道连续 3 失败即冷却 300s，跳过换下家。
#: 存函数名而非函数对象：模块级绑定会让测试 monkeypatch.setattr(sources, …)
#: 失效（绑死旧引用，测试真发 HTTP）——getattr 延迟解析。
_KLINE_LANES = (
    ("tencent", "fetch_kline_tx"),
    ("sina", "fetch_kline_sina"),
    ("eastmoney", "fetch_kline_em"),
)

#: 场内基金车道顺序：腾讯 fqkline 对基金 count>2000 返回空（实测 501001：
#: 2000 正常、2500 起空包），而有史建底仓要 3000 根——基金一律先走新浪，
#: 腾讯只作备用（根数截到 2000），东财基金无数据兜底。
_KLINE_LANES_FUND = (
    ("sina", "fetch_kline_sina"),
    ("tencent", "fetch_kline_tx"),
    ("eastmoney", "fetch_kline_em"),
)
_FUND_TX_CAP = 2000
_FUND_BASE_BARS = 800       # 基金建底仓根数（≈3 年，季线 12 根；之后靠日增量向前累积）


def _gap_count(cutoff: str | None, target: str, initial: int = 3000) -> int:
    """缺口 → 请求根数：自然日×1.6（覆盖周末节假日）+20 安全边际。"""
    if not cutoff:
        return initial                           # 库内无 K 线：建底仓（个股 3000 / 基金 800）
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

        # 读目标集/cutoff：短连接用完立即释放——DuckDB 写锁是连接级排他的，
        # 抓取阶段（个股 5555 + 基金 2168 ≈ 7700 只 × ~150ms ≈ 十几分钟）
        # 绝不能持锁，否则 API 进程的只读连接全部被拒，前端整个瘫掉（真实踩坑）。
        conn = writer.conn()
        stocks = [str(r[0]) for r in conn.execute(
            "SELECT symbol FROM stock_universe WHERE symbol ~ '^[0-9]{6}$'").fetchall()]
        funds = [str(r[0]) for r in conn.execute(
            "SELECT symbol FROM fund_universe WHERE symbol ~ '^[0-9]{6}$'").fetchall()]
        others = [str(r[0]) for r in conn.execute(
            "SELECT DISTINCT symbol FROM daily_ohlcv WHERE symbol LIKE '%.%'").fetchall()]
        latest = {str(r[0]): str(r[1]) for r in conn.execute(
            "SELECT symbol, MAX(date) FROM daily_ohlcv GROUP BY symbol").fetchall()}
        writer.reset()

        fund_set = set(funds)
        fund_pause = settings.duckdb_path.parent / "fund_kline.paused"
        targets = sorted(set(stocks) | set(others) | (set() if fund_pause.exists() else fund_set))

        pending = []
        for s in targets:
            cut = latest.get(s)
            if cut is None or cut < target:
                pending.append((s, cut))
        progress(stage="增量拉取", total=len(pending), done=0,
                 message=f"{target} 待增量 {len(pending)}/{len(targets)} 个标的"
                         + (f"（含场内基金 {sum(1 for s, _ in pending if s in fund_set)} 只）"
                            if funds else "")
                         + ("（已全部最新）" if not pending else ""))

        done = failed = 0
        rows_written = 0
        event_rows = 0
        rejected = 0                # guard_rows 拦截数（脏行/空壳不落库）
        buf: list = []
        touched: list = []          # (symbol, last_bar) 供事件发布
        consec_fail = 0             # 整体熔断计数：所有车道都不可用时快速中止
        now = time.time()           # 车道冷却基准（秒级足够，每标的刷新）
        # 车道级熔断状态：consec=连续失败次数，until=冷却截止时间戳
        lane_state: dict = {name: {"consec": 0, "until": 0.0}
                            for name, _ in _KLINE_LANES}

        for i, (sym, cut) in enumerate(pending):
            if sym in fund_set and fund_pause.exists():
                continue
            if cancel and cancel():
                result["detail"] = f"取消于 {done}/{len(pending)}"
                break
            count = _gap_count(cut, target, _FUND_BASE_BARS if sym in fund_set else 3000)
            # 车道序列（1.0 kline_lanes 语义）：默认腾讯 → 新浪 → 东财；场内基金
            # 走新浪优先 → 腾讯（截 2000 根）→ 东财。空返回视同车道失败，继续
            # 换下家（腾讯对基金 count>2000 返回空包，不能当成功跳过备车道）。
            # 车道级熔断：连续 3 失败冷却 300s，冷却中直接跳过换下家，任务不中止。
            # 半开语义：冷却到期后首次尝试若再失败，consec 已 ≥3 → 立即重新
            # 冷却（不用重攒 3 次）；成功则 consec=0 满血恢复——熔断器完整
            # 状态机（open → half-open → closed/re-open）由这三行天然构成。
            rows = None
            used_lane = None
            lanes = _KLINE_LANES_FUND if sym in fund_set else _KLINE_LANES
            for name, fname in lanes:
                st = lane_state[name]
                if st["until"] > now:
                    continue                      # 该车道冷却中，跳过不撞墙
                cnt = min(count, _FUND_TX_CAP) if (name == "tencent" and sym in fund_set) else count
                try:
                    rows = getattr(sources, fname)(sym, cnt)
                except Exception as e:
                    logger.debug("[Kline] %s %s 拉取失败（%s）: %s",
                                 sym, name, type(e).__name__, str(e)[:60])
                    rows = None
                if rows:
                    used_lane = name
                    st["consec"] = 0
                    break                         # 有数据即成功；空返回继续换下家
                st["consec"] += 1
                if st["consec"] >= 3:
                    st["until"] = now + 300       # 该车道冷却 5 分钟
                    logger.warning("[Kline] 车道 %s 连续 %d 失败，冷却 300s",
                                   name, st["consec"])
            if not rows:
                failed += 1
                done += 1
                consec_fail += 1
                # 进度必须照报：失败路径若静默，前端进度条冻结在 0%，
                # 看起来像任务卡死（2026-10-30 tx 501 + em 断连实测）。
                if done % _COMMIT_EVERY == 0:
                    progress(done=done, rows=rows_written,
                             log=f"K线增量 [{done}/{len(pending)}] 失败 {failed}")
                # 熔断：开头连续 40 只全失败 = 所有车道硬不可用（封禁/断网），
                # 逐个烧完 5665 只要 2 小时且结果注定全败——立即中止，
                # 交给自愈退避重试（每次代价 30s 而不是 2 小时）。
                if consec_fail >= 40 and done == consec_fail:
                    result.update(status="failed",
                                  error=f"数据源连续 {consec_fail} 只全失败，"
                                        f"疑似不可用（封禁/断网），已熔断中止")
                    result["detail"] = f"熔断于 {done}/{len(pending)}"
                    logger.warning("[Kline] %s", result["error"])
                    return result
                continue

            consec_fail = 0
            now = time.time()
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
                    buf, bad = guard_rows(buf)   # 写前防线：脏行计数不落库
                    rejected += bad
                if buf:
                    c = writer.conn()            # 写批次：拿锁 → 写 → 立即释放
                    c.executemany(
                        "INSERT OR REPLACE INTO daily_ohlcv "
                        "(symbol,date,open,high,low,close,volume,amount,pct_chg,turnover_rate) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?)", buf)
                    c.commit()
                    writer.reset()
                    buf.clear()
                progress(done=done, rows=rows_written,
                         log=f"K线增量 [{done}/{len(pending)}] 累计 {rows_written} 根")

        if buf:
            buf, bad = guard_rows(buf)
            rejected += bad
        if buf:
            c = writer.conn()
            c.executemany(
                "INSERT OR REPLACE INTO daily_ohlcv "
                "(symbol,date,open,high,low,close,volume,amount,pct_chg,turnover_rate) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)", buf)
            c.commit()
            writer.reset()
            buf.clear()

        # 近期 pct_chg 缺失行补算（腾讯车道不带涨跌幅；窗口外不动）
        filled = 0
        try:
            window = (date.today() - timedelta(days=_PCT_FILL_DAYS)).isoformat()
            c = writer.conn()
            cur = c.execute("""
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
            c.commit()
            writer.reset()
        except Exception as e:
            logger.warning("[Kline] pct 补算失败: %s", e)
            writer.reset()

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
                   f"失败 {failed}，防错拦截 {rejected} 行，"
                   f"pct 补算 {filled} 行，事件 {event_rows} 条）")
        if failed:
            result["failed_symbols"] = failed
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Kline] 增量更新失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
