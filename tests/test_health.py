"""P1 数据底座三件套测试：体检评估打分口径 + 一键修复计划 + 自愈心跳。"""
import json
from datetime import datetime

import duckdb
import pytest

from app.config import settings
from app.foundation.repo.health import assess
from app.updater.selfheal import Selfheal


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------

def _rw(duckdb_file):        # 写连接：改数后必须先关（同进程读写/只读不可混挂）
    return duckdb.connect(str(duckdb_file))


def _ro(duckdb_file):        # 只读连接：体检用
    return duckdb.connect(str(duckdb_file), read_only=True)


def _topup(duckdb_file):
    """夹具补数据：财务报告期 + 最近周六的复权因子 + 第三只估值/资金流，
    使新鲜度与覆盖率满分。"""
    conn = _rw(duckdb_file)
    conn.execute("INSERT INTO financials VALUES "
                 "('600519','2026-09-30',9.2e9,0.15,0.31,0.21,1.1e10,1)")
    conn.execute("INSERT OR REPLACE INTO adjust_factor VALUES "
                 "('600519','2026-10-24',1.0,1.12)")
    conn.execute("INSERT OR REPLACE INTO daily_valuation VALUES "
                 "('300750','2026-10-30',28.0,9.1,6.2,15.0,1.1e12,9.0e11,2.0e10)")
    conn.execute("INSERT OR REPLACE INTO capital_flow VALUES "
                 "('300750','2026-10-30',0.6e8,0.2e8,0.4e8,-0.1e8,-0.2e8)")
    conn.execute("CHECKPOINT")
    conn.close()


NOW = datetime(2026, 10, 30, 12, 0, 0)   # 周五盘中午间（判定不跨链位缓冲）


@pytest.fixture()
def health_env(monkeypatch, tmp_path):
    """体检环境：updater 在线 + 无失败落账 + 隔离文件路径。"""
    monkeypatch.setattr("app.foundation.repo.health.updater_alive", lambda: True)
    monkeypatch.setattr(settings, "update_snapshot_path", tmp_path / "progress.json")
    monkeypatch.setattr(settings, "selfheal_ledger_path", tmp_path / "ledger.json")
    monkeypatch.setattr(settings, "control_requests_path", tmp_path / "control.jsonl")


# ---------------------------------------------------------------------------
# 体检评估：打分口径
# ---------------------------------------------------------------------------

def test_assess_healthy_full_score(duckdb_file, health_env):
    _topup(duckdb_file)
    r = assess(_ro(duckdb_file), now=NOW)
    assert r["score"] == 100
    assert r["grade"] == "healthy"
    assert r["issues"] == []
    assert r["freshness"]["score"] == 100
    assert r["coverage"]["score"] == 100
    assert r["gap"]["score"] == 100
    assert r["ledger"]["score"] == 100
    assert r["ledger"]["updater_alive"] is True


def test_assess_stale_kline_flags_repair_action(duckdb_file, health_env):
    # 盘中午间预期 T-1：删掉最近两个交易日 → kline 滞后 1 天 → warn + 修复动作
    _topup(duckdb_file)
    conn = _rw(duckdb_file)
    conn.execute("DELETE FROM daily_ohlcv WHERE date >= '2026-10-29'")
    conn.execute("CHECKPOINT")
    conn.close()

    r = assess(_ro(duckdb_file), now=NOW)
    assert r["freshness"]["score"] < 100
    kinds = {(i["code"], i["kind"]) for i in r["issues"]}
    assert ("freshness", "kline_update") in kinds
    act = next(i["action"] for i in r["issues"]
               if i["code"] == "freshness" and i["kind"] == "kline_update")
    assert act == {"kind": "kline_update", "force": True}
    assert r["score"] < 100            # 总分被拖累但单类滞后不至于掉级


