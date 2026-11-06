"""计算前置守卫：数据不新就不算，避免把旧日线榜单当成实时结果。

A 股日线在收盘后入库，盘中只能拿到上一交易日，因此允许落后 1 个交易日；
超过 1 个交易日即视为数据断更，直接拒绝计算并说明落后天数。

参照「最近一个应当已收盘的交易日」（expected_asof，含法定节假日），
而不是 simple 工作日差；同时校验快照：更新内核整体停掉时，日线与快照会
一起停在同一天，只比两者的差值会误判成「最新」。
"""
from datetime import date, timedelta
from typing import Optional

# 各计算链路依赖的数据表与其日期列
SOURCES = {
    "ohlcv": ("daily_ohlcv", "date", "日线"),
    "flow": ("capital_flow", "date", "资金"),
}
MAX_LAG = 1


def _trading_lag(start: date, end: date) -> int:
    """start 之后到 end（含）之间的交易日数；end <= start 记为 0。

    holidays 未安装时退回周末口径（法定节假日会多算，偏保守）。
    """
    try:
        from ...updater.trading_calendar import is_trading_day
    except Exception:                        # noqa: BLE001 日历不可用时不阻断计算
        is_trading_day = lambda d: d.weekday() < 5  # noqa: E731

    n, d = 0, start + timedelta(days=1)
    while d <= end:
        if is_trading_day(d):
            n += 1
        d += timedelta(days=1)
    return n


def _as_date(value) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def fresh_gate(conn, kind: str = "ohlcv") -> dict:
    """返回 {ok, data_date, as_of, lag, message}；lag 为落后交易日数。

    ok=False 时上层必须拒绝计算，并把 message 原样暴露给前端。
    """
    table, col, name = SOURCES[kind]
    data_date = _as_date(conn.execute(
        f"SELECT MAX(CAST({col} AS DATE)) FROM {table}").fetchone()[0])
    as_of = _as_date(conn.execute(
        "SELECT MAX(trade_date) FROM market_snapshot").fetchone()[0])
    if data_date is None or as_of is None:
        return dict(ok=False, data_date=str(data_date or ""),
                    as_of=str(as_of or ""), lag=None,
                    message=f"缺少{name}或快照数据，无法计算")

    try:
        from ...updater.util import expected_asof, now_cst
        ref = _as_date(expected_asof(now_cst()))
    except Exception:                        # noqa: BLE001 日历不可用时以快照日为参照
        ref = None
    ref = ref or as_of

    lag = _trading_lag(data_date, ref)
    snap_lag = _trading_lag(as_of, ref)
    ok = lag <= MAX_LAG and snap_lag <= MAX_LAG
    message = ""
    if lag > MAX_LAG:
        message = (f"{name}数据停在 {data_date}，落后 {lag} 个交易日；"
                   f"请先更新数据，本榜暂不计算")
    elif snap_lag > MAX_LAG:
        message = (f"行情快照停在 {as_of}，落后 {snap_lag} 个交易日；"
                   f"请先更新数据，本榜暂不计算")
    return dict(ok=ok, data_date=str(data_date), as_of=str(as_of),
                lag=lag, message=message)
