"""单位归一 / 写入防错 / 车道熔断 / 请求加固——教训回归测试。

每条用例对应策影（或驭潮）一次真实事故，钉住后同类问题不允许复发：
  · 2026-09-15 全库审计 23,863 行 volume ×100（科创板被一律按手换算）
  · 单源单位两套代码口径分叉 → 80 个 ETF 标的全坏
  · 空壳/非法 OHLC 冒充成功写库（策影 kline_write_guard 针对的场景）
  · 2026-10-30 驭潮 TX 全市场增量：单端点 WAF 拦截 + 车道无冷却烧穿全批
  · 限流伪装页（HTTP 200 + HTML）被当成功数据
"""
from __future__ import annotations

import json

import duckdb
import httpx
import pytest

from app.updater.collectors import sources
from app.updater.collectors.normalize import guard_rows, normalize_rows


def _bar(**over):
    r = {"t": "2026-11-02", "o": 10.0, "c": 10.5, "h": 11.0, "l": 9.5,
         "v": 1000, "amount": None, "pct_chg": None, "turnover_rate": None}
    r.update(over)
    return r


# --- 教训 1：科创板 volume 被一律 ×100 ---------------------------------------

def test_tx_sci_volume_is_shares_not_lots():
    """腾讯车道：科创板 688/689 原始即股，其余手 ×100（先验单点声明）。"""
    rows, _ = normalize_rows([_bar(v=1234)], "tx", sci=True)
    assert rows[0]["v"] == 1234                    # 科创板：股
    rows, _ = normalize_rows([_bar(v=5678)], "tx")
    assert rows[0]["v"] == 567800                  # 主板：手 → 股


def test_em_lots_to_shares_with_selfcheck():
    """东财车道：手 ×100；amount 可用时自证纠偏兜住先验过时。"""
    # 先验正确：1000 手 = 10 万股，amount 100 万 / 10 万股 / 10 元 = 1 → 不动
    rows, _ = normalize_rows([_bar(v=1000, amount=1_000_000.0, c=10.0)], "em")
    assert rows[0]["v"] == 100_000

    # 先验过时（源已改发股）：×100 后 1000 万股 → 隐含均价 0.01 → ÷100 拉回
    rows, _ = normalize_rows([_bar(v=100_000, amount=1_000_000.0, c=10.0)], "em")
    assert rows[0]["v"] == 100_000


def test_lane_unit_consistency_across_sources():
    """同一物理事实（10 万股）经三条车道解析必须得到同一 v。"""
    tx, _ = normalize_rows([_bar(v=1000)], "tx")                       # 手
    em, _ = normalize_rows([_bar(v=1000, amount=1_000_000.0)], "em")   # 手+自证
    sina, _ = normalize_rows([_bar(v=100_000)], "sina")                # 股
    assert tx[0]["v"] == em[0]["v"] == sina[0]["v"] == 100_000


# --- 教训 2：空壳/脏行冒充成功写库 -------------------------------------------

def test_normalize_rejects_bad_ohlc():
    rows, rej = normalize_rows(
        [_bar(h=9.0, l=10.0),                         # high < low
         _bar(c=-1.0),                                # 非正值
         _bar(v=-5),                                  # 负量
         _bar(o="x"),                                 # 非数值
         _bar()], "tx")
    assert len(rows) == 1 and rej == 4


def test_guard_rows_write_gate():
    """写库前最后防线：来源无关断言，脏行计数不落库。"""
    good = ("600519", "2026-11-02", 10.0, 11.0, 9.5, 10.5, 100000, None, None, None)
    buf = [good,
           ("600519", "2026-11-02", 10.0, 9.0, 10.5, 10.5, 1, None, None, None),  # h<l
           ("600519", "2026-11-2", 10.0, 11.0, 9.5, 10.5, 1, None, None, None),   # 日期残缺
           ("600519", "2026-11-02", 10.0, 11.0, 9.5, 10.5, -1, None, None, None), # 负量
           ("bad", "2026-11-02", 0, 0, 0, 0, 0, None, None, None)]                # 零价
    out, rej = guard_rows(buf)
    assert out == [good] and rej == 4


