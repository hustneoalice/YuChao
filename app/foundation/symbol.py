"""symbol 归一化：收敛为 6 位裸码（与 1.0 normalize_symbol 同规则）。

裸码是个股域的身份；指数不要剥成裸码再查个股表。
非标形态退回旧的宽松截断。
"""
import re

# 指数形态：000001.SH / 399001.SZ / 899050.BJ（带市场后缀，与个股裸码区分）
_INDEX_RE = re.compile(r"^\d{6}\.(SH|SZ|BJ)$")

# ticker 常用指数 → 东财 secid（批量行情 / 实时快照共用）
TICKER_INDICES: list[tuple[str, str, str]] = [
    ("000001.SH", "上证指数", "1.000001"),
    ("399001.SZ", "深证成指", "0.399001"),
    ("399006.SZ", "创业板指", "0.399006"),
    ("000688.SH", "科创50", "1.000688"),
    ("000300.SH", "沪深300", "1.000300"),
    ("000905.SH", "中证500", "1.000905"),
    ("899050.BJ", "北证50", "0.899050"),
]

INDEX_NAMES: dict[str, str] = {s: n for s, n, _ in TICKER_INDICES} | {
    "000016.SH": "上证50", "399005.SZ": "中小100",
}


def index_form(symbol: str) -> str | None:
    """是指数形态（带市场后缀）则原样返回规范化形式，否则 None。"""
    if not symbol:
        return None
    s = str(symbol).strip().upper()
    return s if _INDEX_RE.match(s) else None


def normalize_symbol(symbol: str) -> str:
    if not symbol:
        return symbol
    s = str(symbol).strip().upper()
    if "." in s:
        s = s.split(".")[0]
    if len(s) > 6 and s[:2] in ("SH", "SZ", "BJ"):
        s = s[2:]
    return s