def test_assess_gap_detects_missing_day(duckdb_file, health_env):
    # 近 10 交易日里挖掉一天 → 断档检测命中，gap 分 −20
    _topup(duckdb_file)
    conn = _rw(duckdb_file)
    conn.execute("DELETE FROM daily_ohlcv WHERE date = '2026-10-20'")
    conn.execute("CHECKPOINT")
    conn.close()

    r = assess(_ro(duckdb_file), now=NOW)
    assert r["gap"]["score"] == 80
    miss = [g for g in r["gap"]["items"] if g["missing"]]
    assert len(miss) == 1 and miss[0]["date"] == "2026-10-20"
    assert any(i["code"] == "gap" and i["action"]["kind"] == "backfill"
               for i in r["issues"])


def test_assess_coverage_penalty(duckdb_file, health_env):
    # 资金流只覆盖 2/3 标的 → 覆盖率项扣分（新浪源 48% 缺口的同款口径）
    _topup(duckdb_file)
    conn = _rw(duckdb_file)
    conn.execute("DELETE FROM capital_flow WHERE symbol = '300750'")
    conn.execute("CHECKPOINT")
    conn.close()
    r = assess(_ro(duckdb_file), now=NOW)
    cov = next(i for i in r["coverage"]["items"] if i["table"] == "capital_flow")
    assert cov["coverage"] == pytest.approx(66.7, abs=0.2)
    assert cov["score"] < 100


def test_assess_updater_offline_zeroes_ledger(duckdb_file, monkeypatch):
    _topup(duckdb_file)
    monkeypatch.setattr("app.foundation.repo.health.updater_alive", lambda: False)
    r = assess(_ro(duckdb_file), now=NOW)
    assert r["ledger"]["score"] == 0
    assert any(i["code"] == "updater" for i in r["issues"])


# ---------------------------------------------------------------------------
# 一键修复：/data/repair
# ---------------------------------------------------------------------------

def test_repair_submits_plan(client, health_env, monkeypatch):
    monkeypatch.setattr("app.routers.v1.data.updater_alive", lambda: True)
    # 覆盖率不满 → 生成 backfill 动作
    resp = client.post("/api/v1/data/repair")
    assert resp.status_code == 202
    body = resp.json()
    assert body["accepted"] is True
    assert body["submitted"], "体检不满应有修复动作"
    kinds = [s["kind"] for s in body["submitted"]]
    assert all(k in ("backfill", "kline_update", "capital_flow", "valuation",
                     "sector_index") for k in kinds)
    journal = settings.control_requests_path.read_text(encoding="utf-8").strip()
    assert journal, "修复动作必须落控制通道"


def test_repair_no_action_when_healthy(client, health_env, monkeypatch,
                                       duckdb_file):
    # 补齐资金流第三只 → 全部满分 → 无需修复
    _topup(duckdb_file)
    conn = _rw(duckdb_file)
    conn.execute("INSERT OR REPLACE INTO capital_flow VALUES "
                 "('300750','2026-10-30',0.6e8,0.2e8,0.4e8,-0.1e8,-0.2e8)")
    conn.execute("CHECKPOINT")
    conn.close()
    monkeypatch.setattr("app.routers.v1.data.updater_alive", lambda: True)

    resp = client.post("/api/v1/data/repair")
    assert resp.status_code == 202
    assert resp.json()["submitted"] == []
    assert "无需修复" in resp.json()["message"]


def test_repair_503_when_updater_offline(client, health_env, monkeypatch):
    monkeypatch.setattr("app.routers.v1.data.updater_alive", lambda: False)
    resp = client.post("/api/v1/data/repair")
    assert resp.status_code == 503


def test_health_endpoint_shape(client, health_env, monkeypatch, duckdb_file):
    _topup(duckdb_file)
    monkeypatch.setattr("app.routers.v1.data.updater_alive", lambda: True)
    resp = client.get("/api/v1/data/health")
    assert resp.status_code == 200
    body = resp.json()
    for key in ("score", "grade", "freshness", "coverage", "gap", "ledger",
                "issues", "selfheal", "generated_at"):
        assert key in body


# ---------------------------------------------------------------------------
# 自愈心跳：失败重试 + 链位补偿
# ---------------------------------------------------------------------------

class FakeOrch:
    """编排器替身：记录 submit/log_event，不做去重与冷却。"""

    def __init__(self):
        self.submits = []
        self.events = []

    def submit(self, kind, trigger="manual", params=None, force=False):
        self.submits.append({"kind": kind, "trigger": trigger, "force": force})
        return {"ok": True, "task": {"id": "x"}}

    def log_event(self, msg, level="info", kind=None):
        self.events.append({"msg": msg, "level": level, "kind": kind})


