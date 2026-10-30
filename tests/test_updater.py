"""M2 测试：编排器语义（去重/冷却/串行/取消/落账/publish）+ 采集任务幂等 + SSE 总线。"""
import json

import duckdb
import pytest

from app.config import settings
from app.stream.bus import (ControlRequests, FileJournal, StreamBus,
                            channel_matches, make_sse_frame, tail_events)
from app.updater.collectors.financials import _last_periods
from app.updater.collectors.http import market_prefix, pure_of, suffixed_symbol
from app.updater.collectors.kline import _gap_count
from app.updater.orchestrator import UpdateOrchestrator
from app.updater.util import expected_asof
from app.updater.writer import writer


# ---------------------------------------------------------------------------
# 夹具：updater 写连接指向临时库（真实 schema，含 update_log）
# ---------------------------------------------------------------------------

# updater_env 夹具已提升至 conftest.py（采集/编排/自愈多文件共用）

# ---------------------------------------------------------------------------
# 纯函数口径
# ---------------------------------------------------------------------------

def test_market_prefix_bj_before_sh():
    # 1.0 教训：920 段必须先于首位判定（9 开头会误判沪市）
    assert market_prefix("920091") == "bj"
    assert market_prefix("600519") == "sh"
    assert market_prefix("000858") == "sz"
    assert market_prefix("300750") == "sz"
    assert market_prefix("688981") == "sh"


def test_symbol_converters():
    assert pure_of("000001.SH") == "000001"
    assert suffixed_symbol("600519") == "600519.SH"


def test_gap_count():
    assert _gap_count(None, "2026-10-27") == 3000          # 新标的建底仓
    # 缺口 3 个自然日 → 3*1.6+20 ≈ 24 → 下限 30
    assert _gap_count("2026-10-24", "2026-10-27") == 30
    # 缺口 2500 天 → 封顶 3000
    assert _gap_count("2020-01-31", "2026-10-27") == 3000


def test_last_periods():
    ps = _last_periods(2)
    assert len(ps) == 2 and ps[0] > ps[1]
    assert ps[0] in ("2026-09-30", "2026-12-31")
    assert ps[0].endswith(("-03-31", "-06-30", "-09-30", "-12-31"))


def test_expected_asof_weekend(monkeypatch):
    from datetime import datetime
    from app.updater import util

    # 2026-10-24 是周六 → 上一交易日周五 10-23
    assert expected_asof(datetime(2026, 10, 24, 12, 0)) == "2026-10-23"
    # 交易日 15:09（未收盘）→ 前一日；15:11 → 当日
    assert expected_asof(datetime(2026, 10, 27, 15, 9)) == "2026-10-26"
    assert expected_asof(datetime(2026, 10, 27, 15, 11)) == "2026-10-27"


# ---------------------------------------------------------------------------
# 编排器语义（1.0 update_orchestrator 移植验证）
# ---------------------------------------------------------------------------

def _make_orch(tmp_path):
    bus = StreamBus(tmp_path / "events.jsonl")
    orch = UpdateOrchestrator(snapshot_path=tmp_path / "progress.json", bus=bus)
    return orch, bus


def test_orchestrator_dedup_and_serial(updater_env, tmp_path):
    orch, bus = _make_orch(tmp_path)
    order = []

    def make_task(name, dur):
        def fn(progress, ctx):
            progress(stage="跑", total=1, done=0)
            import time
            time.sleep(dur)
            order.append(name)
            return {"rows": 1}
        return fn

    # 时长给足（1.2s）：两次 submit 之间 dedup 窗口必须稳命中——
    # 机器负载高时 0.15s 的任务可能在第二次 submit 前就跑完，断言会 flaky
    orch.register("a", "任务A", make_task("a", 1.2), cooldown_s=0)
    orch.register("b", "任务B", make_task("b", 0.0), cooldown_s=0)

    r1 = orch.submit("a", trigger="manual")
    r2 = orch.submit("a", trigger="manual")      # 同 kind 执行中 → 去重复用
    assert r1["ok"] and r2["ok"] and r2.get("deduped") is True
    assert r1["task"]["id"] == r2["task"]["id"]

    orch.submit("b", trigger="manual")           # 排队，串行在 A 之后
    import time
    deadline = time.time() + 5
    while time.time() < deadline and len(order) < 2:
        time.sleep(0.05)
    assert order == ["a", "b"]                   # 串行：A 结束 B 才跑
    snap = orch.snapshot()
    assert snap["busy"] is False
    assert [t["status"] for t in snap["recent"][:2]] == ["completed", "completed"]


