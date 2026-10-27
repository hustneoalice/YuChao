"""板块端点：GET /sectors · /sectors/{id}/members。"""
from typing import Optional

from fastapi import APIRouter, Depends, Query

from ...contracts.common import SectorType
from ...contracts.sectors import SectorMember, SectorSummary
from ...errors import not_found
from ...foundation import repo
from ...foundation.db import get_conn
from pydantic import TypeAdapter

router = APIRouter(tags=["sectors"])


@router.get("/sectors", response_model=list[SectorSummary], summary="板块列表（当日涨跌排序）")
def list_sectors(
    type: SectorType = Query(default=SectorType.industry),
    limit: int = Query(default=100, ge=1, le=500),
    conn=Depends(get_conn),
):
    data = repo.sectors.list_sectors(conn, type.value, limit)
    return TypeAdapter(list[SectorSummary]).validate_python(data["items"])


@router.get("/sectors/{sector_id}/members",
            response_model=list[SectorMember], summary="成分股（窗口成交额加权涨幅排序）")
def sector_members(
    sector_id: str,
    lookback: int = Query(default=5, description="回看交易日数：5|10|20"),
    limit: int = Query(default=100, ge=1, le=500),
    conn=Depends(get_conn),
):
    if lookback not in (5, 10, 20):
        raise not_found("lookback 仅支持 5|10|20", {"lookback": lookback})
    meta = repo.sectors.get_sector_meta(conn, sector_id)
    if meta is None:
        raise not_found(f"板块不存在：{sector_id}", {"sector_id": sector_id})
    data = repo.sectors.sector_members(conn, sector_id, lookback, limit)
    return TypeAdapter(list[SectorMember]).validate_python(data["items"])
