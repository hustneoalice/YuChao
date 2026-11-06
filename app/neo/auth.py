"""Explicit operator-managed per-account grants, checked on every call."""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from fastapi import Header, HTTPException
import jwt

_lock = Lock()
_active = {}
_recent = {}


def authorize(authorization: str | None = Header(None)):
    key = os.getenv('YUCHAO_NEO_SIGNING_KEY', '')
    issuer = os.getenv('YUCHAO_NEO_ISSUER', '')
    grants_file = os.getenv('YUCHAO_NEO_GRANTS_FILE', '')
    if len(key) < 32 or not issuer or not grants_file:
        raise HTTPException(503, 'NEO service unavailable')
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(401, 'NEO authentication required')
    try:
        claims = jwt.decode(authorization[7:], key, algorithms=['HS256'], audience='neo-compute', issuer=issuer,
            options={'require':['exp','iat','sub','scope','jti','iss','aud']})
        if (not claims['sub'] or not claims['sub'].isdigit() or claims['scope'] != 'neo.trend_histogram'
            or not isinstance(claims['iat'], int) or not isinstance(claims['exp'], int)
            or claims['exp'] - claims['iat'] > 30 or claims['exp'] <= claims['iat']
            or not isinstance(claims['jti'], str) or not claims['jti']):
            raise ValueError()
    except (jwt.PyJWTError, ValueError, TypeError, AttributeError):
        raise HTTPException(401, 'NEO authentication invalid') from None
    try:
        path = Path(grants_file)
        if path.stat().st_size > 1024 * 1024:
            raise ValueError()
        grants = json.loads(path.read_text())
        grant = grants.get(claims['sub'], {})
        expires = datetime.fromisoformat(grant['expires_at'])
        allowed = expires.tzinfo is not None and expires > datetime.now(timezone.utc) and claims['scope'] in grant['capabilities']
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        allowed = False
    if not allowed:
        raise HTTPException(403, 'NEO grant required')
    subject = claims['sub']
    now = time.monotonic()
    with _lock:
        for old in list(_recent):
            if now - _recent[old][0] > 60 and not _active.get(old):
                _recent.pop(old)
        window, count = _recent.get(subject, (now, 0))
        if now - window > 60:
            window, count = now, 0
        if (_active.get(subject, 0) >= 2 or sum(_active.values()) >= 8
            or count >= 30 or (subject not in _recent and len(_recent) >= 1024)):
            raise HTTPException(429, 'NEO request capacity exceeded')
        _recent[subject] = (window, count + 1)
        _active[subject] = _active.get(subject, 0) + 1
    try:
        yield claims
    finally:
        with _lock:
            _active[subject] -= 1
            if not _active[subject]:
                _active.pop(subject)
