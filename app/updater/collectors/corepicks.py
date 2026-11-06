"""20:00 主力军情核心标强轮动；与手动触发共用计算及快照。"""
from ..util import expected_asof
from .rotation_inputs import complete_rotation_inputs
from ...foundation.repo.mainforce_cache import cached_mainforce
from ..writer import writer
from ...foundation.repo.core_rotation import run_rotation, _save


def update_corepicks(progress=None, ctx=None) -> dict:
    ctx = ctx or {}
    target = ctx.get("rotation_date") or expected_asof()
    try:
        completed = complete_rotation_inputs(target, progress, ctx.get('cancel_check'))
        if completed:
            # 刷新同日聚合缓存，让主力军情和本次核心标立即读取补齐后的分母。
            for kind in (4, 9, 1):
                cached_mainforce(writer.conn(), type_code=kind, end=target, force=True)
            cached_mainforce(writer.conn(), view='stocks', end=target, force=True)
        result = run_rotation(writer.conn(), target, progress, ctx.get('cancel_check'),
                              trigger=ctx.get('rotation_trigger','manual'))
        return dict(task='corepicks',status='completed' if result['status']=='completed' else
                    'cancelled' if result['status']=='cancelled' else 'skipped',
                    rows=len(result.get('items',[])),detail=result['message'])
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}"
        _save(writer.conn(), dict(date=target, status='failed',
                                 trigger=ctx.get('rotation_trigger','manual'), message=message))
        return dict(task='corepicks',status='failed',rows=0,error=message,detail=message)
    finally:
        writer.reset()
