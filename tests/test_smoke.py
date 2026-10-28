"""M1 冒烟：仅凭契约即可对接 K线/板块/核心标 三页端点。"""
import json

import pytest
from fastapi.testclient import TestClient


def test_healthz(client: TestClient):
    r = client.get("/healthz")
    assert r.status_code == 200 and r.json()["ok"] is True


def test_openapi_documents_all_pages(client: TestClient):
    paths = client.get("/openapi.json").json()["paths"]
    for p in ("/api/v1/market/kline", "/api/v1/market/quote", "/api/v1/market/search",
              "/api/v1/sectors", "/api/v1/sectors/{sector_id}/members",
              "/api/v1/corepicks", "/api/v1/corepicks/{symbol}/factors",
              "/api/v1/data/status"):
        assert p in paths, p


def test_kline_qfq_with_indicators(client: TestClient):
    r = client.get("/api/v1/market/kline", params={"symbol": "600519", "adjust": "qfq",
                                                   "with": "indicator", "limit": 60})
    assert r.status_code == 200
    body = r.json()
    assert body["symbol"] == "600519" and body["adjust"] == "qfq"
    bars = body["bars"]
    assert len(bars) == 60
    last = bars[-1]
    assert last["indicators"]["ma5"] == pytest.approx(
        sum(b["close"] for b in bars[-5:]) / 5)
    # qfq 口径（ASOF，fore 最新=1）：09-01 无因子退化原始价；09-05 起 ×0.9；09-20 起 ×1.0
    assert bars[0]["close"] == pytest.approx(1500.0)
    assert bars[4]["close"] == pytest.approx(1500.4 * 0.9)
    assert bars[-1]["close"] == pytest.approx(1505.9)


def test_kline_vip_gated(client: TestClient):
    r = client.get("/api/v1/market/kline",
                   params={"symbol": "600519", "adjust": "qfq", "with": "vip"})
    assert r.status_code == 403
    assert r.json()["code"] == "vip_required"
    assert "bars" not in r.json()


def test_kline_unknown_symbol_404(client: TestClient):
    r = client.get("/api/v1/market/kline", params={"symbol": "999999"})
    assert r.status_code == 404 and r.json()["code"] == "not_found"


def test_quote(client: TestClient):
    r = client.get("/api/v1/market/quote", params={"symbol": "600519"})
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "贵州茅台"
    assert body["close"] > 0
    assert body["valuation"]["pe_ttm"] == 22.5
    assert body["capital_flow"]["net_main"] == 1.2e8


