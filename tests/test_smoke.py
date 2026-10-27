"""M1 冒烟：仅凭契约即可对接 K线/板块/核心标 三页端点。"""
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


def test_data_update_stub_501(client: TestClient):
    r = client.post("/api/v1/data/update")
    assert r.status_code == 501 and r.json()["code"] == "not_implemented"


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
