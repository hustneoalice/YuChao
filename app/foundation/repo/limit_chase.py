"""涨停追击收盘版：仅使用留存的同日精确涨停价，不推测盘中事件。"""
import math
from collections import defaultdict

from .zyblock import _MEMBER_TREE, _TOP_LEVEL
from ...updater.util import now_cst

NOTE = ('以所选日最后保存的行情快照统计，不回放盘中过程。只使用同日精确涨停价；'
        '历史快照须与同日原始日线开高低收核验，冲突或无法核验的记录不作信号。'
        '首次/最终封板时间、最大封单额尚无事件记录。板块使用当前成分，涨幅为成分均涨，'
        '不是众赢原始板块指数；强势板块在本版指至少有1只已确认涨停股的板块。')
KINDS = {4:'行业', 2:'概念', 1:'地域', 9:'题材'}


def valid(v):
    return v is not None and math.isfinite(v)


def classify(row):
    price, limit = row.get('current'), row.get('up_limit')
    if not valid(price) or not valid(limit) or limit<=0 or price<=0:
        return 'unknown'
    if price >= limit-1e-6:
        if all(valid(row.get(k)) and abs(row[k]-limit)<1e-6 for k in ('open','high','low')):
            return 'one'
        return 'sealed'
    high = row.get('high')
    if not valid(high):
        return 'unknown'
    return 'broken' if high>=limit-1e-6 else 'normal'


def market_group(symbol, market):
    if str(market).upper()=='BJ': return 'bj'
    if symbol.startswith(('688','689')): return 'star'
    if symbol.startswith(('300','301')): return 'chi'
    return 'main'


