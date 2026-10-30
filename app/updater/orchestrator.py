"""统一更新编排器（自 1.0 update_orchestrator 移植，语义完整保留）。

为什么需要它（1.0 验证过的结论）：「检测到数据滞后」与「执行数据更新」必须是
同一条链路，且执行过程必须可见——否则系统能报出「个股滞后 2 个交易日」，
却没有任何机制去修它，前端只能看黑盒。

设计约束（1.0 原样）：
1. **串行执行**：DuckDB 同一时刻只允许一个写者，队列串行消费，不并发。
   同一 kind 若已在队列或运行中，重复提交直接复用，不排队（去重）。
2. **单一真相**：stage / total / done / rows 一律由执行函数通过 progress
   回调上报，编排器只负责存储与呈现，绝不自己猜进度。
3. **可恢复**：快照落盘 data/update_progress.json；进程重启时仍标记
   running/queued 的任务改写为 interrupted，避免前端挂一个不会动的假进度条。
4. **不吞错**：失败任务保留 error 原文，并落账 update_log。
5. **可取消**：置 cancel_requested，执行函数在每个批次边界自行检查退出。

2.0 升级（设计文档 05.1）：落账后 publish 到流总线（data:update 频道），
驱动 SSE 推送——「数据说了变」才拉，前端新鲜度不再靠 TTL 猜。
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from ..config import settings
from ..stream.bus import StreamBus
from .writer import writer

logger = logging.getLogger("yuchao.updater")

_TERMINAL = {"completed", "failed", "skipped", "cancelled", "interrupted"}

_RECENT_KEEP = 30       # 内存保留的终态任务条数
_LOG_KEEP = 200         # 单任务日志行数上限
_EVENT_KEEP = 300       # 全局事件流上限

# kind → 编排器对外广播的数据集名（SSE data:update 载荷里带上，供前端按前缀失效缓存）
KIND_DATASETS: Dict[str, List[str]] = {
    "kline_update": ["daily_ohlcv"],
    "capital_flow": ["capital_flow"],
    "valuation": ["daily_valuation"],
    "pe_percentile": ["daily_valuation"],
    "adjust_factor": ["adjust_factor"],
    "financials": ["financials"],
    "quotes": ["daily_ohlcv"],
    "sector_index": ["sector_index"],
    "corepicks": ["corepicks_result"],
    "package_import": ["daily_ohlcv", "adjust_factor", "capital_flow", "financials",
                       "stock_universe", "sector_index", "daily_valuation",
                       "corepicks_result", "stock_profile"],
    "package_export": [],                    # 只读导出，底座数据未变
    "backfill": ["daily_ohlcv", "daily_valuation", "capital_flow"],
}


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _ts_of(iso: Optional[str]) -> Optional[float]:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso).timestamp()
    except Exception:
        return None


class UpdateTask:
    """一个更新任务的运行态。字段全部可 JSON 序列化。"""

    __slots__ = ("id", "kind", "label", "trigger", "status", "stage",
                 "total", "done", "succeeded", "failed", "rows",
                 "message", "error", "detail", "params",
                 "queued_at", "started_at", "finished_at",
                 "queued_ts", "started_ts", "finished_ts", "logs")

    def __init__(self, kind: str, label: str, trigger: str,
                 params: Optional[Dict[str, Any]] = None):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.label = label
        self.trigger = trigger            # manual | cron | selfheal | startup
        self.status = "queued"
        self.stage = "排队中"
        self.total = 0
        self.done = 0
        self.succeeded = 0
        self.failed = 0
        self.rows = 0
        self.message = ""
        self.error = ""
        self.detail = ""
        self.params = params or {}
        self.queued_at = _now_iso()
        self.started_at: Optional[str] = None
        self.finished_at: Optional[str] = None
        self.queued_ts = time.time()
        self.started_ts: Optional[float] = None
        self.finished_ts: Optional[float] = None
        self.logs: deque = deque(maxlen=_LOG_KEEP)

    @property
    def percent(self) -> float:
        if self.status in _TERMINAL:
            return 100.0 if self.status == "completed" else 0.0
        if self.total > 0:
            return round(min(self.done / self.total, 1.0) * 100, 1)
        return 0.0

    def elapsed_s(self) -> Optional[int]:
        base = self.started_ts or self.queued_ts
        end = self.finished_ts or time.time()
        return int(end - base) if base else None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id, "kind": self.kind, "label": self.label,
            "trigger": self.trigger, "status": self.status, "stage": self.stage,
            "total": self.total, "done": self.done,
            "succeeded": self.succeeded, "failed": self.failed, "rows": self.rows,
            "percent": self.percent, "elapsed_s": self.elapsed_s(),
            "message": self.message, "error": self.error, "detail": self.detail,
            "params": self.params, "queued_at": self.queued_at,
            "started_at": self.started_at, "finished_at": self.finished_at,
            "logs": list(self.logs)[-40:],
        }


class UpdateOrchestrator:
    """更新任务编排：注册 → 入队 → 串行执行 → 进度上报 → 落账 → publish。"""

    def __init__(self, snapshot_path: str | Path | None = None,
                 bus: StreamBus | None = None):
        self._lock = threading.RLock()
        self._registry: Dict[str, Dict[str, Any]] = {}
        self._queue: List[str] = []
        self._tasks: Dict[str, UpdateTask] = {}
        self._recent: List[str] = []
        self._running_id: Optional[str] = None
        self._cancel: Dict[str, bool] = {}
        self._cooldown: Dict[str, float] = {}
        self._events: deque = deque(maxlen=_EVENT_KEEP)
        self._wake = threading.Event()
        self._worker: Optional[threading.Thread] = None
        self._loaded = False
        self._last_persist = 0.0
        self.cooldown_s = 600
        # 自愈挂点：落账后通知 Selfheal.on_record（updater 进程 __main__ 注入；
        # API 进程不 import selfheal，恒为 None）
        self.on_record = None
        self.snapshot_path = Path(snapshot_path or settings.update_snapshot_path)
        self.bus = bus or StreamBus(settings.stream_events_path)

    # -- 注册 -------------------------------------------------------------

    def register(self, kind: str, label: str, fn: Callable, *,
                 description: str = "", cooldown_s: Optional[int] = None):
        """注册一种更新任务。fn(progress, ctx) -> dict"""
        self._registry[kind] = {
            "kind": kind, "label": label, "fn": fn, "description": description,
            "cooldown_s": cooldown_s if cooldown_s is not None else self.cooldown_s,
        }

    def kinds(self) -> List[Dict[str, Any]]:
        return [{"kind": k, "label": v["label"], "description": v["description"]}
                for k, v in self._registry.items()]

    # -- 入队 -------------------------------------------------------------

    def submit(self, kind: str, trigger: str = "manual",
               params: Optional[Dict[str, Any]] = None,
               force: bool = False) -> Dict[str, Any]:
        """提交一个更新任务；同 kind 已在队列/运行中时直接复用（去重）。"""
        with self._lock:
            spec = self._registry.get(kind)
            if not spec:
                return {"ok": False, "error": f"未注册的任务类型: {kind}",
                        "available": list(self._registry)}

            # 去重：同类任务已在跑或排队 → 复用，不重复排队
            for tid in ([self._running_id] if self._running_id else []) + self._queue:
                if not tid:
                    continue
                t = self._tasks.get(tid)
                if t and t.kind == kind and t.status in ("queued", "running"):
                    return {"ok": True, "deduped": True, "task": t.to_dict(),
                            "message": f"{t.label} 已在{'执行' if t.status == 'running' else '排队'}中"}

            # 冷却：防止自愈/心跳把同一任务反复打进队列。冷却不是失败——
            # 刚提交过同类任务被跳过，不该在账本里留红。
            if not force and trigger != "manual":
                cd = spec.get("cooldown_s", self.cooldown_s)
                last = self._cooldown.get(kind)
                if last and (time.time() - last) < cd:
                    remain = int(cd - (time.time() - last))
                    return {"ok": False, "cooldown": True, "remaining_s": remain,
                            "message": f"{spec['label']} 冷却中，{remain}s 后可再触发"}

            task = UpdateTask(kind, spec["label"], trigger, params)
            self._tasks[task.id] = task
            self._queue.append(task.id)
            self._cooldown[kind] = time.time()
            self._event(f"任务已入队：{task.label}（{trigger}）", "info", kind=kind)
            self._publish_state(task, "queued")

        self._ensure_worker()
        self._wake.set()
        return {"ok": True, "task": task.to_dict()}

    def cancel(self, task_id: Optional[str] = None) -> Dict[str, Any]:
        """请求取消：排队中的直接移除，运行中的置标记由执行函数自行退出。"""
        self._ensure_worker()
        with self._lock:
            tid = task_id or self._running_id or (self._queue[0] if self._queue else None)
            if not tid or tid not in self._tasks:
                return {"ok": False, "error": "没有可取消的任务"}
            t = self._tasks[tid]
            if t.status == "queued":
                if tid in self._queue:
                    self._queue.remove(tid)
                t.status = "cancelled"
                t.stage = "已取消"
                t.finished_ts = time.time()
                t.finished_at = _now_iso()
                self._recent.insert(0, tid)
                self._trim_recent()
                self._persist(force=True)
                return {"ok": True, "task": t.to_dict()}
            if t.status == "running":
                self._cancel[tid] = True
                t.message = "正在停止…"
                self._event(f"请求停止：{t.label}", "warning", kind=t.kind)
                return {"ok": True, "task": t.to_dict()}
            return {"ok": False, "error": f"任务已处于终态: {t.status}"}

    def is_cancelled(self, task_id: str) -> bool:
        return bool(self._cancel.get(task_id))

    # -- 执行 -------------------------------------------------------------

    def _ensure_worker(self):
        with self._lock:
            if self._worker and self._worker.is_alive():
                return
            if not self._loaded:
                self._load_snapshot()
                self._loaded = True
            self._worker = threading.Thread(target=self._loop, daemon=True,
                                            name="update-orchestrator")
            self._worker.start()

    def start(self) -> None:
        """常驻启动（updater 进程入口调用）：恢复快照 + 起工作线程。"""
        self._ensure_worker()

    def _loop(self):
        while True:
            tid = None
            with self._lock:
                if self._queue:
                    tid = self._queue.pop(0)
                    if tid not in self._tasks:
                        tid = None
                    else:
                        # 状态置位与出队必须原子：否则「已出队、还没标 running」
                        # 的空窗里再 submit 同 kind，去重会漏（测试踩中的真实缝隙）
                        t = self._tasks[tid]
                        t.status = "running"
                        t.started_ts = time.time()
            if tid is None:
                # 空队列：等待唤醒（带超时兜底，避免事件丢失导致线程永不退出）
                self._wake.wait(timeout=5)
                self._wake.clear()
                continue
            try:
                self._run_task(tid)
            except Exception:
                # 任务级异常已在 _run_task 内收口；这里兜底防线程死亡
                # （worker 一死队列冻结、running 状态永远悬挂——2026-10-30 教训）
                logger.exception("[Orchestrator] 任务执行框架异常（worker 存活）")
                with self._lock:
                    self._running_id = None
                    t = self._tasks.get(tid)
                    if t is not None and t.status == "running":
                        t.status = "failed"
                        t.error = (t.error or "internal worker error")[:300]
                writer.reset()

    def _run_task(self, task_id: str):
        with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return
            spec = self._registry.get(task.kind)
            task.status = "running"
            task.started_ts = time.time()
            task.started_at = _now_iso()
            task.stage = "启动中"
            self._running_id = task_id
            self._event(f"开始执行：{task.label}", "info", kind=task.kind)
            self._publish_state(task, "running")
        self._persist()

        def progress(**fields):
            """执行函数用这个上报当前进度。字段全可选。"""
            with self._lock:
                t = self._tasks.get(task_id)
                if not t:
                    return
                for k in ("stage", "total", "done", "succeeded", "failed",
                          "rows", "message", "detail"):
                    if k in fields and fields[k] is not None:
                        setattr(t, k, fields[k])
                msg = fields.get("log")
                if msg:
                    t.logs.append({"time": datetime.now().strftime("%H:%M:%S"),
                                   "level": fields.get("level", "info"),
                                   "message": str(msg)[:300]})
                self._publish_state(t, "running")
            self._persist()

        status, error, detail = "completed", "", ""
        t = task
        try:
            if not spec:
                raise RuntimeError(f"任务类型未注册: {task.kind}")
            ctx = dict(task.params)
            ctx["task_id"] = task_id
            ctx["cancel_check"] = lambda: self.is_cancelled(task_id)
            ctx["bus"] = self.bus          # 任务层用它发频道事件（kline.update 等）
            res = spec["fn"](progress, ctx) or {}
            status = res.get("status") or "completed"
            if res.get("error"):
                # 主流程成功但子项失败时也要把原因带出来，
                # 否则「任务成功、数据没动」会再次被静默吞掉
                error = str(res["error"])[:2000]
            detail = str(res.get("detail") or "")[:500]
            with self._lock:
                if t:
                    t.rows = int(res.get("rows", t.rows) or 0)
                    if res.get("total"):
                        t.total = int(res["total"])
                    if res.get("success") is not None:
                        t.succeeded = int(res.get("success") or 0)
        except Exception as e:
            status, error = "failed", f"{type(e).__name__}: {e}"
            logger.exception("[Orchestrator] 任务异常 %s", task.label)

        with self._lock:
            t = self._tasks.get(task_id)
            cancelled = self._cancel.pop(task_id, False)
            if t:
                if cancelled and status != "failed":
                    t.status = "cancelled"
                    t.stage = "已停止"
                else:
                    t.status = status if status in _TERMINAL else "completed"
                    t.stage = {"completed": "已完成", "failed": "执行失败",
                               "skipped": "已跳过", "cancelled": "已停止"}.get(t.status, t.status)
                # 进度收尾：成功完成时把 done 对齐 total，避免 99% 的观感
                if t.status == "completed" and t.total and t.done < t.total:
                    t.done = t.total
                t.error = error
                t.detail = detail or t.detail
                t.finished_ts = time.time()
                t.finished_at = _now_iso()
                if t.status == "completed" and not t.message:
                    t.message = f"写入 {t.rows} 行"
                t.logs.append({
                    "time": datetime.now().strftime("%H:%M:%S"),
                    # skipped / cancelled 是正常终态，不该标成 error——
                    # 「已跳过｜写入 0 行」被记成 error 会让运维去查不存在的问题
                    "level": ("success" if t.status == "completed"
                              else "info" if t.status in ("skipped", "cancelled")
                              else "error"),
                    "message": f"{t.stage}｜耗时 {t.elapsed_s()}s｜写入 {t.rows} 行"
                               + (f"｜{error[:200]}" if error else ""),
                })
                self._publish_state(t, t.status)
            self._running_id = None
            if task_id in self._tasks:
                self._recent.insert(0, task_id)
                self._trim_recent()
            self._event(
                f"{'完成' if (t and t.status == 'completed') else '结束'}："
                f"{t.label if t else task_id}（{t.status if t else '?'}）",
                "success" if (t and t.status == "completed") else "error",
                kind=t.kind if t else None,
            )
        self._persist(force=True)

        # 落账：任何一次触发都必须在 update_log 留一行（1.0 record_update 语义）。
        # 落账失败只告警、绝不外抛——2026-10-30 实测：写锁等待耗尽时这里抛异常
        # 会杀死 worker 线程，队列里剩余任务永远无人消费且 writer.reset() 被跳过。
        if t is not None:
            try:
                writer.record_update(
                    data_type=t.kind, status=t.status, rows=t.rows,
                    error=t.error, detail=t.detail or t.message,
                    duration_s=float(t.elapsed_s() or 0), trigger=t.trigger,
                )
            except Exception:
                logger.error("[Orchestrator] 落账失败（update_log 缺一行）",
                             exc_info=True)
            # 自愈心跳记账（失败重试 / 链位补偿的判定依据）
            if self.on_record:
                try:
                    self.on_record(t.kind, t.status, t.error)
                except Exception:
                    logger.debug("[Orchestrator] on_record 回调失败", exc_info=True)
        # 释放写锁：DuckDB 写连接是排他的——持有期间连 read_only 连接都会被拒，
        # API 进程将完全不可用。锁只在任务执行窗口持有，空闲期让位给 API。
        writer.reset()

    def _trim_recent(self):
        while len(self._recent) > _RECENT_KEEP:
            old = self._recent.pop()
            self._tasks.pop(old, None)
            self._cancel.pop(old, None)

    # -- publish（2.0 新增：落账后广播，驱动 SSE） -------------------------

    def _publish_state(self, t: UpdateTask, state: str) -> None:
        """data:update 频道：{data_type, state, pct, rows, error}（06.2 协议）。
        skipped = 「数据已是最新、什么都没写」，不必惊动前端。"""
        if t.status == "skipped" and state == t.status:
            return
        try:
            self.bus.publish("data:update", "data.update", {
                "data_type": t.kind,
                "datasets": KIND_DATASETS.get(t.kind, [t.kind]),
                "task_id": t.id,
                "state": state,                 # queued | running | completed | failed | cancelled
                "stage": t.stage,
                "pct": t.percent,
                "rows": t.rows,
                "error": t.error,
                "trigger": t.trigger,
            })
        except Exception:                        # 广播失败绝不能影响数据任务本身
            logger.debug("[Orchestrator] publish 失败", exc_info=True)

    # -- 事件与快照 -------------------------------------------------------

    def _event(self, message: str, level: str = "info", kind: Optional[str] = None):
        self._events.append({
            "time": datetime.now().strftime("%H:%M:%S"),
            "level": level, "message": message, "kind": kind,
        })

    def log_event(self, message: str, level: str = "info", kind: Optional[str] = None):
        with self._lock:
            self._event(message, level, kind)

    def events(self, since: int = 0) -> List[Dict[str, Any]]:
        return list(self._events)[since:]

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            running = self._tasks.get(self._running_id) if self._running_id else None
            queued = [self._tasks[t].to_dict() for t in self._queue
                      if t in self._tasks and self._tasks[t].status == "queued"]
            recent = [self._tasks[t].to_dict() for t in self._recent if t in self._tasks]
            return {
                "busy": running is not None or bool(queued),
                "running": running.to_dict() if running else None,
                "queued": queued, "recent": recent,
                "events": list(self._events)[-60:],
                "kinds": self.kinds(),
                "server_time": _now_iso(),
            }

    def _persist(self, force: bool = False):
        """快照落盘。写失败不抛，进度可视化不该拖垮更新本身。
        节流 ~1 次/秒；终态切换强制写。"""
        try:
            now = time.time()
            if not force and (now - self._last_persist) < 1.0:
                return
            self._last_persist = now
            with self._lock:
                snap = {
                    "saved_at": _now_iso(),
                    "running": self._tasks[self._running_id].to_dict()
                    if self._running_id and self._running_id in self._tasks else None,
                    "queued": [self._tasks[t].to_dict() for t in self._queue
                               if t in self._tasks],
                    "recent": [self._tasks[t].to_dict() for t in self._recent[:10]
                               if t in self._tasks],
                }
            self.snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.snapshot_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(snap, ensure_ascii=False, indent=2),
                           encoding="utf-8")
            tmp.replace(self.snapshot_path)
        except Exception as e:
            logger.debug("[Orchestrator] 快照落盘失败: %s", e)

    def heartbeat(self):
        """空闲心跳：强制刷一次快照 saved_at。

        API 侧 _updater_alive 靠 saved_at 判在线（停机期间的请求会被
        控制通道 offset 跳过），空闲时状态不变、_persist 不会被触发，
        必须由主循环周期调用维持心跳。"""
        self._persist(force=True)

    def _load_snapshot(self):
        """启动时读回上次快照，把未结束的任务标为 interrupted。"""
        try:
            if not self.snapshot_path.exists():
                return
            snap = json.loads(self.snapshot_path.read_text(encoding="utf-8"))
            stale = [x for x in ([snap.get("running")] + (snap.get("queued") or [])) if x]
            if stale:
                self._event(
                    f"检测到 {len(stale)} 个未完成的更新任务（进程重启导致中断）："
                    + "、".join(x.get("label", "?") for x in stale), "warning")
            for x in (snap.get("recent") or []):
                t = UpdateTask(x.get("kind", "?"), x.get("label", "?"),
                               x.get("trigger", "auto"))
                for k in ("id", "status", "stage", "total", "done", "succeeded",
                          "failed", "rows", "message", "error", "detail",
                          "queued_at", "started_at", "finished_at", "params"):
                    if x.get(k) is not None:
                        setattr(t, k, x[k])
                # 时间戳必须重建：否则 elapsed 会用「恢复时刻→现在」，
                # 把 224s 的任务显示成十几秒（1.0 教训）
                t.queued_ts = _ts_of(t.queued_at) or time.time()
                t.started_ts = _ts_of(t.started_at)
                t.finished_ts = _ts_of(t.finished_at)
                self._tasks[t.id] = t
                self._recent.append(t.id)
            self._trim_recent()
        except Exception as e:
            logger.warning("[Orchestrator] 快照读回失败: %s", e)


# updater 进程内全局单例（API 进程不 import 本模块——读写分进程）
orchestrator = UpdateOrchestrator()
