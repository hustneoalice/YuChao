"""YuChao 数据底座 · FastAPI 装配。

M1 进程模型：API 进程对 DuckDB 只读挂载；写（更新编排）属 M2 updater 进程。
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from prometheus_client import make_asgi_app

from . import __version__
from .config import settings
from .errors import ApiError
from .foundation.db import DataSourceMissing
from .routers.v1 import corepicks, data, market, sectors

logger = logging.getLogger("yuchao")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("YuChao %s · duckdb=%s (read_only)", __version__, settings.duckdb_path)
    yield


app = FastAPI(
    title=settings.api_title,
    version=__version__,
    description=(
        "驭潮 YuChao · AI 问股数据底座。观潮者看浪，驭潮者乘流——前端可整体替换："
        "仅依赖本 OpenAPI 契约。错误规约 `{code,message,detail?}`；分页信封 `{items,total,cursor?}`。"
    ),
    lifespan=lifespan,
)


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return JSONResponse(
        status_code=exc.status,
        content={"code": exc.code, "message": exc.message, "detail": exc.detail},
    )


@app.exception_handler(DataSourceMissing)
async def data_missing_handler(request: Request, exc: DataSourceMissing):
    return JSONResponse(
        status_code=503,
        content={"code": "data_not_ready", "message": str(exc),
                 "detail": {"hint": "先导入初始数据包或运行 scripts/ensure_schema.py 初始化"}},
    )


@app.get("/healthz", tags=["meta"], summary="存活探针")
def healthz():
    return {"ok": True, "version": __version__}


v1 = settings.api_v1_prefix
app.include_router(market.router, prefix=v1)
app.include_router(sectors.router, prefix=v1)
app.include_router(corepicks.router, prefix=v1)
app.include_router(data.router, prefix=v1)

# Prometheus 可观测性（1.0 资产原样保留）
app.mount("/metrics", make_asgi_app())
