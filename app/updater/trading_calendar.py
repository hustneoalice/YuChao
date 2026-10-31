"""交易日历：周末 + 法定节假日（holidays 包可选，缺失退回周末口径）。

1.0 教训（2026-09-25 中秋实测）：节假日整天休市，东财 clist 返回的仍是
上一交易日的稳定状态——不剔节假日会给快照盖上幽灵日期。
"""
from __future__ import annotations

from datetime import date, datetime, timedelta

try:
    import holidays as _holidays

    _CN = _holidays.China()  # 懒填充，按年缓存
except Exception:            # holidays 未安装
    _CN = None


def is_trading_day(d: date | datetime) -> bool:
    d = d.date() if isinstance(d, datetime) else d
    if d.weekday() >= 5:
        return False
    if _CN is not None and d in _CN:
        return False
    return True


def last_trading_day(d: date | datetime) -> date:
    """d（含）往前最近的交易日。"""
    d = d.date() if isinstance(d, datetime) else d
    d = d - timedelta(days=1)
    while not is_trading_day(d):
        d = d - timedelta(days=1)
    return d


def calendar_health() -> dict:
    """holidays 包覆盖自检（超越策影：包过期/未装不再无感知）。

    is_trading_day 对未知年份 fail-open（当交易日）——包数据停在去年时，
    明年节假日全被当成交易日，中秋幽灵日期教训的根源就在这。audit 消费
    本函数把「日历本身不新鲜」变成显式报警，而不是等幽灵数据写进来。
    status: ok（覆盖今年+明年）| degraded（未装，周末口径）| stale（覆盖不全）。
    """
    if _CN is None:
        return {"status": "degraded",
                "detail": "holidays 未安装，退回周末口径（法定节假日会被当成交易日）"}
    try:
        years = {d.year for d in _CN.keys() if hasattr(d, "year")}
    except Exception:
        years = set()
    if not years:
        return {"status": "stale", "detail": "holidays 数据为空（包异常？）"}
    this = date.today().year
    missing = [y for y in (this, this + 1) if y not in years]
    if missing:
        return {"status": "stale",
                "detail": f"holidays 数据未覆盖 {'/'.join(map(str, missing))} 年"
                          "（包过旧？pip install -U holidays），缺数年份的"
                          "法定节假日会被当成交易日"}
    return {"status": "ok",
            "detail": f"holidays 覆盖 {min(years)}-{max(years)} 年"}
