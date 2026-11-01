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
    return dict(trend_value=values[-1] if values else None,
                trend_cross_date=dates[cross] if cross is not None else None,
                trend_cross_ago=age, trend_above_days=above,
                trend_data_date=dates[-1] if dates else '')


def trend_matches(row, mode, recent, still_above, above_days):
    positive = row.get('trend_value') is not None and row['trend_value'] > 0
    if mode == 'above':
        return positive and row['trend_above_days'] >= above_days
    age = row.get('trend_cross_ago')
    return age is not None and age < recent and (not still_above or positive)
