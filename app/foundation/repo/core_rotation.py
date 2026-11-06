"""主力军情强轮动核心标：公开规则、逐次快照与入选依据。"""
import json
from uuid import uuid4

from .mainforce_cache import cached_mainforce
from ...updater.util import now_cst

DDL = '''CREATE TABLE IF NOT EXISTS core_rotation_runs (
    id VARCHAR PRIMARY KEY, trade_date VARCHAR, created_at VARCHAR,
    status VARCHAR, payload VARCHAR)'''
KINDS = {4: '行业', 9: '题材', 1: '地域'}
NOTE = '板块涨幅为当日成分股平均涨幅；资金沿用主力军情口径。按当前成分回看历史，不能还原历史成分。缺失占比不参与个股优选；不足4只不自动放宽。'


def select_rotation(blocks_by_type, stocks_by_block, previous):
    candidates, selected = [], []
    for kind, blocks in blocks_by_type.items():
        ranked = sorted(blocks, key=lambda b: (-(b['change_rate'] if b['change_rate'] is not None else float('-inf')), b['key']))
        eligible = []
        for rank, b in enumerate(ranked, 1):
            change, net = b['change_rate'], b['main']['net']
            reason = ('缺少涨幅' if change is None else '涨幅不大于2%' if change <= 2 else
                      '昨日已选' if b['key'] in previous else '主力未净流入' if net is None or net <= 0 else '已优选')
            row = dict(b, type_code=kind, category=KINDS[kind], change_rank=rank, reason=reason)
            candidates.append(row)
            if reason == '已优选':
                eligible.append(row)
        eligible.sort(key=lambda b: (-b['main']['net'], b['key']))
        selected.extend(eligible)
    items, groups = [], []
    excluded = 0
    eligible_count = 0
    for b in selected:
        stocks = {}
        for s in stocks_by_block.get(b['key'], []):
            if s['main']['net'] is None or s['main']['net'] <= 0 :
                excluded += 1
                continue
            symbol = s['symbol']
            stocks[symbol] = dict(s, mainboard=symbol.startswith(('000','001','002','003','600','601','603','605')),
                sources=[dict(code=b['key'], name=b['name'], category=b['category'], change_rank=b['change_rank'])])
        funded = sorted(stocks.values(), key=lambda s: (-s['main']['net'], s['symbol']))[:12]
        pool = [dict(s, fund_rank=i) for i,s in enumerate(funded,1) if s['main']['ratio'] is not None]
        excluded += sum(s['main']['ratio'] is None for s in funded)
        ranked = sorted(pool, key=lambda s: (-s['main']['ratio'], -s['main']['net'], s['symbol']))
        picks = [dict(s, rank=i) for i,s in enumerate(ranked[:4], 1)]
        groups.append(dict(block=b, items=picks, eligible_stocks=len(ranked)))
        items.extend(picks)
        eligible_count += len(ranked)
    return dict(items=items, groups=groups, candidates=candidates,
                selected_blocks=selected, eligible_stocks=eligible_count, excluded_stock_records=excluded)


def _save(conn, payload):
    payload = dict(payload, id=uuid4().hex, created_at=now_cst().isoformat(), rule_version='rotation-v4', note=NOTE)
    conn.execute('INSERT INTO core_rotation_runs VALUES (?,?,?,?,?)',
                 [payload['id'],payload['date'],payload['created_at'],payload['status'],json.dumps(payload,ensure_ascii=False)])
    return payload


def run_rotation(conn, day, progress=None, cancel=None, trigger='manual'):
    conn.execute(DDL)
    day = str(day)
    dates = {table: str(conn.execute(f'SELECT MAX(CAST(date AS DATE)) FROM {table} WHERE CAST(date AS DATE)<=?', [day]).fetchone()[0] or '')
             for table in ('capital_flow','daily_valuation','daily_ohlcv')}
    base = dict(date=day, trigger=trigger, data_dates=dates)
    if any(d != day for d in dates.values()):
        return _save(conn,dict(base,status='waiting',message='等待同日收盘数据：'+ '、'.join(t for t,d in dates.items() if d != day)))
    # 取真实上一交易日，不能拿上一次运行日期代替；没有昨日记录时明确提示。
    prev = conn.execute('SELECT MAX(CAST(date AS DATE)) FROM daily_ohlcv WHERE CAST(date AS DATE)<?',[day]).fetchone()[0]
    previous = conn.execute("SELECT payload FROM core_rotation_runs WHERE trade_date=? AND status='completed' ORDER BY created_at DESC LIMIT 1",[str(prev)]).fetchone() if prev else None
    prev_codes = {b['key'] for b in json.loads(previous[0])['selected_blocks']} if previous else set()
    blocks = {}
    for i, kind in enumerate(KINDS, 1):
        if cancel and cancel():
            return _save(conn,dict(base,status='cancelled',message='计算已停止'))
        if progress:
            progress(stage='筛选优选板块',total=4,done=i-1,message=KINDS[kind])
        blocks[kind] = cached_mainforce(conn,type_code=kind,end=day,size=100000)['items']
    chosen = select_rotation(blocks,{},prev_codes)['selected_blocks']
    stocks = {b['key']:cached_mainforce(conn,view='stocks',block_code=b['key'],end=day,size=100000)['items'] for b in chosen}
    if cancel and cancel():
        return _save(conn,dict(base,status='cancelled',message='计算已停止'))
    result = select_rotation(blocks,stocks,prev_codes)
    if progress:
        progress(stage='保存核心标快照',total=4,done=4,message=f"入选{len(result['items'])}只")
    return _save(conn,dict(base,**result,status='completed',previous_date=str(prev) if prev else None,
                          previous_available=bool(previous),message=f"入选{len(result['items'])}只 / 每板块最多4只"))


def read_rotation(conn, day=None):
    exists=conn.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_name='core_rotation_runs'").fetchone()[0]
    if not exists:
        return dict(result=None, latest_attempt=None, history=[], runs=[])
    rows=conn.execute('SELECT payload FROM core_rotation_runs ORDER BY created_at DESC LIMIT 100').fetchall()
    runs=[json.loads(r[0]) for r in rows]
    latest= runs[0] if runs else None
    # 结果不随失败、等待记录消失，历史日期读取也独立于最新尝试。
    cond=' AND trade_date=?' if day else ''
    row=conn.execute("SELECT payload FROM core_rotation_runs WHERE status='completed'"+cond+' ORDER BY trade_date DESC, created_at DESC LIMIT 1',[day] if day else []).fetchone()
    dates=conn.execute("SELECT DISTINCT trade_date FROM core_rotation_runs WHERE status='completed' ORDER BY trade_date DESC").fetchall()
    return dict(result=json.loads(row[0]) if row else None,latest_attempt=latest,
                history=[r[0] for r in dates],runs=[{k:r.get(k) for k in ('id','date','created_at','trigger','status','message')} for r in runs[:30]])
