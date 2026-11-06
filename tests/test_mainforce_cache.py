import duckdb


def test_cache_reuses_rollup_across_sort_search_page_and_reopen(duckdb_file, monkeypatch):
    from app.foundation.repo import mainforce as repo
    from app.foundation.repo.mainforce_cache import cached_mainforce
    original = repo.list_mainforce
    calls = []
    def compute(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(repo, 'list_mainforce', compute)
    with duckdb.connect(str(duckdb_file)) as c:
        first = cached_mainforce(c, view='stocks', size=1)
        second = cached_mainforce(c, view='stocks', sort='name', q='600519', size=20)
        assert first['total'] > 1
        assert second['total'] == 1
        assert second['items'][0]['symbol'] == '600519'
    with duckdb.connect(str(duckdb_file)) as c:
        assert cached_mainforce(c, view='stocks', size=1) == first
    assert len(calls) == 1


def test_cache_invalidates_on_update_log_and_new_flow(duckdb_file):
    from app.foundation.repo.mainforce_cache import cached_mainforce
    with duckdb.connect(str(duckdb_file)) as c:
        before = cached_mainforce(c, view='stocks', q='600519')
        c.execute("UPDATE capital_flow SET net_main=123 WHERE symbol='600519'")
        c.execute("CREATE TABLE IF NOT EXISTS update_log(data_type VARCHAR, created_at TIMESTAMP)")
        c.execute("INSERT INTO update_log(data_type,created_at) VALUES ('capital_flow',CURRENT_TIMESTAMP)")
        after = cached_mainforce(c, view='stocks', q='600519')
        assert after['items'][0]['main']['net'] == 123
        assert before['items'][0]['main']['net'] != 123
        c.execute("INSERT INTO capital_flow VALUES ('600519','2026-11-02',456,0,0,0,0)")
        assert cached_mainforce(c, view='stocks', q='600519')['as_of'] == '2026-11-02'


def test_cached_drilldown_matches_original_and_failed_refresh_preserves_file(duckdb_file, monkeypatch):
    from app.foundation.repo import mainforce
    from app.foundation.repo.mainforce_cache import cached_mainforce
    import pytest
    with duckdb.connect(str(duckdb_file)) as c:
        expected = mainforce.list_mainforce(c, view='stocks', block_code='G000021')
        assert cached_mainforce(c, view='stocks', block_code='G000021') == expected
        def fail(*args, **kwargs):
            raise RuntimeError('refresh failed')
        monkeypatch.setattr(mainforce, 'list_mainforce', fail)
        with pytest.raises(RuntimeError):
            cached_mainforce(c, view='stocks', force=True)
        assert cached_mainforce(c, view='stocks', block_code='G000021') == expected


def test_cache_invalidates_when_members_change_without_row_count_change(duckdb_file):
    from app.foundation.repo.mainforce_cache import cached_mainforce
    with duckdb.connect(str(duckdb_file)) as c:
        before = cached_mainforce(c, type_code=2)
        c.execute("UPDATE zy_block_member SET symbol='300750' WHERE block_code='G000021' AND symbol='600519'")
        after = cached_mainforce(c, type_code=2)
        assert before['items'][0]['main']['net'] != after['items'][0]['main']['net']
