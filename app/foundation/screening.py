"""选股条件框架：指标层（每只票的原始值）× 条件层（启用哪些 + 各自阈值）。

设计约束（新增指标不用改端点 / 不用改前端条件栏）：
  · 指标层：预计算任务（updater/collectors/targets）一次算全市场，字段落
    target_scan 表；
  · 条件层：本文件 CONDITIONS 单点登记，端点读指标值做布尔判定——改条件或
    阈值不触发重算（毫秒级），只有数据更新才重算指标层；
  · 新增指标（例如“主力吸筹”）三步：
      1) 指标层计算函数返回新字段（如 acc_strength）；
      2) target_scan 加列（db.MIGRATIONS 里 ALTER TABLE ... ADD COLUMN IF NOT EXISTS）；
      3) CONDITIONS 追加一条 {"key":"acc","kind":"value","field":"acc_strength",...}，
         前端条件栏自动出现、API 自动支持阈值，无需再动别处。

条件类型：
  flag   布尔型：字段为真即命中（短线趋势橙 / 20日涨停）
  value  数值型：字段 ≥（或 ≤）阈值，阈值由前端传、缺省用 default
         （40日均量倍数；后续主力吸筹强度走同一套）
  trend  复合型：趋势柱线需要模式 / 窗口等参数，由端点额外参数驱动
"""
from __future__ import annotations

import json
from typing import Any, Mapping, Optional

CONDITIONS: tuple[dict[str, Any], ...] = (
    {"key": "trend", "label": "趋势柱线", "kind": "trend", "field": None,
     "default_on": False,
     "title": "STICKV 负转正或持续在零轴上方，可独立筛选或与其他条件同时满足"},
    {"key": "vol", "label": "40日均量", "kind": "value", "field": "vol_ratio",
     "op": ">=", "default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1, "unit": "x",
     "default_on": True, "title": "当日成交量 / 40日均量 不小于阈值"},
    {"key": "short", "label": "短线趋势橙", "kind": "flag", "field": "short_orange",
     "default_on": True, "title": "收盘站上 MA10（K 线短线趋势通道填橙同判定）"},
    {"key": "mid", "label": "中线趋势橙", "kind": "flag", "field": "mid_orange",
     "default_on": True, "title": "收盘站上 MA45（K 线中线趋势通道填橙同判定）"},
    {"key": "up20", "label": "20日内涨停", "kind": "flag", "field": "limit_up_20d",
     "default_on": True, "title": "近 20 个交易日有过涨停（主板 10% / 创业科创 20%）"},
    # 趋势柱线「负柱收敛」两条件依赖 STICKV 序列（dep=trend），用于提前捕捉
    # 即将上穿零轴的标的：绿柱连续缩短 + 当前负柱幅度足够贴近零轴。
    {"key": "negshrink", "label": "负柱收敛", "kind": "value", "field": "neg_run",
     "op": ">=", "default": 3, "min": 2, "max": 10, "step": 1, "unit": "日",
     "default_on": False, "dep": "trend",
     "title": "STICKV 连续 N 个交易日为负且逐日收窄（绿柱缩短），可提前捕捉即将上穿零轴的标的"},
    {"key": "nearzero", "label": "距零轴", "kind": "value", "field": "neg_abs",
     "op": "<=", "default": 20, "min": 2, "max": 100, "step": 1, "unit": "",
     "default_on": False, "dep": "trend",
     "title": "当前负柱幅度 |STICKV| 不超过阈值（越小越贴近零轴）；全市场 |STICKV| 中位数约 50"},
)

_KEYS = {c["key"] for c in CONDITIONS}


def public_conditions() -> list[dict[str, Any]]:
    """下发前端条件栏：只暴露 UI 需要的字段（field 是服务端实现细节）。"""
    return [{
        "key": c["key"], "label": c["label"], "kind": c["kind"],
        "default": c.get("default"), "min": c.get("min"), "max": c.get("max"),
        "step": c.get("step"), "unit": c.get("unit", ""), "op": c.get("op"),
        "default_on": bool(c.get("default_on", True)), "title": c.get("title", ""),
    } for c in CONDITIONS]


def enabled_keys(conds: str) -> set[str]:
    """解析启用条件串（逗号分隔），未知 key 静默忽略（前后端版本错位不报错）。"""
    return {s.strip() for s in (conds or "").split(",") if s.strip()} & _KEYS


def needs_trend(enabled: set[str]) -> bool:
    """启用条件里是否有依赖趋势柱线序列的（trend 本体或 dep=trend 的收敛条件）。"""
    return any(c["key"] in enabled and (c["kind"] == "trend" or c.get("dep") == "trend")
               for c in CONDITIONS)


def parse_values(raw: Optional[str], enabled: set[str]) -> dict[str, float]:
    """解析阈值 JSON（如 {"vol": 1.5}），越界/非法值回落到登记默认值。"""
    try:
        data = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    out: dict[str, float] = {}
    for c in CONDITIONS:
        if c["kind"] != "value" or c["key"] not in enabled:
            continue
        default = float(c["default"])
        try:
            v = float(data.get(c["key"], default))
        except (TypeError, ValueError):
            v = default
        lo, hi = c.get("min"), c.get("max")
        if lo is not None and hi is not None:
            v = min(float(hi), max(float(lo), v))
        out[c["key"]] = v
    return out


def matches(item: Mapping[str, Any], enabled: set[str],
            values: Mapping[str, float], trend_hit: Optional[bool] = None) -> bool:
    """单只标的是否满足全部启用条件（多指标叠加 = 同时满足）。"""
    for c in CONDITIONS:
        if c["key"] not in enabled:
            continue
        if c["kind"] == "trend":
            if not trend_hit:
                return False
            continue
        value = item.get(c["field"])
        if c["kind"] == "flag":
            if not value:
                return False
            continue
        threshold = float(values.get(c["key"], c["default"]))
        if value is None:
            return False
        if c.get("op", ">=") == "<=":
            if float(value) > threshold:
                return False
        elif float(value) < threshold:
            return False
    return True