def test_search(client: TestClient):
    r = client.get("/api/v1/market/search", params={"q": "600519"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 1 and body["items"][0]["symbol"] == "600519"
    r2 = client.get("/api/v1/market/search", params={"q": "茅台"})
    assert any(h["symbol"] == "600519" for h in r2.json()["items"])


def test_sectors_list(client: TestClient):
    r = client.get("/api/v1/sectors", params={"type": "industry"})
    assert r.status_code == 200
    items = r.json()
    assert len(items) == 2
    assert items[0]["id"] == "白酒"  # 按涨跌降序
    assert items[0]["leader"] == "贵州茅台"
    # 概念板块 M1 空集
    r2 = client.get("/api/v1/sectors", params={"type": "concept"})
    assert r2.status_code == 200 and r2.json() == []


def test_sector_members_weighted(client: TestClient):
    r = client.get("/api/v1/sectors/白酒/members", params={"lookback": 5})
    assert r.status_code == 200
    members = r.json()
    assert members and members[0]["symbol"] == "600519"
    assert members[0]["main_net"] == pytest.approx(1.2e8)
    # 加权涨幅 = Σ(amount×pct_chg)/Σ(amount)，窗口 = 最近 5 个交易日（i=55..59）
    amounts = [20_000_000.0 + i * 10_000 for i in range(55, 60)]
    pcts = [1.0 + i * 0.01 for i in range(55, 60)]
    expected = sum(a * p for a, p in zip(amounts, pcts)) / sum(amounts)
    assert members[0]["lookback_pct"] == pytest.approx(expected)


def test_sector_unknown_404(client: TestClient):
    r = client.get("/api/v1/sectors/不存在/members")
    assert r.status_code == 404


def test_corepicks_list(client: TestClient):
    r = client.get("/api/v1/corepicks", params={"pool": "chase"})
    assert r.status_code == 200
    items = r.json()
    assert len(items) == 1
    assert items[0]["symbol"] == "600519" and items[0]["name"] == "贵州茅台"
    assert items[0]["fund_score"] == 86.5 and items[0]["date"] == "2026-10-30"


def test_corepicks_factors_vip_gated(client: TestClient):
    r = client.get("/api/v1/corepicks/600519/factors")
    assert r.status_code == 403 and r.json()["code"] == "vip_required"


def test_data_status(client: TestClient):
    r = client.get("/api/v1/data/status")
    assert r.status_code == 200
    body = r.json()
    assert body["stage"] == "ready"
    tables = {t["table"]: t for t in body["tables"]}
    assert tables["daily_ohlcv"]["rows"] == 180
    assert tables["daily_ohlcv"]["latest_date"] == "2026-10-30"
    assert tables["corepicks_result"]["rows"] == 1
    assert tables["stock_profile"]["rows"] == 0


def test_index_kline_and_quote(client: TestClient, duckdb_file):
    # 指数形态（000001.SH）不剥裸码：与个股 000001.SZ 歧义由后缀区分
    import duckdb
    from tests.conftest import _bars
    con = duckdb.connect(duckdb_file)
    con.executemany(
        "INSERT OR REPLACE INTO daily_ohlcv VALUES (?,?,?,?,?,?,?,?,?,?)",
        _bars("000001.SH", 40, 3000.0, 0.5))
    con.executemany(
        "INSERT OR REPLACE INTO daily_ohlcv VALUES (?,?,?,?,?,?,?,?,?,?)",
        _bars("000001", 40, 10.0))
    con.close()
    r = client.get("/api/v1/market/kline?symbol=000001.SH&limit=10")
    assert r.status_code == 200
    k = r.json()
    assert k["symbol"] == "000001.SH" and k["name"] == "上证指数"
    assert 3000 < k["bars"][-1]["close"] < 3010        # 指数价级，非个股 10 元级
    r = client.get("/api/v1/market/kline?symbol=000001&limit=1")
    assert r.status_code == 200 and r.json()["symbol"] == "000001"  # 裸码仍走个股
    r = client.get("/api/v1/market/quote?symbol=000001.SH")
    assert r.status_code == 200
    q = r.json()
    assert q["name"] == "上证指数" and q.get("valuation") is None   # 指数无估值/资金流


def test_market_indices_degrade(client: TestClient, monkeypatch):
    # 东财不可达 → 空列表降级（不 5xx）
    monkeypatch.setattr("app.foundation.live.realtime_indices",
                        lambda: (_ for _ in ()).throw(RuntimeError("em down")))
    r = client.get("/api/v1/market/indices")
    assert r.status_code == 200
    assert r.json() == {"items": [], "total_amount": 0}


def test_data_update_trigger_202(client: TestClient, monkeypatch, tmp_path):
    # M2：501 桩 → 控制通道 202（updater 进程消费）
    monkeypatch.setattr("app.config.settings.control_requests_path",
                        tmp_path / "c.jsonl")
    r = client.post("/api/v1/data/update", json={"kind": "valuation"})
    assert r.status_code == 202 and r.json()["accepted"] is True


def test_data_update_state_empty(client: TestClient, monkeypatch, tmp_path):
    # 快照缺失 → 空编排态（updater 未运行属正常，不算错误）
    monkeypatch.setattr("app.config.settings.update_snapshot_path",
                        tmp_path / "missing.json")
    r = client.get("/api/v1/data/update/state")
    assert r.status_code == 200
    body = r.json()
    assert body["running"] is None
    assert body["queued"] == [] and body["recent"] == []


def test_data_update_state_snapshot(client: TestClient, monkeypatch, tmp_path):
    snap = {"saved_at": "2026-10-28T17:00:05", "queued": [],
            "running": {"id": "t1", "kind": "kline_update", "label": "K 线增量",
                        "status": "running", "stage": "拉取行情", "percent": 42.0,
                        "done": 42, "total": 100, "rows": 1200, "logs": []},
            "recent": [{"id": "t0", "kind": "valuation", "label": "全市场估值",
                        "status": "completed", "rows": 5300, "finished_at": "2026-10-28T16:20:11"}]}
    p = tmp_path / "progress.json"
    p.write_text(json.dumps(snap, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr("app.config.settings.update_snapshot_path", p)
    r = client.get("/api/v1/data/update/state")
    assert r.status_code == 200
    body = r.json()
    assert body["running"]["percent"] == 42.0
    assert body["recent"][0]["kind"] == "valuation"


def test_data_not_ready_503(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import settings
    from app.foundation import db as fdb

    fdb.reset_conn()
    monkeypatch.setattr(settings, "duckdb_path", tmp_path / "missing.duckdb")
    from app.main import app

    with TestClient(app) as c:
        r = c.get("/api/v1/data/status")
        assert r.status_code == 503 and r.json()["code"] == "data_not_ready"
    fdb.reset_conn()
