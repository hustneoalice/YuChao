"""数据底座只读体检（对策影 data_audit 的裁剪重写）：不写库、可独立运行。

用法：
    .venv/bin/python scripts/audit_data.py            # 默认 data/stock_research.duckdb
    .venv/bin/python scripts/audit_data.py --db 其他.duckdb

检查项（对应策影踩过的坑）：
  1. volume 自证审计：amount/volume/close 隐含均价落在 [0.2,5] 之外的行为
     异常（正常恒 ≈1）——成交量 100 倍误差（科创板被一律 ×100 那次事故）
     的直接证据，按 symbol 分布定位污染范围。范围限定个股与 ETF：指数
     的 volume/amount 口径各源不一（点位×量≠额），无恒等关系，不自证；
  2. OHLC 非法行：high<low、包不住开收、非正值——脏数据会撑爆副图坐标；
  3. 周末幽灵日期行——节假日守卫失效或包导入错位的痕迹；
  4. 覆盖度概览：各表行数与最新日期（滞后判定交给 selfheal 心跳）；
  5. update_log 最近失败：更新链路健康度。

连接策略：API 进程以读写模式持有 DuckDB 时其他进程连只读都会被拒，且
**热拷贝 db 文件会读到半写页**（每次副本结果都可能不同——实测踩坑），因此
锁冲突时不做副本降级，退出码 2 并提示停服后重跑。发现异常行时退出码 1
（可挂 CI / 定时体检）。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import duckdb

# 独立脚本场景可从任意 cwd 运行：把仓库根加进 import 路径
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

#: 隐含均价正常区间（amount/volume/close ≈1，放宽到 [0.2,5] 减少边缘误报）
RATIO_OK = (0.2, 5.0)
#: 自证审计范围：个股（裸码）与 ETF（带后缀的 51/15/56/58 段）；指数段
#（000/399/899/880.SH|SZ|BJ）的量价额口径各源不一，排除（策影 kind='index' 同理）
STOCK_SCOPE = """
    (symbol NOT LIKE '%.%'
     OR regexp_matches(symbol, '^(51|15|56|58)[0-9]{4}\\.(SH|SZ)$'))
