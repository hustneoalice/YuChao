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
    live: Optional[bool] = Field(
        default=None, description="盘中实时合并的「今日未收盘 bar」标记（非库内落库数据）"
    )
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


class FundFlowTotals(BaseModel):
    """区间资金流合计（框选统计用：区间内逐日 capital_flow 求和）。"""

    net_main: Optional[float] = None
    net_super: Optional[float] = None
    net_large: Optional[float] = None
    net_medium: Optional[float] = None
    net_small: Optional[float] = None


class FundFlowRange(BaseModel):
    """区间资金流明细 + 合计（K 线框选统计同步右列资金卡）。

    available=False 表示该标的本身没有个股资金流（指数），items 为空、
    note 说明原因 —— 前端据此降级为「仅成交额」口径，不当作错误。
    """

    symbol: str
    start: Optional[str] = None
    end: Optional[str] = None
    items: list[CapitalFlowDay] = []
    totals: Optional[FundFlowTotals] = None
    covered: int = Field(default=0, description="区间内有资金流数据的天数")
    available: bool = True
    note: Optional[str] = None


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
    # 盘中实时兜底（东财 push2 快照，非盘中/拉取失败时为 None，价格仍为日线收盘）
    rt_price: Optional[float] = None
    rt_time: Optional[str] = None          # "YYYY-MM-DD HH:MM" 快照时间（东财 f86）
    rt_prev_close: Optional[float] = None  # 东财昨收：实时涨跌额的跨源基准


class QuotesOut(BaseModel):
    """批量快照（自选股卡片等 N 只一次渲染）：items 顺序与入参一致，
    missing 为任何表都查不到的入参（含归一后形式）。"""

    items: list[Quote]
    missing: list[str] = []


class SearchHit(BaseModel):
    symbol: str
    name: Optional[str] = None
    market: Optional[str] = None
    industry: Optional[str] = None
    status: Optional[str] = None


class TargetItem(BaseModel):
    """自选目标视图（策影目标页同源口径）：四条件 + 六分段 + 回调。

    条件：40日均量（当日量 ≥ 40日均量）、短线趋势橙（收盘 > MA10，K 线通道
    填橙同一判定）、中线趋势橙（收盘 > MA45）、近 20 个交易日有涨停
    （主板 10% / 创业科创 20% / 北交所 30% 阈值口径）。
    ST 股票服务端直接剔除；北交所受 bj_enabled 开关控制。"""

    symbol: str
    name: Optional[str] = None
    close: Optional[float] = None
    vol: Optional[float] = None
    vol_ma40: Optional[float] = Field(default=None, description="40日均量")
    vol_ratio: Optional[float] = Field(default=None, description="当日量 / 40日均量")
    vol_hit: bool = Field(default=False, description="条件①：当日量 ≥ 40日均量")
    short_orange: bool = Field(default=False, description="条件②：收盘 > MA10（短线趋势橙）")
    mid_orange: bool = Field(default=False, description="条件③：收盘 > MA45（中线趋势橙）")
    limit_up_20d: bool = Field(default=False, description="条件④：近 20 个交易日有涨停")
    limit_up_cnt: int = Field(default=0, description="近 20 个交易日涨停次数")
    seg: int = Field(default=0, description="六分段 1..6（60 日窗口收盘分位）")
    seg_name: str = Field(default="", description="六分段名：超卖/低位/弱势/回升/强势/超买")
    pullback: bool = Field(default=False, description="回调中：收盘跌破 MA7 快线")
