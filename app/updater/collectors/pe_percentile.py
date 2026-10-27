"""16:50 PE 分位重建：从 daily_valuation 最新截面重算全市场分位。

1.0 教训全部继承（2026-09-17 修）：
  · pe_percentile 是「最新截面」快照表（symbol 唯一）非历史表，重建必须与
    当日截面 1:1 对齐：在库的刷值、新进的补插、消失的删除（退市/长停僵尸行）；
  · **必须同时刷新 pe_ttm**——旧版只刷分位漏了 pe_ttm，首次进入快照那天的 PE
    被永久固化（实测 99.4% 行与最新截面不符）；
  · 分位只对 pe_ttm > 0 计算（亏损股 PE 为负不参与低估值分位），但它们的
    pe_ttm 同样要刷新；
  · 行业中位 PE（0 < pe < 500 过滤，口径与判定侧一致）一并重建。
"""
from __future__ import annotations

import logging
import time

from ..writer import writer

logger = logging.getLogger("yuchao.updater")


def rebuild_pe_percentile(progress=None, ctx=None) -> dict:
    start = time.time()
    result: dict = {"task": "pe_percentile", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)   # 允许无进度上报直调
    try:
        progress(stage="重建PE分位", message="基于最新估值截面计算分位数")
        conn = writer.conn()
        # 实体中间表（TEMP TABLE 在部分 DuckDB 版本下 schema 命名不稳定，1.0 教训）
        conn.execute("DROP TABLE IF EXISTS _pe_stage")
        conn.execute("""
            CREATE TABLE _pe_stage AS
            WITH latest AS (
                SELECT symbol, pe_ttm FROM daily_valuation
                WHERE date = (SELECT MAX(date) FROM daily_valuation)
            ),
            ranked AS (
                SELECT symbol,
                       CAST(ROUND(PERCENT_RANK() OVER (ORDER BY pe_ttm) * 100, 1) AS INTEGER) AS pct
                FROM latest WHERE pe_ttm IS NOT NULL AND pe_ttm > 0
            )
            SELECT l.symbol, l.pe_ttm, r.pct
            FROM latest l LEFT JOIN ranked r ON l.symbol = r.symbol
        """)
        # 先刷后补（遗留无主键表，不支持 INSERT OR REPLACE）
        conn.execute("""
            UPDATE pe_percentile
            SET pe_ttm = t.pe_ttm, pe_percentile = t.pct,
                updated_at = CAST(NOW() AS VARCHAR)
            FROM _pe_stage t WHERE pe_percentile.symbol = t.symbol
        """)
        conn.execute("""
            INSERT INTO pe_percentile (symbol, pe_ttm, pe_percentile, updated_at)
            SELECT t.symbol, t.pe_ttm, t.pct, CAST(NOW() AS VARCHAR)
            FROM _pe_stage t
            WHERE NOT EXISTS (SELECT 1 FROM pe_percentile p WHERE p.symbol = t.symbol)
        """)
        removed = conn.execute("""
            SELECT COUNT(*) FROM pe_percentile
            WHERE symbol IS NOT NULL AND symbol NOT IN (SELECT symbol FROM _pe_stage)
        """).fetchone()[0]
        if removed:
            conn.execute("""
                DELETE FROM pe_percentile
                WHERE symbol IS NOT NULL AND symbol NOT IN (SELECT symbol FROM _pe_stage)
            """)
        # 行业中位 PE 回填（放最后，新插的行也能覆盖到）
        conn.execute("DROP TABLE IF EXISTS _pe_ind")
        conn.execute("""
            CREATE TABLE _pe_ind AS
            SELECT u.symbol, m.med AS industry_pe_median
            FROM stock_universe u
            JOIN (
                SELECT u2.industry AS industry, MEDIAN(s.pe_ttm) AS med
                FROM _pe_stage s
                JOIN stock_universe u2 ON u2.symbol = s.symbol
                WHERE s.pe_ttm IS NOT NULL AND s.pe_ttm > 0 AND s.pe_ttm < 500
                  AND u2.industry IS NOT NULL AND u2.industry <> ''
                GROUP BY u2.industry
            ) m ON m.industry = u.industry
        """)
        ind_rows = conn.execute("SELECT COUNT(*) FROM _pe_ind").fetchone()[0]
        conn.execute("""
            UPDATE pe_percentile SET industry_pe_median = t.industry_pe_median
            FROM _pe_ind t WHERE pe_percentile.symbol = t.symbol
        """)
        conn.execute("DROP TABLE IF EXISTS _pe_ind")
        n = conn.execute("SELECT COUNT(*) FROM _pe_stage").fetchone()[0]
        conn.execute("DROP TABLE IF EXISTS _pe_stage")
        conn.commit()
        result.update(status="success", rows=int(n),
                      detail=f"重建 {n} 只股票 PE 分位，行业 PE 中位覆盖 {ind_rows} 只"
                             + (f"，清理 {removed} 只已退市/长停残留" if removed else ""))
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[PE] 分位重建失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
