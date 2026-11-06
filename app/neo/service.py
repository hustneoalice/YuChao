"""Call the owning existing formula without exposing intermediate values."""
import hashlib
import json
import math
from datetime import datetime
from zoneinfo import ZoneInfo
from fastapi import HTTPException
from app.contracts.common import Adjust
from app.foundation.repo.market import get_kline, universe_entry
from app.foundation.target_trend import trend_histogram, trend_summary


def evaluate(conn, request):
    market, symbol = request.instrument_id.split(':')[1::2]
    meta = universe_entry(conn, symbol)
    if not meta or meta['market'].upper() != market:
        raise HTTPException(404, 'NEO instrument unavailable')
    bars = get_kline(conn, symbol, adjust=Adjust(request.adjust), end=request.end.isoformat(), limit=2000)['bars']
    if any(not all(isinstance(b.get(k), (int, float)) and math.isfinite(b[k]) for k in ('high','low','close')) for b in bars):
        raise HTTPException(503, 'NEO price data invalid')
    values = trend_histogram(bars)
    values = [v if v is None or math.isfinite(v) else None for v in values]
    dates = [b['date'] for b in bars]
    version = 'yuchao-target-trend-v1-warmup2000'
    snapshot = hashlib.sha256(json.dumps([request.model_dump(mode='json'), bars, version], sort_keys=True).encode()).hexdigest()
    points = [{'date': d, 'value': v} for d,v in zip(dates, values)][-request.limit:]
    return dict(schema_version=1, status='ok' if bars else 'empty', capability=request.capability,
        instrument_id=request.instrument_id, period='day', adjust=request.adjust, as_of=dates[-1] if dates else None,
        generated_at=datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(), bar_state='closed', rule_version=version,
        origin='formula_migration', verification_status='not_pointwise_validated', snapshot_id=snapshot,
        points=points, latest=trend_summary(dates,values) if bars else None,
        warnings=['原模型逐点一致性尚未验证；固定最多2000根历史预热'], coverage={'bars':len(bars),'warmup_limit':2000})
