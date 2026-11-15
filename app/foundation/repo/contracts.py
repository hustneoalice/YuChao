"""各数据类别的更新周期与新鲜度判定（体检 / 数据内容展示共用）。

不同数据不是同一把尺子：
- 日更表（行情/资金/估值/板块）：按交易日链位判定，滞后交易日数决定分数。
- 财务报表：按报告期披露节奏（季报、半年报、三季报、年报）判定，而不是
  拿库里的报告期日期和今天直接相减（那会把「三季报」误读成滞后 37 天）。
- 复权因子：周六增量任务，先查 update_log 本周是否真的跑过（成功/跳过/失败），
  没有账本记录时才回退到「上次除权日」的自然日差，避免把「本周无新增除权」
  误报成「滞后 14 天」。
- 证券清单：常驻清单，没有日期维度，只按行数判定。

每个表返回统一结构：state(ok/warn/bad) / score / expected / lag_days /
badge / cycle / note，前端据此上色并说明更新周期。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

from ...updater.trading_calendar import is_trading_day

# 表 → 更新周期契约（col 为新鲜度参照的日期列；kind 为修复动作对应的任务）
CONTRACTS: dict[str, dict] = {
    "daily_ohlcv": {"kind": "kline_update", "mode": "daily",
                    "col": "date", "chain": (17, 0),
                    "cycle": "每个交易日 17:00 后补齐当日行情"},
    "capital_flow": {"kind": "capital_flow", "mode": "daily",
                     "col": "date", "chain": (16, 30),
                     "cycle": "每个交易日 16:30 后更新"},
    "daily_valuation": {"kind": "valuation", "mode": "daily",
                        "col": "date", "chain": (16, 20),
                        "cycle": "每个交易日 16:20 后更新"},
    "sector_index": {"kind": "sector_index", "mode": "daily",
                     "col": "trade_date", "chain": (15, 35),
                     "cycle": "每个交易日 15:35 后更新"},
    "financials": {"kind": "financials", "mode": "report",
                   "col": "report_date",
                   "cycle": "每季度披露（一季报 4/30、半年报 8/31、三季报 10/31、年报次年 4/30）"},
    "adjust_factor": {"kind": "adjust_factor", "mode": "weekly",
                      "col": "ex_date", "run_weekday": 5, "run_at": (9, 0),
                      "cycle": "每周六 09:00 增量一次"},
    "stock_universe": {"kind": "stock_universe", "mode": "resident",
                       "col": None,
                       "cycle": "常驻清单，新股会自动入池"},
}


def _as_date(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _prev_trading(d: date) -> date:
    d -= timedelta(days=1)
    while not is_trading_day(d):
        d -= timedelta(days=1)
    return d


def _expected_trading(now: datetime, chain: tuple[int, int]) -> date:
    """链位过点 60min 后预期当日，否则预期上一交易日。"""
    today = now.date()
    if not is_trading_day(today):
        return _prev_trading(today)
    due = now.replace(hour=chain[0], minute=chain[1], second=0, microsecond=0)
    return _prev_trading(today) if now <= due + timedelta(minutes=60) else today


def _trading_lag(latest: str | None, expected: date) -> int:
    """latest 落后 expected 几个交易日（latest 更新也算 0）。"""
    d = _as_date(latest)
    if d is None:
        return 99
    if d >= expected:
        return 0
    lag, cur = 0, expected
    while d < cur and lag < 60:
        cur = _prev_trading(cur)
        lag += 1
    return lag if d == cur else 99


def _next_quarter_end(d: date) -> date:
    for month, day in ((3, 31), (6, 30), (9, 30), (12, 31)):
        cur = date(d.year, month, day)
        if cur > d:
            return cur
    return date(d.year + 1, 3, 31)


def _expected_report(now: datetime) -> date:
    """最近一个已过法定披露截止日的报告期末。"""
    y = now.date().year
    periods: list[tuple[date, date]] = [
        (date(y - 1, 12, 31), date(y, 4, 30)),
        (date(y, 3, 31), date(y, 4, 30)),
        (date(y, 6, 30), date(y, 8, 31)),
        (date(y, 9, 30), date(y, 10, 31)),
        (date(y, 12, 31), date(y + 1, 4, 30)),
    ]
    due = [p for p, deadline in periods if deadline <= now.date()]
    return max(due)


def _report_behind(latest: date | None, expected: date) -> int:
    if latest is None:
        return 99
    if latest >= expected:
        return 0
    n, cur = 0, latest
    while cur < expected and n < 12:
        cur = _next_quarter_end(cur)
        n += 1
    return n


def _expected_weekly_run(now: datetime, weekday: int, at: tuple[int, int]) -> date:
    """最近一个应跑（已到点）的周更日；当天未到点则算上一周。"""
    d = now.date()
    while d.weekday() != weekday:
        d -= timedelta(days=1)
    due = datetime.combine(d, datetime.min.time()).replace(
        hour=at[0], minute=at[1])
    if now < due:
        d -= timedelta(days=7)
    return d


def _weekly_ledger(conn, run: date) -> tuple[str | None, str]:
    """查本周（run 当天 0 点起）最近一条复权因子落账：status, detail。"""
    try:
        row = conn.execute(
            "SELECT status, detail, error FROM update_log "
            "WHERE data_type = 'adjust_factor' AND created_at >= ? "
            "ORDER BY created_at DESC LIMIT 1",
            [f"{run} 00:00:00"]).fetchone()
    except Exception:
        return None, ""
    if not row:
        return None, ""
    detail = str(row[1] or row[2] or "")
    return str(row[0]), detail


def _daily(conn, table: str, spec: dict, latest: str | None,
           now: datetime) -> dict:
    expected = _expected_trading(now, spec["chain"])
    lag = _trading_lag(latest, expected)
    score = 100 if lag == 0 else (70 if lag == 1 else (40 if lag <= 3 else 0))
    state = "ok" if score >= 100 else ("warn" if score >= 40 else "bad")
    if lag == 0:
        badge = "最新"
        note = f"已更新到 {latest or expected}，符合更新周期"
    elif lag >= 99:
        badge = "无数据"
        note = f"库里没有{spec['cycle']}的数据"
    else:
        badge = f"落后 {lag} 个交易日"
        note = f"最新 {latest}，预期 {expected}，落后 {lag} 个交易日"
    return {"score": score, "state": state, "badge": badge, "note": note,
            "expected": str(expected), "lag_days": lag}


_REPORT_NAME = {(3, 31): "一季报", (6, 30): "半年报",
                (9, 30): "三季报", (12, 31): "年报"}
_REPORT_DUE = {(3, 31): "4/30", (6, 30): "8/31", (9, 30): "10/31", (12, 31): "次年 4/30"}


def _report_label(d: date | None) -> tuple[str, str]:
    """报告期末 → (中文名, 法定披露截止)，例如 2026-09-30 → (三季报, 10/31)。"""
    key = (d.month, d.day) if d else (0, 0)
    return _REPORT_NAME.get(key, "财报"), _REPORT_DUE.get(key, "按季")


def _report(conn, table: str, spec: dict, latest: str | None,
            now: datetime) -> dict:
    expected = _expected_report(now)
    behind = _report_behind(_as_date(latest), expected)
    score = 100 if behind == 0 else (60 if behind == 1 else 20)
    state = "ok" if score >= 100 else ("warn" if score >= 60 else "bad")
    if behind == 0:
        name, due = _report_label(_as_date(latest))
        badge = f"{name} · 最新"      # 「45 天前」是报告期末到今天，不是数据滞后
        note = (f"最新报告期 {latest}（{name}），法定披露截止 {due}；"
                f"最近应披露报告期 {expected} 已在库，披露节奏正常")
    elif behind >= 99:
        badge = "无数据"
        note = f"库里没有财报数据，最近应披露报告期为 {expected}"
    else:
        badge = f"落后 {behind} 个报告期"
        note = (f"最新报告期 {latest}，预期最近应披露 {expected}，"
                f"落后 {behind} 个报告期")
    return {"score": score, "state": state, "badge": badge, "note": note,
            "expected": str(expected), "lag_days": behind}


def _weekly(conn, table: str, spec: dict, latest: str | None,
            now: datetime) -> dict:
    run = _expected_weekly_run(now, spec["run_weekday"], spec["run_at"])
    status, detail = _weekly_ledger(conn, run)
    if status:
        if status in ("success", "completed"):
            score, state, badge = 100, "ok", "本周已增量"
            note = detail or f"本周（{run}）复权因子任务已完成"
        elif status == "skipped":
            reason = detail or "数据源不可用"
            score, state, badge = 60, "warn", "本周跳过"
            note = f"本周（{run}）更新跳过：{reason}"
        elif status in ("queued", "running"):
            score, state, badge = 100, "ok", "正在更新"
            note = f"本周（{run}）复权因子任务正在执行"
        else:
            score, state, badge = 20, "bad", "本周失败"
            note = f"本周（{run}）更新{('失败：' + detail) if detail else '失败'}"
        return {"score": score, "state": state, "badge": badge, "note": note,
                "expected": str(run), "lag_days": 0}

    # 没有本周落账：只能按「上次除权日」判断是否属于正常无新增
    d = _as_date(latest)
    days = 99 if d is None else max(0, (now.date() - d).days)
    if days <= 8:
        score, state, badge = 100, "ok", "本周无新增除权"
        note = f"本周（{run}）未发现新增除权，上次除权日 {latest}"
    elif days <= 15:
        score, state, badge = 60, "warn", f"距上次除权 {days} 天"
        note = f"上次除权日 {latest}，距今天 {days} 天，本周任务无落账"
    else:
        score, state, badge = 20, "bad", f"距上次除权 {days} 天"
        note = f"上次除权日 {latest or '无'}，距今天 {days} 天，本周任务无落账"
    return {"score": score, "state": state, "badge": badge, "note": note,
            "expected": str(run), "lag_days": days}


def _resident(conn, table: str, spec: dict, latest: str | None,
              rows: int, now: datetime) -> dict:
    if rows > 0:
        return {"score": 100, "state": "ok", "badge": "常驻清单",
                "note": f"全市场证券底册，共 {rows} 只（代码 / 名称 / 行业 / 上市状态）；"
                        f"筛选、板块成分、选股与搜索都以它为范围，新股上市自动入池",
                "expected": None, "lag_days": 0}
    return {"score": 0, "state": "bad", "badge": "清单为空",
            "note": "证券清单为空，无法确定全市场范围",
            "expected": None, "lag_days": 0}


def assess_table(conn, table: str, latest: str | None, rows: int,
                 now: datetime | None = None) -> dict:
    """按表的数据特性判定新鲜度，返回统一结构（未知表按常驻表兜底）。"""
    now = now or datetime.now()
    spec = CONTRACTS.get(table)
    if spec is None:
        return {"table": table, "kind": None, "latest": latest, "rows": rows,
                "expected": None, "lag_days": 0, "score": 100, "state": "ok",
                "badge": "", "cycle": "", "note": "", "mode": "resident"}
    mode = spec["mode"]
    if mode == "daily":
        res = _daily(conn, table, spec, latest, now)
    elif mode == "report":
        res = _report(conn, table, spec, latest, now)
    elif mode == "weekly":
        res = _weekly(conn, table, spec, latest, now)
    else:
        res = _resident(conn, table, spec, latest, rows, now)
    return {"table": table, "kind": spec.get("kind"), "latest": latest,
            "rows": rows, "mode": mode, "cycle": spec["cycle"], **res}
