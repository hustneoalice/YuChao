"""行情契约：K 线 / 快照 / 搜索。字段名与 1.0 存储逐字段兼容。"""
from typing import Literal, Optional

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
        default=None, description="with=indicator 时的标准指标（均线、BOLL 等）"
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
    concept: Optional[str] = None          # 概念标签（东财 F10 所属板块，逗号分隔）
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


class DepthLevel(BaseModel):
    """盘口单档：价格 + 委托量。volume 单位为手（腾讯原始口径）。"""

    price: float
    volume: int
    amount: Optional[float] = Field(default=None, description="该档委托金额（元，price*volume*100）")


class Depth(BaseModel):
    """五档盘口（腾讯 qt 实时，3s 缓存）。applicable=False 表示无盘口（指数/停牌/外盘）。"""

    symbol: str
    name: Optional[str] = None
    applicable: bool = False
    time: Optional[str] = None              # "HH:MM:SS"（腾讯行情时间）
    price: Optional[float] = None
    prev_close: Optional[float] = None
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    chg: Optional[float] = None
    pct: Optional[float] = None
    avg_price: Optional[float] = None
    limit_up: Optional[float] = None
    limit_down: Optional[float] = None
    bids: list[DepthLevel] = []
    asks: list[DepthLevel] = []
    bid_total: int = 0                     # 五档委买合计（手）
    ask_total: int = 0                     # 五档委卖合计（手）
    bid_ask_diff: int = 0                  # 委差（手）
    bid_ask_ratio: Optional[float] = None  # 委比（%）
    outer_vol: Optional[int] = None        # 外盘（手）
    inner_vol: Optional[int] = None        # 内盘（手）
    volume: Optional[int] = None           # 当日成交量（股）
    amount: Optional[float] = None         # 当日成交额（元）
    turnover_rate: Optional[float] = None
    vol_ratio: Optional[float] = None
    amplitude: Optional[float] = None
    margin: Optional[bool] = Field(default=None, description="是否两融标的（支持融资买入）；None=未知")


class TradeItem(BaseModel):
    """逐笔成交：time=HH:MM:SS，volume=手，direction=1 买 / 2 卖 / 其他中性。"""

    time: str
    price: float
    volume: int
    direction: Optional[int] = None


class Trades(BaseModel):
    symbol: str
    items: list[TradeItem] = []


class SearchHit(BaseModel):
    symbol: str
    name: Optional[str] = None
    market: Optional[str] = None
    industry: Optional[str] = None
    status: Optional[str] = None
    kind: str = Field(default="stock", description="stock | fund | index | sector")
    sub: Optional[str] = Field(default=None, description="板块子类：industry | concept")


class TargetItem(BaseModel):
    """目标页扫描行（策影目标页同源口径）：指标层 + 四条件布尔。

    条件：均量（当日量 ≥ 均量）、短线趋势橙（收盘站上短线趋势线，K 线通道
    填橙同一判定）、中线趋势橙（收盘站上中线趋势线）、近 20 个交易日有涨停
    （主板 10% / 创业科创 20% 阈值口径）。
    ST 股票服务端直接剔除；北交所受 bj_enabled 开关控制。"""

    symbol: str
    name: Optional[str] = None
    close: Optional[float] = None
    pct_chg: Optional[float] = Field(default=None, description="当日涨跌幅%")
    vol_ma40: Optional[float] = Field(default=None, description="均量")
    vol_ratio: Optional[float] = Field(default=None, description="当日量 / 均量")
    vol_hit: bool = Field(default=False, description="条件①：当日量 ≥ 均量")
    short_orange: bool = Field(default=False, description="条件②：收盘站上短线趋势线")
    mid_orange: bool = Field(default=False, description="条件③：收盘站上中线趋势线")
    limit_up_20d: bool = Field(default=False, description="条件④：近 20 个交易日有涨停")
    limit_up_cnt: int = Field(default=0, description="近 20 个交易日涨停次数")
    seg: int = Field(default=0, description="六分段 1..6（趋势线六位置：超跌/反弹/突破/超涨/回踩/跌破）")
    seg_name: str = Field(default="", description="六分段名：超跌/反弹/突破/超涨/回踩/跌破")
    pullback: bool = Field(default=False, description="回调中：收盘跌破短线快线")

    trend_value: Optional[float] = None
    trend_cross_date: Optional[str] = None
    trend_cross_ago: Optional[int] = None
    trend_above_days: int = 0
    neg_run: int = Field(default=0, description="连续负柱收窄天数（绿柱缩短，提前捕捉上穿零轴）")
    neg_abs: Optional[float] = Field(default=None, description="当前负柱距零轴幅度 |STICKV|（正值时为 null）")
    money_date: Optional[str] = Field(default=None, description="最近一次钱袋子（阶段低点）日期")
    money_ago: Optional[int] = Field(default=None, description="钱袋距今交易日数（0=今日；null=近20日未出现）")
    money_cnt: int = Field(default=0, description="近 20 个交易日钱袋出现次数")
    mine_date: Optional[str] = Field(default=None, description="最近一次地雷（阶段高点回落）日期")
    mine_ago: Optional[int] = Field(default=None, description="地雷距今交易日数（0=今日；null=近20日未出现）")
    mine_cnt: int = Field(default=0, description="近 20 个交易日地雷出现次数")
    trend_data_date: str = ""
    trend_provisional: bool = False
    tail_provisional: bool = Field(default=False, description="该行钱袋/地雷来自尾盘估算（收盘前可能变化）")


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
    computed_at: str = Field(default="", description="本次结果的计算时间（YYYY-MM-DD HH:MM）")
    provisional: bool = Field(default=False, description="是否拼入今日实时快照（K 线未落库）")
    values: dict[str, float] = Field(default_factory=dict, description="本次生效的数值条件阈值")
    stale: bool = Field(default=False, description="日线落后快照日超过 1 个交易日，本次未计算")
    data_date: str = Field(default="", description="实际使用的日线日期")
    lag: Optional[int] = Field(default=None, description="日线落后快照日的交易日数")
    message: str = Field(default="", description="不可计算的原因（stale 时非空）")
    tail_mode: bool = Field(default=False, description="是否已用尾盘估算覆盖钱袋/地雷")
    tail_at: str = Field(default="", description="尾盘估算所用快照时刻（HH:MM）")
    items: list[TargetItem] = Field(default_factory=list, description="命中列表（按六分段操作优先级排序，截断至 limit）")


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
    total_members: int = 0                  # 全部成分，与有行情数量分开
    children: int = 0
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


class ShareholderItem(BaseModel):
    rank: int
    name: str
    shares: Optional[int] = None
    ratio: Optional[float] = None  # 占总股本 %，不是占流通股比例
    change: Literal["进入", "加仓", "减仓", "不变", "无法比较"]
    share_change: Optional[int] = None
    ratio_change: Optional[float] = None  # 百分点
    is_social_security: bool = False


class ShareholdersOut(BaseModel):
    symbol: str
    report_dates: list[str] = Field(default_factory=list)
    report_date: Optional[str] = None
    previous_report_date: Optional[str] = None
    notice_date: Optional[str] = None
    total_ratio: Optional[float] = None
    ratio_change: Optional[float] = None
    items: list[ShareholderItem] = Field(default_factory=list)
    source: str = "东方财富 · 定期报告披露"
