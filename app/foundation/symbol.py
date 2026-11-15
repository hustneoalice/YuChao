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
    "000016.SH": "上证50", "399005.SZ": "中小100", "399330.SZ": "深证100",
}

# 全景页指数条固定清单（2.2：静态常识不建表；复用 TICKER_INDICES 的 7 个
# 并补齐大中盘/小盘代表，快照采集与 index_bar 派生共用同一来源）
INDEX_CATALOG: tuple[tuple[str, str], ...] = tuple(
    (s, n) for s, n, _ in TICKER_INDICES
) + (
    ("000016.SH", "上证50"), ("000852.SH", "中证1000"), ("399303.SZ", "国证2000"),
)

# 海外主要指数（滚动行情追加段）：symbol 即腾讯码（qt.gtimg.cn 的 us/hk 形态），
# 不参与东财 secid / K 线跳转，仅 ticker 展示
GLOBAL_INDICES: list[tuple[str, str]] = [
    ("usDJI", "道琼斯"),
    ("usIXIC", "纳斯达克"),
    ("usINX", "标普500"),
    ("hkHSI", "恒生指数"),
]

# 搜索补充指数：不进 INDEX_CATALOG（底部指数条 / 全景顺序不动），
# 只让未上指数条的宽基也能被代码或名称搜到（399330 有完整日线，可直接跳 K 线）。
INDEX_SEARCH_EXTRA: tuple[tuple[str, str], ...] = (
    ("399330.SZ", "深证100"),
)

# 口语别名 → 指数代码：搜索时按「包含」匹配（深圳100 / 深100 都是深证100）
INDEX_ALIASES: dict[str, tuple[str, ...]] = {
    "399330.SZ": ("深圳100", "深100", "深证一百"),
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


# 北交所个股段：43x/83x/87x（老股）与 920 段（现行）；899050 等指数形态不在此列
_BJ_PREFIXES = ("43", "83", "87", "92")


def is_bj(symbol: str) -> bool:
    """北交所个股判定（裸码段位）。指数 899050.BJ 不算个股。"""
    s = str(symbol).strip().upper().split(".")[0]
    return len(s) == 6 and s[:2] in _BJ_PREFIXES
