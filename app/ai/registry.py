"""能力注册表：工具的唯一真源。

/ai/tools、Agent 工具列表、未来的 /mcp 都从这一份注册表派生；新增能力只需
登记一个 ToolSpec + 一个只读函数，流程不写进提示词。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Callable

Handler = Callable[..., dict]


@dataclass(frozen=True)
class ToolSpec:
    id: str
    name: str
    cat: str                       # 行情 | 财务 | 筛选 | 资金 | 联网
    desc: str
    params: dict[str, str]
    returns: str
    source: str
    freshness: str | None = None   # ohlcv | flow：计算前需过 fresh_gate
    readonly: bool = True
    needs_config: bool = False


_TOOLS: dict[str, tuple[ToolSpec, Handler]] = {}


def register(spec: ToolSpec, fn: Handler) -> Handler:
    _TOOLS[spec.id] = (spec, fn)
    return fn


def get(tool_id: str) -> tuple[ToolSpec, Handler]:
    return _TOOLS[tool_id]


def specs() -> list[ToolSpec]:
    return [s for s, _ in _TOOLS.values()]


def handlers() -> dict[str, Handler]:
    return {s.id: fn for s, fn in _TOOLS.values()}


def catalog() -> list[dict]:
    return [asdict(s) for s in specs()]
