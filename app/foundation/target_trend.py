"""目标扫描的趋势柱线STICKV，与前端trend-histogram.ts同源口径。"""
from collections import deque


def trend_histogram(bars):
    periods = (5, 8, 13, 21, 34, 55, 89)
    ema = [0.] * 7
    tr, ranges = deque(), deque()
    tr_sum = range_sum = 0.
    previous = None
    result = []
    for i, bar in enumerate(bars):
        high, low, close = bar['high'], bar['low'], bar['close']
        chl = (high + low + 3 * close) / 5
        count = i + 1
        m = [min(count, n) for n in periods]
        ma = []
        for j, n in enumerate(m):
            ema[j] = chl if i == 0 else (2 * chl + (n - 1) * ema[j]) / (n + 1)
            ma.append((chl + n * ema[j]) / (n + 1))
        prev = close if previous is None else previous
        previous = close
        value = max(high - low, high - prev, prev - low)
        tr.append(value)
        tr_sum += value
        if len(tr) > m[5]:
            tr_sum -= tr.popleft()
        mean = tr_sum / m[5]
        ranges.append(mean)
        range_sum += mean
        if len(ranges) > m[4]:
            range_sum -= ranges.popleft()
        volatility = range_sum / m[4]
        result.append(None if volatility == 0 else (
            (ma[0]-ma[1])+(ma[1]-ma[2])+(ma[2]-ma[3])+(ma[3]-ma[4])
            +(ma[4]-ma[5])*m[2]/m[3]+(ma[5]-ma[6])*m[2]/m[4]
        )*100/(volatility*4))
    return result


def trend_summary(dates, values, calendar=None):
    cross = None
    above = 0
    for i, value in enumerate(values):
        above = above + 1 if value is not None and value > 0 else 0
        if i and value is not None and value > 0 and values[i-1] is not None and values[i-1] <= 0:
            cross = i
    age = None
    if cross is not None:
        age = len(values)-1-cross if calendar is None else calendar[dates[-1]]-calendar[dates[cross]]
    # 负柱收敛（提前捕捉上穿零轴）：今日仍是绿柱，且逐日向零轴收窄
    # （v[i] > v[i-1]）。neg_run = 连续收窄的天数，neg_abs = 当前负柱距零轴幅度。
    neg_run = 0
    if values and values[-1] is not None and values[-1] < 0:
        i = len(values) - 1
        while (i > 0 and values[i] is not None and values[i-1] is not None
               and values[i] < 0 and values[i] > values[i-1]):
            neg_run += 1
            i -= 1
    last = values[-1] if values else None
    return dict(trend_value=last,
                trend_cross_date=dates[cross] if cross is not None else None,
                trend_cross_ago=age, trend_above_days=above,
                neg_run=neg_run,
                neg_abs=abs(last) if last is not None and last < 0 else None,
                trend_data_date=dates[-1] if dates else '')


def trend_matches(row, mode, recent, still_above, above_days):
    positive = row.get('trend_value') is not None and row['trend_value'] > 0
    if mode == 'above':
        return positive and row['trend_above_days'] >= above_days
    age = row.get('trend_cross_ago')
    return age is not None and age < recent and (not still_above or positive)


# -- 钱眼掘金「钱袋子」（与前端 qyjj.ts 同口径：收盘 ZigZag 6% 反转） ----------
_MONEY_PCT = 0.06
_MONEY_MIN_BARS = 30
_MONEY_WINDOW = 20


