"""场内基金清单日级同步 → fund_universe（新浪 ETF/LOF/REIT 三节点，~2168 只）。

基金行情走 market_snapshot 快照任务（kind='fund'，qt 同报文零额外源）；
清单是慢变量，盘前刷新一次即可。基金不入 stock_universe（选股宇宙纯净）。
东财 clist（MK0021-24）保留为 fallback：新浪不可用时退回 ETF 子集。
"""
from __future__ import annotations

import logging
import time

from ..writer import writer
from . import sources

logger = logging.getLogger("yuchao.updater")


def update_fund_universe(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    result: dict = {"task": "fund_universe_sync", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)
    try:
        conn = writer.conn()
        try:
            items = sources.fetch_fund_list(progress=progress, cancel=cancel)
        except Exception as e:
            logger.warning("[FundUniverse] 新浪基金清单失败（%s），回退东财 ETF",
                           type(e).__name__)
            items = []
        if len(items) < 1500:
            logger.warning("[FundUniverse] 新浪仅 %d 行，回退东财 ETF", len(items))
            items = sources.fetch_etf_list(progress=progress, cancel=cancel)
        if len(items) < 1500:
            raise RuntimeError(f"基金清单仅 {len(items)} 行（疑似限流），拒绝覆盖")
        progress(stage="写基金清单", total=len(items), done=len(items),
                 message=f"场内基金 {len(items)} 只")
        # DELETE+INSERT 全量重建：清单小（~2200 行），换名/退市/新上市天然对齐
        conn.execute("DELETE FROM fund_universe")
        conn.executemany(
            "INSERT OR REPLACE INTO fund_universe (symbol, name, market) "
            "VALUES (?,?,?)",
            [(it["symbol"], it["name"], it["market"]) for it in items])
        conn.commit()
        n_sh = sum(1 for it in items if it["market"] == "SH")
        result.update(status="success", rows=len(items),
                      detail=f"场内基金 {len(items)} 只（沪 {n_sh} / 深 {len(items) - n_sh}）")
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[FundUniverse] 基金清单同步失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
