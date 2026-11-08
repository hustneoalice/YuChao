"""指标问答快照：读日线 → foundation.ta 计算 → 结构化结果 + 中文模板。

原则：数值只来自本地 K 线计算（或预计算表），不做推测；图表专用指标如实说明。
"""
from __future__ import annotations

from ..foundation import indicator_catalog as cat
from ..foundation import ta
from ..foundation.repo.market import get_kline

_FIELDS = {
    "short": ("fast", "slow", "close"),
    "mid": ("fast", "slow", "close"),
    "ma": ("close",),
    "ema": ("close",),
    "boll": ("close", "mid", "up", "low"),
    "macd": ("dif", "dea", "hist"),
    "kdj": ("k", "d", "j"),
    "rsi": ("rsi6", "rsi12", "rsi24"),
    "dkx": ("dkx", "madkx"),
    "sixseg": (),
    "bias": ("bias6", "bias12", "bias24"),
    "atr": ("atr14", "pct"),
    "vol": ("volume", "ma5", "ma10", "ratio"),
    "obv": ("obv", "chg5"),
    "vr": ("vr",),
    "wr": ("wr10",),
    "cci": ("cci14",),
    "roc": ("roc12",),
    "mtm": ("mtm12",),
    "psy": ("psy12",),
    "dmi": ("pdi", "mdi", "adx"),
    "trix": ("trix", "matrix"),
    "emv": ("emv", "maemv"),
    "dma": ("dma", "ama"),
    "wvad": ("wvad",),
    "brar": ("br", "ar"),
    "cr": ("cr",),
    "trendhistogram": (),
}


def snapshot(conn, symbol: str, keys: list[str] | None = None, limit: int = 300) -> dict:
    """返回 {ok, symbol, name, data_date, items:[{key,label,where,supported,...}]}。"""
    keys = keys or cat.DEFAULT_KEYS
    try:
        k = get_kline(conn, symbol, limit=limit)
    except Exception as exc:               # 未收录等：转成可读结果，不让聊天 500
        return {"ok": False, "symbol": symbol, "error": str(exc)}
    bars = k.get("bars") or []
    if not bars:
        return {"ok": False, "symbol": symbol, "error": "本地无该标的日线数据（尚未采集）"}
    dates = [str(b["date"]) for b in bars]
    items = []
    for key in keys:
        d = cat.IND_BY_KEY.get(key)
        if not d:
            continue
        if not d["supported"]:
            items.append({"key": key, "label": d["label"], "where": d["where"],
                          "supported": False, "state": "图表专用指标（本地不做问答计算）"})
            continue
        val = ta.compute(key, bars, dates)
        if not val:
            items.append({"key": key, "label": d["label"], "where": d["where"],
                          "supported": False, "state": "指标数据不足（K 线长度不够）"})
            continue
        items.append({"key": key, "label": d["label"], "where": d["where"],
                      "supported": True, **val})
    return {"ok": True, "symbol": k.get("symbol") or symbol,
            "name": k.get("name") or symbol, "data_date": dates[-1], "items": items}


def _fmt_num(v, digits=2, unit=""):
    if v is None:
        return "—"
    if unit == "vol":
        if abs(v) >= 1e8:
            return f"{v / 1e8:.2f} 亿"
        if abs(v) >= 1e4:
            return f"{v / 1e4:.0f} 万"
        return f"{v:.0f}"
    return f"{v:.{digits}f}{unit}"


def _fmt_item(it: dict) -> str:
    key, label = it["key"], it["label"]
    if not it.get("supported"):
        return f"{label}：{it.get('state') or '暂不支持问答'}"
    state = it.get("state") or ""
    if key == "trendhistogram":
        v = it.get("value")
        txt = f"{_fmt_num(v)}（{state}）"
        age, cdate = it.get("trend_cross_ago"), it.get("trend_cross_date")
        if age is None:
            txt += "，区间内未上穿零轴"
        elif v is not None and v > 0:
            txt += f"，上穿零轴于 {cdate}（{age} 个交易日前），已连续 {it.get('trend_above_days')} 日红柱"
        else:
            txt += f"，最近上穿零轴为 {cdate}（{age} 个交易日前），当前已回落零轴下方"
        if it.get("neg_run"):
            txt += f"，负柱连续 {it['neg_run']} 日收窄（距零轴 {_fmt_num(it.get('neg_abs'))}）"
        return f"{label}：{txt}"
    if key in ("short", "mid"):
        f_, s_, c = it.get("fast"), it.get("slow"), it.get("close")
        rel = "快线在慢线上方" if it.get("fast_above") else "快线在慢线下方"
        return (f"{label}：{state.replace('（收盘站上趋势线）', '').replace('（收盘跌破趋势线）', '')}"
                f"（收盘 {_fmt_num(c)}，慢线 {_fmt_num(s_)}，快线 {_fmt_num(f_)}，{rel}）")
    if key == "sixseg":
        return f"{label}：{state}" + (f"，建议{it['action']}" if it.get("action") else "")
    if key == "ma":
        vals = it.get("values") or {}
        return f"{label}：MA5 {_fmt_num(vals.get('ma5'))} / MA10 {_fmt_num(vals.get('ma10'))} / " \
               f"MA20 {_fmt_num(vals.get('ma20'))} / MA60 {_fmt_num(vals.get('ma60'))}，{state}"
    if key == "ema":
        vals = it.get("values") or {}
        age = it.get("cross_ago")
        return f"{label}：EMA12 {_fmt_num(vals.get('ema12'))} / EMA26 {_fmt_num(vals.get('ema26'))}，" \
               f"{state}" + (f"（金叉 {age} 个交易日前）" if age is not None and state.startswith("EMA12 在") else "")
    if key == "boll":
        return f"{label}：上轨 {_fmt_num(it.get('up'))} / 中轨 {_fmt_num(it.get('mid'))} / " \
               f"下轨 {_fmt_num(it.get('low'))}，收盘 {_fmt_num(it.get('close'))}，{state}"
    if key == "macd":
        return f"{label}：DIF {_fmt_num(it.get('dif'))} / DEA {_fmt_num(it.get('dea'))} / " \
               f"柱 {_fmt_num(it.get('hist'))}，{state}"
    if key == "kdj":
        return f"{label}：K {_fmt_num(it.get('k', 1))} / D {_fmt_num(it.get('d', 1))} / " \
               f"J {_fmt_num(it.get('j', 1))}，{state}"
    if key == "vol":
        return f"{label}：{_fmt_num(it.get('volume'), 0, 'vol')}（5 日均 {_fmt_num(it.get('ma5'), 0, 'vol')}，" \
               f"量比 {_fmt_num(it.get('ratio'))}），{state}"
    # 其余按字段顺序拼接
    parts = []
    for f in _FIELDS.get(key, ()):
        if f in it:
            parts.append(f"{f.upper()} {_fmt_num(it.get(f), 0 if f in ('obv', 'chg5', 'volume') else 2)}")
    body = " / ".join(parts)
    return f"{label}：{body}，{state}" if body else f"{label}：{state}"


def format_snapshot(snap: dict) -> str:
    if not snap.get("ok"):
        return f"查不到指标数据：{snap.get('error') or '未知原因'}"
    head = f"{snap.get('name')}（{snap['symbol']}）· {snap.get('data_date')}"
    lines = [_fmt_item(it) for it in snap.get("items") or []]
    return head + "\n" + "\n".join(lines)
