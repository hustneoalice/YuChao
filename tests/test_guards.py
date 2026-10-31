"""2.x 数据底座防线教训测试：新鲜度秒跳 / 依赖传播 / 行数下限 / 失败重试 / 备份 / 日历自检。

对应策影漏洞清单（本文件就是「不让漏洞回归」的验收标准）：
  · 策影到点全量跑，数据已新也白跑          → freshness 预检测试
  · 策影上游失败下游照跑旧数据（纯时间错开）  → needs 传播测试
  · 策影「成功 45 / 失败 2786」WAF 假成功     → min_rows 下限测试
  · 策影 job 异常仅日志，漏一天次日才发现     → 失败自动重试测试
  · 策影 DuckDB 零副本，损坏=全库归零        → backup 测试
  · 策影 holidays 包过期无感知（幽灵日期）    → calendar_health 测试
"""
import time

import pytest

from app.updater.orchestrator import UpdateOrchestrator, UpdateTask
from app.updater.util import expected_asof
from app.updater.writer import writer


class FakeTimer:
    """替身 Timer：捕获参数不真等，重试策略断言用。"""

    instances: list = []

    def __init__(self, delay, fn, args=(), kwargs=None):
        self.delay, self.fn, self.args = delay, fn, args
        self.daemon = False
        self.started = False
        FakeTimer.instances.append(self)

    def start(self):
        self.started = True


@pytest.fixture()
def orch(updater_env, tmp_path, monkeypatch):
    """独立编排器实例（不碰模块级单例）；writer 已指向夹具库。"""
    from app.stream.bus import StreamBus

    FakeTimer.instances = []
    monkeypatch.setattr("app.updater.orchestrator.threading.Timer", FakeTimer)
    o = UpdateOrchestrator(snapshot_path=tmp_path / "snap.json",
                           bus=StreamBus(tmp_path / "events.jsonl"))
    yield o
    with o._lock:
        o._cancel.update({tid: True for tid in list(o._tasks)})
        if o._running_id:
            o._cancel[o._running_id] = True


