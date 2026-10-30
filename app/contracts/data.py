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


class DataStatus(BaseModel):
    stage: str  # uninitialized | initializing | ready | updating | update_failed
    duckdb_path: str
    tables: List[TableStatus] = []
    generated_at: datetime = Field(default_factory=datetime.now)
