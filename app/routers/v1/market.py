"""行情端点：GET /market/kline · /market/quote · /market/search。"""
from typing import Optional

from fastapi import APIRouter, Depends, Query

from ...contracts.common import Adjust, Page, WithParam
from ...contracts.market import Kline, Quote, SearchHit
from ...errors import vip_required
from ...foundation import repo
from ...foundation.db import get_conn
from pydantic import TypeAdapter

router = APIRouter(tags=["market"])


@router.get("/market/kline", response_model=Kline, summary="K 线（复权在查询层派生）")
def kline(
    symbol: str = Query(description="6 位代码，兼容 sh.600519 / 600519.SH 形态"),
    adjust: Adjust = Query(default=Adjust.qfq, description="qfq 看盘 / hfq 收益 / raw 原始价"),
    with_param: Optional[WithParam] = Query(
        default=None, alias="with",
        description="indicator=标准指标（开源）；vip=闭源通道（未授权 403，不返回数据）",
    ),
    start: Optional[str] = Query(default=None, description="起始日期 YYYY-MM-DD"),
    end: Optional[str] = Query(default=None, description="结束日期 YYYY-MM-DD"),
    limit: int = Query(default=500, ge=1, le=5000),
    conn=Depends(get_conn),
):
    if with_param == WithParam.vip:
        raise vip_required("VIP 通道未授权：短线/中线操盘通道数据不返回（M1 桩）")
    data = repo.market.get_kline(conn, symbol, adjust, with_param.value if with_param else None,
                                 start, end, limit)
    return TypeAdapter(Kline).validate_python(data)


@router.get("/market/quote", response_model=Quote, summary="个股快照（最新日线+估值+资金流）")
def quote(symbol: str, conn=Depends(get_conn)):
    return repo.market.get_quote(conn, symbol)


@router.get("/market/search", response_model=Page[SearchHit], summary="代码/名称搜索")
def search(
    q: str = Query(min_length=1, max_length=20),
    limit: int = Query(default=10, ge=1, le=50),
    conn=Depends(get_conn),
):
    hits = repo.market.search(conn, q, limit)
    return Page(items=[SearchHit(**h) for h in hits], total=len(hits))
