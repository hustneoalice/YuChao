"""内置更新内核：编排器 + 调度链 + 控制消费 + 自愈，宿主可插拔。

同一份内核两种宿主形态：
  · FastAPI lifespan（默认，api_embedded_updater=true）——uvicorn 单进程全包，
    「调度并进服务」模式；API 连接全部读写模式打开（同实例共享，DuckDB
    内部管理读写并发），不存在跨进程锁协调；
  · updater CLI（python -m app.updater，回退/手动模式，API 只读挂载 +
    本进程唯一写者，跨进程锁由双方重试协调）。

互斥约束：API 内置内核常驻时不要同时常驻 CLI——控制通道会被双消费、
调度会双触发。api_embedded_updater=true 时 CLI 自动不启调度链（仅手动）。
"""
from __future__ import annotations

import logging
import threading

from ..config import settings
from ..stream.bus import ControlRequests, make_publisher
from .orchestrator import orchestrator
from .registry import TASKS, resolve_fn
from .writer import writer

logger = logging.getLogger("yuchao.updater")


class EmbeddedCore:
    """内核句柄：宿主（lifespan / CLI 信号）收口用。"""

    def __init__(self):
        self.stop = threading.Event()
        self.sched = None
        self.selfheal = None
        self._thread: threading.Thread | None = None

    def shutdown(self) -> None:
        self.stop.set()
        if self.sched:
            self.sched.shutdown(wait=False)
            self.sched = None


def _control_loop(core: EmbeddedCore) -> None:
    """控制通道消费 + 心跳 + 自愈（原 CLI 主循环，宿主无关）。"""
    control = ControlRequests(settings.control_requests_path)
    offset = 0
    if control.journal.path.exists():
        offset = control.journal.path.stat().st_size      # 停机期间请求不重放
    beat = 0
    while not core.stop.is_set():
        try:
            offset, reqs = control.poll(offset)
            for r in reqs:
                kind = str(r.get("kind") or "")
                if kind == "__cancel__":
                    res = orchestrator.cancel((r.get("params") or {}).get("task_id"))
                    logger.info("[Control] 收到停止请求 (id=%s) → %s",
                                r.get("id"), res)
                    continue
                logger.info("[Control] 收到触发请求 %s (id=%s force=%s)",
                            kind, r.get("id"), r.get("force"))
                res = orchestrator.submit(kind, trigger="manual",
                                          force=bool(r.get("force")),
                                          params=r.get("params") or {})
                if not res.get("ok"):
                    logger.warning("[Control] %s 拒绝：%s", kind,
                                   res.get("message") or res.get("error"))
        except Exception:
            logger.exception("[Control] 轮询异常")
            core.stop.wait(settings.control_poll_s)
            continue
        beat += 1
        if beat % 3 == 0:                        # ~6s 空闲心跳，维持 saved_at
            orchestrator.heartbeat()
        core.selfheal.tick(orchestrator)         # 内部节流 ~60s：失败重试 + 链位补偿
        core.stop.wait(settings.control_poll_s)


def start_core(*, scheduler: bool) -> EmbeddedCore:
    """装配并启动内核：schema → 编排器 → 调度链 → 控制消费线程。

    数据底座文件缺失时 ensure_schema 抛 FileNotFoundError，由宿主决定
    降级策略（API 降级纯只读服务；CLI 直接退出）。
    """
    core = EmbeddedCore()

    # 1. schema 幂等就绪（update_log / 2.0 新表 / 复权视图口径单处定义）
    writer.ensure_schema()
    writer.reset()          # 立即释放写锁：写连接排他，空闲期让位给其他连接
    logger.info("schema 就绪")

    # 2. 编排器：注册任务 + 工作线程（backplane：Redis 优先，缺省文件总线）
    orchestrator.bus = make_publisher()
    for spec in TASKS:
        orchestrator.register(spec["kind"], spec["label"], resolve_fn(spec),
                              description=spec["description"],
                              meta={k: spec[k] for k in
                                    ("freshness", "needs", "min_rows")
                                    if k in spec})
    orchestrator.start()
    from .selfheal import Selfheal
    core.selfheal = Selfheal()
    orchestrator.on_record = core.selfheal.on_record
    logger.info("编排器就绪：%d 种任务（自愈心跳开启）", len(TASKS))

    # 3. 调度链（北京时间 cron；开关由宿主决定）
    if scheduler:
        from .registry import describe_chain
        from .scheduler import build_scheduler
        core.sched = build_scheduler(orchestrator)
        core.sched.start()
        for row in describe_chain():
            logger.info("调度链 %s · %s", row["cron"], row["label"])

    # 4. 控制消费 + 自愈守护线程
    core._thread = threading.Thread(target=_control_loop, args=(core,),
                                    daemon=True, name="update-control")
    core._thread.start()
    logger.info("控制通道轮询 %.1fs", settings.control_poll_s)
    return core
