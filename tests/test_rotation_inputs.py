from app.updater.collectors import rotation_inputs as inputs


def test_same_day_denominators_are_persisted_without_overwriting(duckdb_file, monkeypatch):
    import duckdb
    conn = duckdb.connect(str(duckdb_file))
    day='2026-10-30'
    conn.execute("INSERT OR REPLACE INTO capital_flow (symbol,date,net_main) VALUES ('600001',?,100),('600002',?,200)",[day,day])
    conn.execute("INSERT OR REPLACE INTO daily_valuation (symbol,date,amount,circ_mv) VALUES ('600001',?,0,123)",[day])
    monkeypatch.setattr(inputs.writer,'conn',lambda:conn)
    monkeypatch.setattr(inputs.writer,'reset',lambda:None)
    monkeypatch.setattr(inputs,'_tx_quotes',lambda s:{
        '600001':dict(qdate=day,amount=1000,circ_mv_yi=2),
        '600002':dict(qdate='2026-11-02',amount=999,circ_mv_yi=9)})
    assert inputs.complete_rotation_inputs(day)==1
    assert conn.execute("SELECT amount,circ_mv FROM daily_valuation WHERE symbol='600001' AND date=?",[day]).fetchone()==(1000,123)
    assert conn.execute("SELECT COUNT(*) FROM daily_valuation WHERE symbol='600002' AND date=?",[day]).fetchone()[0]==0
    conn.close()
