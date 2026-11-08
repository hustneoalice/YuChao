"""技术指标计算（问答工具专用，口径与前端图表 1:1 对齐）。

输入为日线 bar 列表（dict: date/open/high/low/close/volume/amount），
输出为「最新值 + 状态判断」的结构化 dict，由 ai.service 组织成中文答复。
趋势柱线 / 六段直接复用 target_trend，公式见 frontend/src/indicators.ts。
"""
from __future__ import annotations

import math

from .target_trend import six_segment_series, trend_histogram, trend_summary


def _col(bars, key):
    return [float(b[key] or 0.) for b in bars]


def _sma(vals, n):
    out = []
    s = 0.
    for i, v in enumerate(vals):
        s += v
        if i >= n:
            s -= vals[i - n]
        out.append(s / n if i >= n - 1 else None)
    return out


def _ema(vals, n):
    out = []
    k = 2 / (n + 1)
    prev = None
    seed = 0.
    for i, v in enumerate(vals):
        if i < n - 1:
            seed += v
            out.append(None)
            continue
        if i == n - 1:
            seed += v
            prev = seed / n
        else:
            prev = v * k + prev * (1 - k)
        out.append(prev)
    return out


def _ema_from(vals, n, mask):
    """与前端 emaFrom 一致：首个 n 个有效值做 SMA 种，之后递推。"""
    out = []
    k = 2 / (n + 1)
    prev = None
    seed = 0.
    seen = 0
    started = False
    for i, v in enumerate(vals):
        if mask[i] is None:
            out.append(None)
            continue
        seen += 1
        if not started:
            seed += v
            if seen == n:
                prev = seed / n
                started = True
                out.append(prev)
            else:
                out.append(None)
            continue
        prev = v * k + prev * (1 - k)
        out.append(prev)
    return out


def _last(vals):
    for v in reversed(vals or []):
        if v is not None:
            return v
    return None


def _cross_age(fast, slow):
    """返回 (状态, 上穿/金叉距今天数)；状态为 fast 在 slow 上/下。"""
    if fast is None or slow is None:
        return None, None
    cross = None
    for i in range(1, min(len(fast), len(slow))):
        a0, b0, a1, b1 = fast[i - 1], slow[i - 1], fast[i], slow[i]
        if None in (a0, b0, a1, b1):
            continue
        if a0 <= b0 and a1 > b1:
            cross = i
    above = fast[-1] >= slow[-1]
    age = (len(fast) - 1 - cross) if cross is not None else None
    return above, age


def _r(x, digits=2):
    return None if x is None else round(float(x), digits)


def _state_above(close, line):
    if close is None or line is None:
        return "数据不足"
    return "多头（收盘站上趋势线）" if close >= line else "空头（收盘跌破趋势线）"


