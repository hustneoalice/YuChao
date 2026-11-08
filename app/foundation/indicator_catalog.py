"""指标注册表（问答侧唯一真源）——key 与前端 IND_DEFS 对齐。

每项：key / label / where(main|sub) / aliases（口语别名，小写匹配）/ supported
（后端能否回答数值问题；自定义图表指标标 False，答复时如实说明"图表专用"）。
"""
INDICATORS = [
    # ── 主图 ──
    {"key": "qyjj", "label": "阶段反转", "where": "main", "supported": False, "aliases": ["阶段反转", "拐点"]},
    {"key": "strongpullback", "label": "强势调整", "where": "main", "supported": False, "aliases": ["强势调整"]},
    {"key": "ma", "label": "均线", "where": "main", "supported": True,
     "aliases": ["均线", "移动平均", "ma"]},
    {"key": "td", "label": "九转序列", "where": "main", "supported": False, "aliases": ["九转", "td序列", "td"]},
    {"key": "ema", "label": "指数均线", "where": "main", "supported": True, "aliases": ["指数均线", "ema"]},
    {"key": "boll", "label": "BOLL", "where": "main", "supported": True,
     "aliases": ["boll", "布林", "布林带", "布林线"]},
    {"key": "sar", "label": "SAR", "where": "main", "supported": False, "aliases": ["sar", "抛物线"]},
    {"key": "short", "label": "短线趋势", "where": "main", "supported": True,
     "aliases": ["短线趋势", "短线操盘", "短趋", "短线趋势线"]},
    {"key": "maincost", "label": "主力成本", "where": "main", "supported": False, "aliases": ["主力成本"]},
    {"key": "mid", "label": "中线趋势", "where": "main", "supported": True,
     "aliases": ["中线趋势", "中线操盘", "中趋", "中线趋势线"]},
    {"key": "avg", "label": "均价线", "where": "main", "supported": False, "aliases": ["均价线", "分时均价"]},
    {"key": "bbi", "label": "BBI", "where": "main", "supported": False, "aliases": ["bbi", "多空指数"]},
    {"key": "bbiboll", "label": "BBIBOLL", "where": "main", "supported": False, "aliases": ["bbiboll"]},
    # ── 趋势副图 ──
    {"key": "trendhistogram", "label": "趋势柱线", "where": "sub", "supported": True,
     "aliases": ["趋势柱线", "趋势柱", "柱线", "趋势值", "stickv"]},
    {"key": "macd", "label": "MACD", "where": "sub", "supported": True, "aliases": ["macd"]},
    {"key": "dmi", "label": "DMI", "where": "sub", "supported": True, "aliases": ["dmi", "趋向指标"]},
    {"key": "trix", "label": "TRIX", "where": "sub", "supported": True, "aliases": ["trix", "三重指数"]},
    {"key": "emv", "label": "EMV", "where": "sub", "supported": True, "aliases": ["emv", "简易波动"]},
    {"key": "dma", "label": "DMA", "where": "sub", "supported": True, "aliases": ["dma", "平均线差"]},
    {"key": "dkx", "label": "DKX", "where": "sub", "supported": True, "aliases": ["dkx", "多空线"]},
    # ── 动量副图 ──
    {"key": "stockoperate", "label": "个股操盘", "where": "sub", "supported": False, "aliases": ["个股操盘"]},
    {"key": "kdj", "label": "KDJ", "where": "sub", "supported": True, "aliases": ["kdj", "随机指标"]},
    {"key": "rsi", "label": "RSI", "where": "sub", "supported": True, "aliases": ["rsi", "相对强弱"]},
    {"key": "cci", "label": "CCI", "where": "sub", "supported": True, "aliases": ["cci", "顺势指标"]},
    {"key": "roc", "label": "ROC", "where": "sub", "supported": True, "aliases": ["roc", "变动率"]},
    {"key": "mtm", "label": "MTM", "where": "sub", "supported": True, "aliases": ["mtm", "动量指标"]},
    {"key": "wr", "label": "WR", "where": "sub", "supported": True, "aliases": ["wr", "威廉指标"]},
    {"key": "obos", "label": "超买超卖", "where": "sub", "supported": False, "aliases": ["超买超卖", "操盘线"]},
    {"key": "psy", "label": "PSY", "where": "sub", "supported": True, "aliases": ["psy", "心理线"]},
    {"key": "lwr", "label": "LWR", "where": "sub", "supported": False, "aliases": ["lwr"]},
    {"key": "osc", "label": "OSC", "where": "sub", "supported": False, "aliases": ["osc"]},
    {"key": "udl", "label": "UDL", "where": "sub", "supported": False, "aliases": ["udl", "引力线"]},
    # ── 量能副图 ──
    {"key": "volumeactivity", "label": "量能活跃", "where": "sub", "supported": False, "aliases": ["量能活跃"]},
    {"key": "accumulation", "label": "主力吸筹", "where": "sub", "supported": False, "aliases": ["主力吸筹", "吸筹"]},
    {"key": "vol", "label": "VOL", "where": "sub", "supported": True, "aliases": ["vol", "成交量", "量能"]},
    {"key": "volfs", "label": "VOLFS", "where": "sub", "supported": False, "aliases": ["volfs", "分时量"]},
    {"key": "obv", "label": "OBV", "where": "sub", "supported": True, "aliases": ["obv", "能量潮"]},
    {"key": "vr", "label": "VR", "where": "sub", "supported": True, "aliases": ["vr", "成交量比率", "量比"]},
    {"key": "wvad", "label": "WVAD", "where": "sub", "supported": True, "aliases": ["wvad"]},
    # ── 摆动人气 ──
    {"key": "brar", "label": "BRAR", "where": "sub", "supported": True, "aliases": ["brar", "人气意愿"]},
    {"key": "cr", "label": "CR", "where": "sub", "supported": True, "aliases": ["cr指标", "cr"]},
    {"key": "bias", "label": "BIAS", "where": "sub", "supported": True, "aliases": ["bias", "乖离率", "乖离"]},
    # ── 波动分位 ──
    {"key": "atr", "label": "ATR", "where": "sub", "supported": True, "aliases": ["atr", "真实波幅", "波动率"]},
    {"key": "sixseg", "label": "六段", "where": "sub", "supported": True, "aliases": ["六段", "六分段", "趋势六段"]},
]

