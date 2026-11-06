import math
import pytest


def test_frozen_score_matches_research_and_invalid_inputs():
    from app.foundation.repo.mainforce_motion import score_motion
    r=score_motion(2586353061.97,12.317873299296318,1.671755774657316)
    assert r['score_raw']==pytest.approx(620.7005254597063)
    assert sum(r['contributions'].values())==pytest.approx(r['score_raw'])
    assert score_motion(-1,10,2) is None
    assert score_motion(100,None,2) is None
    assert score_motion(100,10,math.inf) is None


def test_historical_inputs_and_complete_twenty_days(duckdb_file):
    import duckdb
    from datetime import date,timedelta
    from app.foundation.repo.mainforce_motion import list_motion
    with duckdb.connect(str(duckdb_file)) as c:
        days=[str(date(2026,8,1)+timedelta(days=i)) for i in range(22)]
        for symbol,volume in [('600001',200),('600002',300)]:
            c.execute("INSERT OR REPLACE INTO stock_universe (symbol,name,market) VALUES (?,?,'sh')",[symbol,symbol])
            c.executemany('INSERT OR REPLACE INTO daily_ohlcv (symbol,date,close,volume,amount,pct_chg) VALUES (?,?,10,?,1000,1)',[(symbol,d,volume if d==days[20] else 100) for d in days])
            c.execute('INSERT OR REPLACE INTO capital_flow (symbol,date,net_main) VALUES (?,?,100)',[symbol,days[20]])
        c.execute('UPDATE daily_ohlcv SET volume=NULL WHERE symbol=? AND date=?',['600002',days[0]])
        r=list_motion(c,days[20])
        assert r['as_of']==days[20]
        assert len(r['items'])==1
        assert r['items'][0]['volume_rel20']==2
        assert r['items'][0]['ratio']==10
        assert r['excluded']['history']==1
        c.execute('UPDATE daily_ohlcv SET amount=NULL WHERE symbol=? AND date=?',['600001',days[20]])
        c.execute('INSERT OR REPLACE INTO daily_valuation (symbol,date,amount) VALUES (?,?,1000)',['600001',days[20]])
        assert len(list_motion(c,days[20])['items'])==1
        c.execute('UPDATE daily_valuation SET amount=NULL WHERE symbol=? AND date=?',['600001',days[20]])
        assert list_motion(c,days[20])['excluded']['amount']==1


def test_motion_endpoint_validates_date(client):
    assert client.get('/api/v1/market/mainforce-motion?end=invalid').status_code==422
    assert client.get('/api/v1/market/mainforce-motion?end=2099-01-01').status_code==422