def _drain(o, timeout=5.0):
    """等队列与运行位清空（串行 worker 同步语义的测试观察点）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with o._lock:
            if not o._running_id and not o._queue:
                return
        time.sleep(0.02)
    raise AssertionError("任务队列 5s 内未排空")


def _last(o, kind):
    with o._lock:
        cands = [t for t in o._tasks.values() if t.kind == kind]
    return cands[-1]


# -- 新鲜度前置秒跳 -------------------------------------------------------

def test_freshness_table_mode_skips(orch):
    day = expected_asof()
    writer.conn().execute(
        "INSERT OR REPLACE INTO daily_valuation VALUES "
        "(?,?,?,?,?,?,?,?,?)", ("600519", day, 20.0, 6.0, None, None,
                                2.0e12, 2.0e12, 2.0e8))
    writer.conn().commit()
    spec = {"freshness": {"table": "daily_valuation", "col": "date"}}

    def boom(progress, ctx):        # 预检应拦住：这个函数绝不许被调用
        raise AssertionError("数据已新仍执行了任务")

    orch.register("valuation", "全市场估值", boom, meta=spec)
    task = UpdateTask("valuation", "全市场估值", "cron")
    msg = orch._precheck(task, orch._registry["valuation"], force=False)
    assert "数据已最新" in msg


def test_freshness_stale_runs(orch, monkeypatch):
    # 夹具库的截面是 2026-10-30；把「今天」推到未来制造真实滞后场景
    monkeypatch.setattr("app.updater.orchestrator.expected_asof",
                        lambda: "2026-11-02")
    spec = {"freshness": {"table": "daily_valuation", "col": "date"}}
    called = {}

    def ok(progress, ctx):
        called["ran"] = True
        return {"rows": 2, "detail": "旧截面补跑"}

    orch.register("valuation", "全市场估值", ok, meta=spec)
    task = UpdateTask("valuation", "全市场估值", "cron")
    assert orch._precheck(task, orch._registry["valuation"], False) == ""
    assert called == {}             # _precheck 只预检不执行


def test_freshness_log_mode_skips(orch):
    writer.record_update(data_type="financials", status="completed",
                         trigger="cron")
    spec = {"freshness": {"log": True}}
    task = UpdateTask("financials", "财务数据", "cron")
    msg = orch._precheck(task, spec, False)
    assert "今日已更新过" in msg


def test_force_bypasses_freshness(orch):
    day = expected_asof()
    writer.conn().execute(
        "INSERT OR REPLACE INTO daily_valuation VALUES "
        "(?,?,?,?,?,?,?,?,?)", ("600519", day, 20.0, 6.0, None, None,
                                2.0e12, 2.0e12, 2.0e8))
    writer.conn().commit()
    spec = {"freshness": {"table": "daily_valuation", "col": "date"}}
    task = UpdateTask("valuation", "全市场估值", "manual")
    assert orch._precheck(task, spec, force=True) == ""


# -- 依赖失败传播 ---------------------------------------------------------

def test_needs_upstream_failed_skips(orch):
    writer.record_update(data_type="valuation", status="failed",
                         error="东财 clist 不可达", trigger="cron")
    spec = {"needs": ["valuation"]}
    task = UpdateTask("pe_percentile", "PE 分位重建", "cron")
    msg = orch._precheck(task, spec, False)
    assert "上游 valuation 今日失败" in msg


def test_needs_upstream_ok_runs(orch):
    writer.record_update(data_type="valuation", status="completed",
                         trigger="cron")
    spec = {"needs": ["valuation"]}
    task = UpdateTask("pe_percentile", "PE 分位重建", "cron")
    assert orch._precheck(task, spec, False) == ""


def test_needs_no_record_today_runs(orch):
    """上游今天还没跑过（如手动提前触发）：不拦，放行（拿已有截面算不算错
    由数据本身决定，依赖守卫只拦「明确失败」）。"""
    spec = {"needs": ["valuation"]}
    task = UpdateTask("pe_percentile", "PE 分位重建", "manual")
    assert orch._precheck(task, spec, False) == ""


# -- 写后行数下限（WAF 假成功防线） ---------------------------------------

def test_min_rows_floor_rejects(orch):
    def few(progress, ctx):
        return {"rows": 37, "detail": "接口被拦，只回了 37 行"}

    orch.register("valuation", "全市场估值", few,
                  meta={"min_rows": 3000})
    r = orch.submit("valuation", trigger="cron")
    assert r["ok"]
    _drain(orch)
    t = _last(orch, "valuation")
    assert t.status == "failed"
    assert "低于下限 3000" in t.error


def test_min_rows_pass_when_enough(orch):
    def full(progress, ctx):
        return {"rows": 5400, "detail": "全市场快照"}

    orch.register("valuation", "全市场估值", full,
                  meta={"min_rows": 3000})
    orch.submit("valuation", trigger="cron")
    _drain(orch)
    assert _last(orch, "valuation").status == "completed"


def test_incremental_tasks_have_no_floor():
    """增量型任务（资金流/K线/复权因子）0 行是合法的，绝不许声明 min_rows。"""
    from app.updater.registry import TASKS

    no_floor = {"capital_flow", "kline_update", "adjust_factor", "quotes"}
    for t in TASKS:
        if t["kind"] in no_floor:
            assert "min_rows" not in t, f"{t['kind']} 是增量型，不得设行数下限"


# -- 失败自动重试 ---------------------------------------------------------

def test_failed_cron_retries_with_backoff(orch):
    def boom(progress, ctx):
        raise RuntimeError("源整体超时")

    orch.register("kline_update", "K 线增量", boom)
    orch.submit("kline_update", trigger="cron")
    _drain(orch)
    assert _last(orch, "kline_update").status == "failed"
    # Timer 在落账之后才创建，_drain 可能先观察到排空——短暂轮询等调度落定
    deadline = time.time() + 2
    while not FakeTimer.instances and time.time() < deadline:
        time.sleep(0.05)
    assert FakeTimer.instances, "cron 失败应调度自动重试"
    assert FakeTimer.instances[0].delay == 300      # 第一次退避 5 分钟
    assert FakeTimer.instances[0].args == ("kline_update", 1)


def test_manual_failure_no_retry(orch):
    def boom(progress, ctx):
        raise RuntimeError("手动触发踩雷")

    orch.register("kline_update", "K 线增量", boom)
    orch.submit("kline_update", trigger="manual")
    _drain(orch)
    assert _last(orch, "kline_update").status == "failed"
    assert not FakeTimer.instances                  # 用户在场，不自动重试


def test_retry_attempts_capped(orch):
    def boom(progress, ctx):
        raise RuntimeError("一直失败")

    orch.register("kline_update", "K 线增量", boom)
    orch.submit("kline_update", trigger="cron", params={"attempt": 2})
    _drain(orch)
    assert _last(orch, "kline_update").status == "failed"
    assert not FakeTimer.instances                  # 已重试 2 次，封顶


def test_retry_submit_requeues_with_attempt(orch):
    orch.register("kline_update", "K 线增量",
                  lambda progress, ctx: {"rows": 10})
    orch._retry_submit("kline_update", 1)
    _drain(orch)
    t = _last(orch, "kline_update")
    assert t.status == "completed"
    assert t.trigger == "retry"


# -- 库快照备份 -----------------------------------------------------------

def test_backup_creates_readable_snapshot(updater_env, tmp_path,
                                          monkeypatch):
    from app.config import settings
    from app.updater.collectors.backup import run_backup

    monkeypatch.setattr(settings, "duckdb_path", updater_env)
    r1 = run_backup()
    assert r1["status"] == "success"
    snaps = list((updater_env.parent / "backups").glob("test_*.duckdb"))
    assert len(snaps) == 1

    r2 = run_backup()                               # 同日再跑 → 秒跳
    assert r2["status"] == "skipped"
    assert len(list((updater_env.parent / "backups").glob("test_*.duckdb"))) == 1


def test_backup_prunes_old_snapshots(updater_env, monkeypatch):
    import os

    from app.config import settings
    from app.updater.collectors.backup import BACKUP_KEEP, run_backup

    monkeypatch.setattr(settings, "duckdb_path", updater_env)
    bdir = updater_env.parent / "backups"
    bdir.mkdir(parents=True, exist_ok=True)
    stales = []
    for i in range(BACKUP_KEEP):                    # 垫满保留份额的旧快照
        p = bdir / f"test_2001{i:02d}01.duckdb"
        p.write_bytes(b"fake-old-snapshot")
        os.utime(p, (i, i))                         # i=0 最老
        stales.append(p)
    r = run_backup()                                # 第 8 份进场 → 最老 1 份被清
    assert r["status"] == "success"
    assert not stales[0].exists()                   # 最老的被滚动清理
    assert len(list(bdir.glob("test_*.duckdb"))) == BACKUP_KEEP


# -- 交易日历自检 ---------------------------------------------------------

def test_calendar_health_shape():
    from app.updater.trading_calendar import calendar_health

    cal = calendar_health()
    assert cal["status"] in ("ok", "stale", "degraded")
    assert isinstance(cal["detail"], str) and cal["detail"]