def compute(key, bars, dates):
    """返回单个指标的最新值与状态；未知/不支持返回 None。"""
    close = _col(bars, "close")
    high = _col(bars, "high")
    low = _col(bars, "low")
    vol = _col(bars, "volume")
    n = len(bars)
    if n == 0:
        return None

    if key == "trendhistogram":
        values = trend_histogram(bars)
        s = trend_summary(dates, values)
        v = s["trend_value"]
        state = "数据不足" if v is None else ("零轴上方" if v > 0 else "零轴下方")
        return {"value": _r(v), "state": state, **{k: s[k] for k in
                ("trend_cross_date", "trend_cross_ago", "trend_above_days", "neg_run", "neg_abs")}}

    if key in ("short", "mid"):
        fast_n, slow_n = ((7, 10) if key == "short" else (35, 45))
        fast = _sma(close, fast_n)
        slow = _sma(close, slow_n)
        f, sl = _last(fast), _last(slow)
        return {"fast": _r(f), "slow": _r(sl), "close": _r(close[-1]),
                "state": _state_above(close[-1], sl),
                "fast_above": None if f is None or sl is None else f >= sl}

    if key == "sixseg":
        segs = six_segment_series(bars)
        names = ["", "超跌", "反弹", "突破", "超涨", "回踩", "跌破"]
        actions = ["", "不参与", "禁止参与", "积极参与", "小仓谨慎", "积极参与", "禁止参与"]
        seg = segs[-1] if segs else 0
        return {"segment": seg, "state": names[seg] if seg else "数据不足",
                "action": actions[seg] if seg else ""}

    if key == "ma":
        out = {f"ma{p}": _r(_last(_sma(close, p))) for p in (5, 10, 20, 60)}
        ma5, ma10, ma20 = out["ma5"], out["ma10"], out["ma20"]
        state = "数据不足"
        if None not in (ma5, ma10, ma20) and close[-1] is not None:
            if ma5 > ma10 > ma20:
                state = "多头排列（MA5>MA10>MA20）"
            elif ma5 < ma10 < ma20:
                state = "空头排列（MA5<MA10<MA20）"
            else:
                state = "均线交织"
        return {"values": out, "close": _r(close[-1]), "state": state}

    if key == "ema":
        out = {f"ema{p}": _r(_last(_ema(close, p))) for p in (12, 26)}
        above, age = _cross_age(_ema(close, 12), _ema(close, 26))
        return {"values": out, "close": _r(close[-1]),
                "state": "EMA12 在 EMA26 上方" if above else "EMA12 在 EMA26 下方",
                "cross_ago": age}

    if key == "boll":
        mid = _sma(close, 20)
        up, lo = [], []
        for i in range(n):
            if i < 19:
                up.append(None)
                lo.append(None)
                continue
            m = mid[i]
            sd = math.sqrt(sum((close[j] - m) ** 2 for j in range(i - 19, i + 1)) / 20)
            up.append(m + 2 * sd)
            lo.append(m - 2 * sd)
        u, m, l = _last(up), _last(mid), _last(lo)
        c = close[-1]
        if None in (u, m, l):
            state = "数据不足"
        elif c > u:
            state = "突破上轨"
        elif c >= m:
            state = "中轨上方（上轨与中轨之间）"
        elif c >= l:
            state = "中轨下方（中轨与下轨之间）"
        else:
            state = "跌破下轨"
        return {"mid": _r(m), "up": _r(u), "low": _r(l), "close": _r(c), "state": state}

    if key == "macd":
        ef, es = _ema(close, 12), _ema(close, 26)
        dif = [None if ef[i] is None or es[i] is None else ef[i] - es[i] for i in range(n)]
        valid = [d if d is not None else 0. for d in dif]
        dea = _ema_from(valid, 9, dif)
        hist = [None if dif[i] is None or dea[i] is None else (dif[i] - dea[i]) * 2 for i in range(n)]
        prev_hist = hist[-2] if n >= 2 else None
        state = "数据不足"
        if dif[-1] is not None and dea[-1] is not None:
            golden = dif[-1] > dea[-1]
            state = "金叉（DIF 在 DEA 上方）" if golden else "死叉（DIF 在 DEA 下方）"
            if hist[-1] is not None and prev_hist is not None:
                if hist[-1] > 0 and hist[-1] > prev_hist:
                    state += " · 红柱放大"
                elif hist[-1] > 0:
                    state += " · 红柱缩短"
                elif hist[-1] < 0 and hist[-1] < prev_hist:
                    state += " · 绿柱放大"
                else:
                    state += " · 绿柱收窄"
        return {"dif": _r(dif[-1]), "dea": _r(dea[-1]), "hist": _r(hist[-1]), "state": state}

    if key == "kdj":
        k = d = 50.
        K, D, J = [], [], []
        for i in range(n):
            if i < 8:
                K.append(None), D.append(None), J.append(None)
                continue
            hh = max(high[i - 8:i + 1])
            ll = min(low[i - 8:i + 1])
            rsv = 50. if hh == ll else (close[i] - ll) / (hh - ll) * 100
            k = (2 / 3) * k + (1 / 3) * rsv
            d = (2 / 3) * d + (1 / 3) * k
            K.append(k), D.append(d), J.append(3 * k - 2 * d)
        kv, dv, jv = K[-1], D[-1], J[-1]
        state = "数据不足"
        if kv is not None:
            if kv > 80:
                state = "超买区（K>80）"
            elif kv < 20:
                state = "超卖区（K<20）"
            else:
                state = "中性区（20≤K≤80）"
            if kv > dv:
                state += " · 金叉向上" if (K[-2] is not None and K[-2] <= D[-2]) else " · K 在 D 上方"
            else:
                state += " · 死叉向下" if (K[-2] is not None and K[-2] >= D[-2]) else " · K 在 D 下方"
        return {"k": _r(kv), "d": _r(dv), "j": _r(jv), "state": state}

    if key == "rsi":
        def rsi(period):
            gains, losses = 0., 0.
            out = None
            for i in range(1, n):
                chg = close[i] - close[i - 1]
                if i <= period - 1:
                    gains += max(chg, 0.)
                    losses += max(-chg, 0.)
                elif i == period:
                    gains += max(chg, 0.)
                    losses += max(-chg, 0.)
                    out = 100. if losses == 0 else 100. - 100. / (1 + gains / losses)
                else:
                    gains = (gains * (period - 1) + max(chg, 0.)) / period
                    losses = (losses * (period - 1) + max(-chg, 0.)) / period
                    out = 100. if losses == 0 else 100. - 100. / (1 + gains / losses)
            return out
        r6, r12, r24 = rsi(6), rsi(12), rsi(24)
        state = "数据不足"
        if r6 is not None:
            state = "超买（RSI6>70）" if r6 > 70 else "超卖（RSI6<30）" if r6 < 30 else "中性区间"
        return {"rsi6": _r(r6), "rsi12": _r(r12), "rsi24": _r(r24), "state": state}

    if key == "dkx":
        dkx = []
        for i in range(n):
            if i < 19:
                dkx.append(None)
                continue
            acc = sum(close[i - j] * (20 - j) for j in range(20))
            dkx.append(acc / 210)
        madkx = _sma([v if v is not None else 0. for v in dkx], 10)
        dv, mv = dkx[-1], _last(madkx)
        above, age = _cross_age(dkx, madkx)
        return {"dkx": _r(dv), "madkx": _r(mv),
                "state": "DKX 在 MADKX 上方（偏多）" if above else "DKX 在 MADKX 下方（偏空）",
                "cross_ago": age}

    if key in ("bias", "roc", "mtm", "psy", "wr", "cci", "vol", "vr", "wvad",
               "brar", "cr", "atr", "obv", "dmi", "trix", "emv", "dma"):
        return _classic(key, bars, close, high, low, vol, dates)

    return None


