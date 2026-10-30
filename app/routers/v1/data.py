"""数据底座端点：status · tasks · update 触发 · updates 落账 · init/export。

进程模型：本进程对 DuckDB 只读。POST /data/update、/data/init、/data/export
都不直接写库——落控制请求（data/control_requests.jsonl），由 updater 进程
（唯一写者）轮询消费、经编排器排队执行（数据包操作与更新任务互斥）。
"""
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, TypeAdapter

from ...contracts.data import DataStatus
from ...config import settings
from ...errors import invalid_param
from ...foundation import repo
from ...foundation.db import get_conn
from ...foundation.repo.health import assess as health_assess
from ...foundation.repo.health import updater_alive
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
    if not _updater_alive():
        raise HTTPException(
            status_code=503,
            detail="更新进程未运行（请求不会被消费）— 启动：python -m app.updater")
    rid = ControlRequests(settings.control_requests_path).submit(
        body.kind, force=body.force)
    return {
        "accepted": True,
        "request_id": rid,
        "kind": body.kind,
        "force": body.force,
        "note": "updater 进程约 2s 内消费；执行结果以 GET /data/updates 落账为准",
    }


@router.post("/data/update/cancel", status_code=202,
             summary="请求停止当前更新 / 清空排队（经控制通道交 updater 进程）")
def update_cancel():
    if not _updater_alive():
        raise HTTPException(
            status_code=503, detail="更新进程未运行，无需停止")
    rid = ControlRequests(settings.control_requests_path).submit("__cancel__")
    return {
        "accepted": True,
        "request_id": rid,
        "note": "updater 进程约 2s 内消费；排队任务直接移除，运行中的任务由采集函数自行退出",
    }


@router.get("/data/update/state", summary="更新编排快照（进行中/排队/最近任务的实时进度）")
def update_state():
    """读 updater 进程落盘的 update_progress.json（只读快照，节流 ~1s）。

    返回 {saved_at, running, queued, recent}；running 任务含 stage/percent/
    done/total/rows/logs，驱动前端进度条。updater 未运行时返回空快照。
    """
    empty = {"saved_at": None, "running": None, "queued": [], "recent": []}
    try:
        return json.loads(settings.update_snapshot_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty
    except Exception:
        return {**empty, "error": "snapshot_unreadable"}


def _updater_alive(max_age_s: float = 20.0) -> bool:
    """deprecated shim：判定逻辑收编至 foundation/repo/health.updater_alive。"""
    return updater_alive()


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
    if not _updater_alive():
        raise HTTPException(
            status_code=503,
            detail="更新进程未运行（请求不会被消费）— 启动：python -m app.updater")
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
    if not _updater_alive():
        raise HTTPException(
            status_code=503,
            detail="更新进程未运行（请求不会被消费）— 启动：python -m app.updater")
    rid = ControlRequests(settings.control_requests_path).submit(
        "package_export", params=params)
    out_dir = body.out_dir or str(settings.export_dir)
    return {
        "accepted": True,
        "request_id": rid,
        "out_dir": out_dir,
        "note": "导出与更新互斥（编排器排队）；产物 yuchao_data_*.duckdb + .manifest.json",
    }


# ---------------------------------------------------------------------------
# P1 数据底座三件套：体检评估 + 一键修复
# ---------------------------------------------------------------------------

@router.get("/data/health", summary="数据体检评估（新鲜度/覆盖率/断档/落账 → 综合分）")
def health(conn=Depends(get_conn)):
    """四维打分 0-100，分级 healthy/warn/poor；issues 带修复动作建议。

    写锁持有期间只读连接会被拒（DuckDB 跨进程互斥）——此时返回
    unavailable=true 而非 500，前端展示「体检暂时不可用，任务结束后重试」。
    """
    try:
        report = health_assess(conn)
    except Exception:
        return {"unavailable": True,
                "note": "DuckDB 写锁持有中（更新任务执行窗口），体检稍后自动恢复",
                "updater_alive": updater_alive()}
    report["selfheal"] = _selfheal_snapshot()
    return report


def _selfheal_snapshot() -> dict:
    """自愈账本快照（data/selfheal_ledger.json，updater 进程维护，这里只读）。"""
    try:
        return json.loads(
            settings.selfheal_ledger_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {}


@router.post("/data/repair", status_code=202,
             summary="一键修复：按体检结果生成修复计划并经控制通道提交")
def repair():
    """体检 → 生成 actions（新鲜度落后→补触发对应任务、断档→历史回补、
    失败落账→force 重试）→ 逐条落控制通道交 updater 执行（与手动触发
    同一链路，编排器去重/冷却兜底）。一次最多提交 4 个动作（队列串行）。"""
    if not _updater_alive():
        raise HTTPException(
            status_code=503,
            detail="更新进程未运行（修复请求不会被消费）— 启动：python -m app.updater")
    from ...foundation.db import open_conn
    conn = open_conn()
    try:
        report = health_assess(conn)
    except Exception as e:
        raise HTTPException(status_code=503,
                            detail=f"体检暂不可用（写锁持有中），请稍后重试：{e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

    actions: list[dict] = []
    seen: set[str] = set()
    for it in report.get("issues", []):
        act = it.get("action")
        if not act or act["kind"] in seen:
            continue
        seen.add(act["kind"])
        actions.append({"kind": act["kind"], "force": bool(act.get("force")),
                        "reason": it["message"]})
        if len(actions) >= 4:
            break
    if not actions:
        return {"accepted": True, "submitted": [], "plan": [],
                "message": f"体检 {report['score']} 分（{report['grade']}），无需修复"}

    submitted = []
    for act in actions:
        try:
            rid = ControlRequests(settings.control_requests_path).submit(
                act["kind"], force=act["force"])
            submitted.append({**act, "request_id": rid})
        except Exception as e:
            submitted.append({**act, "error": str(e)})
    return {
        "accepted": True,
        "submitted": submitted,
        "score": report["score"],
        "note": "updater 进程约 2s 内消费；执行结果以 GET /data/updates 与体检复评（GET /data/health）为准",
    }
