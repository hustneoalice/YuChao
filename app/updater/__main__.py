"""updater 进程入口（回退/手动模式）：`python -m app.updater`。

默认架构下更新内核已内置 API 进程（app/main.py lifespan，见 updater/embedded），
本 CLI 仅两种场景使用：
  · 回退模式 YUCHAO_API_EMBEDDED_UPDATER=false：API 只读挂载，本进程唯一写者；
  · 临时手动跑批（与常驻 API 并存时注意：跨进程写锁由双方重试协调，任务可能排队）。

api_embedded_updater=true 时本进程不启调度链（调度归 API 进程），
只做手动触发与自愈——避免双进程双调度。
"""
from __future__ import annotations

import logging
import signal
import sys

from ..config import settings
from .embedded import start_core

logger = logging.getLogger("yuchao.updater")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%m-%d %H:%M:%S",
    )
    logger.info("YuChao updater 启动 · duckdb=%s", settings.duckdb_path)

    core = start_core(
        scheduler=settings.scheduler_enabled and not settings.api_embedded_updater)
    if not core.sched:
        logger.info("调度链未在本进程启用（内置 API 模式归 API 承担，或已显式关闭）")

    def _sig(_num, _frm):
        logger.info("收到退出信号，收尾中…")
        core.stop.set()

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    while not core.stop.is_set():
        core.stop.wait(1.0)
    core.shutdown()
    logger.info("updater 退出")


if __name__ == "__main__":
    sys.exit(main())
