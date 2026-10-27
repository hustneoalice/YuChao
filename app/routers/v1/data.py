"""数据底座端点：status · tasks · update 触发 · updates 落账 · init/export。

进程模型：本进程对 DuckDB 只读。POST /data/update、/data/init、/data/export
都不直接写库——落控制请求（data/control_requests.jsonl），由 updater 进程
（唯一写者）轮询消费、经编排器排队执行（数据包操作与更新任务互斥）。
"""
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, TypeAdapter

from ...contracts.data import DataStatus
from ...config import settings
from ...errors import invalid_param
from ...foundation import repo
from ...foundation.db import get_conn
from ...stream.bus import ControlRequests
from ...updater import registry

router = APIRouter(tags=["data"])


class UpdateTrigger(BaseModel):
    kind: str = Field(..., description="任务类型，见 GET /data/tasks")
    force: bool = Field(False, description="跳过冷却检查")


class InitTrigger(BaseModel):
    mode: str = Field("import", description="import 导入数据包 | backfill 多源回补")
    package: str | None = Field(None, description="数据包 .duckdb 路径（mode=import 必填）")


class ExportTrigger(BaseModel):
    out_dir: str | None = Field(None, description="导出目录（缺省 data/exports）")


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


@router.post("/data/init", status_code=202,
             summary="初始化：导入数据包（import）或多源回补（backfill）")
def init(body: InitTrigger):
    """数据包协议：.duckdb 主文件 + .manifest.json（SHA256/行数/抽样）。

    import 路径在本进程预检存在性（updater 侧还有 SHA256→行数→抽样 三级校验，
    校验通过才换库，原库留 .bak）；backfill 走采集链（多源降级），适合无包可导
    的冷启动。执行进度以 GET /data/updates 落账与 /stream/sse data:update 为准。
    """
    if body.mode == "import":
        if not body.package:
            raise invalid_param("mode=import 需要 package 参数（数据包 .duckdb 路径）")
        pkg = Path(body.package).expanduser().resolve()
        if not pkg.exists():
            raise invalid_param(f"数据包不存在: {pkg}")
        if not pkg.suffix == ".duckdb":
            raise invalid_param("数据包应为 .duckdb 文件（manifest 与主文件同名同目录）")
        kind, params = "package_import", {"package": str(pkg)}
    elif body.mode == "backfill":
        kind, params = "backfill", {}
    else:
        raise invalid_param(f"未知 mode: {body.mode}", {"available": ["import", "backfill"]})
    rid = ControlRequests(settings.control_requests_path).submit(kind, params=params)
    return {
        "accepted": True,
        "request_id": rid,
        "mode": body.mode,
        "package": params.get("package"),
        "note": "updater 进程约 2s 内消费；结果以 GET /data/updates 落账为准",
    }


@router.post("/data/export", status_code=202,
             summary="导出离线数据包（全量快照 + SHA256 manifest，P1 · F14）")
def export(body: ExportTrigger):
    params = {"out_dir": body.out_dir} if body.out_dir else {}
    rid = ControlRequests(settings.control_requests_path).submit(
        "package_export", params=params)
    out_dir = body.out_dir or str(settings.export_dir)
    return {
        "accepted": True,
        "request_id": rid,
        "out_dir": out_dir,
        "note": "导出与更新互斥（编排器排队）；产物 yuchao_data_*.duckdb + .manifest.json",
    }
