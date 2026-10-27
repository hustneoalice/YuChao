"""updater 进程入口：`python -m app.updater`。

进程模型（设计文档 03/05 节）：
  · DuckDB 多进程只允许全 read_only → 本进程是**唯一写者**；
  · 编排器串行消费队列（去重/冷却/进度快照/落账/publish）；
  · APScheduler 调度链按北京时间触发（YUCHAO_SCHEDULER_ENABLED=false 可关，
    仅保留手动触发与自愈）；
  · 常驻轮询控制通道：API 进程 POST /data/update 落 control_requests.jsonl，
    本进程消费后提交编排器（API 进程只读，不能直接入队）。
    停机期间的请求不重放（启动即 seek 到文件尾）——触发结果以 update_log 为准。
"""
from __future__ import annotations

import logging
import signal
import sys
import threading

from ..config import settings
from ..stream.bus import ControlRequests
from .orchestrator import orchestrator
from .registry import TASKS, resolve_fn
from .writer import writer

logger = logging.getLogger("yuchao.updater")


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        datefmt="%m-%d %H:%M:%S",
    )
    logger.info("YuChao updater 启动 · duckdb=%s（唯一写者）", settings.duckdb_path)

    # 1. schema 幂等就绪（update_log / 2.0 新表 / 复权视图口径单处定义）
    writer.ensure_schema()
    writer.reset()          # 立即释放写锁：DuckDB 写连接排他，空闲期让位给 API 只读连接
    logger.info("schema 就绪")

    # 2. 注册任务 → 启动编排器工作线程
    for spec in TASKS:
        orchestrator.register(spec["kind"], spec["label"], resolve_fn(spec),
                              description=spec["description"])
    orchestrator.start()
    logger.info("编排器就绪：%d 种任务", len(TASKS))

    # 3. 调度链
    sched = None
    if settings.scheduler_enabled:
        from .scheduler import build_scheduler, describe_chain

        sched = build_scheduler(orchestrator)
        sched.start()
        for row in describe_chain():
            logger.info("调度链 %s · %s", row["cron"], row["label"])
    else:
        logger.info("调度链已关闭（YUCHAO_SCHEDULER_ENABLED=false）")

    # 4. 控制通道消费循环（API 触发 → 编排器）
    control = ControlRequests(settings.control_requests_path)
    offset = 0
    if control.journal.path.exists():
        offset = control.journal.path.stat().st_size      # 停机期间请求不重放
    stop = threading.Event()

    def _sig(_num, _frm):
        logger.info("收到退出信号，收尾中…")
        stop.set()

    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)

    logger.info("updater 就绪（控制轮询 %.1fs）", settings.control_poll_s)
    while not stop.is_set():
        try:
            offset, reqs = control.poll(offset)
            for r in reqs:
                kind = str(r.get("kind") or "")
                logger.info("[Control] 收到触发请求 %s (id=%s force=%s)",
                            kind, r.get("id"), r.get("force"))
                res = orchestrator.submit(kind, trigger="manual",
                                          force=bool(r.get("force")))
                if not res.get("ok"):
                    logger.warning("[Control] %s 拒绝：%s", kind,
                                   res.get("message") or res.get("error"))
        except Exception:
            logger.exception("[Control] 轮询异常")
            stop.wait(settings.control_poll_s)
            continue
        stop.wait(settings.control_poll_s)

    if sched:
        sched.shutdown(wait=False)
    logger.info("updater 退出")


if __name__ == "__main__":
    sys.exit(main())
