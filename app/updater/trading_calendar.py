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
