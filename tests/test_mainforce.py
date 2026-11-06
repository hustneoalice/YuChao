"""独立军情统计：真实 DuckDB、同日分母与历史成分去重。"""
import duckdb
import pytest


def test_rollup_pairing_calendar_and_drilldown(duckdb_file):
    from app.foundation.repo.mainforce import list_mainforce
    with duckdb.connect(str(duckdb_file)) as c:
        c.execute("INSERT INTO zy_block_member VALUES ('H110000','600519','贵州茅台'), ('H110700','600519','贵州茅台'), ('H110700','000858','五粮液')")
        c.execute("INSERT INTO capital_flow VALUES ('600519','2026-10-29',100,0,0,20,-120)")
        data = list_mainforce(c, type_code=4, period=3)
        r = next(r for r in data['items'] if r['key'] == 'H110000')
        assert data['as_of'] == '2026-10-30'
        assert data['days'] == ['2026-10-28','2026-10-29','2026-10-30']
        assert r['members'] == 2 and r['expected'] == 6 and r['covered'] == 3
        assert r['main']['net'] == 70_000_100
        assert r['main']['participation'] is None  # 29日缺同期估值
        assert r['main']['ratio'] is not None  # 分母仅与有资金的股日配对
        assert r['medium']['net'] == -19_999_980
        stocks = list_mainforce(c, view='stocks', block_code='H110000', period=3)
        assert stocks['total'] == 2
        assert [x['symbol'] for x in stocks['items']] == ['600519','000858']
        assert stocks['block_name'] == '农林牧渔'


def test_missing_data_and_no_future_valuation(duckdb_file):
    from app.foundation.repo.mainforce import list_mainforce
    with duckdb.connect(str(duckdb_file)) as c:
        c.execute("INSERT INTO zy_block_member VALUES ('H110700','300750','宁德时代')")
        c.execute("DELETE FROM daily_valuation WHERE symbol='600519'")
        c.execute("INSERT INTO daily_valuation(symbol,date,circ_mv) VALUES ('600519','2026-10-31',1)")
        r = list_mainforce(c, view='stocks', block_code='G000021')['items'][0]
        assert r['main']['participation'] is None
        empty = list_mainforce(c, type_code=4)['items'][0]
        assert empty['main']['net'] is None and empty['continuous_inflow_days'] is None
        assert empty['covered'] == 0
        assert list_mainforce(c, end='2000-01-01')['as_of'] is None


def test_streak_missing_latest_and_cap(duckdb_file):
    from app.foundation.repo.mainforce import list_mainforce
    with duckdb.connect(str(duckdb_file)) as c:
        c.execute('DELETE FROM capital_flow')
        c.execute("INSERT INTO capital_flow SELECT '600519', date, 1,0,0,2,-3 FROM daily_ohlcv WHERE symbol='600519'")
        r = list_mainforce(c, view='stocks', block_code='G000021')['items'][0]
        assert r['continuous_inflow_days'] == 55 and r['streak_capped'] is True
        assert list_mainforce(c, view='stocks', block_code='G000021')['items'][1]['continuous_inflow_days'] is None


def test_mainforce_http_contract(client):
    response = client.get('/api/v1/market/mainforce?type_code=2&period=1')
    assert response.status_code == 200
    assert response.json()['total'] == 1
    assert client.get('/api/v1/market/mainforce?period=2').status_code == 422
    assert client.get('/api/v1/market/mainforce?sort=sql').status_code == 422


def test_date_flow_paired_denominators_null_sort_and_pagination(duckdb_file):
    from app.foundation.repo.mainforce import list_mainforce
    with duckdb.connect(str(duckdb_file)) as c:
        c.execute('CREATE TABLE dated_flow AS SELECT * REPLACE (CAST(date AS DATE) AS date) FROM capital_flow')
        c.execute('DROP TABLE capital_flow')
        c.execute('ALTER TABLE dated_flow RENAME TO capital_flow')
        c.execute("INSERT INTO zy_block_member VALUES ('G000021','300750','宁德时代')")
        c.execute("UPDATE daily_ohlcv SET amount=1000 WHERE date='2026-10-30' AND symbol='600519'")
        c.execute("UPDATE daily_valuation SET circ_mv=2000 WHERE date='2026-10-30' AND symbol='600519'")
        r = list_mainforce(c, view='stocks', block_code='G000021')['items'][0]
        assert r['main']['ratio'] == 1.2e8 / 1000 * 100
        assert r['main']['participation'] == 1.2e8 / 2000 * 100
        assert r['medium']['net'] == -0.3e8
        assert r['small']['net'] == -0.9e8
        ascending = list_mainforce(c, view='stocks', block_code='G000021', sort='main_net')
        assert [r['symbol'] for r in ascending['items']] == ['000858','600519','300750']
        assert ascending['items'][-1]['main']['net'] is None
        assert list_mainforce(c, view='stocks', block_code='G000021', size=1, page=2)['items'][0]['symbol'] == '000858'
        c.execute("UPDATE market_snapshot SET trade_date='2026-10-31'")
        historical = list_mainforce(c, view='stocks', block_code='G000021')['items'][0]
        assert historical['change_rate'] == pytest.approx(1.59)
        assert historical['limit_up_count'] is None


def test_ratio_uses_same_day_valuation_amount_when_bar_amount_missing(duckdb_file):
    from app.foundation.repo.mainforce import list_mainforce
    with duckdb.connect(str(duckdb_file)) as c:
        c.execute("UPDATE daily_ohlcv SET amount=NULL WHERE symbol='600519' AND date='2026-10-30'")
        c.execute("UPDATE daily_valuation SET amount=1000 WHERE symbol='600519' AND date='2026-10-30'")
        kwargs = dict(view='stocks', block_code='G000021', q='600519')
        assert list_mainforce(c, **kwargs)['items'][0]['main']['ratio'] == 1.2e8 / 1000 * 100
        c.execute("UPDATE daily_ohlcv SET amount=0 WHERE symbol='600519' AND date='2026-10-30'")
        assert list_mainforce(c, **kwargs)['items'][0]['main']['ratio'] == 1.2e8 / 1000 * 100
        c.execute("UPDATE daily_valuation SET date='2026-10-31' WHERE symbol='600519'")
        assert list_mainforce(c, **kwargs)['items'][0]['main']['ratio'] is None


def test_all_stocks_use_universe_independent_of_hidden_type(duckdb_file):
    from app.foundation.repo.mainforce import list_mainforce
    with duckdb.connect(str(duckdb_file)) as c:
        c.execute("UPDATE stock_universe SET name='股票池名称' WHERE symbol='600519'")
        industry = list_mainforce(c, view='stocks', type_code=4)
        concept = list_mainforce(c, view='stocks', type_code=2)
        assert industry['total'] == concept['total'] == 3
        assert {r['symbol'] for r in industry['items']} == {'600519','000858','300750'}
        assert next(r for r in concept['items'] if r['symbol']=='600519')['name'] == '股票池名称'
        assert list_mainforce(c, view='stocks', q='股票池名称')['total'] == 1
        assert list_mainforce(c, view='stocks', block_code='unknown')['total'] == 0
