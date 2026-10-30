"""数据底座体检评估（P1）：新鲜度 / 覆盖率 / 断档 / 落账健康 → 综合分与分级。

对标 1.0 数据治理三件套（data_inventory / data_audit / data_quality_issues）
的只读版：API 进程对 DuckDB 只有只读连接，体检全部用 SELECT，写锁持有期间
连接会被拒——调用方（router）自行 try/except 降级为「无法体检」。

打分口径（策影 foundation 设计「体检评估」对齐）：
- 新鲜度 40%：每类数据最新日期 vs 预期日期（链位时刻 + 60min 缓冲后预期
  当日，否则预期上一交易日）；滞后 0/1/2-3/>3 交易日 → 100/70/40/0。
  财务（报告期）与复权因子（周更）用宽松口径。
- 覆盖率 30%：最新截面覆盖标的数 / 全市场证券数，≥90%→100 线性到 0。
- 断档 20%：daily_ohlcv 近 10 个交易日逐日检查缺日与标的数骤降。
- 落账健康 10%：update_log 近 7 天失败次数扣分 + updater 进程在线探测。

分级：healthy ≥85 / warn ≥70 / poor <70。issues 带修复动作（action），
一键修复端点 /data/repair 直接消费。
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta

from ...config import settings
from ...updater.trading_calendar import is_trading_day
from .data import _coverage

# 体检对象：表 → kind / 日期列 / 链位时刻(h,m)（None=宽松日历口径）/ 周更 /
# 宽松口径的宽限天数 (满分界, 及格界)
_FRESH_TABLES: dict[str, dict] = {
    "daily_ohlcv": {"kind": "kline_update", "col": "date",
                    "chain": (17, 0), "weekly": False},
    "capital_flow": {"kind": "capital_flow", "col": "date",
                     "chain": (16, 30), "weekly": False},
    "daily_valuation": {"kind": "valuation", "col": "date",
                        "chain": (16, 20), "weekly": False},
    "sector_index": {"kind": "sector_index", "col": "trade_date",
                     "chain": (15, 35), "weekly": False},
    # 财务按报告期披露（季报节奏 ≈ 90 天，双倍缓冲宽判）
    "financials": {"kind": "financials", "col": "report_date",
                   "chain": None, "weekly": False, "soft": (200, 320)},
    # 复权因子周六增量（一周一更，双周宽判）
    "adjust_factor": {"kind": "adjust_factor", "col": "ex_date",
                      "chain": None, "weekly": True, "soft": (8, 15)},
}

# 覆盖率计入总分的核心表（个股维度截面）
_COVER_TABLES = ("daily_ohlcv", "daily_valuation", "capital_flow")


def updater_alive(max_age_s: float = 20.0) -> bool:
    """updater 心跳探测：进度快照 saved_at 距今 < 20s 视为在线。

    （自 routers/v1/data.py 收编：体检与更新触发共用同一判定。）
    """
    try:
        snap = json.loads(settings.update_snapshot_path.read_text(encoding="utf-8"))
        saved = snap.get("saved_at")
        if not saved:
            return False
        t = datetime.fromisoformat(str(saved).replace("Z", "+00:00"))
        age = (datetime.now(tz=t.tzinfo or None) - t).total_seconds() \
            if t.tzinfo else (datetime.now() - t).total_seconds()
        return 0 <= age < max_age_s
    except FileNotFoundError:
        return False
    except Exception:
        return False


# -- 新鲜度 ------------------------------------------------------------------

def _expected_date(now: datetime, chain: tuple[int, int] | None) -> date:
    """预期最新日期：链位过点 60min 后预期当日（交易日），否则上一交易日。"""
    today = now.date()
    if chain is not None:
        due = now.replace(hour=chain[0], minute=chain[1], second=0, microsecond=0)
        if now <= due + timedelta(minutes=60):
            return _prev_trading(today)
    if is_trading_day(today):
        return today
    return _prev_trading(today)


def _expected_saturday(now: datetime) -> date:
    """周更任务预期日期：最近一个周六（含今天）。"""
    d = now.date()
    while d.weekday() != 5:
        d -= timedelta(days=1)
    return d


def _prev_trading(d: date) -> date:
    d -= timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d


def _trading_lag(latest: str | None, expected: date) -> int:
    """latest 落后 expected 几个交易日（0=齐平；latest 更新也算 0）。"""
    if not latest:
        return 99
    try:
        d = date.fromisoformat(str(latest)[:10])
    except Exception:
        return 99
    if d >= expected:
        return 0
    lag = 0
    cur = expected
    while d < cur and lag < 30:
        cur = _prev_trading(cur)
        lag += 1
    return lag if d == cur else 99


def _fresh_score(lag: int, soft: tuple[int, int] | None) -> int:
    if soft:                          # 财务/复权因子：日历口径宽判
        full, pass_ = soft
        return 100 if lag <= full else (60 if lag <= pass_ else 20)
    return 100 if lag == 0 else (70 if lag == 1 else (40 if lag <= 3 else 0))


def _freshness(conn, now: datetime) -> tuple[int, list[dict]]:
    items, scores = [], []
    for table, spec in _FRESH_TABLES.items():
        latest = None
        try:
            row = conn.execute(f"SELECT MAX({spec['col']}) FROM {table}").fetchone()
            latest = str(row[0]) if row and row[0] else None
        except Exception:
            pass
        soft = spec.get("soft")
        if spec["weekly"]:
            expected = _expected_saturday(now)
            lag = _calendar_lag(latest)
        elif soft:                    # 报告期口径：纯日历宽限
            expected = None
            lag = _calendar_lag(latest)
        else:
            expected = _expected_date(now, spec["chain"])
            lag = _trading_lag(latest, expected)
        score = _fresh_score(lag, soft)
        scores.append(score)
        items.append({
            "table": table, "kind": spec["kind"], "latest": latest,
            "expected": str(expected) if expected else None, "lag_days": lag,
            "score": score, "lenient": bool(soft),
        })
    return round(sum(scores) / len(scores)) if scores else 100, items


def _calendar_lag(latest: str | None) -> int:
    if not latest:
        return 99
    try:
        return (datetime.now().date() - date.fromisoformat(str(latest)[:10])).days
    except Exception:
        return 99


# -- 覆盖率 ------------------------------------------------------------------

def _cover_score(pct: float | None) -> int:
    if pct is None:
        return 100                    # 无全市场基数（universe 空）不扣分
    if pct >= 90:
        return 100
    return max(0, round(pct / 90 * 100))


def _coverage_all(conn) -> tuple[int, list[dict]]:
    items, scores = [], []
    for table in _COVER_TABLES:
        date_col = {"daily_ohlcv": "date", "daily_valuation": "date",
                    "capital_flow": "date"}[table]
        latest = None
        try:
            row = conn.execute(f"SELECT MAX({date_col}) FROM {table}").fetchone()
            latest = str(row[0]) if row and row[0] else None
        except Exception:
            pass
        pct = _coverage(conn, table, date_col, latest)
        score = _cover_score(pct)
        scores.append(score)
        items.append({"table": table, "latest": latest,
                      "coverage": pct, "score": score})
    return round(sum(scores) / len(scores)) if scores else 100, items


# -- 断档 --------------------------------------------------------------------

def _gap_check(conn) -> tuple[int, list[dict]]:
    """近 10 个交易日：缺日 −20，当日标的数较中位数骤降 >30% −10。"""
    days: list[date] = []
    d = datetime.now().date()
    while len(days) < 10:
        if is_trading_day(d):
            days.append(d)
        d -= timedelta(days=1)
    days.reverse()
    if not days:
        return 100, []
    since = str(days[0])
    try:
        rows = conn.execute(
            "SELECT CAST(date AS VARCHAR), COUNT(DISTINCT symbol) "
            "FROM daily_ohlcv WHERE date >= ? GROUP BY 1", [since]).fetchall()
    except Exception:
        return 100, []
    by_day = {str(r[0]): int(r[1] or 0) for r in rows}
    counts = sorted(v for v in by_day.values() if v > 0)
    median = counts[len(counts) // 2] if counts else 0
    items, score = [], 100
    for day in days:
        key = str(day)
        n = by_day.get(key, 0)
        missing = n == 0
        drop = (not missing and median > 0 and n < median * 0.7)
        if missing:
            score -= 20
        elif drop:
            score -= 10
        items.append({"date": key, "symbols": n,
                      "missing": missing, "drop": drop})
    return max(0, score), items


# -- 落账健康 ------------------------------------------------------------------

def _ledger_check(conn) -> tuple[int, list[dict], bool]:
    alive = updater_alive()
    failed: list[dict] = []
    try:
        rows = conn.execute(
            "SELECT data_type, COUNT(*) FROM update_log "
            "WHERE status = 'failed' "
            "AND created_at >= CURRENT_TIMESTAMP - INTERVAL 7 DAY "
            "GROUP BY 1 ORDER BY 2 DESC").fetchall()
        failed = [{"kind": str(r[0]), "failed": int(r[1] or 0)} for r in rows]
    except Exception:
        failed = []
    score = 100 - min(100, sum(f["failed"] for f in failed) * 15)
    if not alive:
        score = 0
    return max(0, score), failed, alive


# -- 汇总 ----------------------------------------------------------------------

def assess(conn, now: datetime | None = None) -> dict:
    now = now or datetime.now()
    fresh_score, fresh_items = _freshness(conn, now)
    cover_score, cover_items = _coverage_all(conn)
    gap_score, gap_items = _gap_check(conn)
    ledger_score, failed_7d, alive = _ledger_check(conn)

    score = round(fresh_score * 0.4 + cover_score * 0.3
                  + gap_score * 0.2 + ledger_score * 0.1)
    grade = "healthy" if score >= 85 else ("warn" if score >= 70 else "poor")

    issues: list[dict] = []
    for it in fresh_items:
        if it["score"] < 100:
            issues.append({
                "level": "warn" if it["score"] >= 40 else "error",
                "code": "freshness", "kind": it["kind"],
                "message": f"{it['table']} 最新 {it['latest'] or '无'}"
                           + (f"，预期 {it['expected']}（滞后 {it['lag_days']} 天）"
                              if it["expected"] else f"（滞后 {it['lag_days']} 天）"),
                "action": {"kind": it["kind"], "force": True}
                if not it.get("lenient") else None,
            })
    for it in cover_items:
        if it["score"] < 100 and it["coverage"] is not None:
            issues.append({
                "level": "warn" if it["coverage"] >= 70 else "error",
                "code": "coverage", "kind": it["table"],
                "message": f"{it['table']} 最新截面覆盖率 {it['coverage']}%",
                "action": {"kind": "backfill", "force": False},
            })
    misses = [g for g in gap_items if g["missing"] or g["drop"]]
    if misses:
        issues.append({
            "level": "error" if any(g["missing"] for g in misses) else "warn",
            "code": "gap", "kind": "backfill",
            "message": "近 10 交易日断档/异常："
                       + "、".join(g["date"] + ("缺" if g["missing"] else "骤降")
                                   for g in misses[:5]),
            "action": {"kind": "backfill", "force": False},
        })
    for f in failed_7d:
        issues.append({
            "level": "warn", "code": "update_log", "kind": f["kind"],
            "message": f"近 7 天 {f['kind']} 失败 {f['failed']} 次",
            "action": {"kind": f["kind"], "force": True},
        })
    if not alive:
        issues.append({
            "level": "error", "code": "updater", "kind": None,
            "message": "updater 进程不在线（自动更新与自愈均已停摆）"
                       "— 启动：python -m app.updater",
            "action": None,
        })

    return {
        "score": score, "grade": grade,
        "freshness": {"score": fresh_score, "items": fresh_items},
        "coverage": {"score": cover_score, "items": cover_items},
        "gap": {"score": gap_score, "items": gap_items},
        "ledger": {"score": ledger_score, "updater_alive": alive,
                   "failed_7d": failed_7d},
        "issues": issues,
        "generated_at": now.isoformat(timespec="seconds"),
    }
