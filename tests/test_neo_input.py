"""A private calculation uses only the caller's signed price snapshot."""
import hashlib
import json
import time
from datetime import date, timedelta

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.foundation.db import get_conn
from app.foundation.target_trend import trend_histogram
from app.neo.router import router


@pytest.fixture
def compute(tmp_path, monkeypatch):
    from app.neo import auth
    auth._recent.clear()
    grants = tmp_path / 'grants.json'
    grants.write_text(json.dumps({'47': {'capabilities': ['neo.trend_histogram'], 'expires_at': '2099-01-01T00:00:00+08:00'}}))
    monkeypatch.setenv('YUCHAO_NEO_SIGNING_KEY', 'i' * 32)
    monkeypatch.setenv('YUCHAO_NEO_ISSUER', 'input-test')
    monkeypatch.setenv('YUCHAO_NEO_GRANTS_FILE', str(grants))
    app = FastAPI()
    app.include_router(router)
    def forbidden_db():
        raise AssertionError('pure compute must not acquire a database')
    app.dependency_overrides[get_conn] = forbidden_db
    return TestClient(app)


def payload():
    bars = [dict(date=(date(2020, 1, 1) + timedelta(days=i)).isoformat(), open=10.0+i/100, high=12.0+i/100,
                 low=9.0+i/100, close=11.0+i/100, volume=None, amount=None) for i in range(180)]
    body = dict(capability='neo.trend_histogram', instrument_id='CN:SH:stock:600519', period='day', adjust='qfq', end='2020-12-31', limit=100, bars=bars)
    body['input_snapshot_id'] = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return body


def headers(body):
    now = int(time.time())
    claims = dict(iss='input-test', aud='neo-compute', sub='47', scope='neo.trend_histogram', iat=now, exp=now+30, jti='input-test', input_snapshot_id=body['input_snapshot_id'])
    return {'Authorization': 'Bearer ' + jwt.encode(claims, 'i'*32, algorithm='HS256')}


def test_calculates_supplied_snapshot_without_database(compute):
    body = payload()
    r = compute.post('/api/v1/neo/evaluate', json=body, headers=headers(body))
    assert r.status_code == 200, r.text
    result = r.json()
    assert result['schema_version'] == 2
    assert result['input_snapshot_id'] == body['input_snapshot_id']
    assert result['coverage']['bars'] == len(body['bars'])
    assert [p['value'] for p in result['points']] == trend_histogram(body['bars'])[-100:]
    assert [p['date'] for p in result['points']] == [b['date'] for b in body['bars'][-100:]]


def test_changed_price_snapshot_rejected(compute):
    body = payload()
    auth = headers(body)
    body['bars'][-1]['close'] += .01
    assert compute.post('/api/v1/neo/evaluate', json=body, headers=auth).status_code == 422


def test_input_digest_is_bound_to_signed_authorization(compute):
    body = payload()
    auth = headers(body | {'input_snapshot_id': '0'*64})
    assert compute.post('/api/v1/neo/evaluate', json=body, headers=auth).status_code == 401