IND_BY_KEY = {d["key"]: d for d in INDICATORS}

# 「看看指标整体状态」等泛问默认取这组
DEFAULT_KEYS = ["short", "mid", "trendhistogram", "macd", "kdj", "rsi", "boll", "vol"]

# 句子里出现这些泛词但没有命中具体指标时，允许升级到大模型
GENERIC_WORDS = ("指标", "趋势", "均线", "金叉", "死叉", "零轴", "超买", "超卖", "副图", "主图")


def catalog_public():
    """给前端下发的精简表（不含提问逻辑）。"""
    return [
        {"key": d["key"], "label": d["label"], "where": d["where"],
         "aliases": d["aliases"], "supported": d["supported"]}
        for d in INDICATORS
    ]


def match_keys(text: str) -> list[str]:
    """按别名最长优先从问句里抽指标 key（去重、保持出现顺序）。"""
    low = (text or "").lower()
    hits: list[tuple[int, int, str]] = []      # (start, alias_len, key)
    for d in INDICATORS:
        for alias in d["aliases"]:
            a = alias.lower()
            if not a:
                continue
            idx = low.find(a)
            while idx >= 0:
                # 纯字母别名要求词边界，避免 "ma" 命中 "macd" / "dma"
                if a.isalpha() and a.isascii():
                    before = low[idx - 1] if idx > 0 else " "
                    after = low[idx + len(a)] if idx + len(a) < len(low) else " "
                    if not (before.isascii() and before.isalnum()) and \
                       not (after.isascii() and after.isalnum()):
                        hits.append((idx, len(a), d["key"]))
                else:
                    hits.append((idx, len(a), d["key"]))
                idx = low.find(a, idx + 1)
    hits.sort(key=lambda x: (-x[1], x[0]))     # 长别名优先，再按出现位置
    out: list[str] = []
    occupied: list[tuple[int, int]] = []
    for start, ln, key in hits:
        end = start + ln
        if any(start < b and end > a for a, b in occupied):
            continue
        occupied.append((start, end))
        if key not in out:
            out.append(key)
    return out


def expand_all(text: str) -> list[str] | None:
    """「所有指标 / 全部副图」→ 全量（或全部副图）可算指标。"""
    low = (text or "").lower()
    if not any(w in low for w in ("所有指标", "全部指标", "所有副图", "全部副图", "全部", "所有")):
        return None
    only_sub = "副图" in low
    return [d["key"] for d in INDICATORS
            if d["supported"] and (not only_sub or d["where"] == "sub")]
