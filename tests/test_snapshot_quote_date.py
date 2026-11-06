from datetime import datetime


def test_intraday_snapshot_uses_current_session_not_last_close(monkeypatch):
    from app.updater.collectors import market_snapshot as mod
    monkeypatch.setattr(mod,'expected_asof',lambda *args:'2026-11-03')
    assert mod.snapshot_day(datetime(2026,11,4,10,0))=='2026-11-04'
    assert mod.snapshot_day(datetime(2026,11,4,8,0))=='2026-11-03'


def test_snapshot_provider_rejects_quotes_from_other_day(monkeypatch):
    from app.updater.collectors import sources
    fields=['0']*52
    fields[1]='测试';fields[3]='10';fields[30]='20261104150000'
    monkeypatch.setattr(sources,'_get_text',lambda url:'v_sh600001="'+'~'.join(fields)+'";')
    assert sources.fetch_qt_snapshot(['600001'],expected_date='2026-11-03')=={}
    assert '600001.SH' in sources.fetch_qt_snapshot(['600001'],expected_date='2026-11-04')
