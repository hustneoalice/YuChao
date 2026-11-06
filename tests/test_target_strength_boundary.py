"""目标筛选与图表的强弱边界保持一致：收盘等于慢线也为强势。"""
import duckdb
import pytest

from app.foundation.repo import market


@pytest.mark.parametrize('last_close,expected', [(9.0, False), (10.0, True), (11.0, True)])
def test_target_strength_includes_slow_line_equality(duckdb_file, monkeypatch, last_close, expected):
    monkeypatch.setattr(market, '_live_overlay', lambda conn: None)
    monkeypatch.setattr(market, '_TGT_CACHE', {'key': None})
    with duckdb.connect(str(duckdb_file)) as conn:
        conn.execute('UPDATE daily_ohlcv SET close=10, open=10, high=11, low=9')
        conn.execute('UPDATE daily_ohlcv SET close=? WHERE date=(SELECT MAX(date) FROM daily_ohlcv)', [last_close])
        rows, _ = market.compute_target_scan(conn)
    assert rows
    for row in rows:
        assert row['short_orange'] is expected
        assert row['mid_orange'] is expected
