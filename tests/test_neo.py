import json
import time
import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.neo.router import router
from app.foundation.db import get_conn

@pytest.fixture
def neo(duckdb_file, tmp_path, monkeypatch):
    import duckdb
    monkeypatch.setenv('YUCHAO_NEO_SIGNING_KEY', 'x' * 32)
    monkeypatch.setenv('YUCHAO_NEO_ISSUER', 'test-instance')
    grants = tmp_path / 'grants.json'
    grants.write_text(json.dumps({'1': {'capabilities': ['neo.trend_histogram'], 'expires_at': '2099-01-01T00:00:00+08:00'}}))
    monkeypatch.setenv('YUCHAO_NEO_GRANTS_FILE', str(grants))
    app = FastAPI()
    app.include_router(router)
    def conn():
        c = duckdb.connect(str(duckdb_file))
        try: yield c
        finally: c.close()
    app.dependency_overrides[get_conn] = conn
    return TestClient(app), grants

def token(**kwargs):
    now = int(time.time())
    return jwt.encode(dict(iss='test-instance', aud='neo-compute', sub='1', scope='neo.trend_histogram', iat=now, exp=now+30, jti='test') | kwargs, 'x'*32, algorithm='HS256')

BODY = dict(capability='neo.trend_histogram', instrument_id='CN:SH:stock:600519', end='2026-10-30', limit=3)

def test_protected_real_output(neo):
    client, _ = neo
    assert client.post('/api/v1/neo/evaluate', json=BODY).status_code == 401
    response = client.post('/api/v1/neo/evaluate', json=BODY, headers={'Authorization': 'Bearer '+token()})
    assert response.status_code == 200, response.text
    data = response.json()
    assert len(data['points']) == 3
    assert data['coverage']['bars'] == 60
    assert data['points'][-1]['value'] > 0

@pytest.mark.parametrize('claims', [{'exp':1}, {'scope':'neo.short_trend'}, {'iss':'wrong'}, {'sub':'2'}])
def test_denied_tokens(neo, claims):
    response = neo[0].post('/api/v1/neo/evaluate', json=BODY, headers={'Authorization':'Bearer '+token(**claims)})
    assert response.status_code in (401,403)

def test_revocation_and_wrong_exchange(neo):
    client, grants = neo
    headers = {'Authorization':'Bearer '+token()}
    assert client.post('/api/v1/neo/evaluate', json=BODY | {'instrument_id':'CN:SZ:stock:600519'}, headers=headers).status_code == 404
    grants.write_text('{}')
    assert client.post('/api/v1/neo/evaluate', json=BODY, headers=headers).status_code == 403


def test_expired_grant_and_tampered_token(neo):
    client, grants = neo
    grants.write_text(json.dumps({'1': {'capabilities':['neo.trend_histogram'], 'expires_at':'2000-01-01T00:00:00+08:00'}}))
    assert client.post('/api/v1/neo/evaluate', json=BODY, headers={'Authorization':'Bearer '+token()}).status_code == 403
    assert client.post('/api/v1/neo/evaluate', json=BODY, headers={'Authorization':'Bearer '+token()+'corrupt'}).status_code == 401


def test_unconfigured_and_strict_date(neo, monkeypatch):
    client, _ = neo
    monkeypatch.delenv('YUCHAO_NEO_SIGNING_KEY')
    assert client.post('/api/v1/neo/evaluate', json=BODY).status_code == 503
    from app.neo.contracts import EvaluationRequest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        EvaluationRequest(**(BODY | {'end':0}))


def test_finerove_roundtrip_filters_private_fields(duckdb_file, tmp_path, monkeypatch):
    import asyncio
    async def run():
        from pathlib import Path
        import duckdb
        import httpx
        public_src = Path(__file__).resolve().parents[2] / 'FinRove' / 'src'
        if not public_src.exists():
            pytest.skip('Sibling FineRove source not installed')
        monkeypatch.syspath_prepend(str(public_src))
        from finerove.finance.service import NeoService
        from finerove.finance.contracts import EvaluationRequest
        grants = tmp_path / 'roundtrip-grants.json'
        grants.write_text(json.dumps({'7':{'capabilities':['neo.trend_histogram'], 'expires_at':'2099-01-01T00:00:00+08:00'}}))
        for prefix in ('FINEROVE', 'YUCHAO'):
            monkeypatch.setenv(prefix+'_NEO_SIGNING_KEY', 'r'*32)
            monkeypatch.setenv(prefix+'_NEO_ISSUER', 'roundtrip')
        monkeypatch.setenv('FINEROVE_NEO_BASE_URL', 'http://127.0.0.1')
        monkeypatch.setenv('YUCHAO_NEO_GRANTS_FILE', str(grants))
        app = FastAPI()
        app.include_router(router)
        def conn():
            c = duckdb.connect(str(duckdb_file))
            try: yield c
            finally: c.close()
        app.dependency_overrides[get_conn] = conn
        service = NeoService(httpx.AsyncClient(transport=httpx.ASGITransport(app=app)))
        result = await service.evaluate(7, EvaluationRequest(**BODY))
        assert len(result.points) == 3
        from app.foundation.repo.market import get_kline
        from app.foundation.target_trend import trend_histogram
        from app.contracts.common import Adjust
        c = duckdb.connect(str(duckdb_file))
        try:
            bars = get_kline(c, '600519', adjust=Adjust.qfq, end=BODY['end'], limit=2000)['bars']
            assert [p.value for p in result.points] == trend_histogram(bars)[-3:]
        finally:
            c.close()
        await service.close()

    asyncio.run(run())