# --- 教训 3：单端点 WAF 拦截（2026-10-30 全市场增量全失败） -------------------

def test_fetch_kline_tx_endpoint_rotation(monkeypatch):
    """腾讯 4 端点轮换：前两个被拦自动换下一个，全失败才抛。"""
    calls = []

    def fake_get_json(url, param, referer, timeout=10.0):
        calls.append(url)
        if len(calls) < 3:
            raise RuntimeError("WAF 403")
        return {"data": {"sh600519": {"day": [
            ["2026-11-02", "10.0", "10.5", "11.0", "9.5", "1000"]]}}}

    monkeypatch.setattr(sources, "get_json", fake_get_json)
    rows = sources.fetch_kline_tx("600519")
    assert len(calls) == 3                          # 轮换到第 3 个端点
    assert rows[0]["v"] == 100_000                  # 手 → 股
    assert rows[0]["t"] == "2026-11-02"


# --- 教训 4：车道级熔断 + 半开语义（冷却不白烧、恢复不莽撞） ------------------

def test_lane_circuit_breaker_cooldown(updater_env, monkeypatch):
    """tx 连续 3 败即冷却：后续标的不再撞它；sina 全程接管。"""
    from app.updater.collectors import kline as kmod

    # 补 2 只标的（共 5 只 pending），证明第 4/5 只不再调用 tx
    conn = duckdb.connect(str(updater_env))
    for sym in ("600036", "000333"):
        conn.execute("INSERT OR REPLACE INTO stock_universe "
                     "(symbol, name, market, industry, status, list_date) "
                     "VALUES (?, 'x', 'SH', 'y', 'traded', '2000-01-01')", [sym])
    conn.close()

    calls = {"tx": 0, "sina": 0, "em": 0}
    monkeypatch.setattr(kmod, "expected_asof", lambda: "2026-11-02")

    def boom(name):
        def f(sym, count=0):
            calls[name] += 1
            raise RuntimeError(f"{name} 被拦")
        return f

    def ok_sina(sym, count=0):
        calls["sina"] += 1
        return [_bar(v=100_000)]

    monkeypatch.setattr(kmod.sources, "fetch_kline_tx", boom("tx"))
    monkeypatch.setattr(kmod.sources, "fetch_kline_sina", ok_sina)
    monkeypatch.setattr(kmod.sources, "fetch_kline_em", boom("em"))

    res = kmod.update_kline(progress=None, ctx={"cancel_check": lambda: False})
    assert res["status"] == "success"
    assert calls["tx"] == 3                         # 3 败后冷却，第 4/5 只跳过
    assert calls["sina"] == 5                       # 新浪全程接管
    assert calls["em"] == 0                         # sina 可用则东财不启用


# --- 教训 5：限流伪装页（HTTP 200 + HTML）当成功 ------------------------------

def test_http_ratelimit_page_retried_then_ok(monkeypatch):
    from app.updater.collectors import http as hmod

    monkeypatch.setattr(hmod.time, "sleep", lambda s: None)
    calls = []

    def fake_get(url, **k):
        calls.append(url)
        if len(calls) == 1:                          # 限流伪装页：200 + HTML
            return httpx.Response(200, text="<html>blocked</html>",
                                  request=httpx.Request("GET", url))
        return httpx.Response(200, json={"ok": 1},
                              request=httpx.Request("GET", url))

    monkeypatch.setattr(hmod.client, "get", fake_get)
    assert hmod.get_json("https://x/api", {}, "https://x/") == {"ok": 1}
    assert len(calls) == 2                          # 伪装页重试后成功


def test_http_4xx_no_retry(monkeypatch):
    """4xx 封禁态原地重试无意义：直接抛，交给 get_json_hosts 换域名。"""
    from app.updater.collectors import http as hmod

    monkeypatch.setattr(hmod.time, "sleep", lambda s: None)
    calls = []

    def fake_get(url, **k):
        calls.append(url)
        return httpx.Response(403, request=httpx.Request("GET", url))

    monkeypatch.setattr(hmod.client, "get", fake_get)
    with pytest.raises(httpx.HTTPStatusError):
        hmod.get_json("https://x/api", {}, "https://x/")
    assert len(calls) == 1