def test_orchestrator_cooldown(updater_env, tmp_path):
    orch, _ = _make_orch(tmp_path)
    import time

    def quick(p, c):
        time.sleep(0.3)                          # 留时间窗口，避免走去重路径
        return {"rows": 0}

    orch.register("x", "任务X", quick, cooldown_s=600)
    r1 = orch.submit("x", trigger="selfheal")
    assert r1["ok"]
    deadline = time.time() + 5
    while time.time() < deadline and orch.snapshot()["busy"]:
        time.sleep(0.05)                         # 等第一次执行完
    r2 = orch.submit("x", trigger="selfheal")    # 冷却内 → 拒绝（非失败）
    assert r2["ok"] is False and r2["cooldown"] is True
    r3 = orch.submit("x", trigger="manual")      # manual 不受冷却约束
    assert r3["ok"] is True


def test_orchestrator_unknown_kind(updater_env, tmp_path):
    orch, _ = _make_orch(tmp_path)
    r = orch.submit("nope")
    assert r["ok"] is False and "未注册" in r["error"]


def test_orchestrator_cancel_queued(updater_env, tmp_path):
    orch, _ = _make_orch(tmp_path)
    import time

    def slow(p, c):
        time.sleep(0.4)
        return {"rows": 0}

    orch.register("slow", "慢任务", slow, cooldown_s=0)
    orch.register("next", "后任务", lambda p, c: {"rows": 0}, cooldown_s=0)
    orch.submit("slow")
    orch.submit("next")
    time.sleep(0.1)
    r = orch.cancel()                            # 取消当前运行中的
    assert r["ok"] is True
    deadline = time.time() + 5
    while time.time() < deadline:
        snap = orch.snapshot()
        if not snap["busy"]:
            break
        time.sleep(0.05)
    assert orch.snapshot()["busy"] is False


def test_orchestrator_failure_and_ledger(updater_env, tmp_path):
    orch, _ = _make_orch(tmp_path)

    def boom(p, c):
        raise RuntimeError("数据源整体不可达")

    orch.register("boom", "会炸", boom, cooldown_s=0)
    orch.submit("boom", trigger="manual")
    import time
    deadline = time.time() + 5
    while time.time() < deadline:
        snap = orch.snapshot()
        if not snap["busy"]:
            break
        time.sleep(0.05)
    t = orch.snapshot()["recent"][0]
    assert t["status"] == "failed"
    assert "数据源整体不可达" in t["error"]

    # 落账：update_log 必须留一行（1.0 record_update 语义）
    conn = duckdb.connect(str(updater_env))
    rows = conn.execute(
        "SELECT data_type, status, error FROM update_log WHERE data_type='boom'"
    ).fetchall()
    conn.close()
    assert len(rows) == 1 and rows[0][1] == "failed" and "不可达" in rows[0][2]


def test_orchestrator_publishes_data_update(updater_env, tmp_path):
    orch, bus = _make_orch(tmp_path)
    orch.register("p", "发布任务", lambda p, c: {"rows": 3}, cooldown_s=0)
    orch.submit("p", trigger="manual")
    import time
    deadline = time.time() + 5
    while time.time() < deadline and not orch.snapshot()["recent"]:
        time.sleep(0.05)

    # data:update 频道应收到 queued/running/completed 三态（06.2 协议）
    events = [json.loads(l) for l in
              (tmp_path / "events.jsonl").read_text().splitlines() if l.strip()]
    du = [e for e in events if e["channel"] == "data:update"]
    states = [e["data"]["state"] for e in du]
    assert states == ["queued", "running", "completed"]
    assert du[-1]["data"]["rows"] == 3
    assert du[-1]["data"]["data_type"] == "p"
    # seq 频道内单调
    seqs = [e["seq"] for e in du]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)


