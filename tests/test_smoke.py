"""M1 冒烟：仅凭契约即可对接 K线/板块/核心标 三页端点。"""
import json
from datetime import date

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


def test_quotes_batch(client: TestClient):
    """批量快照（自选股卡片底座能力）：一次请求 N 只 + missing 归集。"""
    r = client.get("/api/v1/market/quotes",
                   params={"symbols": "600519,000858,999999, 600519 "})
    assert r.status_code == 200
    body = r.json()
    syms = [q["symbol"] for q in body["items"]]
    assert syms == ["600519", "000858"]            # 顺序与入参一致，重复只出一次
    assert body["missing"] == ["999999"]
    moutai = body["items"][0]
    assert moutai["name"] == "贵州茅台"
    assert abs(moutai["close"] - (1500.0 + 59 * 0.1)) < 1e-6   # 夹具最新日线收盘
    assert moutai["valuation"]["pe_ttm"] == 22.5
    assert moutai["capital_flow"]["net_main"] == 1.2e8
    wly = body["items"][1]
    assert wly["name"] == "五粮液" and wly["capital_flow"]["net_main"] == -0.5e8


def test_quotes_batch_rt_overlay(client: TestClient, monkeypatch):
    """盘中批量实时覆盖：一次腾讯 HTTP 后价格字段改用实时值（与单只同规约）。"""
    import app.foundation.live as _live
    _live._RTS_CACHE.clear()        # 隔离其他用例/真实网络留下的实时缓存（flaky 源）
    # ts/qdate 必须是动态「今天」：_apply_rt 以 qdate==今天 且已有开盘价判定盘中覆盖
    d = date.today().isoformat()
    today = d + " 10:30"
    monkeypatch.setattr("app.foundation.live.realtime_quotes", lambda syms: {
        s: {"price": 888.0, "open": 880.0, "high": 890.0, "low": 875.0,
            "prev_close": 870.0, "pct": 2.07, "volume": 12300.0, "amount": 1.1e9,
            "turnover": 3.3, "pe_ttm": 30.0, "pb": 8.0,
            "total_mv_yi": 9000.0, "circ_mv_yi": 9000.0,
            "qdate": d, "ts": today}
        for s in syms})
    r = client.get("/api/v1/market/quotes", params={"symbols": "600519,000858"})
    assert r.status_code == 200
    for q in r.json()["items"]:
        assert q["rt_price"] == 888.0 and q["rt_time"] == today
        assert q["close"] == 888.0 and q["pct_chg"] == 2.07   # 盘中覆盖
        assert q["rt_prev_close"] == 870.0


def test_quotes_index_and_empty(client: TestClient, duckdb_file):
    """指数形态批量支持；空入参宽松返回空集。"""
    import duckdb
    from tests.conftest import _bars
    con = duckdb.connect(duckdb_file)
    con.executemany(
        "INSERT OR REPLACE INTO daily_ohlcv VALUES (?,?,?,?,?,?,?,?,?,?)",
        _bars("000001.SH", 40, 3000.0, 0.5))
    con.close()
    r = client.get("/api/v1/market/quotes", params={"symbols": "000001.SH"})
    assert r.status_code == 200
    body = r.json()
    assert body["items"][0]["symbol"] == "000001.SH"
    assert body["items"][0]["name"] == "上证指数"
    assert 3000 < body["items"][0]["close"] < 3010      # 指数价级
    r2 = client.get("/api/v1/market/quotes", params={"symbols": ","})
    assert r2.status_code == 200 and r2.json() == {"items": [], "missing": []}


def test_search(client: TestClient):
    r = client.get("/api/v1/market/search", params={"q": "600519"})
    assert r.status_code == 200
    body = r.json()
    assert body["total"] >= 1 and body["items"][0]["symbol"] == "600519"
    r2 = client.get("/api/v1/market/search", params={"q": "茅台"})
    assert any(h["symbol"] == "600519" for h in r2.json()["items"])


