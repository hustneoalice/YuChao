"""YuChao 数据底座 · FastAPI 装配。

进程模型（2.1 起默认内置更新内核，api_embedded_updater=true）：
  · 本进程同时承担 只读 API + 更新内核（编排器/调度链/自愈，见 updater/embedded）；
    DuckDB 连接全部读写模式打开（同实例共享），无跨进程锁协调；
  · 回退模式（YUCHAO_API_EMBEDDED_UPDATER=false）：本进程只读挂载，写属
    独立 updater 进程（python -m app.updater）。
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from prometheus_client import make_asgi_app

from . import __version__
from .config import settings
from .errors import ApiError
from .foundation.db import DataSourceMissing
from .routers.v1 import auth, corepicks, data, market, me, sectors
from .stream.sse import router as stream_router

logger = logging.getLogger("yuchao")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("YuChao %s · duckdb=%s", __version__, settings.duckdb_path)
    core = None
    if settings.api_embedded_updater:
        # 内置更新内核（编排器+调度链+自愈并入 uvicorn）。数据底座缺失时
        # 降级纯只读 API（503 提示初始化），不拖死服务。
        from .updater.embedded import start_core
        try:
            core = start_core(scheduler=True)
            # 锚连接：并发每请求 connect 的 attach 竞态消除（见 db.hold_anchor）
            from .foundation.db import hold_anchor
            hold_anchor()
        except FileNotFoundError as e:
            logger.warning("内置更新内核未启动：%s", e)
    yield
    if core:
        core.shutdown()


app = FastAPI(
    title=settings.api_title,
    version=__version__,
    description=(
        "驭潮 YuChao · AI 问股数据底座。观潮者看浪，驭潮者乘流——前端可整体替换："
        "仅依赖本 OpenAPI 契约。错误规约 `{code,message,detail?}`；分页信封 `{items,total,cursor?}`。"
    ),
    lifespan=lifespan,
)

# M4 前端跨域：dev server（vite 5173 等）直连 API；鉴权走 Bearer header（不用 cookie），
# 无需 allow_credentials。生产同源部署时由反向代理消化，此处保持开放即可。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
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
app.include_router(auth.router, prefix=v1)
app.include_router(me.router, prefix=v1)
app.include_router(market.router, prefix=v1)
app.include_router(sectors.router, prefix=v1)
app.include_router(corepicks.router, prefix=v1)
app.include_router(data.router, prefix=v1)
app.include_router(stream_router, prefix=v1)

# Prometheus 可观测性（1.0 资产原样保留）
app.mount("/metrics", make_asgi_app())
