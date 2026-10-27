"""21:00 核心标推送位（M2 桩）。

核心标引擎属 StrategyLens 应用层（策略/资金分/排序），底座只负责
corepicks_result 落表与 corepicks:daily 频道广播。M2 先占住调度链
21:00 位置；引擎迁移到 2.0 后把实现挂进来，publish 已由编排器统一做。
"""
from __future__ import annotations


def update_corepicks(progress=None, ctx=None) -> dict:
    return {
        "task": "corepicks",
        "status": "skipped",
        "rows": 0,
        "detail": "核心标引擎属应用层，M2 底座仅预留调度位与 corepicks:daily 频道",
    }