def test_sparks_batch(client: TestClient, monkeypatch):
    """批量当日走势（自选 sparkline 底座能力）：降采样点 + 昨收 + missing 归集。"""
    from app.routers.v1 import market as m
    m._m_cache.clear()
    bars = [f"09{i:02d} {1500 + i * 0.5:.1f} {100 + i} {150000 * (i + 1)}" for i in range(30)]

    def fake_fetch(url, params=None):
        return {"data": {"sh600519": {"data": {"data": bars, "date": "20261030"},
                "qt": {"sh600519": ["1", "贵州茅台", "1514.5", "9.8", "1490.00"]}}}}

    monkeypatch.setattr(m, "_tx_fetch", fake_fetch)
    r = client.get("/api/v1/market/sparks", params={"symbols": "600519,999999"})
    assert r.status_code == 200
    body = r.json()
    assert [i["symbol"] for i in body["items"]] == ["600519"]   # 顺序与入参一致
    assert body["missing"] == ["999999"]
    it = body["items"][0]
    assert it["prev_close"] == 1490.0
    assert 2 <= len(it["points"]) <= 31
    assert it["points"][-1] == 1514.5                           # 首尾保留


def test_sectors_list(client: TestClient):
    r = client.get("/api/v1/sectors", params={"type": "industry"})
    assert r.status_code == 200
    items = r.json()
    assert len(items) == 2
    assert items[0]["id"] == "白酒"  # 行业按涨跌降序
    assert items[0]["leader"] == "贵州茅台"
    # 2.1 板块级聚合：主力净流入（capital_flow 按成分归属 rollup）+ 成分数
    assert items[0]["member_count"] == 2
    assert items[0]["main_net_today"] == pytest.approx(1.2e8 - 0.5e8)
    assert items[0]["main_net_5d"] == pytest.approx(1.2e8 - 0.5e8)
    assert items[1]["main_net_today"] is None  # 电池无资金流数据 → NULL
    # 概念板块（2.1 sector_member 口径）
    rc = client.get("/api/v1/sectors", params={"type": "concept"})
    assert rc.status_code == 200
    ci = rc.json()
    assert len(ci) == 1 and ci[0]["id"] == "免税概念" and ci[0]["type"] == "concept"
    assert ci[0]["member_count"] == 2       # sector_member 映射口径
    assert ci[0]["main_net_today"] == pytest.approx(1.2e8)


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


def test_sector_members_concept(client: TestClient):
    """概念成分走 sector_member 映射口径（与行业 f100 分流）。"""
    r = client.get("/api/v1/sectors/免税概念/members", params={"lookback": 5})
    assert r.status_code == 200
    members = r.json()
    assert {m["symbol"] for m in members} == {"600519", "300750"}
    assert members[0]["symbol"] == "300750"     # 加权涨幅更高者居首（pct_base 2.0 > 1.0）


def test_sector_unknown_404(client: TestClient):
    r = client.get("/api/v1/sectors/不存在/members")
    assert r.status_code == 404


# -- 2.2 全景大页（market_snapshot 派生层） ----------------------------------


def test_market_board(client: TestClient):
    """全景大表：沪深 tab 默认按涨跌幅降序；指数不混入股票表。"""
    r = client.get("/api/v1/market/board")
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3 and body["as_of"] == "2026-10-30"
    syms = [it["symbol"] for it in body["items"]]
    assert syms == ["000858", "600519", "300750"]     # +10.0% / +0.67% / -1.18%
    top = body["items"][0]
    assert top["current"] == 132.0 and top["up_limit"] == 132.0
    assert top["bid1"] == 132.0 and top["bid1_vol"] == 5000.0
    # tab 过滤：创业板（300 开头）命中 300750；搜索命中
    rc = client.get("/api/v1/market/board", params={"tab": "cyb"}).json()
    assert rc["total"] == 1 and rc["items"][0]["symbol"] == "300750"
    rq = client.get("/api/v1/market/board", params={"q": "茅台"})
    assert rq.json()["total"] == 1 and rq.json()["items"][0]["symbol"] == "600519"


def test_market_index_bar(client: TestClient):
    r = client.get("/api/v1/market/index_bar")
    assert r.status_code == 200
    bar = {it["symbol"]: it for it in r.json()}
    assert bar["000001.SH"]["current"] == 3599.02     # 上证指数快照直出
    assert bar["000001.SH"]["change_rate"] == -1.44
    assert bar["399001.SZ"]["current"] is None        # 未采指数 → null 占位


