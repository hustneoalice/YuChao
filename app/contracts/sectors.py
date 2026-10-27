"""板块契约：板块指数列表 + 成分股按成交额加权涨幅排序。"""
from typing import Optional

from pydantic import BaseModel


class SectorSummary(BaseModel):
    """sector_index 最新交易日一行（1.0 字段原样；id 即板块名）。"""

    id: str
    name: str
    type: str = "industry"
    trade_date: str
    close: Optional[float] = None
    pct_change: Optional[float] = None
    up_count: Optional[int] = None
    down_count: Optional[int] = None
    leader: Optional[str] = None
    leader_change: Optional[float] = None


class SectorMember(BaseModel):
    """成分股：窗口内成交额加权涨幅（口径 PRD：sum(amount×pct_chg)/sum(amount)）。"""

    symbol: str
    name: Optional[str] = None
    last_date: Optional[str] = None
    last_close: Optional[float] = None
    lookback_pct: Optional[float] = None
    main_net: Optional[float] = None
