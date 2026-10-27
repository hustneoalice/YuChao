"""核心标契约：名单公开；三因子明细属 VIP（M1 桩 403）。"""
from typing import Optional

from pydantic import BaseModel

from .common import Pool


class Corepick(BaseModel):
    date: str
    pool: Pool
    sector: Optional[str] = None
    symbol: str
    name: Optional[str] = None
    rank: Optional[int] = None
    fund_score: Optional[float] = None
    seg: Optional[str] = None


class CorepickFactors(Corepick):
    """三因子明细（factors_json 解析）——VIP 校验后返回，M1 未授权一律 403。"""

    factors: Optional[dict] = None
