"""17:00 K 线增量 → daily_ohlcv（腾讯 fqkline 主车道，东财 push2his 备用）。

目标集 = stock_universe 个股 + fund_universe 场内基金（ETF/LOF/REIT）+
daily_ohlcv 中带后缀的其他品种；基金与个股同一车道、同一口径（无复权因子
时 qfq 视图自动退化为原始价）。

目标集排除（不更新、也不计入失败排查）：
  · 北交所（settings.bj_enabled=False 时全系统关闭）；
  · ST / 退市股（无行情可补，留着只会每轮空转并制造「失败」噪音）；
  · 当日停牌的个股（见下，只跳当日，复牌自动恢复）。

停牌语义（trade_status_daily 旁表）：
  · 当日确实无成交才跳过；按 date 取标志，下一交易日 target 变即重新纳入，
    复牌后源返回当日 K 线就恢复正常更新，不会永久失联；
  · 排除依据只认收盘后的估值快照（updated_at >= 15:00）与行情源自证
    （source='kline'）——盘中快照会把当天复牌股误标停牌；
  · 源返回了历史、但最后一根早于 target → 判为当日停牌，写 source='kline'
    自证行，不算失败；本轮有股票拿到当日 K 线（traded_n > 0）才敢写，
    避免盘前/节假日/源站故障时把全市场误标停牌；
  · 拿到当日 K 线 → 清掉该标的当日停牌标志（复牌清账）。

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
import threading
import time
from datetime import date, datetime, timedelta

from ...config import settings
from ...foundation.symbol import is_bj
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


def _pace(done: int, total: int, elapsed: float) -> str:
    """速度与预计剩余：给前端日志的实时参考（只/分 + 倒计时）。"""
    if done <= 0 or total <= 0 or elapsed <= 0:
        return ""
    rate = done / elapsed * 60
    if done >= total:
        return f"{rate:.0f} 只/分"
    left = (total - done) / (done / elapsed)
    return f"{rate:.0f} 只/分 · 剩 {int(left) // 60} 分 {int(left) % 60:02d} 秒"


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
        # 名称随标的集一起读入：进度日志里带股票名，比只报代码更容易对照
        names: dict[str, str] = {}
        stocks = []
        skipped_st = skipped_bj = 0
        for sym, nm in conn.execute(
                "SELECT symbol, name FROM stock_universe WHERE symbol ~ '^[0-9]{6}$'").fetchall():
            s, name = str(sym), str(nm or "")
            # 北交所默认关闭（settings.bj_enabled=False）：全系统不更新北交所标的
            if not settings.bj_enabled and is_bj(s):
                skipped_bj += 1
                continue
            # ST / 退市：不更新、也不进失败排查——无行情可补，留着只会每轮空转
            if "ST" in name.upper() or "退" in name:
                skipped_st += 1
                continue
            stocks.append(s)
            names[s] = name
        funds = []
        for sym, nm in conn.execute(
                "SELECT symbol, name FROM fund_universe WHERE symbol ~ '^[0-9]{6}$'").fetchall():
            funds.append(str(sym))
            names.setdefault(str(sym), str(nm or ""))
        others = [str(r[0]) for r in conn.execute(
            "SELECT DISTINCT symbol FROM daily_ohlcv WHERE symbol LIKE '%.%'").fetchall()]
        latest = {str(r[0]): str(r[1]) for r in conn.execute(
            "SELECT symbol, MAX(date) FROM daily_ohlcv GROUP BY symbol").fetchall()}
        # 停牌标志：当日无成交才跳过，且只跳过「当日」——按 date 取，下一交易日
        # target 变了自动重新纳入，复牌即恢复更新。只认行情源自证（source='kline'）
        # 与收盘后的估值快照（snapshot 且 updated_at >= 15:00）；盘中快照会把当天
        # 复牌股误标停牌，不能当依据。
        try:
            suspended = {str(r[0]) for r in conn.execute(
                "SELECT symbol FROM trade_status_daily "
                "WHERE CAST(date AS VARCHAR) = ? AND suspended "
                "AND (source = 'kline' OR (source = 'snapshot' "
                "     AND CAST(updated_at AS TIMESTAMP) >= CAST(? AS TIMESTAMP)))",
                [target, f"{target} 15:00:00"]).fetchall()}
        except Exception:                    # 旧库还没有这张表：全部尝试（安全降级）
            suspended = set()
        writer.reset()

        fund_set = set(funds)
        fund_pause = settings.duckdb_path.parent / "fund_kline.paused"
        targets = sorted(set(stocks) | set(others) | (set() if fund_pause.exists() else fund_set))

        pending = []
        suspended_now = 0
        for s in targets:
            if s in suspended:               # 当日停牌：本轮不取数，下一交易日再看
                suspended_now += 1
                continue
            cut = latest.get(s)
            if cut is None or cut < target:
                pending.append((s, cut))
        skip_note = ""
        if skipped_st:
            skip_note += f"，跳过 ST/退市 {skipped_st} 只"
        if skipped_bj:
            skip_note += f"，跳过北交所 {skipped_bj} 只"
        if suspended_now:
            skip_note += f"，当日停牌 {suspended_now} 只"
        progress(stage="增量拉取", total=len(pending), done=0,
                 message=f"{target} 待增量 {len(pending)}/{len(targets)} 个标的"
                         + (f"（含场内基金 {sum(1 for s, _ in pending if s in fund_set)} 只）"
                            if funds else "")
                         + skip_note
                         + ("（已全部最新）" if not pending else ""))

        done = failed = 0
        rows_written = 0
        event_rows = 0
        rejected = 0                # guard_rows 拦截数（脏行/空壳不落库）
        buf: list = []
        touched: list = []          # (symbol, last_bar) 供事件发布
        fail_reasons: list = []     # 前 5 条失败原因（排障用，不刷日志）
        verified_susp: list = []    # 源返回历史但无当日 K 线：当日停牌，不算失败
        traded_today: list = []     # 本轮拿到当日 K 线的个股：用于清掉旧的停牌标志
        traded_n = 0                # 拿到当日 K 线的个股数（>0 才敢做停牌自证）
        susp_marked = 0             # 本轮写回的停牌自证行数
        consec_fail = 0             # 整体熔断计数：所有车道都不可用时快速中止
        last_beat = time.time()     # 时间心跳：卡住时界面不再冻结在 0%
        lock = threading.Lock()     # 保护车道熔断状态（worker 并发读写）
        stop = threading.Event()    # 取消/熔断后让排队中的 worker 立即返回
        # 并发度只作用于 HTTP 取数；写库仍在主线程串行（DuckDB 连接非线程安全）
        workers = max(1, int(settings.kline_workers or 1))
        total = len(pending)
        # 车道级熔断状态：consec=连续失败次数，until=冷却截止时间戳
        lane_state: dict = {name: {"consec": 0, "until": 0.0}
                            for name, _ in _KLINE_LANES}

        def _flush() -> None:
            """主线程写批：拿锁 → 写 → 立即释放（连接不跨线程）。"""
            nonlocal buf, rejected
            if not buf:
                return
            buf, bad = guard_rows(buf)   # 写前防线：脏行计数不落库
            rejected += bad
            if not buf:
                return
            c = writer.conn()
            c.executemany(
                "INSERT OR REPLACE INTO daily_ohlcv "
                "(symbol,date,open,high,low,close,volume,amount,pct_chg,turnover_rate) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)", buf)
            c.commit()
            writer.reset()
            buf.clear()

        def _fetch_one(sym: str, cut):
            """线程内只做 HTTP 取数，绝不碰 DuckDB。

            车道序列（1.0 kline_lanes 语义）：默认腾讯 → 新浪 → 东财；场内基金
            走新浪优先 → 腾讯（截 2000 根）→ 东财。空返回视同车道失败，继续
            换下家（腾讯对基金 count>2000 返回空包，不能当成功跳过备车道）。
            车道级熔断：连续 3 失败冷却 300s，冷却中直接跳过换下家，任务不中止。
            半开语义：冷却到期后首次尝试若再失败，consec 已 ≥3 → 立即重新
            冷却（不用重攒 3 次）；成功则 consec=0 满血恢复。
            """
            if stop.is_set() or (sym in fund_set and fund_pause.exists()):
                return sym, [], ""
            count = _gap_count(cut, target, _FUND_BASE_BARS if sym in fund_set else 3000)
            lanes = _KLINE_LANES_FUND if sym in fund_set else _KLINE_LANES
            errs: list = []
            for name, fname in lanes:
                with lock:
                    cooling = lane_state[name]["until"] > time.time()
                if cooling:
                    continue                      # 该车道冷却中，跳过不撞墙
                cnt = min(count, _FUND_TX_CAP) if (name == "tencent" and sym in fund_set) else count
                try:
                    rows = getattr(sources, fname)(sym, cnt)
                except Exception as e:
                    logger.debug("[Kline] %s %s 拉取失败（%s）: %s",
                                 sym, name, type(e).__name__, str(e)[:60])
                    errs.append(f"{name}:{type(e).__name__}")
                    rows = None
                if rows:
                    with lock:
                        lane_state[name]["consec"] = 0
                    return sym, rows, ""
                with lock:
                    lane_state[name]["consec"] += 1
                    cooled = lane_state[name]["consec"] >= 3
                    if cooled:
                        lane_state[name]["until"] = time.time() + 300
                errs.append(f"{name}:空")
                if cooled:
                    logger.warning("[Kline] 车道 %s 连续 3 失败，冷却 300s", name)
            return sym, [], "；".join(errs[:3])

        from concurrent.futures import ThreadPoolExecutor, as_completed

        pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="kline")
        try:
            futures = {pool.submit(_fetch_one, sym, cut): (sym, cut)
                       for sym, cut in pending}
            for fut in as_completed(futures):
                sym, cut = futures[fut]
                if cancel and cancel():
                    result["detail"] = f"取消于 {done}/{total}"
                    stop.set()
                    break
                try:
                    sym, rows, err = fut.result()
                except Exception as e:            # worker 自身异常不炸整批
                    rows, err = [], f"{type(e).__name__}:{str(e)[:60]}"

                if not rows:
                    failed += 1
                    done += 1
                    consec_fail += 1
                    if err and len(fail_reasons) < 5:
                        fail_reasons.append(f"{names.get(sym, '')}{sym} · {err}")
                    # 进度必须照报：失败路径若静默，前端进度条冻结在 0%，
                    # 看起来像任务卡死（2026-10-30 tx 501 + em 断连实测）。
                    if done % _COMMIT_EVERY == 0 or (time.time() - last_beat) >= 15:
                        last_beat = time.time()
                        progress(done=done, rows=rows_written, failed=failed,
                                 log=f"K线增量 [{done}/{total}] "
                                     f"{names.get(sym, '')} {sym} · 失败 {failed} · "
                                     f"{_pace(done, total, time.time() - start)}")
                    # 熔断：开头连续 40 只全失败 = 所有车道硬不可用（封禁/断网），
                    # 逐个烧完 5665 只要 2 小时且结果注定全败——立即中止，
                    # 交给自愈退避重试（每次代价 30s 而不是 2 小时）。
                    if consec_fail >= 40 and done == consec_fail:
                        result.update(status="failed",
                                      error=f"数据源连续 {consec_fail} 只全失败，"
                                            f"疑似不可用（封禁/断网），已熔断中止")
                        result["detail"] = f"熔断于 {done}/{total}"
                        logger.warning("[Kline] %s", result["error"])
                        stop.set()
                        break
                    continue

                consec_fail = 0
                # 个股停牌判定：源能返回历史、但最后一根早于 target → 当日无成交。
                # 有当日 K 线 → 正常交易/复牌，顺手清掉旧停牌标志，下一轮就不再
                # 被 pending 排除（这就是「解开停牌后继续更新」的落点）。
                if sym not in fund_set and "." not in sym:
                    if max(r["t"] for r in rows) >= target:
                        traded_today.append(sym)
                        traded_n += 1
                    else:
                        verified_susp.append(sym)
                new = [r for r in rows if (cut is None or r["t"] > cut)]
                if new:
                    buf.extend((sym, r["t"], r["o"], r["h"], r["l"], r["c"],
                                r["v"], r["amount"], r["pct_chg"], r["turnover_rate"])
                               for r in new)
                    rows_written += len(new)
                    touched.append((sym, new[-1]))

                done += 1
                if len(buf) >= 20000 or done % _COMMIT_EVERY == 0:
                    _flush()
                    progress(done=done, rows=rows_written, failed=failed,
                             log=f"K线增量 [{done}/{total}] "
                                 f"{names.get(sym, '')} {sym} · 累计 {rows_written} 根 · "
                                 f"{_pace(done, total, time.time() - start)}")
                elif (time.time() - last_beat) >= 15:   # 时间心跳：慢但没死
                    last_beat = time.time()
                    progress(done=done, rows=rows_written, failed=failed,
                             log=f"K线增量 [{done}/{total}] "
                                 f"{names.get(sym, '')} {sym} · 累计 {rows_written} 根 · "
                                 f"{_pace(done, total, time.time() - start)}")
        finally:
            # 取消/熔断后：排队中的直接取消，运行中的等其 HTTP 超时返回
            pool.shutdown(wait=True, cancel_futures=True)

        _flush()

        # 停牌自证：把「源站确实拿不到当日 K 线」的结论写成 source='kline' 权威行，
        # 同日重跑直接跳过；换交易日后 target 变，停牌股自动重新纳入 pending——复牌
        # 时源返回当日 K 线，再清掉旧标志。所以停牌只影响当日，不会永久失联。
        # 只在 traded_n > 0（本轮确有股票拿到当日 K 线）时写：盘前/节假日/源站故障
        # 下全体「无当日 K 线」属于环境问题，不能把全市场误标成停牌。
        if traded_n > 0 and (verified_susp or traded_today):
            try:
                c = writer.conn()
                c.execute("""CREATE TABLE IF NOT EXISTS trade_status_daily (
                    symbol VARCHAR NOT NULL, date DATE NOT NULL,
                    suspended BOOLEAN NOT NULL DEFAULT TRUE,
                    source VARCHAR, updated_at TIMESTAMP)""")
                if verified_susp:
                    c.executemany(
                        "DELETE FROM trade_status_daily "
                        "WHERE CAST(date AS VARCHAR) = ? AND symbol = ?",
                        [(target, s) for s in verified_susp])
                    c.executemany(
                        "INSERT INTO trade_status_daily "
                        "(symbol, date, suspended, source, updated_at) "
                        "VALUES (?,?,TRUE,'kline',?)",
                        [(s, target, datetime.now()) for s in verified_susp])
                    susp_marked = len(verified_susp)
                if traded_today:                 # 正常交易/复牌：清掉任何来源的旧标志
                    c.executemany(
                        "DELETE FROM trade_status_daily "
                        "WHERE CAST(date AS VARCHAR) = ? AND symbol = ?",
                        [(target, s) for s in traded_today])
                c.commit()
                writer.reset()
            except Exception as e:
                logger.warning("[Kline] 停牌自证写回失败: %s", e)
                writer.reset()

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

        if not pending:
            # 无待增量：全市场（去掉 ST/退市、北交所、当日停牌）都已最新
            status = "skipped" if not failed else "failed"
            detail = f"{target} 全部 {len(targets)} 个标的均已最新" + skip_note
        else:
            status = "success" if (failed == 0 or rows_written) else "failed"
            detail = (f"增量 {rows_written} 根 K 线（{done}/{len(pending)} 标的，"
                      f"失败 {failed}，停牌 {susp_marked}，防错拦截 {rejected} 行，"
                      f"pct 补算 {filled} 行，事件 {event_rows} 条"
                      + skip_note + "）"
                      + (f"｜失败样例：{'；'.join(fail_reasons)}" if fail_reasons else ""))
        result.update(
            status=status,
            rows=rows_written,
            total=len(pending), success=done - failed,
            error=f"{failed} 个标的拉取失败" if failed and not rows_written else "",
            detail=detail)
        if failed:
            result["failed_symbols"] = failed
            result["fail_samples"] = fail_reasons   # 前 5 条失败原因（排障用）
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Kline] 增量更新失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
