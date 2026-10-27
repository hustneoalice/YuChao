"""核心标端点：GET /corepicks · /corepicks/{symbol}/factors。"""
from typing import Optional

from fastapi import APIRouter, Depends, Query

from ...contracts.common import Pool
from ...contracts.corepicks import Corepick, CorepickFactors
from ...errors import vip_required
from ...foundation import repo
from ...foundation.db import get_conn
from pydantic import TypeAdapter

router = APIRouter(tags=["corepicks"])


@router.get("/corepicks", response_model=list[Corepick], summary="核心标名单（公开）")
def list_corepicks(
    date: Optional[str] = Query(default=None, description="结果日，缺省取最新"),
    pool: Optional[Pool] = Query(default=None, description="chase 追涨 / dip 低吸"),
    limit: int = Query(default=100, ge=1, le=500),
    conn=Depends(get_conn),
):
    data = repo.corepicks.list_corepicks(conn, date, pool.value if pool else None, limit)
    return TypeAdapter(list[Corepick]).validate_python(data["items"])


@router.get("/corepicks/{symbol}/factors",
            response_model=CorepickFactors,
            summary="三因子明细（VIP 校验后返回；M1 未授权一律 403）")
def corepick_factors(
    symbol: str,
    date: Optional[str] = None,
    pool: Pool = Query(default=Pool.chase),
):
    # 名单公开、明细收费：未授权不返回数据（设计承诺；license 中间件属 M2，
    # 授权后改走 repo.corepicks.get_factors(conn, symbol, date, pool.value)）
    raise vip_required("VIP 通道未授权：三因子明细不返回（M1 桩）")
