import json
import subprocess
from pathlib import Path

import pytest

from app.foundation.target_trend import trend_histogram, trend_summary, trend_matches


def test_formula_matches_frontend():
    bars = [dict(high=12+i/10, low=10+i/10, close=11+i/10) for i in range(180)]
    module = (Path(__file__).parents[1] / 'frontend/src/trend-histogram.ts').as_uri()
    script = f"import {{trendHistogramSeries}} from '{module}'; let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(trendHistogramSeries(JSON.parse(s)).map(v=>v.short)));"
    expected = json.loads(subprocess.check_output(['node', '--experimental-strip-types', '--input-type=module', '-e', script], input=json.dumps(bars).encode()))
    assert trend_histogram(bars) == pytest.approx(expected)


def test_cross_boundary_and_still_above():
    summary = trend_summary(['01', '02', '03', '04'], [-2, 0, 3, 4])
    assert summary['trend_cross_date'] == '03'
    assert summary['trend_cross_ago'] == 1
    assert summary['trend_above_days'] == 2
    assert trend_matches(summary, 'cross', 2, True, 1)
    assert not trend_matches(summary, 'cross', 1, True, 1)
    assert trend_matches(summary, 'above', 5, True, 2)
    assert not trend_matches(summary, 'above', 5, True, 3)


def test_reversal_missing_and_latest_cross():
    summary = trend_summary(['01', '02', '03', '04'], [-1, 2, -1, -2])
    assert not trend_matches(summary, 'cross', 5, True, 1)
    assert trend_matches(summary, 'cross', 5, False, 1)
    assert summary['trend_above_days'] == 0
    assert trend_summary(['01', '02', '03'], [-1, None, 1])['trend_cross_date'] is None
    assert trend_summary(['01', '02', '03', '04'], [-1, 1, 0, 2])['trend_cross_date'] == '04'
    assert trend_histogram([dict(high=1, low=1, close=1)] * 20) == [None] * 20


def test_endpoint_independent_combined_and_time_controls(client, monkeypatch):
    from app.foundation.repo import market
    base = dict(name='测试', close=10, pct_chg=0, vol_hit=True, vol_ratio=1,
                short_orange=True, mid_orange=True, limit_up_20d=False,
                limit_up_cnt=0, seg=3, seg_name='弱势', pullback=False)
    rows = [{**base, 'symbol': '000001'}, {**base, 'symbol': '000002', 'vol_hit': False}]
    monkeypatch.setattr(market, 'stock_targets_universe', lambda conn: (rows, dict(scanned=2, as_of='2026-10-30')))
    monkeypatch.setattr(market, 'stock_target_trends', lambda conn: {
        '000001': dict(trend_value=2, trend_cross_date='2026-10-29', trend_cross_ago=1, trend_above_days=2, trend_data_date='2026-10-30'),
        '000002': dict(trend_value=-1, trend_cross_date='2026-10-30', trend_cross_ago=0, trend_above_days=0, trend_data_date='2026-10-30'),
    })
    url = '/api/v1/market/targets'
    def symbols(**params):
        r = client.get(url, params=params)
        assert r.status_code == 200
        return [t['symbol'] for t in r.json()['items']]
    assert symbols(conds='trend') == ['000001']
    assert symbols(conds='trend', trend_still_above=False) == ['000002', '000001']
    assert symbols(conds='trend,vol', trend_still_above=False) == ['000001']
    assert symbols(conds='trend', trend_recent=1) == []
    assert symbols(conds='trend', trend_mode='above', trend_above_days=3) == []
    assert symbols(conds='trend', trend_mode='above', trend_above_days=2) == ['000001']
    assert client.get(url, params={'trend_recent': 0}).status_code == 422
    assert client.get(url, params={'trend_mode': 'invalid'}).status_code == 422


def test_calendar_age_counts_market_sessions_including_suspension():
    row = trend_summary(['01', '02', '05'], [-1, 1, 2], {str(i).zfill(2): i for i in range(1, 6)})
    assert row['trend_cross_ago'] == 3


def test_stock_cache_only_recalculates_changed_symbol(duckdb_file, monkeypatch):
    import duckdb
    from app.foundation.repo import market
    import app.foundation.target_trend as module
    monkeypatch.setattr(market, '_TGT_TREND_CACHE', {'keys': {}, 'rows': {}})
    calls = []
    original = module.trend_histogram
    def count(bars):
        calls.append(len(bars))
        return original(bars)
    monkeypatch.setattr(module, 'trend_histogram', count)
    conn = duckdb.connect(str(duckdb_file))
    try:
        first = market.stock_target_trends(conn)
        assert first
        count_first = len(calls)
        assert count_first > 0
        assert market.stock_target_trends(conn) == first
        assert len(calls) == count_first
        symbol = next(iter(first))
        conn.execute('UPDATE daily_ohlcv SET close=close+0.1 WHERE symbol=? AND date=(SELECT MAX(date) FROM daily_ohlcv WHERE symbol=?)', [symbol, symbol])
        market.stock_target_trends(conn)
        assert len(calls) == count_first + 1
    finally:
        conn.close()
