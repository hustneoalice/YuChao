#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""拉取 ETF 清单全量日线（东财公开接口，前复权），并计算全局统计与波段极值。
统计口径与 A股指数与半导体ETF波段极值分析.html 保持逐字段一致：
- 价格：日线 O/C/L/H，前复权 fqt=1
- 波段：日内高/低点拐点，反向变动 >=10% 确认，|幅度|>10% 计为有效段
- 涨跌幅：按收盘价向前回溯 N 个交易日
运行：python3 fetch_etf.py  -> 生成 etf_daily.json / panorama-data.json
"""
import csv, json, os, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LIST_CSV = "/Users/neo/WorkBuddy/2026-11-07-23-51-33/返钱列表_ETF清单.csv"
T = 0.10

def secid(code):
    return ("1." if code.startswith("5") else "0.") + code

def fetch(code):
    url = ("https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=%s"
           "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58"
           "&klt=101&fqt=1&beg=19900101&end=20500101" % secid(code))
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.loads(r.read().decode())
    if not d.get("data") or not d["data"].get("klines"):
        return None, None
    name = d["data"].get("name")
    rows = []
    for line in d["data"]["klines"]:
        p = line.split(",")
        rows.append([p[0], float(p[1]), float(p[2]), float(p[3]), float(p[4])])  # d,o,c,h,l
    return name, rows

def zigzag(c, h, l, d):
    lo, hi, lod, hid = l[0], h[0], d[0], d[0]
    direction, piv, k = 0, None, 0
    n = len(c)
    for k in range(1, n):
        if l[k] < lo: lo, lod = l[k], d[k]
        if h[k] > hi: hi, hid = h[k], d[k]
        if hid > lod and (hi - lo) / lo >= T:
            piv, direction = {"d": lod, "p": lo}, 1
            break
        if lod > hid and (hi - lo) / hi >= T:
            piv, direction = {"d": hid, "p": hi}, -1
            break
    if not piv:
        return None
    ep, ed = (hi, hid) if direction == 1 else (lo, lod)
    pivots = [piv]
    for j in range(k + 1, n):
        if d[j] <= ed:
            continue
        if direction == 1:
            if h[j] > ep:
                ep, ed = h[j], d[j]
            elif (ep - l[j]) / ep >= T:
                pivots.append({"d": ed, "p": ep}); direction = -1; ep, ed = l[j], d[j]
        else:
            if l[j] < ep:
                ep, ed = l[j], d[j]
            elif (h[j] - ep) / ep >= T:
                pivots.append({"d": ed, "p": ep}); direction = 1; ep, ed = h[j], d[j]
    return {"pivots": pivots, "tail": {"d": ed, "p": ep, "dir": direction}}

def segs_of(pivots, d):
    out = []
    for a, b in zip(pivots, pivots[1:]):
        pct = b["p"] / a["p"] - 1
        out.append({"dir": 1 if pct > 0 else 0, "sd": a["d"], "ed": b["d"],
                    "p1": a["p"], "p2": b["p"], "pct": pct})
    return out

def days(a, b):
    from datetime import date
    x = date(*map(int, a.split("-"))); y = date(*map(int, b.split("-")))
    return (y - x).days

def stats(name, rows):
    ds = [r[0] for r in rows]; c = [r[2] for r in rows]
    h = [r[3] for r in rows]; l = [r[4] for r in rows]
    last, lc = ds[-1], c[-1]
    def back(n):
        j = len(c) - 1 - n
        return lc / c[j] - 1 if j >= 0 else None
    y = last[:4]
    yi = next((k for k, x in enumerate(ds) if x >= y + "-01-01"), None)
    ytd = lc / c[yi - 1] - 1 if yi and yi > 0 else None
    # 最大回撤（收盘口径）
    peak, mdd, pk, tr = -1e18, 0.0, None, None
    for k, v in enumerate(c):
        if v > peak: peak, pk = v, ds[k]
        dd = v / peak - 1
        if dd < mdd: mdd, tr = dd, ds[k]
    # 历史高/低（日内，与 ext.histHigh 口径一致）
    hh, hd = max(h), ds[h.index(max(h))]
    ll, ld = min(l), ds[l.index(min(l))]
    # 近 1 年（250 交易日）
    st = max(0, len(ds) - 250)
    y1h = max(h[st:]); y1hd = ds[st + h[st:].index(y1h)]
    y1l = min(l[st:]); y1ld = ds[st + l[st:].index(y1l)]
    after = l[st:][h[st:].index(y1h):]
    y1drop = (min(after) / y1h - 1) if after else None
    # 波段
    z = zigzag(c, h, l, ds)
    valid = []
    if z:
        valid = [s for s in segs_of(z["pivots"], ds) if abs(s["pct"]) > T]
    ups = [s for s in valid if s["pct"] > 0]
    dns = [s for s in valid if s["pct"] <= 0]
    mu = max(ups, key=lambda s: s["pct"]) if ups else None
    md = min(dns, key=lambda s: s["pct"]) if dns else None
    # 当前所处段
    tail = z["tail"] if z else None
    return {
        "name": name, "listed": ds[0], "last": last, "close": lc,
        "d1": lc / c[-2] - 1,
        "r5": back(5), "r20": back(20), "r60": back(60), "r120": back(120),
        "r250": back(250), "ytd": ytd, "total": lc / c[0] - 1,
        "histHigh": hh, "histHighDate": hd, "histLow": ll, "histLowDate": ld,
        "distHigh": lc / hh - 1,
        "mdd": mdd, "mddPeak": pk, "mddTrough": tr,
        "maxUp": mu["pct"] if mu else None, "maxUpRange": (mu["sd"] + "→" + mu["ed"]) if mu else None,
        "maxUpMonths": round(days(mu["sd"], mu["ed"]) / 30, 1) if mu else None,
        "maxDn": md["pct"] if md else None, "maxDnRange": (md["sd"] + "→" + md["ed"]) if md else None,
        "maxDnMonths": round(days(md["sd"], md["ed"]) / 30, 1) if md else None,
        "nSeg": len(valid), "nUp": len(ups), "nDn": len(dns),
        "years": round(days(ds[0], last) / 365.25, 2), "bars": len(ds),
        # 当前波段：进行中的方向 + 起点 + 幅度
        "curDir": tail["dir"] if tail else 0,
        "curFrom": tail["p"] if tail else None,
        "curFromDate": tail["d"] if tail else None,
        "curPct": lc / tail["p"] - 1 if tail else None,
        "y1High": y1h, "y1HighDate": y1hd, "y1Low": y1l, "y1LowDate": y1ld, "y1Drop": y1drop,
        "spark": [round(v, 4) for v in (c[::max(1, len(c) // 140)] + [lc])],
    }

def main():
    rows = list(csv.DictReader(open(LIST_CSV, encoding="utf-8-sig")))
    daily, out = {}, []
    for r in rows:
        code, short, official, topic = r["代码"], r["图中简称"], r["官方基金名称(场内简称)"], r["主题分类"]
        try:
            nm, bars = fetch(code)
        except Exception as e:
            print("FAIL", code, e); bars = None
        if not bars:
            print("EMPTY", code); continue
        daily[code] = {"name": nm or official, "bars": bars}
        st = stats(nm or official, bars)
        st.update({"code": code, "short": short, "official": official, "topic": topic, "isEtf": True})
        out.append(st)
        print("%-8s %-6s %-22s %5d %s %8.2f%%" % (code, short, (nm or official)[:22], len(bars), st["last"], st["total"] * 100))
        time.sleep(0.25)
    json.dump(daily, open(os.path.join(HERE, "etf_daily.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    groups = []
    for r in out:
        if r["topic"] not in groups: groups.append(r["topic"])
    json.dump({"asOf": max(r["last"] for r in out), "groups": groups, "rows": out},
              open(os.path.join(HERE, "panorama-data.json"), "w"), ensure_ascii=False, separators=(",", ":"))
    print("OK", len(out), "asOf", max(r["last"] for r in out))

if __name__ == "__main__":
    main()
