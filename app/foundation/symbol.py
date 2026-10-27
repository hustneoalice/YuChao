"""symbol 归一化：收敛为 6 位裸码（与 1.0 normalize_symbol 同规则）。

裸码是个股域的身份；指数不要剥成裸码再查个股表。
非标形态退回旧的宽松截断。
"""
def normalize_symbol(symbol: str) -> str:
    if not symbol:
        return symbol
    s = str(symbol).strip().upper()
    if "." in s:
        s = s.split(".")[0]
    if len(s) > 6 and s[:2] in ("SH", "SZ", "BJ"):
        s = s[2:]
    return s
