"""流总线（backplane）：updater「发布」→ API「订阅」的跨进程通道。

M2 用**文件总线**（同机双进程，零依赖）：updater 进程 append 事件行到
`data/stream_events.jsonl`，API 进程的 SSE 网关 tail 同一文件做本地 fanout。
Redis pub/sub backplane 属 M3（设计文档 10 节）——届时实现 RedisBus 替换，
`publish()` / `iter_events()` 接口不变，SSE 网关与编排器无需改动。

控制方向同理：API 进程把 POST /data/update 写进 `data/control_requests.jsonl`，
updater 常驻 tail 后提交编排器（API 进程只读 DuckDB，不能直接入队）。

行格式（JSONL，一行一事件，全部字段 JSON 安全）：
    {"seq": 17, "channel": "kline:600519:1d", "event": "kline.update",
     "data": {...}, "ts": 1730000000123}
seq 为**频道内**单调递增，客户端检测跳号 → 回退 REST 重拉（设计文档 06.2）。
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Iterator


class FileJournal:
    """JSONL 追加 / 增量读取。文件被轮转（变小）时读取方自动归零。"""

    ROTATE_BYTES = 16 * 1024 * 1024      # 超过 16MB 在下次 append 时轮转

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def append(self, record: dict) -> None:
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock:
            if self.path.exists() and self.path.stat().st_size > self.ROTATE_BYTES:
                # 简单轮转：超限直接截断（事件是瞬时的，消费方靠 seq 跳号回退 REST）
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text("", encoding="utf-8")
                os.replace(tmp, self.path)
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line)

    def iter_from(self, offset: int) -> Iterator[tuple[int, dict]]:
        """从字节偏移读取新记录；返回 (新偏移, 记录)。文件轮转（变小）则从头读。"""
        try:
            size = self.path.stat().st_size
        except OSError:
            return
        if size < offset:                    # 被轮转/截断：归零重读
            offset = 0
        if size == offset:
            return
        with open(self.path, "r", encoding="utf-8") as f:
            f.seek(offset)
            for line in f:
                offset += len(line.encode("utf-8"))
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:     # 半行（append 中断）→ 忽略
                    continue
                yield offset, rec


class StreamBus:
    """发布侧：维护频道内 seq（状态由事件文件本身恢复——重启扫尾部取最大 seq）。"""

    def __init__(self, events_path: str | Path):
        self.journal = FileJournal(events_path)
        self._seq: dict[str, int] = {}
        self._seeded = False

    def _seed(self) -> None:
        """从既有文件尾部恢复各频道最大 seq，保证重启不回卷。"""
        self._seeded = True
        try:
            size = self.journal.path.stat().st_size
        except OSError:
            return
        start = max(0, size - 256 * 1024)    # 只扫尾部 256KB，够恢复最近 seq
        for _, rec in self.journal.iter_from(start):
            ch, sq = rec.get("channel"), rec.get("seq")
            if isinstance(ch, str) and isinstance(sq, int):
                self._seq[ch] = max(self._seq.get(ch, 0), sq)

    def publish(self, channel: str, event: str, data: dict) -> dict:
        if not self._seeded:
            self._seed()
        seq = self._seq.get(channel, 0) + 1
        self._seq[channel] = seq
        rec = {"seq": seq, "channel": channel, "event": event,
               "data": data, "ts": int(time.time() * 1000)}
        self.journal.append(rec)
        return rec


class ControlRequests:
    """API → updater 控制通道：POST /data/update 落一行请求，updater tail 消费。"""

    def __init__(self, path: str | Path):
        self.journal = FileJournal(path)

    def submit(self, kind: str, force: bool = False, params: dict | None = None) -> str:
        rid = uuid.uuid4().hex[:12]
        self.journal.append({"id": rid, "kind": kind, "force": bool(force),
                             "params": params or {}, "ts": int(time.time() * 1000)})
        return rid

    def poll(self, offset: int) -> tuple[int, list[dict]]:
        """updater 侧轮询：返回 (新偏移, 新请求列表)。"""
        reqs: list[dict] = []
        for new_off, rec in self.journal.iter_from(offset):
            offset = new_off
            if rec.get("kind"):
                reqs.append(rec)
        return offset, reqs


def channel_matches(subscribed: str | None, channel: str) -> bool:
    """频道匹配：None/all → 全收；`kline:*` 前缀通配；其余精确匹配。"""
    if not subscribed or subscribed == "all":
        return True
    if subscribed == channel:
        return True
    if subscribed.endswith("*"):
        return channel.startswith(subscribed[:-1])
    return False


def make_sse_frame(rec: dict) -> str:
    """记录 → SSE 帧（id=seq·频道，event=事件名，data=负载 JSON）。"""
    payload = json.dumps(rec.get("data") or {}, ensure_ascii=False)
    return (f"id: {rec.get('channel', '')}#{rec.get('seq', 0)}\n"
            f"event: {rec.get('event', 'message')}\n"
            f"data: {payload}\n\n")


def make_publisher():
    """发布侧工厂：按配置返回 RedisBus 或 FileBus 的 StreamBus。

    updater 主链路与 API 进程（vip.changed 等）共用。发布方向上事件源互不
    重叠（data:update/kline:* 只出自 updater，license:* 只出自 API），
    文件总线的频道内 seq 不会互相踩踏；Redis 总线 seq 由 INCR 保证单调。
    """
    from ..config import settings
    if settings.redis_url:
        from .redis_bus import RedisBus
        return RedisBus(settings.redis_url)
    return StreamBus(settings.stream_events_path)


def tail_events(events_path: str | Path, offset: int,
                matcher: Callable[[str], bool]) -> tuple[int, list[dict]]:
    """SSE 网关侧：读新事件并按频道过滤。返回 (新偏移, 命中事件)。"""
    hits: list[dict] = []
    j = FileJournal(events_path)
    for new_off, rec in j.iter_from(offset):
        offset = new_off
        if matcher(str(rec.get("channel", ""))):
            hits.append(rec)
    return offset, hits
