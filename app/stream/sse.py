"""SSE 网关：GET /api/v1/stream/sse（设计文档 06 节）。

M2 进程模型：updater 落账后 publish → 文件总线 → 本进程 tail → 有界队列 → SSE。
- 频道协议 v1：data:update / kline:{symbol}:1d / corepicks:daily（news/license 属 M3）；
- 每连接 asyncio.Queue(maxsize=256) 背压：慢消费者丢帧靠 seq 跳号回退 REST 重拉；
- 断线续传：Last-Event-ID（`channel#seq`）→ 之前的事件不重放（M2 语义：跳号由
  客户端识别后回退 REST；服务端补发快照帧随 M3 Redis backplane 一起做）。
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from ..config import settings
from .bus import channel_matches, make_sse_frame, tail_events

logger = logging.getLogger("yuchao.stream")

router = APIRouter(tags=["stream"])

_QUEUE_MAX = 256
_HEARTBEAT_S = 15.0
_POLL_S = 0.4


@router.get("/stream/sse", summary="事件流（频道协议 v1：data:update · kline:{symbol}:1d · corepicks:daily）")
async def stream_sse(request: Request, channels: str = "all"):
    """订阅事件频道。`channels` 逗号分隔，支持 `kline:*` 前缀通配。

    帧：`id: {channel}#{seq}` / `event: {event}` / `data: {json}`。
    客户端检测频道内 seq 跳号 → 回退对应 REST 端点重拉（06.2 跳号回退）。
    """
    wanted = [c.strip() for c in channels.split(",") if c.strip()] or ["all"]
    matched = [c for c in wanted if c != "all"] or None       # None = 全收

    async def gen():
        queue: asyncio.Queue = asyncio.Queue(maxsize=_QUEUE_MAX)
        # 新连接从文件尾开始：只收建立后的事件（历史重放靠 REST；
        # Last-Event-ID 断点续传随 M3 Redis backplane 一起做）
        try:
            box = {"offset": Path(settings.stream_events_path).stat().st_size}
        except OSError:
            box = {"offset": 0}

        def poll_step() -> tuple[int, list[dict]]:
            def hit(ch: str) -> bool:
                return matched is None or any(channel_matches(c, ch) for c in matched)
            new_off, hits = tail_events(settings.stream_events_path,
                                        box["offset"], hit)
            box["offset"] = new_off
            return new_off, hits

        async def reader():
            while True:
                try:
                    _, hits = await asyncio.to_thread(poll_step)
                    for rec in hits:
                        try:
                            queue.put_nowait(rec)
                        except asyncio.QueueFull:             # 背压：丢最旧保最新
                            try:
                                queue.get_nowait()
                            except asyncio.QueueEmpty:
                                pass
                            queue.put_nowait(rec)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    pass
                await asyncio.sleep(_POLL_S)

        task = asyncio.create_task(reader())
        try:
            yield "retry: 5000\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    rec = await asyncio.wait_for(queue.get(), timeout=_HEARTBEAT_S)
                    yield make_sse_frame(rec)
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"               # 保活，防代理掐空闲连接
        finally:
            task.cancel()

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
