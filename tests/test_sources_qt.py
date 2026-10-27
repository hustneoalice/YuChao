"""备用车道回归：fetch_qt_batch 必须给裸码补交易所前缀（腾讯丢弃裸码请求）。

2026-10-27 真实库 E2E 踩中：valuation 备用车道传 stock_universe 裸码，
腾讯 qt 只回 v_pv_none_match，5555 只全空 → 「网络整体故障」误报。
"""
import re

from app.updater.collectors import sources


def _qt_payload(symbol: str) -> str:
    """腾讯 qt 字段位（1.0 实测）：[3]价 [37]成交额(万) [38]换手 [39]PE
    [44]流通市值(亿) [45]总市值(亿) [46]PB。"""
    f = [""] * 47
    f[0], f[1], f[2], f[3] = "1", "贵州茅台", symbol, "10.0"
    f[37], f[38], f[39] = "522680", "0.44", "20.5"
    f[44], f[45], f[46] = "16949.9", "17100.0", "6.75"
    return "~".join(f)


def test_fetch_qt_batch_prefixes_bare_codes(monkeypatch):
    captured = []

    def fake_get_text(url):
        captured.append(url)
        return "\n".join(
            f'v_{m.group(0)}="{_qt_payload(m.group(1))}"'
            for m in re.finditer(r"((?:sh|sz|bj)(\d{6}))", url))

    monkeypatch.setattr(sources, "_get_text", fake_get_text)
    out = sources.fetch_qt_batch(["600519", "000001", "830799"])

    assert len(captured) == 1
    assert "sh600519" in captured[0] and "sz000001" in captured[0] \
        and "bj830799" in captured[0]          # 三市场前缀齐全
    assert set(out) == {"600519", "000001", "830799"}
    assert out["600519"][2] == 20.5            # PE 透传
    assert out["600519"][4] == 17100.0 * 1e8   # 总市值换算成元


def test_fetch_qt_batch_skips_invalid_codes(monkeypatch):
    def fake_get_text(url):
        if "sh600519" not in url:
            return ""
        return f'v_sh600519="{_qt_payload("600519")}"'

    monkeypatch.setattr(sources, "_get_text", fake_get_text)
    out = sources.fetch_qt_batch(["bogus", "600519"])
    assert set(out) == {"600519"}              # 非法码被剔除，合法码照常解析
