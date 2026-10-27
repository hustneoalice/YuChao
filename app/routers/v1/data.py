"""数据底座端点：status · tasks · update 触发 · updates 落账 · init/export(M3)。

进程模型：本进程对 DuckDB 只读。POST /data/update 不直接写库——落一行
控制请求到 data/control_requests.jsonl，由 updater 进程（唯一写者）轮询消费。
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from pydantic import TypeAdapter

from ...contracts.data import DataStatus
from ...config import settings
from ...errors import invalid_param, not_implemented
from ...foundation import repo
from ...foundation.db import get_conn
from ...stream.bus import ControlRequests
from ...updater import registry

router = APIRouter(tags=["data"])


class UpdateTrigger(BaseModel):
    kind: str = Field(..., description="任务类型，见 GET /data/tasks")
    force: bool = Field(False, description="跳过冷却检查")


@router.get("/data/status", response_model=DataStatus, summary="底座状态（表清单体检）")
def status(conn=Depends(get_conn)):
    return TypeAdapter(DataStatus).validate_python(repo.data.get_status(conn, settings.duckdb_path))


@router.get("/data/tasks", summary="更新任务清单与调度链")
def tasks():
    return {
        "items": [{"kind": t["kind"], "label": t["label"],
                   "description": t["description"]} for t in registry.TASKS],
        "schedule": registry.describe_chain(),
        "note": "调度时区北京时间；节假日任务自动跳过",
    }


@router.post("/data/update", status_code=202,
             summary="触发增量更新（经控制通道交 updater 进程执行）")
def update(body: UpdateTrigger):
    if not registry.is_valid_kind(body.kind):
        raise invalid_param(
            f"未知任务类型: {body.kind}",
            {"available": [t["kind"] for t in registry.TASKS]})
    rid = ControlRequests(settings.control_requests_path).submit(
        body.kind, force=body.force)
    return {
        "accepted": True,
        "request_id": rid,
        "kind": body.kind,
        "force": body.force,
        "note": "updater 进程约 2s 内消费；执行结果以 GET /data/updates 落账为准",
    }


@router.get("/data/updates", summary="更新落账查询（updater 写入的 update_log）")
def updates(limit: int = 50, data_type: str | None = None,
            status: str | None = None, conn=Depends(get_conn)):
    try:
        items = repo.data.list_update_log(conn, limit=limit,
                                          data_type=data_type, status=status)
    except Exception:
        # 旧库未跑过 ensure_schema：update_log 还不存在（API 只读，不能建表）
        return {"items": [], "note": "update_log 未初始化——先运行 python -m app.updater"}
    return {"items": items}


@router.post("/data/init", summary="初始化/导入初始数据包（M3）")
def init():
    raise not_implemented("初始数据包导入（import|backfill）属 M3")


@router.post("/data/export", summary="导出离线数据包（P1 · F14，M3）")
def export():
    raise not_implemented("离线数据包导出属 M3")
