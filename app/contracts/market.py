"""行情契约：K 线 / 快照 / 搜索。字段名与 1.0 存储逐字段兼容。"""
from typing import Optional

from pydantic import BaseModel, Field

from .common import Adjust, WithParam


class Bar(BaseModel):
    date: str
    open: float
    high: float
    low: float
    close: float
    volume: Optional[float] = None
    amount: Optional[float] = None
    pct_chg: Optional[float] = None
    turnover_rate: Optional[float] = None
    indicators: Optional[dict[str, Optional[float]]] = Field(
        default=None, description="with=indicator 时的标准指标（MA5/7/10/20/35/45、std20、BOLL）"
    )


class Kline(BaseModel):
    symbol: str
    name: Optional[str] = None
    period: str = "day"
    adjust: Adjust
    with_param: Optional[WithParam] = Field(default=None, alias="with")
    bars: list[Bar]

    model_config = {"populate_by_name": True}


class Valuation(BaseModel):
    """daily_valuation 最新行（1.0 字段原样）。"""

    date: str
    pe_ttm: Optional[float] = None
    pb: Optional[float] = None
    ps_ttm: Optional[float] = None
    total_mv: Optional[float] = None
    circ_mv: Optional[float] = None


class CapitalFlowDay(BaseModel):
    """capital_flow 最新行（资金流唯一事实表，1.0 字段原样）。"""

    date: str
    net_main: Optional[float] = None
    net_super: Optional[float] = None
    net_large: Optional[float] = None
    net_medium: Optional[float] = None
    net_small: Optional[float] = None


class Quote(BaseModel):
    """个股快照：最新日线 + 估值 + 当日资金流 + 池内档案。"""

    symbol: str
    name: Optional[str] = None
    market: Optional[str] = None
    industry: Optional[str] = None
    status: Optional[str] = None
    date: Optional[str] = None
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    close: Optional[float] = None
    pct_chg: Optional[float] = None
    volume: Optional[float] = None
    amount: Optional[float] = None
    turnover_rate: Optional[float] = None
    valuation: Optional[Valuation] = None
    capital_flow: Optional[CapitalFlowDay] = None


class SearchHit(BaseModel):
    symbol: str
    name: Optional[str] = None
    market: Optional[str] = None
    industry: Optional[str] = None
    status: Optional[str] = None
