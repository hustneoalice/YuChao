"""SSE 网关：GET /api/v1/stream/sse（设计文档 06 节）。

- 频道协议 v1：data:update / kline:{symbol}:1d / corepicks:daily / license:{user_id}；
- 传输按配置切换：YUCHAO_REDIS_URL 设置 → Redis pub/sub backplane（多 worker/
  多机，每进程一条订阅连接）；缺省文件总线（同机双进程，零依赖）；
- 每连接 asyncio.Queue(maxsize=256) 背压：慢消费者丢帧靠 seq 跳号回退 REST 重拉；
- license:{user_id} 频道校验属主：JWT 走 query 参数（EventSource 不支持 header）；
- 新连接只收建立后的事件（历史靠 REST）；客户端检测频道内 seq 跳号 → 回退 REST。
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse

from ..auth import service
from ..config import settings
from ..errors import ApiError, forbidden, unauthorized
from .bus import channel_matches, make_sse_frame, tail_events
from .redis_bus import get_fanout

logger = logging.getLogger("yuchao.stream")

router = APIRouter(tags=["stream"])

_QUEUE_MAX = 256
_HEARTBEAT_S = 15.0
_POLL_S = 0.4


class _FileSource:
    """文件总线订阅：tail data/stream_events.jsonl，命中频道后入队。"""

    def __init__(self, matched: list[str] | None):
        self.matched = matched
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
        self._task: asyncio.Task | None = None

    def _poll_step(self, box: dict) -> list[dict]:
        def hit(ch: str) -> bool:
            return self.matched is None or any(channel_matches(c, ch) for c in self.matched)
        new_off, hits = tail_events(settings.stream_events_path, box["offset"], hit)
        box["offset"] = new_off
        return hits

    async def _reader(self, box: dict):
        while True:
            try:
                hits = await asyncio.to_thread(self._poll_step, box)
                for rec in hits:
                    try:
                        self.queue.put_nowait(rec)
                    except asyncio.QueueFull:            # 背压：丢最旧保最新
                        try:
                            self.queue.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                        self.queue.put_nowait(rec)
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(_POLL_S)

    async def start(self):
        box: dict = {}
        try:      # 新连接从文件尾开始：只收建立后的事件
            box["offset"] = Path(settings.stream_events_path).stat().st_size
        except OSError:
            box["offset"] = 0
        self._task = asyncio.create_task(self._reader(box))

    async def recv(self, timeout: float):
        try:
            return await asyncio.wait_for(self.queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None

    async def close(self):
        if self._task:
            self._task.cancel()


class _RedisSource:
    """Redis backplane 订阅：进程级 pub/sub 连接（get_fanout）→ 本连接队列。"""

    def __init__(self, url: str, matched: list[str] | None):
        self.url = url
        self.matched = matched
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)

    async def start(self):
        get_fanout(self.url).subscribe(self.queue)

    async def recv(self, timeout: float):
        try:
            rec = await asyncio.wait_for(self.queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None
        ch = str(rec.get("channel", ""))
        if self.matched is not None and not any(channel_matches(c, ch) for c in self.matched):
            return await self.recv(timeout)          # 本进程共享订阅，这里按连接过滤
        return rec

    async def close(self):
        get_fanout(self.url).unsubscribe(self.queue)


@router.get("/stream/sse",
            summary="事件流（data:update · kline:{symbol}:1d · corepicks:daily · license:{user_id}）")
async def stream_sse(request: Request, channels: str = "all",
                     token: str | None = Query(default=None)):
    """订阅事件频道。`channels` 逗号分隔，支持 `kline:*` 前缀通配。

    帧：`id: {channel}#{seq}` / `event: {event}` / `data: {json}`。
    license:{user_id} 频道须携带本人 JWT（?token=）；检测到频道内 seq 跳号
    → 回退对应 REST 端点重拉（06.2 跳号回退）。
    """
    wanted = [c.strip() for c in channels.split(",") if c.strip()] or ["all"]
    matched = [c for c in wanted if c != "all"] or None       # None = 全收

    # license 频道属主校验：token 必须有效且 sub 与频道 user_id 一致
    lic_channels = [c for c in wanted if c.startswith("license:")]
    if lic_channels:
        payload = service.decode_token(token) if token else None
        if not payload:
            raise unauthorized("license 频道需要 JWT（?token=）")
        for c in lic_channels:
            uid = c.split(":", 1)[1]
            if uid != "*" and uid != str(payload.get("sub")):
                raise forbidden(f"license 频道属主不匹配: {c}")

    source: _FileSource | _RedisSource = (
        _RedisSource(settings.redis_url, matched) if settings.redis_url
        else _FileSource(matched))

    async def gen():
        await source.start()
        try:
            yield "retry: 5000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                rec = await source.recv(_HEARTBEAT_S)
                yield make_sse_frame(rec) if rec else ": heartbeat\n\n"
        finally:
            await source.close()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