def _classic(key, bars, close, high, low, vol, dates):
    n = len(bars)

    if key == "bias":
        return {"bias6": _r((close[-1] / _last(_sma(close, 6)) - 1) * 100 if _last(_sma(close, 6)) else None),
                "bias12": _r((close[-1] / _last(_sma(close, 12)) - 1) * 100 if _last(_sma(close, 12)) else None),
                "bias24": _r((close[-1] / _last(_sma(close, 24)) - 1) * 100 if _last(_sma(close, 24)) else None),
                "state": "价格偏离均线程度（正=高于均线）"}

    if key == "roc":
        v = None if n < 13 or close[-13] == 0 else (close[-1] / close[-13] - 1) * 100
        return {"roc12": _r(v), "state": "动量向上" if v and v > 0 else "动量向下" if v else "数据不足"}

    if key == "mtm":
        v = None if n < 13 else close[-1] - close[-13]
        return {"mtm12": _r(v), "state": "动量向上" if v and v > 0 else "动量向下" if v else "数据不足"}

    if key == "psy":
        up = sum(1 for i in range(n - 12, n) if i > 0 and close[i] > close[i - 1]) if n >= 12 else 0
        v = up / 12 * 100 if n >= 12 else None
        return {"psy12": _r(v), "state": "人气偏热（>75）" if v and v > 75 else "人气偏冷（<25）" if v and v < 25 else "人气中性"}

    if key == "wr":
        hh, ll = max(high[-10:]), min(low[-10:])
        v = None if hh == ll else (hh - close[-1]) / (hh - ll) * 100
        return {"wr10": _r(v), "state": "超买（WR<20）" if v is not None and v < 20 else "超卖（WR>80）" if v is not None and v > 80 else "中性区间"}

    if key == "cci":
        tp = [(high[i] + low[i] + close[i]) / 3 for i in range(n)]
        ma = _last(_sma(tp, 14))
        if ma is None:
            return {"cci14": None, "state": "数据不足"}
        md = sum(abs(tp[i] - ma) for i in range(n - 14, n)) / 14
        v = None if md == 0 else (tp[-1] - ma) / (0.015 * md)
        return {"cci14": _r(v), "state": "超买（CCI>100）" if v and v > 100 else "超卖（CCI<-100）" if v and v < -100 else "常态区间"}

    if key == "vol":
        m5, m10 = _last(_sma(vol, 5)), _last(_sma(vol, 10))
        ratio = (vol[-1] / m5) if m5 else None
        return {"volume": _r(vol[-1], 0), "ma5": _r(m5, 0), "ma10": _r(m10, 0),
                "ratio": _r(ratio),
                "state": "放量（≥1.5 倍 5 日均量）" if ratio and ratio >= 1.5 else
                         "缩量（≤0.7 倍 5 日均量）" if ratio and ratio <= 0.7 else "平量"}

    if key == "obv":
        obv = [0.]
        for i in range(1, n):
            obv.append(obv[-1] + (vol[i] if close[i] > close[i - 1] else -vol[i] if close[i] < close[i - 1] else 0.))
        chg5 = obv[-1] - obv[-6] if n >= 6 else None
        return {"obv": _r(obv[-1], 0), "chg5": _r(chg5, 0),
                "state": "5 日资金流入" if chg5 and chg5 > 0 else "5 日资金流出" if chg5 else "数据不足"}

    if key == "vr":
        up = sum(vol[i] for i in range(max(0, n - 26), n) if close[i] > close[i - 1])
        dn = sum(vol[i] for i in range(max(0, n - 26), n) if close[i] < close[i - 1])
        flat = sum(vol[i] for i in range(max(0, n - 26), n) if close[i] == close[i - 1])
        v = None if (dn + flat / 2) == 0 else (up + flat / 2) / (dn + flat / 2) * 100
        return {"vr": _r(v), "state": "买盘强（VR>160）" if v and v > 160 else "卖盘强（VR<80）" if v and v < 80 else "量能均衡"}

    if key == "wvad":
        acc = 0.
        for i in range(max(0, n - 6), n):
            rng = high[i] - low[i]
            if rng:
                acc += vol[i] * (close[i] - low[i]) / rng
        v = acc / 6 if n else None
        return {"wvad": _r(v, 0), "state": "量价支撑（正值）" if v and v > 0 else "量价压制（负值）" if v else "数据不足"}

    if key == "brar":
        up, dn = 0., 0.
        for i in range(max(0, n - 26), n):
            up += max(0., high[i] - close[i - 1]) if i else 0.
            dn += max(0., close[i - 1] - low[i]) if i else 0.
        br = None if dn == 0 else up / dn * 100
        ar = None
        if n >= 26:
            hh = max(high[-26:])
            ll = min(low[-26:])
            o = bars[-26]["open"]
            ar = None if (hh - ll) == 0 else (hh - o) / (o - ll) * 100 if (o - ll) != 0 else None
        return {"br": _r(br), "ar": _r(ar), "state": "情绪偏强" if br and br > 100 else "情绪偏弱" if br else "数据不足"}

    if key == "cr":
        if n < 27:
            return {"cr": None, "state": "数据不足"}
        mid = [(high[i] + low[i] + close[i]) / 3 for i in range(n)]
        up = sum(max(0., high[i] - mid[i - 1]) for i in range(n - 26, n))
        dn = sum(max(0., mid[i - 1] - low[i]) for i in range(n - 26, n))
        v = None if dn == 0 else up / dn * 100
        return {"cr": _r(v), "state": "强势区（CR>100）" if v and v > 100 else "弱势区" if v else "数据不足"}

    if key == "atr":
        trs = []
        for i in range(n):
            if i == 0:
                trs.append(high[i] - low[i])
            else:
                trs.append(max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1])))
        a = sum(trs[-14:]) / 14
        pct = a / close[-1] * 100 if close[-1] else None
        return {"atr14": _r(a), "pct": _r(pct), "state": f"日均波动约 {pct:.2f}%" if pct else "数据不足"}

    if key == "dmi":
        plus_dm, minus_dm, trs = [], [], []
        for i in range(n):
            if i == 0:
                plus_dm.append(0.), minus_dm.append(0.), trs.append(high[i] - low[i])
                continue
            up_move = high[i] - high[i - 1]
            dn_move = low[i - 1] - low[i]
            plus_dm.append(up_move if up_move > dn_move and up_move > 0 else 0.)
            minus_dm.append(dn_move if dn_move > up_move and dn_move > 0 else 0.)
            trs.append(max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1])))
        if n < 28:
            return {"pdi": None, "mdi": None, "adx": None, "state": "数据不足"}
        dxs = []
        for i in range(14, n):
            atr = sum(trs[i - 13:i + 1]) / 14
            if not atr:
                continue
            pdi = sum(plus_dm[i - 13:i + 1]) / 14 / atr * 100
            mdi = sum(minus_dm[i - 13:i + 1]) / 14 / atr * 100
            if pdi + mdi:
                dxs.append((pdi, mdi, abs(pdi - mdi) / (pdi + mdi) * 100))
        pdi, mdi, _ = dxs[-1]
        adx = sum(d for _, _, d in dxs[-14:]) / len(dxs[-14:])
        state = "趋势较强（ADX≥25）" if adx >= 25 else "趋势偏弱（ADX<25）"
        return {"pdi": _r(pdi), "mdi": _r(mdi), "adx": _r(adx), "state": state}

    if key == "trix":
        def tri(n):
            v = _ema(_ema(_ema(close, n), n), n)
            out = []
            for i in range(len(v)):
                if v[i] is None or i == 0 or v[i - 1] is None:
                    out.append(None)
                else:
                    out.append((v[i] - v[i - 1]) / v[i - 1] * 100)
            return out
        t = tri(12)
        mat = _sma([x if x is not None else 0. for x in t], 9)
        tv, mv = _last(t), _last(mat)
        above, age = _cross_age(t, mat)
        return {"trix": _r(tv), "matrix": _r(mv),
                "state": "TRIX 在 MATRIX 上方（偏多）" if above else "TRIX 在 MATRIX 下方（偏空）",
                "cross_ago": age}

    if key == "emv":
        mids = [(high[i] + low[i]) / 2 for i in range(n)]
        emv = [0.]
        for i in range(1, n):
            rng = high[i] - low[i]
            if rng == 0 or vol[i] == 0:
                emv.append(emv[-1])
            else:
                emv.append(emv[-1] + (mids[i] - mids[i - 1]) * rng / (vol[i] * 1000))
        m = _last(_sma(emv, 9))
        return {"emv": _r(emv[-1]), "maemv": _r(m),
                "state": "量价向上" if emv[-1] > (m or 0) else "量价向下"}

    if key == "dma":
        dif = [_last(_sma(close, 10)), _last(_sma(close, 50))]
        dma = None if None in dif else dif[0] - dif[1]
        v10 = _sma(close, 10)
        v50 = _sma(close, 50)
        series = [None if v10[i] is None or v50[i] is None else v10[i] - v50[i] for i in range(n)]
        ama = _last(_sma([x if x is not None else 0. for x in series], 10))
        above, age = _cross_age(series, _sma([x if x is not None else 0. for x in series], 10))
        return {"dma": _r(dma), "ama": _r(ama),
                "state": "DMA 在 AMA 上方（偏多）" if above else "DMA 在 AMA 下方（偏空）",
                "cross_ago": age}

    return None
