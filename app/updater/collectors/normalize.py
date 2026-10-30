"""K 线行归一化单点：单位口径 / OHLC 防错 / volume 自证纠偏。

全系统唯一单位口径：volume=股、amount=元、价格=不复权原始价（涨跌幅与
换手率由写库侧派生）。三条车道解析出原始行后一律经 normalize_rows 收口；
写库前 guard_rows 再拦一道（空壳/非法 OHLC 不落库）。

吸收策影 data_quality 两条血泪教训（裁剪重写，零依赖，不复制代码）：
  · 2026-09-15 全库审计 23,863 行 volume 偏离真值 100 倍（3,229 只，科创
    板整段被「一律 ×100」放大）——「某源一定是手」的先验会过时。腾讯车道
    按板块判定（688/689 原始即股、其余手），东财车道带 amount，用
    「成交额÷成交量÷收盘价」隐含均价自证纠偏：≈100 说明拿到的是手（补
    ×100），≈0.01 说明已被双重换算（÷100）——先验过时也兜得住；
  · 个股/指数/ETF 两套单位代码口径分叉，单源故障时 80 个 ETF 全坏
    ——换算只在本文件一处定义，任何车道不得自行 ×100。
"""
from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# 自证隐含均价（amount / volume / close）判定区间：
#   [50, 200]      → volume 原始是手（隐含均价被放大 100 倍）
#   [0.005, 0.02]  → volume 已被双重换算成百股量级
# 正常值恒 ≈1（元 ÷ 股 ÷ 元/股），落在两区间之外且非 ≈1 即脏数据。
_RATIO_LOT = (50.0, 200.0)
_RATIO_DOUBLE = (0.005, 0.02)


def _f(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def normalize_rows(rows: Iterable[Dict[str, Any]], source: str, *,
                   sci: bool = False) -> Tuple[List[Dict[str, Any]], int]:
    """采集出口统一收口 → (合法行, 拒绝数)。

    source 单位声明（单点定义，车道不得自行换算）：
      'tx'   腾讯：手（sci=True 科创板 688/689 原始即股）
      'em'   东财：手（含指数/ETF，688/689 亦按手返回）
      'sina' 新浪：股（原始即股）
    价格四元组必须为正且 high≥low、high≥max(o,c)、low≤min(o,c)；volume
    非负。非法行丢弃并计数，绝不静默改值。
    """
    out: List[Dict[str, Any]] = []
    rejected = 0
    for r in rows or []:
        o, h, l, c = _f(r.get("o")), _f(r.get("h")), _f(r.get("l")), _f(r.get("c"))
        v = _f(r.get("v"))
        if None in (o, h, l, c) or v is None or v < 0:
            rejected += 1
            continue
        if min(o, h, l, c) <= 0 or h < l or h < max(o, c) or l > min(o, c):
            rejected += 1
            continue
        row = dict(r)
        if source == "em":
            row["v"] = int(v * 100) if v else 0              # 手 → 股
        elif source == "tx":
            row["v"] = (int(v) if sci else int(v * 100)) if v else 0
        elif source == "sina":
            row["v"] = int(v)
        else:
            raise ValueError(f"未知 K 线来源: {source!r}（单位声明必须在 normalize 单点）")
        row["amount"] = _f(r.get("amount"))
        row["pct_chg"] = _f(r.get("pct_chg"))
        row["turnover_rate"] = _f(r.get("turnover_rate"))
        _selfcheck_volume(row)
        out.append(row)
    return out, rejected


def _selfcheck_volume(row: Dict[str, Any]) -> None:
    """amount 可用时自证 volume 单位（不依赖先验，兜住端点改版/板块差异）。

    隐含均价 = amount / volume / close，正常恒 ≈1：落在手区间补 ×100，
    落在双重换算区间 ÷100 拉回。腾讯/新浪车道 amount=None，无自证材料
    （第 1 道先验仍生效）——这也是主车道优先用东财补 amount 的原因。
    """
    amt, v, c = row.get("amount"), row.get("v"), row.get("c")
    if not (amt and v and c):
        return
    ratio = amt / v / c
    if _RATIO_LOT[0] <= ratio <= _RATIO_LOT[1]:
        row["v"] = int(row["v"] * 100)
    elif _RATIO_DOUBLE[0] <= ratio <= _RATIO_DOUBLE[1]:
        row["v"] = max(int(row["v"] / 100), 1)


def guard_rows(buf: Sequence[tuple]) -> Tuple[List[tuple], int]:
    """写库前最后防线（策影 kline_write_guard 语义）：来源无关的合法性断言。

    normalize_rows 在采集出口按源换算；guard 在写入口对任何来源（含未来
    新增车道、数据包导入）再断言一次：symbol/日期齐、OHLC 关系合法、
    volume 非负——空壳数据与脏行拒绝落库并计数，绝不静默放行。
    输入为 executemany 的 tuple 行 (symbol,date,o,h,l,c,v,amount,pct,tr)。
    """
    good: List[tuple] = []
    rejected = 0
    for r in buf:
        try:
            sym, t = str(r[0]), str(r[1])
            o, h, l, c = float(r[2]), float(r[3]), float(r[4]), float(r[5])
            v = float(r[6])
            if len(sym) < 6 or len(t) != 10 or t[4] != "-":
                rejected += 1
                continue
            if min(o, h, l, c) <= 0 or v < 0 or h < l \
                    or h < max(o, c) or l > min(o, c):
                rejected += 1
                continue
        except (TypeError, ValueError, IndexError):
            rejected += 1
            continue
        good.append(r)
    return good, rejected
