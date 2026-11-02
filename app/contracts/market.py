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
    rt_date: Optional[str] = None          # 行情归属日（腾讯 p[30]）：盘前/周末为上一交易日
    rt_live: Optional[bool] = None         # 今日是否已有真实成交（盘前 qdate 已切今天但 open=0 → False）
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
    """目标页扫描行（策影目标页同源口径）：指标层 + 四条件布尔。

    条件：40日均量（当日量 ≥ 40日均量）、短线趋势橙（收盘 > MA10，K 线通道
    填橙同一判定）、中线趋势橙（收盘 > MA45）、近 20 个交易日有涨停
    （主板 10% / 创业科创 20% 阈值口径）。
    ST 股票服务端直接剔除；北交所受 bj_enabled 开关控制。"""

    symbol: str
    name: Optional[str] = None
    close: Optional[float] = None
    pct_chg: Optional[float] = Field(default=None, description="当日涨跌幅%")
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

    trend_value: Optional[float] = None
    trend_cross_date: Optional[str] = None
    trend_cross_ago: Optional[int] = None
    trend_above_days: int = 0
    trend_data_date: str = ""
    trend_provisional: bool = False


class TargetCondItem(BaseModel):
    """可选条件元数据（GET /market/targets/conditions，前端条件栏据此渲染）。

    kind：flag 布尔条件 / value 数值阈值条件 / trend 复合条件（趋势柱线参数）。
    新增条件只需在 screening.CONDITIONS 登记，前端自动出现。"""

    key: str
    label: str
    kind: str = Field(description="flag | value | trend")
    default: Optional[float] = None
    min: Optional[float] = None
    max: Optional[float] = None
    step: Optional[float] = None
    unit: str = ""
    op: Optional[str] = Field(default=None, description="value 条件的比较方向：>= | <=")
    default_on: bool = Field(default=True, description="条件栏初始是否勾选")
    title: str = ""


class TargetScanOut(BaseModel):
    scanned: int = Field(description="实际进入判定的标的数（ST/北交剔除后）")
    total_hits: int = Field(description="命中当前勾选条件的总数")
    as_of: str = Field(default="", description="数据截至（今日 K 线未落库时取实时快照日）")
    provisional: bool = Field(default=False, description="是否拼入今日实时快照（K 线未落库）")
    values: dict[str, float] = Field(default_factory=dict, description="本次生效的数值条件阈值")
    items: list[TargetItem] = Field(default_factory=list, description="命中列表（强势段在前，截断至 limit）")


class BoardRow(BaseModel):
    """全景大表行（2.2，market_snapshot 快照口径；ST 已在采集侧不排除——
    全景需要全市场口径，ST 过滤只在目标页做）。"""
    symbol: str
    name: Optional[str] = None
    current: Optional[float] = None
    change_amount: Optional[float] = None
    change_rate: Optional[float] = None
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    pre_close: Optional[float] = None
    volume: Optional[float] = None          # 手
    amount: Optional[float] = None          # 元
    turnover_rate: Optional[float] = None
    vol_ratio: Optional[float] = None
    amplitude: Optional[float] = None
    bid1: Optional[float] = None
    bid1_vol: Optional[float] = None
    ask1: Optional[float] = None
    ask1_vol: Optional[float] = None
    outer_vol: Optional[float] = None
    inner_vol: Optional[float] = None
    market_value: Optional[float] = None    # 元
    circ_value: Optional[float] = None      # 元
    up_limit: Optional[float] = None
    down_limit: Optional[float] = None
    updated_at: Optional[str] = None


class BoardOut(BaseModel):
    items: list[BoardRow] = Field(default_factory=list)
    total: int = 0
    tab: str = "hsa"
    as_of: str = Field(default="", description="快照交易日")


class IndexBarItem(BaseModel):
    symbol: str
    name: str
    current: Optional[float] = None
    change_amount: Optional[float] = None
    change_rate: Optional[float] = None
    amount: Optional[float] = None


class BreadthOut(BaseModel):
    up: int = 0
    down: int = 0
    flat: int = 0
    limit_up: int = 0
    limit_down: int = 0
    amount: float = 0.0
    updated_at: Optional[str] = None


class ZyBlockRow(BaseModel):
    """众赢板块行（清单 × 当日快照聚合；无成分/无快照时行情字段 NULL）。"""
    block_code: str
    block_name: str
    type_code: int                          # 1 地域 / 2 概念 / 4 行业 / 8 风格 / 9 题材
    parent_code: Optional[str] = None
    members: int = 0                        # 有当日快照的成分数
    up_count: int = 0
    down_count: int = 0
    flat_count: int = 0
    avg_change: Optional[float] = None      # 成分涨跌幅平均 %
    amount: Optional[float] = None          # 成分合计成交额（元）
    leader: Optional[str] = None            # 领涨股
    leader_change: Optional[float] = None


class ZyBlocksOut(BaseModel):
    items: list[ZyBlockRow] = Field(default_factory=list)
    total: int = 0
    type_code: int = 2
    as_of: str = Field(default="", description="快照交易日")


class ZyBlockMembersOut(BaseModel):
    items: list[BoardRow] = Field(default_factory=list)
    total: int = 0
    block_code: str = ""
    block_name: str = ""
    as_of: str = ""
