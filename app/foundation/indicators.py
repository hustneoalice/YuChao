"""标准技术指标（open-core 开源部分）。

1.0 services/kline_chart.py 实现照搬：MA5/7/10/20/35/45 + std20，
BOLL 由 MA20 ± 2×std20 派生。短线（MA7/MA10）与中线（MA35/MA45）操盘通道
状态属闭源包，本模块不实现 —— with=vip 由 license 中间件后调用闭源包。
窗口不足 n 的位置为 None（与 1.0 口径一致）。
"""
from typing import List, Optional

REAL = Optional[float]

_MA_WINDOWS = (("ma5", 5), ("ma7", 7), ("ma10", 10), ("ma20", 20), ("ma35", 35), ("ma45", 45))


def sma(values: List[REAL], n: int) -> List[REAL]:
    """简单移动平均；前 n-1 位为 None。"""
    out: List[REAL] = []
    for i in range(len(values)):
        if i + 1 < n:
            out.append(None)
            continue
        seg = values[i + 1 - n: i + 1]
        if any(v is None for v in seg):
            out.append(None)
            continue
        out.append(sum(seg) / n)
    return out


def rolling_std(values: List[REAL], n: int) -> List[REAL]:
    """滚动总体标准差（口径同 numpy.std 默认 ddof=0）；前 n-1 位为 None。"""
    out: List[REAL] = []
    for i in range(len(values)):
        if i + 1 < n:
            out.append(None)
            continue
        seg = values[i + 1 - n: i + 1]
        if any(v is None for v in seg):
            out.append(None)
            continue
        mean = sum(seg) / n
        out.append((sum((v - mean) ** 2 for v in seg) / n) ** 0.5)
    return out


def standard_indicators(closes: List[REAL]) -> dict[str, List[REAL]]:
    """按 bar 序返回全部标准指标序列（开源口径）。"""
    out: dict[str, List[REAL]] = {name: sma(closes, n) for name, n in _MA_WINDOWS}
    std20 = rolling_std(closes, 20)
    out["std20"] = std20
    ma20 = out["ma20"]
    out["boll_upper"] = [
        (a + 2 * s) if (a is not None and s is not None) else None
        for a, s in zip(ma20, std20)
    ]
    out["boll_lower"] = [
        (a - 2 * s) if (a is not None and s is not None) else None
        for a, s in zip(ma20, std20)
    ]
    return out