def test_orchestrator_snapshot_recovery(updater_env, tmp_path):
    orch, _ = _make_orch(tmp_path)
    orch.register("done", "完成的", lambda p, c: {"rows": 7}, cooldown_s=0)
    orch.submit("done")
    import time
    deadline = time.time() + 5
    while time.time() < deadline and not orch.snapshot()["recent"]:
        time.sleep(0.05)

    # 新编排器从快照读回历史任务（含耗时重建）
    orch2 = UpdateOrchestrator(snapshot_path=tmp_path / "progress.json",
                               bus=StreamBus(tmp_path / "events.jsonl"))
    orch2._load_snapshot()
    recent = orch2.snapshot()["recent"]
    assert recent and recent[0]["rows"] == 7
    assert recent[0]["status"] == "completed"
    t = next(x for x in orch2._tasks.values())
    assert t.elapsed_s() is not None and t.elapsed_s() >= 0


# ---------------------------------------------------------------------------
# 采集任务写库（mock 数据源，真实 DuckDB）
# ---------------------------------------------------------------------------

def test_kline_task_increment(updater_env, tmp_path, monkeypatch):
    from app.updater.collectors import kline as kmod

    monkeypatch.setattr(kmod, "expected_asof", lambda: "2026-11-02")

    def fake_tx(code, count=3000):
        assert code in ("600519", "000858", "300750")
        last = {"600519": (1506.0, 1506.5), "000858": (125.5, 126.0),
                "300750": (205.0, 206.0)}[code]          # 贴各自前收盘
        return [
            {"t": "2026-11-02", "o": last[0], "h": last[1] + 2, "l": last[0] - 2,
             "c": last[1], "v": 100, "amount": 150.0,
             "pct_chg": None, "turnover_rate": None},
        ]

    monkeypatch.setattr(kmod.sources, "fetch_kline_tx", fake_tx)
    monkeypatch.setattr(kmod.sources, "fetch_kline_em",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("不该用备用车道")))

    bus = StreamBus(tmp_path / "k.jsonl")
    res = kmod.update_kline(progress=None, ctx={"bus": bus, "cancel_check": lambda: False})
    assert res["status"] == "success" and res["rows"] == 3

    conn = duckdb.connect(str(updater_env))
    rows = conn.execute(
        "SELECT symbol, date, close, pct_chg FROM daily_ohlcv WHERE date='2026-11-02' "
        "ORDER BY symbol").fetchall()
    conn.close()
    assert len(rows) == 3
    # pct 补算：前收盘 1505.9 → (1506.5/1505.9-1)*100 ≈ 0.04
    assert rows[0][3] is not None and abs(rows[0][3]) < 1.0

    # kline:{symbol}:1d 事件（最后一根 bar）
    events = [json.loads(l) for l in
              (tmp_path / "k.jsonl").read_text().splitlines() if l.strip()]
    assert {e["channel"] for e in events} == {"kline:600519:1d", "kline:000858:1d",
                                              "kline:300750:1d"}
    ev = next(e for e in events if e["channel"] == "kline:600519:1d")
    assert ev["event"] == "kline.update" and ev["data"]["bar"]["t"] == "2026-11-02"
    assert ev["data"]["closed"] is True


def test_valuation_task(updater_env, tmp_path, monkeypatch):
    from app.updater.collectors import valuation as vmod

    monkeypatch.setattr(vmod, "expected_asof", lambda: "2026-11-02")
    monkeypatch.setattr(
        vmod.sources, "fetch_valuation_snapshot",
        lambda progress=None, cancel=None: (
            {"600519": (25.0, 8.0, 2.1e12, 2.1e12, 5.2e9),        # 正常
             "000858": (18.0, 4.0, 5.6e11, 5.6e11, None)},        # 无成交 → 停牌旁表
            {"600519": "2001-08-27"},
            {"600519": "酿酒行业"},
        ))

    res = vmod.update_valuation(progress=None, ctx={"cancel_check": lambda: False})
    assert res["status"] == "success" and res["rows"] == 2

    conn = duckdb.connect(str(updater_env))
    val = conn.execute(
        "SELECT pe_ttm, amount FROM daily_valuation WHERE date='2026-11-02' "
        "AND symbol='600519'").fetchone()
    susp = conn.execute(
        "SELECT suspended FROM trade_status_daily WHERE date='2026-11-02' "
        "AND symbol='000858'").fetchone()
    ind = conn.execute(
        "SELECT industry FROM stock_universe WHERE symbol='600519'").fetchone()
    conn.close()
    assert val == (25.0, 5.2e9)
    assert susp == (True,)
    assert ind[0] == "酿酒行业"


