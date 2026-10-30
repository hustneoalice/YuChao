"""自愈心跳（P1）：失败自动重试 + 错过链位补偿。

为什么放在 updater 进程内（而非 API 侧）：编排器队列只有本进程能提交
（API 经控制通道只能落请求文件），自愈要入队就必须与编排器同进程；
且失败判定依赖落账回调，同进程零延迟、不依赖 DuckDB 连接（写锁
持有期间任何只读连接都会被拒——自愈绝不能反过来挤占数据任务）。

两件事（设计文档「更新失败(重试/多源降级/告警)→已就绪」状态机落地）：

1. 失败重试：编排器落账 status=failed 时 on_record 记账；tick 周期检查
   未超过重试上限的失败任务，按指数退避（2min/10min/30min，最多 3 次）
   以 trigger=selfheal 重新入队。任务 completed/skipped 即清零计数。

2. 错过补偿（misfire）：APScheduler 的 coalesce 只覆盖进程存活窗口；
   updater 停机跨过 17:00（如部署机重启）后，当日 K 线增量就永远丢了。
   tick 对每个链位检查「当日链位已过 15min 宽限 且 账本无当日成功落账
   且该 kind 不在队/执行中」→ 补触发一次。判定读 selfheal_ledger.json
   （on_record 维护，落盘持久化），不查 update_log——规避写锁。

边界与安全：
- 全部动作经 orchestrator.submit 的去重（在队/执行中复用）与冷却兜底，
  自愈自身不再发明第二套去重；
- 补触发用默认冷却（600s）：自愈循环 bug 也不至于把队列打爆；
  失败重试用 force=True（自带退避间隔，冷却无意义反而挡住重试）；
- 账本按日重置：非交易日不补漏（调度链同款节假日守卫）。
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

from ..config import settings
from .registry import CRON_CHAIN, TASKS, WEEKLY
from .trading_calendar import is_trading_day
from .util import now_cst

logger = logging.getLogger("yuchao.updater")

_MAX_RETRIES = 3
_BACKOFF_S = (120, 600, 1800)   # 第 n 次失败后等待再重试的秒数
_MISFIRE_GRACE_S = 15 * 60      # 链位过点宽限：17:00:00~17:15 之间不算错过
# 推送类任务不参与链位补偿：早报错过盘前时点无补发价值（内容是昨夜
# 核心标，白天补发语义错乱），次日 08:35 自然恢复；失败重试路径保留。
_NOTIFY_KINDS = {t["kind"] for t in TASKS if t.get("notify")}


class Selfheal:
    """失败重试 + 错过补偿。updater 进程内单例；所有方法可在任意线程调用。"""

    def __init__(self, ledger_path: str | Path | None = None):
        self.ledger_path = Path(ledger_path or settings.selfheal_ledger_path)
        self._lock = threading.RLock()
        self._state: Dict[str, Any] = {}
        self._loaded = False
        self._last_tick = 0.0
        self.tick_interval_s = 60.0     # 主循环按 control_poll_s 高频调 tick，内部节流

    # -- 账本 -------------------------------------------------------------

    def _load(self) -> None:
        if self._loaded:
            return
        try:
            self._state = json.loads(self.ledger_path.read_text(encoding="utf-8"))
        except Exception:
            self._state = {}
        self._loaded = True

    def _save(self) -> None:
        try:
            self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.ledger_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._state, ensure_ascii=False, indent=2),
                           encoding="utf-8")
            tmp.replace(self.ledger_path)
        except Exception as e:
            logger.debug("[Selfheal] 账本落盘失败: %s", e)

    def _day(self) -> str:
        return now_cst().strftime("%Y-%m-%d")

    def _roll_day(self) -> None:
        if self._state.get("date") != self._day():
            self._state = {"date": self._day(), "kinds": {}}

    def entry(self, kind: str) -> Dict[str, Any]:
        self._load()
        with self._lock:
            self._roll_day()
            return self._state.setdefault("kinds", {}).setdefault(kind, {})

    # -- 落账回调（编排器注入） --------------------------------------------

    def on_record(self, kind: str, status: str, error: str = "") -> None:
        """编排器每次落账后调用。completed/skipped 清零失败计数。"""
        if status in ("completed", "skipped"):
            e = self.entry(kind)
            e.update({"ok_at": _now(), "fails": 0, "retries": 0, "error": ""})
        elif status == "failed":
            e = self.entry(kind)
            e["fails"] = int(e.get("fails") or 0) + 1
            e["failed_at"] = _now()
            e["error"] = (error or "")[:300]
        else:                                # cancelled / interrupted 不记账
            return
        with self._lock:
            self._save()

    # -- 心跳 -------------------------------------------------------------

    def tick(self, orchestrator, force: bool = False) -> None:
        """updater 主循环周期调用；内部节流到 tick_interval_s。"""
        now = time.monotonic()
        if not force and (now - self._last_tick) < self.tick_interval_s:
            return
        self._last_tick = now
        try:
            self._retry_failed(orchestrator)
            self._catch_up_missed(orchestrator)
        except Exception:
            logger.exception("[Selfheal] 心跳异常（下个周期再试）")

    def _retry_failed(self, orchestrator) -> None:
        """失败任务指数退避重试：第 n 次失败后等 _BACKOFF_S[n-1] 再试。"""
        self._load()
        with self._lock:
            self._roll_day()
            kinds = dict(self._state.get("kinds") or {})
        for kind, e in kinds.items():
            fails = int(e.get("fails") or 0)
            failed_at = _parse(e.get("failed_at"))
            if fails <= 0 or fails > _MAX_RETRIES or not failed_at:
                continue
            wait = _BACKOFF_S[min(fails, len(_BACKOFF_S)) - 1]
            if time.time() - failed_at < wait:
                continue
            r = orchestrator.submit(kind, trigger="selfheal", force=True)
            if r.get("ok") and not r.get("deduped"):
                ent = self.entry(kind)
                ent["retries"] = int(ent.get("retries") or 0) + 1
                ent["failed_at"] = _now()      # 重置退避计时，避免每秒连发
                with self._lock:
                    self._save()
                orchestrator.log_event(
                    f"自愈：{kind} 第 {fails} 次失败，自动重试"
                    f"（{ent['retries']}/{_MAX_RETRIES}）", "warning", kind=kind)
            elif r.get("cooldown"):
                pass                           # 冷却中：下个周期再看

    def _catch_up_missed(self, orchestrator) -> None:
        """错过链位补偿：链位过点 + 宽限后仍无当日成功落账 → 补触发。

        账本按日重置，因此「当日成功落账」= entry.ok_at 存在。
        日链仅在交易日检查（节假日整天休市，采了盖幽灵日期——调度链同款
        守卫）；周链（周六复权因子）不受交易日守卫：周六本身非交易日，
        守卫会让周任务永远无法补偿。
        """
        now = now_cst()
        done = self._done_kinds()
        chain = list(CRON_CHAIN) if is_trading_day(now) else []
        if now.weekday() == 5:                 # 周六复权因子
            chain += list(WEEKLY)
        for kind, h, m in chain:
            if kind in _NOTIFY_KINDS:
                continue
            due = now.replace(hour=h, minute=m, second=0, microsecond=0)
            if now < due or (now - due).total_seconds() < _MISFIRE_GRACE_S:
                continue
            if kind in done:
                continue
            r = orchestrator.submit(kind, trigger="selfheal")
            if r.get("ok") and not r.get("deduped"):
                orchestrator.log_event(
                    f"自愈：{kind} 今日链位 {h:02d}:{m:02d} 无成功落账，补偿触发",
                    "warning", kind=kind)

    def _done_kinds(self) -> set[str]:
        """账本中当日已有成功落账的 kind 集合（账本按日重置，无需再查日期）。"""
        self._load()
        with self._lock:
            kinds = {k: dict(v) for k, v in (self._state.get("kinds") or {}).items()}
        return {k for k, e in kinds.items() if e.get("ok_at")}

    # -- 观测（API /data/health 引用同一份账本文件） ------------------------

    def snapshot(self) -> Dict[str, Any]:
        self._load()
        with self._lock:
            self._roll_day()
            return json.loads(json.dumps(self._state, ensure_ascii=False))


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _parse(iso: Optional[str]) -> Optional[float]:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso).timestamp()
    except Exception:
        return None
