"""Redis backplane（设计文档 03/06 节，M3）：多 worker / 多机事件 fanout。

- 发布侧 RedisBus：`publish()` 接口与 FileBus 的 StreamBus 完全一致；
  频道内 seq 用 Redis INCR（`yuchao:seq:{channel}`）——跨进程、跨重启单调，
  客户端跳号回退 REST 的语义不变。
- 订阅侧 RedisFanout：每个 API 进程一条 pub/sub 连接（懒启动），事件落到
  本进程后再分发进各 SSE 连接的有界队列（背压丢最旧保最新，同文件总线）。

事件信封与文件总线相同（{seq, channel, event, data, ts}），SSE 帧格式
复用 bus.make_sse_frame——客户端无感。redis 包为可选依赖：未安装或未配置
YUCHAO_REDIS_URL 时全程不 import（文件总线兜底，单机双进程够用）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Optional

logger = logging.getLogger("yuchao.stream")

CHANNEL = "yuchao:stream"                 # 单频道广播 + 订阅侧按频道过滤


class RedisBus:
    """发布侧（updater / API 进程共用）。"""

    def __init__(self, url: str, client=None):
        self.url = url
        self._client = client             # 测试可注入 fakeredis

    def _conn(self):
        if self._client is not None:
            return self._client
        import redis
        return redis.Redis.from_url(self.url, decode_responses=True)

    def publish(self, channel: str, event: str, data: dict) -> dict:
        r = self._conn()
        try:
            seq = int(r.incr(f"yuchao:seq:{channel}"))
        finally:
            if self._client is None:
                try:
                    r.close()
                except Exception:
                    pass
        rec = {"seq": seq, "channel": channel, "event": event,
               "data": data, "ts": int(time.time() * 1000)}
        r.publish(CHANNEL, json.dumps(rec, ensure_ascii=False, separators=(",", ":")))
        return rec


class RedisFanout:
    """订阅侧：每 API 进程单例；一条 pub/sub 连接分发到所有本地订阅队列。"""

    def __init__(self, url: str, client=None):
        self.url = url
        self._client = client
        self._subs: dict[asyncio.Queue, None] = {}
        self._task: Optional[asyncio.Task] = None

    async def _reader(self):
        import redis.asyncio as aredis
        r = self._client or aredis.Redis.from_url(self.url, decode_responses=True)
        pubsub = r.pubsub()
        try:
            await pubsub.subscribe(CHANNEL)
            async for msg in pubsub.listen():
                if msg.get("type") != "message":
                    continue
                try:
                    rec = json.loads(msg["data"])
                except (TypeError, ValueError):
                    continue
                for q in list(self._subs):
                    try:
                        q.put_nowait(rec)
                    except asyncio.QueueFull:      # 背压：丢最旧保最新
                        try:
                            q.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                        q.put_nowait(rec)
        except asyncio.CancelledError:
            raise
        except Exception:                          # 断线由订阅方重建（SSE 重连）
            logger.warning("[RedisFanout] 订阅中断", exc_info=True)
        finally:
            try:
                await pubsub.aclose()
                if self._client is None:
                    await r.aclose()
            except Exception:
                pass

    def subscribe(self, queue: asyncio.Queue) -> None:
        """注册本地队列（须在事件循环内调用）；首订阅懒启动读协程。"""
        self._subs[queue] = None
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(
                self._reader(), name="redis-fanout")

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subs.pop(queue, None)
        if not self._subs and self._task and not self._task.done():
            self._task.cancel()
            self._task = None


_fanouts: dict[str, RedisFanout] = {}


def get_fanout(url: str) -> RedisFanout:
    """进程级单例（同一 URL 复用一条 pub/sub 连接）。"""
    fanout = _fanouts.get(url)
    if fanout is None:
        fanout = RedisFanout(url)
        _fanouts[url] = fanout
    return fanout