def test_pe_percentile_rebuild(updater_env):
    from app.updater.collectors import pe_percentile as pmod

    res = pmod.rebuild_pe_percentile(progress=None, ctx=None)
    assert res["status"] == "success"
    conn = duckdb.connect(str(updater_env))
    rows = conn.execute(
        "SELECT symbol, pe_ttm, pe_percentile FROM pe_percentile ORDER BY symbol"
    ).fetchall()
    conn.close()
    # 600519 PE 22.5 < 000858 18.1？→ 000858 分位更低
    m = {r[0]: r for r in rows}
    assert m["600519"][2] > m["000858"][2]
    assert m["600519"][1] == 22.5                # pe_ttm 同步刷新（1.0 教训）


def test_sector_index_task(updater_env, tmp_path, monkeypatch):
    from app.updater.collectors import sector_index as smod

    monkeypatch.setattr(smod, "expected_asof", lambda: "2026-11-02")
    monkeypatch.setattr(
        smod.sources, "fetch_sector_snapshot",
        lambda progress=None, cancel=None: [
            {"industry": "白酒", "code": "BK0477", "close": 3200.0,
             "pct_change": 2.0, "up_count": 20, "down_count": 1,
             "leader": "贵州茅台", "leader_change": 3.1}])

    res = smod.update_sector_index(progress=None, ctx={"cancel_check": lambda: False})
    assert res["status"] == "success" and res["rows"] == 1
    conn = duckdb.connect(str(updater_env))
    n = conn.execute(
        "SELECT COUNT(*) FROM sector_index WHERE trade_date='2026-11-02'").fetchone()[0]
    conn.close()
    assert n == 1


# ---------------------------------------------------------------------------
# 流总线（文件 backplane，M3 换 Redis 接口不变）
# ---------------------------------------------------------------------------

def test_file_journal_roundtrip(tmp_path):
    j = FileJournal(tmp_path / "j.jsonl")
    j.append({"a": 1})
    j.append({"b": "中文"})
    off, recs = 0, []
    for off2, r in j.iter_from(0):
        off, recs = off2, recs + [r]
    assert recs == [{"a": 1}, {"b": "中文"}]
    # 偏移推进后无新数据
    assert list(j.iter_from(off)) == []
    # 半行（崩溃残留）被忽略，不破坏后续读取
    with open(j.path, "a", encoding="utf-8") as f:
        f.write("not-json-garbage\n")
    j.append({"c": 3})
    got = [r for _, r in j.iter_from(off)]
    assert got == [{"c": 3}]


def test_stream_bus_seq_monotonic_and_seed(tmp_path):
    p = tmp_path / "events.jsonl"
    b1 = StreamBus(p)
    for i in range(3):
        b1.publish("ch", "ev", {"i": i})
    b2 = StreamBus(p)                            # 重启 → 从文件尾部恢复 seq
    rec = b2.publish("ch", "ev", {"i": 3})
    assert rec["seq"] == 4                       # 不回卷


def test_channel_matches():
    assert channel_matches(None, "kline:600519:1d")
    assert channel_matches("all", "data:update")
    assert channel_matches("kline:*", "kline:600519:1d")
    assert not channel_matches("kline:*", "data:update")
    assert channel_matches("data:update", "data:update")


def test_sse_frame_format():
    f = make_sse_frame({"seq": 7, "channel": "kline:600519:1d",
                        "event": "kline.update", "data": {"c": 1500.0}})
    assert f == ("id: kline:600519:1d#7\n"
                 "event: kline.update\n"
                 'data: {"c": 1500.0}\n\n')


