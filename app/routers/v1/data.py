"""数据底座端点：GET /data/status · POST /data/update|init|export（M2 桩）。"""
from fastapi import APIRouter, Depends

from ...contracts.data import DataStatus
from ...config import settings
from ...errors import not_implemented
from ...foundation import repo
from ...foundation.db import get_conn
from pydantic import TypeAdapter

router = APIRouter(tags=["data"])


@router.get("/data/status", response_model=DataStatus, summary="底座状态（表清单体检）")
def status(conn=Depends(get_conn)):
    return TypeAdapter(DataStatus).validate_python(repo.data.get_status(conn, settings.duckdb_path))


@router.post("/data/update", summary="触发增量更新（updater 进程职责，M2）")
def update():
    raise not_implemented("M1 为只读 API 进程；更新编排器（updater）属 M2")


@router.post("/data/init", summary="初始化/导入初始数据包（M2）")
def init():
    raise not_implemented("初始数据包导入（import|backfill）属 M2")


@router.post("/data/export", summary="导出离线数据包（P1 · F14，M2）")
def export():
    raise not_implemented("离线数据包导出属 M2")
