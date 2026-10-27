"""核心标端点：GET /corepicks · /corepicks/{symbol}/factors。

名单公开、明细收费：factors 端点经 require_vip（服务端脱敏，未授权不返回
数据）；打分实现属闭源包（open-core），本仓库只读打分结果。
"""
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import TypeAdapter

from ...auth.deps import current_user, require_vip, resolve_token
from ...contracts.common import Pool
from ...contracts.corepicks import Corepick, CorepickFactors
from ...foundation import repo
from ...foundation.db import get_conn

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
            summary="三因子明细（VIP：tier 实时校验，未授权 403 不返回数据）")
def corepick_factors(
    symbol: str,
    date: Optional[str] = None,
    pool: Pool = Query(default=Pool.chase),
    token: str | None = Depends(resolve_token),
):
    require_vip(current_user(token))
    conn = get_conn()
    data = repo.corepicks.get_factors(conn, symbol, date, pool.value)
    return TypeAdapter(CorepickFactors).validate_python(data)