def test_tail_events_filter(tmp_path):
    p = tmp_path / "t.jsonl"
    b = StreamBus(p)
    b.publish("data:update", "data.update", {"x": 1})
    b.publish("kline:600519:1d", "kline.update", {"x": 2})
    b.publish("kline:000858:1d", "kline.update", {"x": 3})
    off, hits = tail_events(p, 0, lambda ch: ch.startswith("kline:"))
    assert [h["data"]["x"] for h in hits] == [2, 3]


def test_control_requests_roundtrip(tmp_path):
    cr = ControlRequests(tmp_path / "c.jsonl")
    rid = cr.submit("valuation", force=True)
    off, reqs = cr.poll(0)
    assert len(reqs) == 1 and reqs[0]["id"] == rid
    assert reqs[0]["kind"] == "valuation" and reqs[0]["force"] is True
    assert cr.poll(off)[1] == []                 # 偏移推进后为空


# ---------------------------------------------------------------------------
# API 侧（只读进程 → 控制通道触发）
# ---------------------------------------------------------------------------

def test_api_update_trigger_202(client, monkeypatch, tmp_path):
    monkeypatch.setattr("app.config.settings.control_requests_path",
                        tmp_path / "c.jsonl")
    # 提交前有 updater 心跳探测（停机期请求会被控制通道 offset 跳过）
    monkeypatch.setattr("app.routers.v1.data._updater_alive", lambda **kw: True)
    r = client.post("/api/v1/data/update", json={"kind": "valuation"})
    assert r.status_code == 202
    body = r.json()
    assert body["accepted"] is True and body["kind"] == "valuation"
    # 控制文件确实落了一行（updater 进程 2s 内消费）
    recs = [json.loads(l) for l in
            (tmp_path / "c.jsonl").read_text().splitlines() if l.strip()]
    assert recs and recs[0]["kind"] == "valuation"


def test_api_update_trigger_offline_503(client, monkeypatch, tmp_path):
    """updater 不在线（无心跳快照）→ 503 明确报错，而不是静默丢失请求。"""
    monkeypatch.setattr("app.config.settings.control_requests_path",
                        tmp_path / "c.jsonl")
    monkeypatch.setattr("app.config.settings.update_snapshot_path",
                        tmp_path / "missing.json")
    r = client.post("/api/v1/data/update", json={"kind": "valuation"})
    assert r.status_code == 503
    assert "更新进程未运行" in r.json()["detail"]
    assert not (tmp_path / "c.jsonl").exists()      # 不落请求行


def test_api_update_unknown_kind_422(client, monkeypatch, tmp_path):
    monkeypatch.setattr("app.config.settings.control_requests_path",
                        tmp_path / "c.jsonl")
    r = client.post("/api/v1/data/update", json={"kind": "not_a_task"})
    assert r.status_code == 422 and r.json()["code"] == "invalid_param"
    assert "valuation" in str(r.json()["detail"])   # available 列表带出来了


def test_api_data_tasks(client):
    r = client.get("/api/v1/data/tasks")
    assert r.status_code == 200
    body = r.json()
    kinds = {t["kind"] for t in body["items"]}
    assert {"valuation", "kline_update", "capital_flow", "corepicks"} <= kinds
    crons = {c["kind"]: c["cron"] for c in body["schedule"]}
    assert crons["valuation"] == "交易日 16:20"
    assert crons["adjust_factor"] == "周六 09:00"


def test_api_updates_ledger(duckdb_file, client):
    # updater 侧写一行落账（模拟），API 只读查询
    from app.updater.writer import UPDATE_LOG_DDL

    w = duckdb.connect(str(duckdb_file))
    for stmt in UPDATE_LOG_DDL.split(";"):
        if stmt.strip():
            w.execute(stmt)
    w.execute("INSERT INTO update_log (id, data_type, status, rows, error, detail, "
              "trigger, created_at) VALUES ('t1','valuation','completed',5400,'',''"
              ",'cron', '2026-10-27 16:20:00')")
    w.close()
    r = client.get("/api/v1/data/updates")
    assert r.status_code == 200
    items = r.json()["items"]
    assert len(items) == 1 and items[0]["data_type"] == "valuation"
    assert items[0]["rows"] == 5400 and items[0]["status"] == "completed"
