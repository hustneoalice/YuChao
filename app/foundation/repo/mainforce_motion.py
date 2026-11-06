"""主力动向近似评分：固定研究参数，只读同日资金及此前20日成交量。"""
import json
import math
from pathlib import Path

from .freshness import fresh_gate

MODEL = json.loads(Path(__file__).with_name('motion_model.json').read_text())
NOTE = ('试验模型，非众赢原公式。基于2026-11-04榜内样本拟合；'
        '10只留出样本平均误差约48分，尚未跨日验证。历史日期使用当前固定模型重算，不能视为当时可得的回测结果。')


def score_motion(net, ratio, volume_rel20):
    if any(v is None or not math.isfinite(v) for v in (net, ratio, volume_rel20)) or net <= 0 or volume_rel20 < 0:
        return None
    values = (math.log1p(net), ratio, volume_rel20)
    contributions = dict(intercept=MODEL['coefficients'][0])
    for key, value, mean, std, coefficient in zip(MODEL['features'], values, MODEL['means'], MODEL['stds'], MODEL['coefficients'][1:]):
        contributions[key] = (value-mean)/std*coefficient
    raw = sum(contributions.values())
    return dict(score_raw=raw, score=round(raw), contributions=contributions)


def list_motion(conn, end=None):
    # 看历史日不受新鲜度限制；只有最新榜要求资金数据不落后。
    gate = fresh_gate(conn, 'flow') if not end else dict(ok=True, data_date='', as_of='', lag=None, message='')
    day = conn.execute('SELECT MAX(CAST(date AS DATE)) FROM capital_flow WHERE CAST(date AS DATE)<=?', [end or '9999-12-31']).fetchone()[0]
    target = str(end or day) if end or day else None
    result = dict(as_of=target, items=[], eligible=0, total=0, excluded=dict(net=0,amount=0,history=0),
                  model_version=MODEL['version'], training_date=MODEL['training_date'], note=NOTE,
                  stale=not gate['ok'], data_date=gate['data_date'], lag=gate['lag'], message=gate['message'])
    if not gate['ok']:
        result['as_of'] = gate['data_date']
        return result
    if target is None:
        return result
    days = [r[0] for r in conn.execute('SELECT DISTINCT CAST(date AS DATE) AS d FROM daily_ohlcv WHERE CAST(date AS DATE)<? ORDER BY d DESC LIMIT 20',[target]).fetchall()]
    if not days:
        return result
    rows = conn.execute('''
        WITH history AS (
            SELECT symbol, COUNT(volume) AS n, AVG(volume) AS avg_volume
            FROM daily_ohlcv WHERE CAST(date AS DATE) IN (SELECT UNNEST(?)) GROUP BY symbol
        )
        SELECT f.symbol, COALESCE(u.name,f.symbol), f.net_main,
               COALESCE(NULLIF(o.amount,0),v.amount), o.close,o.pct_chg,o.volume,
               h.n,h.avg_volume,v.circ_mv
        FROM capital_flow f
        LEFT JOIN stock_universe u ON u.symbol=f.symbol
        LEFT JOIN daily_ohlcv o ON o.symbol=f.symbol AND CAST(o.date AS DATE)=CAST(f.date AS DATE)
        LEFT JOIN daily_valuation v ON v.symbol=f.symbol AND CAST(v.date AS DATE)=CAST(f.date AS DATE)
        LEFT JOIN history h ON h.symbol=f.symbol
        WHERE CAST(f.date AS DATE)=? AND u.market IN ('sh','sz')
    ''',[days,target]).fetchall()
    result['total'] = len(rows)
    items = []
    for symbol,name,net,amount,close,change,volume,n,average,circ in rows:
        if net is None or not math.isfinite(net) or net <= 0:
            result['excluded']['net'] += 1
            continue
        if amount is None or not math.isfinite(amount) or amount <= 0:
            result['excluded']['amount'] += 1
            continue
        if len(days)!=20 or n!=20 or average is None or average<=0 or volume is None:
            result['excluded']['history'] += 1
            continue
        ratio, relative = net/amount*100, volume/average
        score = score_motion(net,ratio,relative)
        if score is None:
            result['excluded']['history'] += 1
            continue
        items.append(dict(symbol=symbol,name=name,net=net,ratio=ratio,volume_rel20=relative,
                          amount=amount,close=close,change_rate=change,
                          participation=net/circ*100 if circ and circ>0 else None,**score))
    items.sort(key=lambda r:(-r['score_raw'],-r['net'],r['symbol']))
    result.update(eligible=len(items),items=[dict(r,rank=i) for i,r in enumerate(items[:50],1)])
    return result
