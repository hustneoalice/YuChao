"""通用契约：枚举、错误体、分页信封。"""
from enum import Enum
from typing import Generic, List, Optional, TypeVar

from pydantic import BaseModel


class Adjust(str, Enum):
    """复权口径：qfq 看盘（默认）/ hfq 收益 / raw 原始价。"""

    qfq = "qfq"
    hfq = "hfq"
    raw = "raw"


class SectorType(str, Enum):
    industry = "industry"
    concept = "concept"


class Pool(str, Enum):
    """核心标池：chase 追涨 / dip 低吸。"""

    chase = "chase"
    dip = "dip"


class WithParam(str, Enum):
    """K 线附加通道：indicator 标准指标（开源）/ vip 闭源通道（需授权）。"""

    indicator = "indicator"
    vip = "vip"


class Error(BaseModel):
    """统一错误体：{code, message, detail?}。"""

    code: str
    message: str
    detail: Optional[object] = None


T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    """分页信封：{items, total, cursor?}。"""

    items: List[T]
    total: int
    cursor: Optional[str] = None