def qyjj_signals(bars):
    """钱袋/地雷信号下标：低点/高点后反转 6% 确认，信号落在拐点后一根。

    返回 (下标, 'money'|'mine') 升序列表，与前端 qyjj.ts 同口径：
    钱袋=阶段低点（画在最低价下方），地雷=阶段高点（画在最高价上方）。"""
    n = len(bars)
    if n < _MONEY_MIN_BARS:
        return []
    close = [b['close'] for b in bars]
    out: set[int] = set()
    signals: list[tuple[int, str]] = []
    direction = -1                 # 先找底部，再找顶部，严格交替
    ext = 0
    ext_val = close[0]
    for i in range(1, n):
        c = close[i]
        at = -1
        signal = None
        if direction == -1:
            if c < ext_val:
                ext, ext_val = i, c
            elif c >= ext_val * (1 + _MONEY_PCT):
                at = ext + 1
                signal = 'money'
                direction, ext, ext_val = 1, i, c
        elif c > ext_val:
            ext, ext_val = i, c
        elif c <= ext_val * (1 - _MONEY_PCT):
            at = ext + 1
            signal = 'mine'
            direction, ext, ext_val = -1, i, c
        if signal and at < n and at not in out:
            out.add(at)
            signals.append((at, signal))
    return signals


def money_indexes(bars):
    """钱袋信号所在下标：低点后反弹 6% 确认，信号落在拐点后一根（原模型 1 日滞后）。"""
    return [i for i, kind in qyjj_signals(bars) if kind == 'money']


def qyjj_money_summary(dates, bars, window=_MONEY_WINDOW):
    """近 window 个交易日的钱袋：最近一次日期 / 距今天数 / 出现次数。

    钱袋是「低点确认」的早期信号，目标页按距今天数排序比按强度更实用。"""
    n = len(bars)
    recent = [i for i in money_indexes(bars) if i >= n - window]
    if not recent:
        return dict(money_date=None, money_ago=None, money_cnt=0)
    last = recent[-1]
    return dict(money_date=dates[last],
                money_ago=n - 1 - last,
                money_cnt=len(recent))


# -- 六分段（趋势线六位置，与前端 indicators.ts 同口径：MA7 快 / MA10 慢 + ATR14） --
_SEG_NAME = ('', '超跌', '反弹', '突破', '超涨', '回踩', '跌破')


def six_segment_series(bars):
    """逐 bar 六分段判定：0=预热不足，1 超跌 → 2 反弹 → 3 突破 → 4 超涨 → 5 回踩 → 6 跌破。"""
    closes = [b['close'] for b in bars]
    ma7: list = []
    ma10: list = []
    atr14: list = []
    trs: list = []
    s7 = s10 = s_tr = 0.
    for i, close in enumerate(closes):
        s7 += close
        if i >= 7:
            s7 -= closes[i - 7]
        s10 += close
        if i >= 10:
            s10 -= closes[i - 10]
        ma7.append(s7 / 7 if i >= 6 else None)
        ma10.append(s10 / 10 if i >= 9 else None)
        high, low = bars[i].get('high'), bars[i].get('low')
        high = close if high is None else high
        low = close if low is None else low
        prev = closes[i - 1] if i > 0 else close
        tr = max(high - low, abs(high - prev), abs(low - prev))
        trs.append(tr)
        s_tr += tr
        if i >= 14:
            s_tr -= trs[i - 14]
        atr14.append(s_tr / 14 if i >= 13 else None)
    out = []
    for i, close in enumerate(closes):
        fast, slow, atr = ma7[i], ma10[i], atr14[i]
        if fast is None or slow is None or atr is None or not slow:
            out.append(0)
            continue
        deep = 1.5 * max(atr / close, 0.01)
        dev = close / slow - 1
        if close >= slow:
            if fast > slow and dev >= deep:
                out.append(4)                          # 超涨
            elif fast >= slow and close < fast:
                out.append(5)                          # 回踩快线
            else:
                out.append(3)                          # 突破 / 上升趋势
        elif fast > slow:
            out.append(6)                              # 刚跌破慢线
        else:
            out.append(1 if dev <= -deep else 2)        # 超跌 / 反弹
    return out


def six_segment_summary(dates, values):
    """当前所在段位与名称（无数据时 segment=0、名称空）。"""
    segment = values[-1] if values else 0
    return dict(segment=segment, segment_name=_SEG_NAME[segment],
                data_date=dates[-1] if dates else '')