def list_chase(conn, end=None, markets=('main','chi','star','bj'), show_st=False, period=3):
    latest=conn.execute("SELECT MAX(trade_date) FROM market_snapshot WHERE kind='stock'").fetchone()[0]
    target=str(end or latest) if end or latest else None
    available=[str(r[0]) for r in conn.execute("SELECT DISTINCT trade_date FROM market_snapshot WHERE kind='stock' ORDER BY trade_date DESC LIMIT 120").fetchall()]
    result=dict(as_of=target,previous_date=None,available_dates=available,today=[],yesterday=[],broken=[],blocks=[],
                summary={},snapshot_count=0,unknown_limits=0,invalid_snapshots=0,invalid_previous_snapshots=0,snapshot_time=None,period=period,note=NOTE)
    if target is None: return result
    calendar=[str(r[0]) for r in conn.execute('SELECT DISTINCT CAST(date AS DATE) AS d FROM daily_ohlcv WHERE CAST(date AS DATE)<? ORDER BY d DESC LIMIT 60',[target]).fetchall()]
    days=[target]+calendar
    previous=calendar[0] if calendar else None
    result['previous_date']=previous
    cols='symbol,market,name,current,change_rate,open,high,low,up_limit,amount,turnover_rate,bid1,bid1_vol,circ_value,trade_date,updated_at'
    records=conn.execute(f"SELECT {cols} FROM market_snapshot WHERE kind='stock' AND CAST(trade_date AS DATE) IN (SELECT UNNEST(CAST(? AS DATE[])))",[days]).fetchall()
    snapshot_days=sorted({str(r[-2]) for r in records})
    raw_bars={(s,str(d)):(o,h,l,c) for s,d,o,h,l,c in conn.execute(
        'SELECT symbol,CAST(date AS DATE),open,high,low,close FROM daily_ohlcv '
        'WHERE CAST(date AS DATE) IN (SELECT UNNEST(CAST(? AS DATE[])))',[snapshot_days]).fetchall()}
    today_date=now_cst().date().isoformat()
    history={}
    for values in records:
        row=dict(zip(cols.split(','),values));row['trade_date']=str(row['trade_date']);row['status']=classify(row)
        row['integrity_invalid']=False
        if row['trade_date']<today_date:
            bar=raw_bars.get((row['symbol'],row['trade_date']))
            values=[row.get(k) for k in ('open','high','low','current')]
            if bar is None or not all(valid(v) for v in (*bar,*values)) or any(abs(a-b)>0.005 for a,b in zip(bar,values)):
                row['integrity_invalid']=True
                row['status']='unknown'
                for k in ('current','change_rate','open','high','low','up_limit','amount','bid1','bid1_vol','turnover_rate','circ_value'):
                    row[k]=None
        row['market_group']=market_group(row['symbol'],row['market'])
        history[row['symbol'],row['trade_date']]=row
    def selected(row):
        return row['market_group'] in markets and (show_st or not (row['name'] or '').upper().startswith(('ST','*ST')))
    current={s:r for (s,d),r in history.items() if d==target and selected(r)}
    old={s:r for (s,d),r in history.items() if d==previous and selected(r)}
    invalid_current=sum(r['integrity_invalid'] for r in current.values())
    invalid_previous=sum(r['integrity_invalid'] for r in old.values())
    flows=dict(conn.execute('SELECT symbol,net_main FROM capital_flow WHERE CAST(date AS DATE)=?',[target]).fetchall())
    sealed=lambda r:r['status'] in ('sealed','one')
    def streak(symbol):
        count=0
        for d in days:
            r=history.get((symbol,d))
            if r is None or r['status']=='unknown': return count,False
            if not sealed(r): return count,True
            count+=1
        return count,False
    def item(row):
        symbol=row['symbol'];qty=None;money=None
        if sealed(row) and valid(row.get('bid1')) and abs(row['bid1']-row['up_limit'])<1e-6 and valid(row.get('bid1_vol')) and row['bid1_vol']>=0:
            qty=row['bid1_vol']*100  # 腾讯买一原字段单位手，展示统一为股。
            money=qty*row['bid1']
        n,complete=streak(symbol)
        amount=row.get('amount');circ=row.get('circ_value')
        return dict(symbol=symbol,name=row.get('name') or symbol,market_group=row['market_group'],status=row['status'],
                    close=row.get('current'),change_rate=row.get('change_rate'),net=flows.get(symbol),amount=amount,
                    turnover_rate=row.get('turnover_rate'),streak=n,streak_complete=complete,
                    seal_shares=qty,seal_amount=money,seal_ratio=money/amount if money is not None and valid(amount) and amount>0 else None,
                    seal_flow_ratio=money/circ if money is not None and valid(circ) and circ>0 else None,
                    first_limit_time=None,last_seal_time=None,max_seal_amount=None,blocks=[])
    today=[item(r) for r in current.values() if sealed(r)]
    broken=[item(r) for r in current.values() if r['status']=='broken']
    yesterday=[]
    for symbol,row in old.items():
        if sealed(row):
            cur=current.get(symbol)
            if cur: entry=item(cur)
            else: entry=dict(symbol=symbol,name=row.get('name') or symbol,market_group=row['market_group'],status='unknown',close=None,change_rate=None,net=flows.get(symbol),amount=None,turnover_rate=None,streak=0,streak_complete=False,seal_shares=None,seal_amount=None,seal_ratio=None,seal_flow_ratio=None,first_limit_time=None,last_seal_time=None,max_seal_amount=None,blocks=[])
            yesterday.append(entry)
    def stock_order(r):return (-(r['net'] if valid(r['net']) else float('-inf')),r['symbol'])
    for group in (today,broken,yesterday):group.sort(key=stock_order)
    touched=len(today)+len(broken);old_up=[r for r in old.values() if sealed(r)];old_touched=sum(r['status'] in ('one','sealed','broken') for r in old.values())
    paired=[current[r['symbol']] for r in old_up if r['symbol'] in current and current[r['symbol']]['status']!='unknown']
    old_changes=[r['change_rate'] for r in paired if valid(r.get('change_rate'))]
    unknown=sum(r['status']=='unknown' for r in current.values());old_unknown=sum(r['status']=='unknown' for r in old.values())
    result.update(today=today,broken=broken,yesterday=yesterday,snapshot_count=len(current),unknown_limits=unknown,
                  invalid_snapshots=invalid_current,invalid_previous_snapshots=invalid_previous,
                  snapshot_time=max((str(r['updated_at']) for r in current.values()),default=None),
                  summary=dict(up_count=len(today) if len(current)>unknown else None,yesterday_count=len(old_up) if old and not invalid_previous else None,
                               seal_rate=len(today)/touched*100 if touched else None,
                               yesterday_seal_rate=len(old_up)/old_touched*100 if old_touched and not invalid_previous else None,
                               continuity_rate=sum(sealed(r) for r in paired)/len(old_up)*100 if old_up and len(paired)==len(old_up) and not invalid_previous else None,
                               yesterday_change=sum(old_changes)/len(old_changes) if old_up and len(old_changes)==len(old_up) and not invalid_previous else None,
                               previous_coverage=len(paired),broken_count=len(broken),previous_unknown=old_unknown))
    if not current: return result
    # 区间成分收益由完整的逐日涨幅连乘；不使用未来日线或缺失日补零。
    window=[target]+calendar[:period-1]
    changes=defaultdict(dict)
    for symbol,d,pct in conn.execute('SELECT symbol,CAST(date AS DATE),pct_chg FROM daily_ohlcv WHERE CAST(date AS DATE) IN (SELECT UNNEST(CAST(? AS DATE[])))',[window]).fetchall():
        if valid(pct): changes[symbol][str(d)]=pct
    metas=conn.execute(f'SELECT block_code,block_name,type_code FROM zy_block b WHERE type_code IN (1,2,4,9) AND {_TOP_LEVEL} ORDER BY type_code,block_code').fetchall()
    members=defaultdict(set)
    for code,symbol in conn.execute(f'{_MEMBER_TREE} SELECT root_code,symbol FROM mm').fetchall():
        if symbol in current:members[code].add(symbol)
    picks={r['symbol']:r for r in today};tagged=defaultdict(list)
    blocks=[]
    for code,name,kind in metas:
        scoped=members[code];up=sorted(scoped & picks.keys())
        if not up: continue
        priced=[current[s]['change_rate'] for s in scoped if valid(current[s].get('change_rate'))]
        period_returns=[]
        for s in scoped:
            if len(window)==period and all(d in changes[s] for d in window):
                value=1
                for d in window:value*=1+changes[s][d]/100
                period_returns.append((value-1)*100)
        blocks.append(dict(code=code,name=name,category=KINDS[kind],members=len(scoped),up_count=len(up),up_ratio=len(up)/len(scoped)*100,
                           one_count=sum(picks[s]['status']=='one' for s in up),consecutive_count=sum(picks[s]['streak']>=2 for s in up),
                           change_rate=sum(priced)/len(priced) if priced else None,period_change=sum(period_returns)/len(period_returns) if period_returns else None,
                           period_coverage=len(period_returns),unknown_limits=sum(current[s]['status']=='unknown' for s in scoped),symbols=up))
        for symbol in up:
            if len(tagged[symbol])<3:tagged[symbol].append(name)
    for group in (today,broken,yesterday):
        for r in group:r['blocks']=tagged[r['symbol']]
    blocks.sort(key=lambda b:(-(b['change_rate'] if b['change_rate'] is not None else float('-inf')),b['code']))
    result['blocks']=blocks
    return result
