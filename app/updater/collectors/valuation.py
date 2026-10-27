"""16:20 全市场估值快照 → daily_valuation（东财 clist 主车道 + 腾讯备用）。

幂等口径（1.0 原样）：daily_valuation 有 (symbol,date) 主键但**没有**「更新即
覆盖」语义——同一天重复跑必须先把当日整批删掉，否则退市/停牌导致字段变 None
的标的会留下新旧混杂的行。
"""
from __future__ import annotations

import logging
import time
from datetime import datetime

from ..util import expected_asof
from ..writer import writer
from . import sources

logger = logging.getLogger("yuchao.updater")


def update_valuation(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    result: dict = {"task": "valuation", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)   # 允许无进度上报直调
    try:
        day = expected_asof()
        d0 = datetime.strptime(day, "%Y-%m-%d").date()
        try:
            snap, listed, industries = sources.fetch_valuation_snapshot(
                progress=progress, cancel=cancel)
            src = "东财 clist"
        except RuntimeError as e:
            # 备用车道：东财 push2 被 IP 风控掐连时换腾讯 qt（1.0 2026-09 实战）
            progress(stage="切换备用数据源", total=0, done=0,
                     message=f"东财 clist 不可达（{str(e)[:80]}），切换腾讯 qt", level="warning")
            conn = writer.conn()
            syms = [str(r[0]) for r in conn.execute(
                "SELECT symbol FROM stock_universe WHERE symbol ~ '^[0-9]{6}$'").fetchall()]
            raw = sources.fetch_qt_batch(syms, progress=progress, cancel=cancel)
            snap = {s: (v[2], v[3], v[4], v[5], v[6]) for s, v in raw.items()}
            listed, industries = {}, {}
            src = "腾讯 qt（备用车道）"
            if not snap:
                raise RuntimeError("腾讯备用车道也为空（可能是网络整体故障）") from e
        if not snap:
            raise RuntimeError("估值快照为空（接口可能被限流）")

        rows = [(sym, d0, pe, pb, None, None, mv, cmv, amt)
                for sym, (pe, pb, mv, cmv, amt) in snap.items()]
        progress(stage="写入估值", total=len(rows), done=0,
                 message=f"{day} 共 {len(rows)} 个标的")
        conn = writer.conn()
        conn.execute("DELETE FROM daily_valuation WHERE date = ?", [d0])
        conn.executemany(
            "INSERT OR REPLACE INTO daily_valuation "
            "(symbol,date,pe_ttm,pb,ps_ttm,pcf_ncf_ttm,total_mv,circ_mv,amount) "
            "VALUES (?,?,?,?,?,?,?,?,?)", rows)

        # 停牌信号落旁表（当日无成交、f6='-'）；只存停牌，一天几行到几十行。
        # 只删同来源行：行情源自证（source='kline'）的结论更权威，不能被快照覆盖。
        suspended = [(sym, d0) for sym, (_, _, _, _, amt) in snap.items() if amt is None]
        conn.execute("""CREATE TABLE IF NOT EXISTS trade_status_daily (
            symbol VARCHAR NOT NULL, date DATE NOT NULL,
            suspended BOOLEAN NOT NULL DEFAULT TRUE,
            source VARCHAR, updated_at TIMESTAMP)""")
        conn.execute(
            "DELETE FROM trade_status_daily WHERE date = ? AND source = 'snapshot'", [d0])
        if suspended:
            conn.executemany(
                "INSERT INTO trade_status_daily (symbol, date, suspended, source, updated_at) "
                "VALUES (?,?,TRUE,'snapshot',?)",
                [(s, d0, datetime.now()) for s, _ in suspended])

        # 补 list_date：只补「库内为空」的，绝不覆盖数仓已有的权威值
        fixed = 0
        try:
            missing = {str(r[0]) for r in conn.execute(
                "SELECT symbol FROM stock_universe WHERE list_date IS NULL").fetchall()}
            for sym, ld in listed.items():
                if sym in missing:
                    conn.execute(
                        "UPDATE stock_universe SET list_date = ? "
                        "WHERE symbol = ? AND list_date IS NULL",
                        [datetime.strptime(ld, "%Y-%m-%d").date(), sym])
                    fixed += 1
        except Exception as e:
            logger.warning("[Valuation] 补上市日期失败: %s", e)

        # 补 industry：与 list_date「只补空」不同，这里直接刷新——行业分类随东财
        # 调整而变，库内没有别的权威来源；取不到行业的保留原值。
        ind_fixed = 0
        try:
            if industries:
                conn.executemany(
                    "UPDATE stock_universe SET industry = ? WHERE symbol = ?",
                    [(v, k) for k, v in industries.items()])
                ind_fixed = len(industries)
        except Exception as e:
            logger.warning("[Valuation] 补行业分类失败: %s", e)
        conn.commit()

        with_pe = sum(1 for r in rows if r[2] is not None)
        result.update(status="success", rows=len(rows),
                      detail=f"{day} 写入 {len(rows)} 个标的估值（其中 {with_pe} 个有 PE，"
                             f"{len(suspended)} 个当日无成交/停牌，来源 {src}）"
                             + (f"，补 {fixed} 个上市日期" if fixed else "")
                             + (f"，刷新 {ind_fixed} 个行业分类" if ind_fixed else ""))
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Valuation] 估值采集失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
