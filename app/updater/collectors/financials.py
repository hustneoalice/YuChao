"""17:30 财务数据 → financials（东财 datacenter，按报告期全量分页）。

口径（1.0 原样）：
  · 利润表 RPT_LICO_FN_CPD：归母净利润 / 同比 / 加权ROE；
  · 资产负债 RPT_DMSK_FN_BALANCE（负债率）+ 现金流 RPT_DMSK_FN_CASHFLOW
    （经营现金流）按期取全量后按股合并——按股取要 5500+ 次请求（1.0 教训）；
  · 覆盖最近两个报告期：年报/季报披露有先后，只跑当期会漏掉刚披露上期的新股。
"""
from __future__ import annotations

import logging
import time
from datetime import date

from ..writer import writer
from . import sources

logger = logging.getLogger("yuchao.updater")


_QEND = [(3, 31), (6, 30), (9, 30), (12, 31)]


def _last_periods(n: int = 2) -> list[str]:
    """最近 n 个已结束的季末报告期（YYYY-MM-DD），披露滞后不管——
    未披露的报告期接口返回空，任务侧留痕即可。"""
    today = date.today()
    y = today.year
    anchor = None
    for m, d in reversed(_QEND):                     # 从当年最近的季末往前找
        if date(y, m, d) <= today:
            anchor = (y, m, d)
            break
    if anchor is None:
        anchor = (y - 1, 12, 31)
    out = [anchor]
    while len(out) < n:
        py, pm, pd = out[-1]
        out.append((py - 1, 12, 31) if pm == 3 else (py, pm - 3, pd))
    return [f"{a:04d}-{b:02d}-{c:02d}" for a, b, c in out]


def update_financials(progress=None, ctx=None) -> dict:
    start = time.time()
    cancel = (ctx or {}).get("cancel_check")
    result: dict = {"task": "financials", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)   # 允许无进度上报直调
    try:
        periods = _last_periods(2)
        conn = writer.conn()
        total_rows = 0
        for pi, period in enumerate(periods):
            if cancel and cancel():
                result["detail"] = f"取消于 {period}"
                break
            progress(stage="采集财务", total=0, done=0,
                     message=f"报告期 {period}（{pi + 1}/{len(periods)}）")
            main = sources.fetch_financial_period(period)
            if not main:
                progress(log=f"报告期 {period} 暂无披露数据（可能未到披露季）",
                         level="info")
                continue
            extras = sources.fetch_financial_extras(period)
            rows = []
            for sym, rep, np_, yoy, roe in main:
                dr, ocf = extras.get(sym, (None, None))
                rows.append((sym, rep, np_, yoy, roe, dr, ocf, None))
            # 幂等：先删该报告期再整批插入（不依赖主键存在）
            conn.execute("DELETE FROM financials WHERE report_date = ?", [period])
            conn.executemany(
                "INSERT INTO financials "
                "(symbol,report_date,net_profit,net_profit_yoy,roe,debt_ratio,"
                "operating_cashflow,audit_opinion) VALUES (?,?,?,?,?,?,?,?)", rows)
            conn.commit()
            total_rows += len(rows)
            progress(log=f"报告期 {period} 写入 {len(rows)} 条",
                     level="success" if rows else "info")

        result.update(status="success", rows=total_rows,
                      detail=f"写入 {total_rows} 条财务记录（报告期 {'、'.join(periods)}）")
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Financials] 财务更新失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
