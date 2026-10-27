"""M3 Redis backplane：发布/订阅 fanout、seq 单调、背压丢弃。"""
import asyncio

import pytest

fakeredis = pytest.importorskip("fakeredis")

from app.stream.redis_bus import RedisBus, RedisFanout


def _mk_server():
    server = fakeredis.FakeServer()
    sync = fakeredis.FakeRedis(server=server, decode_responses=True)
    return server, sync


def test_publish_seq_monotonic_across_publishers():
    server, sync = _mk_server()
    bus1 = RedisBus("redis://fake", client=sync)
    bus2 = RedisBus("redis://fake", client=sync)
    r1 = bus1.publish("kline:600519:1d", "kline.update", {"bar": {"c": 1}})
    r2 = bus2.publish("kline:600519:1d", "kline.update", {"bar": {"c": 2}})
    r3 = bus1.publish("data:update", "data.update", {"state": "queued"})
    assert (r1["seq"], r2["seq"]) == (1, 2)                # 跨发布实例单调
    assert r3["seq"] == 1 and r3["channel"] == "data:update"


def test_fanout_multi_subscriber_and_backpressure():
    server, sync = _mk_server()
    asy1 = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    asy2 = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    bus = RedisBus("redis://fake", client=sync)

    async def scenario():
        f1 = RedisFanout("redis://fake", client=asy1)
        f2 = RedisFanout("redis://fake", client=asy2)
        q1, q2 = asyncio.Queue(maxsize=1), asyncio.Queue(maxsize=8)
        f1.subscribe(q1)
        f2.subscribe(q2)
        try:
            await asyncio.sleep(0.05)                       # 订阅生效
            for i in range(3):
                bus.publish("kline:1:1d", "kline.update", {"i": i})
            e2 = [await asyncio.wait_for(q2.get(), 2) for _ in range(3)]
            assert [e["data"]["i"] for e in e2] == [0, 1, 2]  # 全量可达
            e1 = await asyncio.wait_for(q1.get(), 2)
            assert e1["data"]["i"] == 2                     # 背压：maxsize=1 丢最旧，收到最新
        finally:
            f1.unsubscribe(q1)
            f2.unsubscribe(q2)

    asyncio.run(scenario())


def test_fanout_unsubscribe_stops_reader():
    server, sync = _mk_server()
    asy = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)

    async def scenario():
        f = RedisFanout("redis://fake", client=asy)
        q = asyncio.Queue(maxsize=8)
        f.subscribe(q)
        await asyncio.sleep(0.05)
        task = f._task
        f.unsubscribe(q)
        await asyncio.sleep(0.05)
        assert task.done() or task.cancelled()              # 无订阅者 → 读协程停止

    asyncio.run(scenario())
