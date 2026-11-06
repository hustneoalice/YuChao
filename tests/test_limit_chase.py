import duckdb
import pytest


def align_snapshot(c, day='2026-10-30'):
    c.execute("UPDATE daily_ohlcv o SET open=s.open,high=s.high,low=s.low,close=s.current FROM market_snapshot s WHERE s.symbol=o.symbol AND CAST(o.date AS DATE)=s.trade_date AND s.trade_date=?",[day])


def test_precise_prices_and_one_word_classification():
    from app.foundation.repo.limit_chase import classify
    assert classify(dict(current=12,up_limit=12,open=10,high=12,low=9))=='sealed'
    assert classify(dict(current=12,up_limit=12,open=12,high=12,low=12))=='one'
    assert classify(dict(current=11,up_limit=12,open=10,high=12,low=9))=='broken'
    assert classify(dict(current=11,up_limit=None,open=10,high=12,low=9))=='unknown'
    assert classify(dict(current=11,up_limit=12,open=10,high=None,low=9))=='unknown'
    assert classify(dict(current=25,up_limit=30,open=25,high=26,low=24))=='normal'


def test_same_day_seal_quantity_and_historical_unknown(duckdb_file):
    from app.foundation.repo.limit_chase import list_chase
    with duckdb.connect(str(duckdb_file)) as c:
        align_snapshot(c)
        r=list_chase(c,'2026-10-30')
        s=next(x for x in r['today'] if x['symbol']=='000858')
        assert s['seal_shares']==5000*100
        assert s['seal_amount']==132*5000*100
        assert s['streak']==1 and s['streak_complete'] is False
        assert s['first_limit_time'] is None and s['max_seal_amount'] is None
        c.execute("UPDATE market_snapshot SET bid1=NULL,bid1_vol=NULL WHERE symbol='000858'")
        s=next(x for x in list_chase(c,'2026-10-30')['today'] if x['symbol']=='000858')
        assert s['seal_amount'] is None
        assert list_chase(c,'2026-10-31')['today']==[]


def test_previous_snapshot_and_block_dedup(duckdb_file):
    from app.foundation.repo.limit_chase import list_chase
    with duckdb.connect(str(duckdb_file)) as c:
        c.execute("INSERT INTO zy_block_member VALUES ('H110000','000858','五粮液'),('H110700','000858','五粮液'),('H110000','600519','贵州茅台')")
        c.execute("UPDATE daily_ohlcv SET open=120,high=121,low=119,close=120 WHERE symbol='000858' AND date='2026-10-29'")
        # 精确历史快照是已知非涨停，才能确定首板；未来快照不能补历史。
        c.execute("INSERT INTO market_snapshot (symbol,kind,market,name,current,open,high,low,up_limit,trade_date) VALUES ('000858','stock','SZ','五粮液',120,120,121,119,132,'2026-10-29')")
        align_snapshot(c)
        r=list_chase(c,'2026-10-30')
        s=next(x for x in r['today'] if x['symbol']=='000858')
        assert s['streak_complete'] is True and s['streak']==1
        b=next(x for x in r['blocks'] if x['code']=='H110000')
        assert b['members']==2 and b['up_count']==1 and b['up_ratio']==50
        assert b['symbols']==['000858']
        c.execute("UPDATE market_snapshot SET name='*ST五粮液' WHERE symbol='000858' AND trade_date='2026-10-30'")
        assert list_chase(c,'2026-10-30')['today']==[]
        assert len(list_chase(c,'2026-10-30',show_st=True)['today'])==1


def test_chase_endpoint_validation(client):
    assert client.get('/api/v1/market/limit-chase?end=invalid').status_code==422
    assert client.get('/api/v1/market/limit-chase?markets=invalid').status_code==422


def test_wrong_day_quote_cannot_create_false_continuation(duckdb_file):
    from app.foundation.repo.limit_chase import list_chase
    with duckdb.connect(str(duckdb_file)) as c:
        c.execute("UPDATE daily_ohlcv SET open=120,high=132,low=119.5,close=132 WHERE symbol='000858' AND date='2026-10-30'")
        c.execute("INSERT INTO market_snapshot (symbol,kind,market,name,current,open,high,low,up_limit,trade_date) VALUES ('000858','stock','SZ','五粮液',132,120,132,119.5,132,'2026-10-29')")
        align_snapshot(c)
        r=list_chase(c,'2026-10-30')
        s=next(x for x in r['today'] if x['symbol']=='000858')
        assert s['streak']==1 and not s['streak_complete']
        assert r['invalid_previous_snapshots']>=1
        assert r['summary']['continuity_rate'] is None


def test_unverifiable_day_is_not_displayed_as_zero_limit_ups(duckdb_file):
    from app.foundation.repo.limit_chase import list_chase
    with duckdb.connect(str(duckdb_file)) as c:
        c.execute("DELETE FROM market_snapshot WHERE symbol='600519'")
        c.execute("UPDATE market_snapshot SET current=999 WHERE symbol='000858'")
        r=list_chase(c,'2026-10-30')
        assert r['today']==[]
        assert r['summary']['up_count'] is None


def test_chase_query_accepts_ui_period_and_markets(client):
    response=client.get('/api/v1/market/limit-chase?end=2026-10-30&markets=main,chi,star,bj&show_st=false&period=3')
    assert response.status_code==200
    assert response.json()['period']==3
    assert client.get('/api/v1/market/limit-chase?period=7').status_code==422
