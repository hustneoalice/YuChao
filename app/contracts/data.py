"""数据底座契约：状态机 未初始化→初始化中→已就绪→更新中→更新失败。"""
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field


class TableStatus(BaseModel):
    table: str
    rows: Optional[int] = None
    latest_date: Optional[str] = None
    earliest_date: Optional[str] = None  # 数据起始日（前端展示数据范围年限）
    coverage: Optional[float] = None  # 0-100，最新截面覆盖的标的数 / 全市场证券数
    # 按数据类别自带的更新周期判定（日更 / 季度 / 周更 / 常驻），前端据此上色与说明
    cycle: Optional[str] = None
    expected: Optional[str] = None
    fresh: Optional[str] = None          # ok | warn | bad
    fresh_badge: Optional[str] = None    # 「最新」「符合季度周期」「常驻清单」…
    fresh_note: Optional[str] = None     # 一句话说明（悬停可见）


class DataStatus(BaseModel):
    stage: str  # uninitialized | initializing | ready | updating | update_failed
    duckdb_path: str
    tables: List[TableStatus] = []
    # 是否是交易日（周末/法定节假日为 False）；前端据此避免休市时显示「盘中行情」
    trading_day: bool = True
    generated_at: datetime = Field(default_factory=datetime.now)
