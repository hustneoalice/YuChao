#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全局统计：本地库 49 个品种（16 指数 + 33 ETF）跑同一套算法。

复用库内算法（不另起一套）：
  work/final_calc.py     -> build()            波段划分与波段极值（10% ZigZag）
  work/calc_extremes.py  -> price_extremes()   价格极值（历史高/低、极限涨跌、单日极值、波动率）
数据全部来自 work/ 本地库：
  指数 -> idx_*.json 对应的 raw_*.json / sse_daily.json（SPECS 见 calc_indices.py）
  ETF  -> poolfq_*.json（截止日基准前复权，已消除份额折算跳空）

输出 panorama-data.json：一次派生，页面只读结果；数据补一根 K，重跑即全表更新。
"""
import json, os, sys, csv, math, datetime as dt

W = "/Users/neo/WorkBuddy/2026-11-07-23-51-33/work"
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, W)

from final_calc import build          # noqa: E402
from calc_extremes import price_extremes  # noqa: E402
from calc_indices import SPECS, load_bars  # noqa: E402

POOL_NAMES = json.load(open(os.path.join(W, "pool_names.json"), encoding="utf-8"))
LIST_CSV = "/Users/neo/WorkBuddy/2026-11-07-23-51-33/返钱列表_ETF清单.csv"


def bars_from(path):
    d = json.load(open(os.path.join(W, path), encoding="utf-8"))
    out = []
    for line in d["data"]["klines"]:
        f = line.split(",")
        o, c, h, l = float(f[1]), float(f[2]), float(f[3]), float(f[4])
        # 数据体检：前复权极早期偶有 0 价行（510050 2005-03 / 510880 2008-12），
        # 0 价会让极值比率除零，按无效行剔除。
        if min(o, c, h, l) <= 0 or h < l:
            continue
        out.append((dt.date.fromisoformat(f[0]), o, c, h, l))
    return out


def topic_of(code, meta_topic, key):
    if meta_topic:
        return meta_topic
    return {"sh": "上证综指", "szcz": "深证成指", "cyb": "创业板", "kc50": "科创50",
            "h30184": "半导体·芯片", "cescsc": "半导体·芯片"}.get(key, "其他")


def stats(name, code, cat, bars):
    ds = [b[0] for b in bars]
    c = [b[2] for b in bars]
    last, lc = ds[-1], c[-1]
    n = len(c)

    def back(k):
        j = n - 1 - k
        return lc / c[j] - 1 if j >= 0 else None

    y = str(last)[:4]
    yi = next((k for k, x in enumerate(ds) if str(x) >= y + "-01-01"), None)
    ytd = lc / c[yi - 1] - 1 if yi and yi > 0 else None

    # 最大回撤（收盘口径）
    peak, mdd, pk, tr = -1e18, 0.0, None, None
    for k, v in enumerate(c):
        if v > peak:
            peak, pk = v, ds[k]
        dd = v / peak - 1
        if dd < mdd:
            mdd, tr = dd, ds[k]

    # A 类：价格极值（库内同名函数）
    pe = price_extremes(bars)

    # B 类：波段极值（库内同一套 10% ZigZag）
    su, segs, valid = build(name + " 全历史", bars, None, None)
    mu, md = su["max_up"], su["max_dn"]

    # 近一年（250 交易日）
    st = max(0, n - 250)
    hs = [b[3] for b in bars[st:]]
    ls = [b[4] for b in bars[st:]]
    y1h, y1l = max(hs), min(ls)
    after = ls[hs.index(y1h):]
    y1drop = min(after) / y1h - 1 if after else None

    spark = c[::max(1, n // 140)] + [lc]
    return {
        "code": code, "name": name, "cat": cat,
        "listed": str(ds[0]), "last": str(last), "bars": n,
        "years": round((dt.date(last.year, last.month, last.day) - dt.date(ds[0].year, ds[0].month, ds[0].day)).days / 365.25, 2),
        "close": lc,
        "d1": lc / c[-2] - 1,
        "r5": back(5), "r20": back(20), "r60": back(60), "r120": back(120),
        "r250": back(250), "ytd": ytd, "total": lc / c[0] - 1,
        "histHigh": pe["histHigh"], "histHighDate": pe["histHighDate"],
        "histLow": pe["histLow"], "histLowDate": pe["histLowDate"],
        "distHigh": lc / pe["histHigh"] - 1,
        "runUp": pe["runUp"], "runUpInfo": pe["runUpInfo"],
        "runDn": pe["runDn"], "runDnInfo": pe["runDnInfo"],
        "dayUp": pe["dayUp"], "dayUpDate": pe["dayUpDate"],
        "dayDn": pe["dayDn"], "dayDnDate": pe["dayDnDate"],
        "vol": pe["vol"], "runUp": pe["runUp"],
        "mdd": mdd, "mddPeak": str(pk), "mddTrough": str(tr),
        "maxUp": mu["pct"], "maxUpRange": str(mu["start"]) + "→" + str(mu["end"]),
        "maxUpMonths": round(mu["months"], 1),
        "maxDn": md["pct"], "maxDnRange": str(md["start"]) + "→" + str(md["end"]),
        "maxDnMonths": round(md["months"], 1),
        "nUp": su["n_up"], "nDn": su["n_dn"], "nSeg": len(valid),
        "tailDir": 1 if su["tail"]["dir"] == "涨" else 0,
        "tailFrom": su["tail"]["price"], "tailFromDate": str(su["tail"]["date"]),
        "tailPct": lc / su["tail"]["price"] - 1,
        "y1High": y1h, "y1HighDate": str(ds[st + hs.index(y1h)]),
        "y1Low": y1l, "y1LowDate": str(ds[st + ls.index(y1l)]),
        "y1Drop": y1drop,
        "spark": [round(v, 4) for v in spark],
    }


def main():
    rows = []
    # 指数（SPECS 来自 calc_indices.py）
    for sp in SPECS:
        rows.append(stats(sp["name"], sp["key"], topic_of(None, None, sp["key"]),
                          load_bars(os.path.join(W, sp["raw"]))))
    # ETF（返钱清单 33 只，本地 poolfq 前复权）
    meta = {r["代码"]: r for r in csv.DictReader(open(LIST_CSV, encoding="utf-8-sig"))}
    for code in sorted(POOL_NAMES):
        p = os.path.join(W, "poolfq_%s.json" % code)
        if not os.path.exists(p):
            print("MISS", code); continue
        m = meta.get(code, {})
        cat = m.get("主题分类") or "其他"
        rows.append(stats(POOL_NAMES[code], code, cat, bars_from("poolfq_%s.json" % code)))

    cats = []
    for r in rows:
        if r["cat"] not in cats:
            cats.append(r["cat"])
    asof = max(r["last"] for r in rows)
    total_bars = sum(r["bars"] for r in rows)
    out = {"asOf": asof, "cats": cats, "n": len(rows), "bars": total_bars, "rows": rows}
    json.dump(out, open(os.path.join(HERE, "panorama-data.json"), "w"),
              ensure_ascii=False, separators=(",", ":"))
    print("OK", len(rows), "items /", total_bars, "bars / asOf", asof)
    print("cats:", cats)
    for r in sorted(rows, key=lambda x: -(x["d1"] or -9))[:5]:
        print("  %-22s %-10s d1=%6.2f%% 20d=%7.2f%% mdd=%7.2f%% segU=%6.1f%%" % (
            r["name"][:22], r["cat"], r["d1"] * 100, (r["r20"] or 0) * 100, r["mdd"] * 100, r["maxUp"] * 100))


if __name__ == "__main__":
    main()
