"""Run the owning formula on a caller-supplied snapshot; never acquire market data."""
import hashlib
import math
from datetime import datetime
from zoneinfo import ZoneInfo

from app.foundation.target_trend import (
    qyjj_money_summary,
    qyjj_signals,
    six_segment_series,
    six_segment_summary,
    trend_histogram,
    trend_summary,
)

_RULE_VERSION = {
    'neo.trend_histogram': 'neo-target-trend-v2-input',
    'neo.six_segment': 'neo-six-segment-v1-input',
    'neo.money_bag': 'neo-qyjj-v1-input',
}


def _series(capability, bars, dates):
    """Return (逐 bar 数值, 摘要, 警告)。数值统一为 float|None，钱袋 1=钱袋 / -1=地雷。"""
    if capability == 'neo.six_segment':
        values = six_segment_series(bars)
        latest = six_segment_summary(dates, values) if bars else None
        warnings = ['六分段仅按调用方行情快照判定；原模型逐点一致性尚未验证']
    elif capability == 'neo.money_bag':
        signals = {i: (1. if kind == 'money' else -1.) for i, kind in qyjj_signals(bars)}
        values = [signals.get(i) for i in range(len(bars))]
        latest = qyjj_money_summary(dates, bars) if bars else None
        if latest is not None:
            latest['data_date'] = dates[-1]
        warnings = ['钱眼掘金为近似移植；原公式在服务端，点位仅部分一致']
    else:
        values = trend_histogram(bars)
        values = [v if v is None or math.isfinite(v) else None for v in values]
        latest = trend_summary(dates, values) if bars else None
        warnings = ['原模型逐点一致性尚未验证；仅使用调用方提供的行情快照']
    return values, latest, warnings


def evaluate(request):
    bars = [bar.model_dump(mode='json') for bar in request.bars]
    dates = [b['date'] for b in bars]
    version = _RULE_VERSION[request.capability]
    values, latest, warnings = _series(request.capability, bars, dates)
    snapshot = hashlib.sha256((request.input_snapshot_id + ':' + version).encode()).hexdigest()
    points = [{'date': d, 'value': v} for d, v in zip(dates, values)][-request.limit:]
    if len(bars) < 2000:
        warnings.append(f'实际预热输入 {len(bars)} 根，未使用完整 2000 根历史；不补用私服行情')
    return dict(schema_version=2, status='ok' if bars else 'empty', capability=request.capability,
        instrument_id=request.instrument_id, period='day', adjust=request.adjust, as_of=dates[-1] if dates else None,
        generated_at=datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(), bar_state='closed', rule_version=version,
        origin='formula_migration', verification_status='not_pointwise_validated', snapshot_id=snapshot,
        input_snapshot_id=request.input_snapshot_id,
        points=points, latest=latest,
        warnings=warnings, coverage={'bars': len(bars), 'warmup_limit': 2000})
