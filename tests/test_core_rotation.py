from app.foundation.repo.core_rotation import select_rotation


def board(code, change=3, net=100):
    return dict(key=code,name=code,change_rate=change,main=dict(net=net))


def stock(symbol, ratio=10, net=100):
    return dict(symbol=symbol,name=symbol,change_rate=1,main=dict(net=net,ratio=ratio,participation=1))


def test_threshold_top15_previous_and_positive_money():
    blocks={4:[board('equal',2,999),board('old',4,999),board('negative',3,-1),board('winner')]+[board(str(i),5,1) for i in range(13)]}
    result=select_rotation(blocks,{'old':[stock('600001')],'winner':[stock('600002')]},{'old'})
    # 不再限制板块前15名。
    assert 'winner' in [b['key'] for b in result['selected_blocks']]
    assert next(b for b in result['candidates'] if b['key']=='old')['reason']=='昨日已选'
    equal=select_rotation({4:[board('equal',2),board('winner')]},{'winner':[stock('600002')]},set())
    assert equal['items'][0]['symbol']=='600002'


def test_mainboard_ratio_net_dedup_four_and_missing():
    result=select_rotation({4:[board('a')],9:[board('b')]},{
        'a':[stock('300001',99),stock('600001',5),stock('000001',10),stock('600002',None),stock('600003',20,-1)],
        'b':[stock('600001',5),stock('000002',10,200),stock('688001',80)]},set())
    assert [s['symbol'] for s in result['groups'][0]['items']]==['300001','000001','600001']
    assert [s['symbol'] for s in result['groups'][1]['items']]==['688001','000002','600001']
    assert len(result['groups'])==2
    assert len(result['items'][1]['sources'])==1
    assert result['items'][1]['mainboard'] is True
    assert result['items'][0]['mainboard'] is False


def test_empty_and_stable_ties():
    assert select_rotation({4:[]},{},set())['items']==[]
    result=select_rotation({1:[board('z'),board('a')]},{'a':[stock('600002'),stock('600001')]},set())
    assert result['selected_blocks'][0]['key']=='a'
    assert [s['symbol'] for s in result['items']]==['600001','600002']


def test_waiting_preserves_result_and_manual_rerun_uses_previous_trade_day(duckdb_file, monkeypatch):
    import duckdb
    from app.foundation.repo import core_rotation as repo
    def cached(conn, view='blocks', type_code=4, **kwargs):
        return {'items': [stock('600001')] if view=='stocks' else [board('a'+str(type_code))]}
    monkeypatch.setattr(repo,'cached_mainforce',cached)
    with duckdb.connect(str(duckdb_file)) as c:
        first=repo.run_rotation(c,'2026-10-30')
        second=repo.run_rotation(c,'2026-10-30')
        assert first['status']=='completed' and second['items']==first['items']
        assert second['previous_available'] is False
        waiting=repo.run_rotation(c,'2026-11-02')
        assert waiting['status']=='waiting'
        saved=repo.read_rotation(c)
        assert saved['result']['date']=='2026-10-30'
        assert saved['latest_attempt']['status']=='waiting'
        assert saved['history']==['2026-10-30']
        assert len(saved['runs'])==3
        assert repo.read_rotation(c,'2026-10-29')['result'] is None


def test_previous_trading_day_blocks_are_excluded(duckdb_file, monkeypatch):
    import duckdb,json
    from app.foundation.repo import core_rotation as repo
    def cached(conn, view='blocks', type_code=4, **kwargs):
        return {'items': [stock('600001')] if view=='stocks' else [board('a'+str(type_code))]}
    monkeypatch.setattr(repo,'cached_mainforce',cached)
    with duckdb.connect(str(duckdb_file)) as c:
        c.execute(repo.DDL)
        prev=c.execute("SELECT MAX(CAST(date AS DATE)) FROM daily_ohlcv WHERE CAST(date AS DATE)<'2026-10-30'").fetchone()[0]
        repo._save(c,dict(date=str(prev),status='completed',selected_blocks=[{'key':'a4'}]))
        r=repo.run_rotation(c,'2026-10-30')
        assert r['previous_available'] is True
        assert [b['key'] for b in r['selected_blocks']]==['a9','a1']


def test_http_rotation_empty(client):
    r=client.get('/api/v1/corepicks/rotation')
    assert r.status_code==200
    assert r.json()['result'] is None


def test_scheduler_retry_waits_then_stops_after_success(monkeypatch):
    from datetime import datetime
    from app.updater import scheduler
    from app.foundation import db
    from app.foundation.repo import core_rotation
    class Conn:
        def close(self): pass
    monkeypatch.setattr(db,'open_conn',lambda:Conn())
    monkeypatch.setattr(scheduler,'now_cst',lambda:datetime(2026,11,4,20,10))
    monkeypatch.setattr(scheduler,'is_trading_day',lambda now:True)
    calls=[]
    monkeypatch.setattr(scheduler,'_submit',lambda *args,**kwargs:calls.append(kwargs))
    monkeypatch.setattr(core_rotation,'read_rotation',lambda c:{'latest_attempt':{'date':'2026-11-04','status':'waiting'}})
    scheduler._retry_corepicks(object())
    assert len(calls)==1
    monkeypatch.setattr(core_rotation,'read_rotation',lambda c:{'latest_attempt':{'date':'2026-11-04','status':'completed'}})
    scheduler._retry_corepicks(object())
    assert len(calls)==1


def test_history_backfill_does_not_replace_latest(duckdb_file):
    import duckdb
    from app.foundation.repo import core_rotation as repo
    with duckdb.connect(str(duckdb_file)) as c:
        c.execute(repo.DDL)
        repo._save(c, dict(date='2026-10-30', status='completed'))
        repo._save(c, dict(date='2026-10-29', status='completed'))
        assert repo.read_rotation(c)['result']['date'] == '2026-10-30'
        assert repo.read_rotation(c, '2026-10-29')['result']['date'] == '2026-10-29'


def test_rotation_invalid_date(client):
    assert client.get('/api/v1/corepicks/rotation?date=invalid').status_code == 422


def test_rotation_submit_historical_date(client, monkeypatch):
    from app.foundation.repo import health
    from app.stream.bus import ControlRequests
    monkeypatch.setattr(health, 'updater_alive', lambda: True)
    calls=[]
    monkeypatch.setattr(ControlRequests, 'submit', lambda self,*a,**kw: calls.append(kw) or 'test')
    response=client.post('/api/v1/corepicks/rotation/run?date=2026-10-30')
    assert response.status_code == 202
    assert calls[0]['params']['rotation_date'] == '2026-10-30'
    assert client.post('/api/v1/corepicks/rotation/run?date=2099-01-01').status_code == 422


def test_each_board_gets_own_four():
    result=select_rotation({4:[board('a'),board('b')]},{k:[stock(f'60000{i}') for i in range(6)] for k in ('a','b')},set())
    assert [len(g['items']) for g in result['groups']] == [4,4]
    assert len(result['items']) == 8


def test_net_top_twelve_before_ratio_and_no_refill_for_missing_ratio():
    stocks=[stock(f'600{i:03}',ratio=i,net=100-i) for i in range(14)]
    stocks[0]['main']['ratio']=None
    stocks[12]['main']['ratio']=999
    r=select_rotation({4:[board('a')]},{'a':stocks},set())
    assert [s['symbol'] for s in r['items']]==['600011','600010','600009','600008']
    assert [s['fund_rank'] for s in r['items']]==[12,11,10,9]