def test_market_breadth(client: TestClient):
    """市场总貌：涨停用现价 vs 涨停价精确判定（000858 132.0 == up_limit）。"""
    r = client.get("/api/v1/market/breadth")
    assert r.status_code == 200
    b = r.json()
    assert b["up"] == 2 and b["down"] == 1 and b["flat"] == 0   # 300750 -1.18%
    assert b["limit_up"] == 1                          # 000858 触板精确命中
    assert b["limit_down"] == 0
    assert b["amount"] == pytest.approx(3.78e9 + 1.06e10 + 7.5e9)


def test_market_snapshot_one(client: TestClient):
    """单标的快照：目录指数只认全码（000001.SH 不落回裸码歧义），
    未命中返回 null。"""
    r = client.get("/api/v1/market/snapshot_one", params={"symbol": "600519"})
    assert r.status_code == 200
    b = r.json()
    assert b["symbol"] == "600519" and b["current"] is not None
    assert b["name"] == "贵州茅台"
    # 指数全码形态：精确命中指数行，绝不落回 000001 裸码（平安银行）
    r2 = client.get("/api/v1/market/snapshot_one", params={"symbol": "000001.SH"})
    assert r2.status_code == 200
    b2 = r2.json()
    assert b2 is not None and b2["symbol"] == "000001.SH"
    assert b2["name"] == "上证指数" and b2["current"] is not None
    # 裸码 000001（seed 无平安银行快照行）→ null，验证两段式不串位
    r2b = client.get("/api/v1/market/snapshot_one", params={"symbol": "000001"})
    assert r2b.status_code == 200 and r2b.json() is None
    # 未入库标的 → null（前端降级为「无盘中快照」而不是报错）
    r3 = client.get("/api/v1/market/snapshot_one", params={"symbol": "688981"})
    assert r3.status_code == 200 and r3.json() is None


def test_board_fund_tabs(client: TestClient):
    """基金 tab：fund 命中 ETF 行；fund_sh 沪市过滤；stocks tab 不串基金。"""
    r = client.get("/api/v1/market/board", params={"tab": "fund"})
    b = r.json()
    assert r.status_code == 200 and b["total"] == 1
    assert b["items"][0]["symbol"] == "510300" and b["items"][0]["name"] == "沪深300ETF"
    r2 = client.get("/api/v1/market/board", params={"tab": "fund_sh"})
    assert r2.json()["total"] == 1
    r3 = client.get("/api/v1/market/board", params={"tab": "fund_sz"})
    assert r3.json()["total"] == 0
    r4 = client.get("/api/v1/market/board", params={"tab": "hsa"})
    syms = {it["symbol"] for it in r4.json()["items"]}
    assert "510300" not in syms            # 基金绝不混进股票 tab


def test_zy_blocks(client: TestClient):
    """众赢板块：清单 × 快照聚合（成员数/涨跌家数/均涨/领涨股），类型过滤。"""
    r = client.get("/api/v1/market/zy_blocks", params={"type_code": 2})
    b = r.json()
    assert r.status_code == 200 and b["total"] == 1
    row = b["items"][0]
    assert row["block_code"] == "G000021" and row["block_name"] == "大飞机"
    assert row["members"] == 2 and row["up_count"] == 2 and row["down_count"] == 0
    assert row["leader"] == "五粮液" and row["leader_change"] == 10.0   # seed 000858 +10%
    assert row["avg_change"] is not None
    # 题材板（TC000001，成员 300750 有快照）
    r2 = client.get("/api/v1/market/zy_blocks", params={"type_code": 9})
    assert r2.json()["items"][0]["members"] == 1
    # 非法 type_code → 404
    assert client.get("/api/v1/market/zy_blocks",
                      params={"type_code": 7}).status_code == 404