@pytest.fixture()
def sh(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "selfheal_ledger_path", tmp_path / "ledger.json")
    return Selfheal(ledger_path=tmp_path / "ledger.json")


def test_selfheal_retry_after_backoff(sh, monkeypatch):
    monkeypatch.setattr(Selfheal, "_catch_up_missed", lambda self, orch: None)  # 本测试只测重试，屏蔽墙钟相关的链位补偿
    orch = FakeOrch()
    sh.on_record("kline_update", "failed", error="boom")
    assert sh.entry("kline_update")["fails"] == 1

    sh.tick(orch, force=True)
    assert not orch.submits, "退避窗口内不应立即重试"

    monkeypatch.setattr("app.updater.selfheal._BACKOFF_S", (0, 0, 0))
    sh.tick(orch, force=True)
    kinds = [s["kind"] for s in orch.submits]
    assert "kline_update" in kinds
    s = next(s for s in orch.submits if s["kind"] == "kline_update")
    assert s["trigger"] == "selfheal" and s["force"] is True


def test_selfheal_clears_on_success(sh, monkeypatch):
    monkeypatch.setattr(Selfheal, "_catch_up_missed", lambda self, orch: None)  # 同上：屏蔽链位补偿
    orch = FakeOrch()
    sh.on_record("kline_update", "failed")
    sh.on_record("kline_update", "completed")
    assert sh.entry("kline_update")["fails"] == 0
    monkeypatch.setattr("app.updater.selfheal._BACKOFF_S", (0, 0, 0))
    sh.tick(orch, force=True)
    assert not orch.submits


def test_selfheal_stops_after_max_retries(sh, monkeypatch):
    orch = FakeOrch()
    monkeypatch.setattr("app.updater.selfheal._BACKOFF_S", (0, 0, 0))
    for _ in range(5):                     # 连续失败 5 次（> 上限 3）
        sh.on_record("kline_update", "failed")
        sh.tick(orch, force=True)
    assert len([s for s in orch.submits if s["kind"] == "kline_update"]) == 3


def test_selfheal_misfire_catches_missed_chain(sh, monkeypatch):
    # 交易日 18:00，账本为空 → 15:35 之后的链位全部补偿
    orch = FakeOrch()
    monkeypatch.setattr("app.updater.selfheal.now_cst",
                        lambda: datetime(2026, 10, 30, 18, 0, 0))
    sh.tick(orch, force=True)
    kinds = [s["kind"] for s in orch.submits]
    assert "sector_index" in kinds and "kline_update" in kinds
    assert all(s["trigger"] == "selfheal" and not s["force"] for s in orch.submits)


def test_selfheal_misfire_skips_done_kinds(sh, monkeypatch):
    orch = FakeOrch()
    monkeypatch.setattr("app.updater.selfheal.now_cst",
                        lambda: datetime(2026, 10, 30, 18, 0, 0))
    sh.on_record("sector_index", "completed")
    sh.tick(orch, force=True)
    kinds = [s["kind"] for s in orch.submits]
    assert "sector_index" not in kinds
    assert "kline_update" in kinds


def test_selfheal_misfire_holiday_silent(sh, monkeypatch):
    # 2026-10-31 是周六：日链不补，仅周任务链位后补复权因子
    orch = FakeOrch()
    monkeypatch.setattr("app.updater.selfheal.now_cst",
                        lambda: datetime(2026, 10, 31, 18, 0, 0))
    sh.tick(orch, force=True)
    kinds = [s["kind"] for s in orch.submits]
    assert "kline_update" not in kinds
    assert "adjust_factor" in kinds        # 周六链位过点 → 补偿


def test_selfheal_ledger_persists_across_restart(sh, tmp_path, monkeypatch):
    sh.on_record("kline_update", "failed", error="boom")
    reborn = Selfheal(ledger_path=tmp_path / "ledger.json")
    assert reborn.entry("kline_update")["fails"] == 1
    assert reborn.entry("kline_update")["error"] == "boom"