"""


def _connect(db: Path):
    """直连只读；锁冲突（API 读写连接独占文件）提示停服，绝不热拷贝。"""
    try:
        return duckdb.connect(str(db), read_only=True)
    except duckdb.IOException as e:
        if "Could not set lock" in str(e):
            print("[audit] 库文件被 API 进程占用（读写连接独占）。")
            print("        热拷贝副本会读到半写页（实测结果错乱），请停服务后重跑：")
            print("          kill $(cat .logs/backend.pid) && python scripts/audit_data.py")
            sys.exit(2)
        raise


def _tables(conn) -> set:
    return {r[0] for r in conn.execute(
        "SELECT table_name FROM information_schema.tables").fetchall()}


def _date_col(conn, table: str) -> str | None:
    cols = [r[0] for r in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name=?",
        [table]).fetchall()]
    for cand in ("date", "trade_date", "report_date"):
        if cand in cols:
            return cand
    return None


def audit(db: Path) -> int:
    conn = _connect(db)
    problems = 0
    try:
        tables = _tables(conn)
        print(f"\n== 数据底座体检：{db}（直连只读）==\n")

        # 1. volume 自证审计 --------------------------------------------------
        if "daily_ohlcv" in tables:
            lo, hi = RATIO_OK
            row = conn.execute(f"""
                SELECT COUNT(*) FROM daily_ohlcv
                WHERE {STOCK_SCOPE}
                  AND amount > 0 AND volume > 0 AND close > 0
                  AND (amount / volume / close NOT BETWEEN {lo} AND {hi})
            """).fetchone()
            bad = int(row[0])
            print(f"[1] volume 自证审计：异常 {bad} 行"
                  f"（amount/volume/close 隐含均价 ∉ [{lo}, {hi}]，"
                  f"仅个股/ETF；指数口径不一不自证）")
            if bad:
                problems += bad
                top = conn.execute(f"""
                    SELECT symbol, COUNT(*) AS n, MIN(date), MAX(date)
                    FROM daily_ohlcv
                    WHERE {STOCK_SCOPE}
                      AND amount > 0 AND volume > 0 AND close > 0
                      AND (amount / volume / close NOT BETWEEN {lo} AND {hi})
                    GROUP BY symbol ORDER BY n DESC LIMIT 20
                """).fetchall()
                print("    污染分布（top 20）：")
                for r in top:
                    print(f"      {r[0]}  {r[1]} 行  {r[2]} ~ {r[3]}")

            # 2. OHLC 非法行 --------------------------------------------------
            row = conn.execute("""
                SELECT COUNT(*) FROM daily_ohlcv
                WHERE high < low OR high < GREATEST(open, close)
                   OR low > LEAST(open, close) OR LEAST(open, close) <= 0
                   OR volume < 0
            """).fetchone()
            bad = int(row[0])
            print(f"[2] OHLC 非法行：{bad}")
            if bad:
                problems += bad
                for r in conn.execute("""
                    SELECT symbol, date, open, high, low, close, volume
                    FROM daily_ohlcv
                    WHERE high < low OR high < GREATEST(open, close)
                       OR low > LEAST(open, close) OR LEAST(open, close) <= 0
                       OR volume < 0 LIMIT 10
                """).fetchall():
                    print(f"      {r}")

            # 3. 周末幽灵日期 -------------------------------------------------
            row = conn.execute("""
                SELECT COUNT(*) FROM daily_ohlcv
                WHERE dayofweek(CAST(date AS TIMESTAMP)) IN (0, 6)
            """).fetchone()
            bad = int(row[0])
            print(f"[3] 周末幽灵日期行：{bad}")
            if bad:
                problems += bad

            # 4. 覆盖度概览 ---------------------------------------------------
            n_sym, last = conn.execute(
                "SELECT COUNT(DISTINCT symbol), MAX(date) FROM daily_ohlcv"
            ).fetchone()
            uni = 0
            if "stock_universe" in tables:
                uni = conn.execute(
                    "SELECT COUNT(*) FROM stock_universe WHERE symbol ~ '^[0-9]{6}$'"
                ).fetchone()[0]
            cov = 0
            if uni:
                cov = conn.execute("""
                    SELECT COUNT(DISTINCT o.symbol) FROM daily_ohlcv o
                    JOIN stock_universe u USING (symbol)
                    WHERE u.symbol ~ '^[0-9]{6}$'
                """).fetchone()[0]
            print(f"[4] daily_ohlcv：{n_sym} 个标的，最新 {last}"
                  + (f"；universe 个股 {uni}，K 线已覆盖 {cov}（{cov * 100 // uni}%）"
                     if uni else ""))

        for t in ("daily_valuation", "capital_flow", "financials",
                  "adjust_factor", "pe_percentile", "sector_index"):
            if t not in tables:
                continue
            dc = _date_col(conn, t)
            n = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            last = conn.execute(f"SELECT MAX({dc}) FROM {t}").fetchone()[0] if dc else "-"
            print(f"    {t}：{n} 行，最新 {last}")

        # 5. update_log 最近失败 ---------------------------------------------
        if "update_log" in tables:
            fails = conn.execute("""
                SELECT created_at, data_type, status, error FROM update_log
                WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10
            """).fetchall()
            print(f"[5] update_log 最近失败：{len(fails)} 条（最多展示 10）")
            for r in fails:
                print(f"      {r[0]}  {r[1]}  {r[2]}  {str(r[3])[:80]}")

        # 6. 交易日历自检 -----------------------------------------------------
        # is_trading_day 对未知年份 fail-open，holidays 包过期 = 明年节假日全被
        # 当成交易日（中秋幽灵日期教训的根源）——把「日历本身不新鲜」变成显式报警
        try:
            from app.updater.trading_calendar import calendar_health
            cal = calendar_health()
        except Exception as e:
            cal = {"status": "unknown", "detail": f"日历模块不可用: {e}"}
        print(f"[6] 交易日历自检：{cal['status']}——{cal['detail']}")
        if cal["status"] in ("stale", "degraded"):
            problems += 1

        verdict = "体检通过，未见异常" if problems == 0 else f"发现 {problems} 行异常，请处理"
        print(f"\n== 结论：{verdict} ==")
        return 1 if problems else 0
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser(description="驭潮数据底座只读体检")
    ap.add_argument("--db", default=str(Path(__file__).resolve().parent.parent
                                        / "data" / "stock_research.duckdb"))
    return audit(Path(ap.parse_args().db))


if __name__ == "__main__":
    sys.exit(main())
