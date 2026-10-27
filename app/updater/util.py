"""updater 工具：北京时间与「应有交易日」口径（自 1.0 data_update_manager 移植）。

expected_asof 给出独立于库内 MAX(date) 的目标日：全库一起停滞时（源站挂了几天），
只看 MAX(date) 会把增量误判成「全都最新」，永远追不上。宁可多试一天——
数据源只返回真实交易日，多拉一天不会写脏数据，少试却停滞自愈不了。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))


def now_cst() -> datetime:
    """北京时间 now。「15:10 收盘」是北京语义，用 UTC 算会整整错 8 小时
    （1.0 容器 UTC 教训）。"""
    return datetime.now(CST)


def expected_asof(now: datetime | None = None) -> str:
    """最近一个应当已收盘的交易日（ISO 日期）。

    · 周末 / 法定节假日（holidays 包可用时）→ 上一交易日；
    · 交易日 15:10 前（未收盘）→ 上一交易日；
    · 法定节假日识别依赖 holidays 包，缺失时退回纯周末口径。
    """
    now = now or now_cst()
    try:
        from .trading_calendar import is_trading_day, last_trading_day

        if not is_trading_day(now):
            return last_trading_day(now).isoformat()
        if (now.hour, now.minute) < (15, 10):
            return last_trading_day(now).isoformat()
        return now.date().isoformat()
    except ImportError:
        pass
    # 旧口径（holidays 缺失）：按工作日回退，不识别法定节假日
    d = now.date()
    if d.weekday() < 5 and (now.hour, now.minute) < (15, 10):
        d = d - timedelta(days=1)
    while d.weekday() >= 5:
        d = d - timedelta(days=1)
    return d.isoformat()