def test_zy_block_members(client: TestClient):
    """板块成分 × 快照：命中快照的行有行情，未入库成分行情字段为 null。"""
    r = client.get("/api/v1/market/zy_blocks/G000021/members")
    b = r.json()
    assert r.status_code == 200 and b["total"] == 2
    assert b["block_name"] == "大飞机"
    by_sym = {it["symbol"]: it for it in b["items"]}
    assert by_sym["600519"]["name"] == "贵州茅台"
    assert by_sym["600519"]["current"] is not None
    # 不存在的板块 → 404
    assert client.get("/api/v1/market/zy_blocks/G999999/members").status_code == 404


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
    # stock_profile（主营/行业资料，AI 解读上下文表）0 行空表不出现在看板清单
    assert "stock_profile" not in tables


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
    # M2：501 桩 → 控制通道 202（updater 进程消费；探测需在线）
    monkeypatch.setattr("app.config.settings.control_requests_path",
                        tmp_path / "c.jsonl")
    monkeypatch.setattr("app.routers.v1.data._updater_alive", lambda **kw: True)
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

    monkeypatch.setattr(settings, "duckdb_path", tmp_path / "missing.duckdb")
    # 必须关内置内核：否则 lifespan 真启动调度链，已过点的 cron 任务被当
    # misfire 立即补跑 → 泄漏的编排器线程在后续测试窗口真跑全市场采集
    # （qt 夹具测试被第二个真实 URL 污染的 flake 根因）
    monkeypatch.setattr(settings, "api_embedded_updater", False)
    from app.main import app

    with TestClient(app) as c:
        r = c.get("/api/v1/data/status")
        assert r.status_code == 503 and r.json()["code"] == "data_not_ready"


def test_market_targets(client: TestClient, duckdb_file):
    """目标页全市场扫描：四条件 + 六分段 + 回调；ST/北交所剔除；条件即时重筛。"""
    import duckdb

    con = duckdb.connect(str(duckdb_file))
    con.executemany(
        "INSERT OR REPLACE INTO stock_universe VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)",
        [("600555", "*ST海创", "SH", "综合", "traded", "2000-01-01"),
         ("832000", "北交样本", "BJ", "综合", "traded", "2015-01-01")])
    con.close()

    r = client.get("/api/v1/market/targets", params={"conds": "vol,short,mid"})
    assert r.status_code == 200
    body = r.json()
    syms = {x["symbol"] for x in body["items"]}
    # ST 直接剔除；北交所开关默认关；无 K 线的档案不参与
    assert "600555" not in syms and "832000" not in syms
    assert {"600519", "000858"} <= syms
    assert body["scanned"] >= 2 and body["as_of"]

    t = next(x for x in body["items"] if x["symbol"] == "600519")
    # 种子 60 根单边上升：站上全部均线、量达标、趋势线突破（第 3 段）、非回调、近 20 日无涨停
    assert t["name"] == "贵州茅台"
    assert t["short_orange"] and t["mid_orange"] and t["vol_hit"]
    assert t["seg"] == 3 and t["seg_name"] == "突破"
    assert t["pullback"] is False
    assert t["limit_up_20d"] is False and t["limit_up_cnt"] == 0
    assert t["vol_ratio"] is not None and t["vol_ratio"] > 0.99

    # 条件即时重筛：只勾 20日涨停 → 种子无涨停，无命中
    r = client.get("/api/v1/market/targets", params={"conds": "up20"})
    assert r.json()["items"] == []

    # 000858 最近一根日线抬到主板涨停幅度（10.5% ≥ 9.9 阈值）→ 数据更新触发重算
    con = duckdb.connect(str(duckdb_file))
    con.execute(
        "UPDATE daily_ohlcv SET pct_chg = 10.5 WHERE symbol = '000858'"
        " AND date = (SELECT MAX(date) FROM daily_ohlcv WHERE symbol = '000858')")
    con.close()
    r = client.get("/api/v1/market/targets", params={"conds": "up20"})
    items = r.json()["items"]
    assert [x["symbol"] for x in items] == ["000858"]
    assert items[0]["limit_up_20d"] is True and items[0]["limit_up_cnt"] == 1


def test_search_bj_switch(client: TestClient, duckdb_file, monkeypatch):
    """北交所开关：关闭（默认）时搜索结果不含北交所标的，开启后恢复。"""
    import duckdb

    from app.config import settings

    con = duckdb.connect(str(duckdb_file))
    con.execute(
        "INSERT OR REPLACE INTO stock_universe VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)",
        ("832000", "北交样本", "BJ", "综合", "traded", "2015-01-01"))
    con.close()
    r = client.get("/api/v1/market/search", params={"q": "北交样本"})
    assert [x["symbol"] for x in r.json()["items"]] == []
    monkeypatch.setattr(settings, "bj_enabled", True)
    r = client.get("/api/v1/market/search", params={"q": "北交样本"})
    assert [x["symbol"] for x in r.json()["items"]] == ["832000"]
