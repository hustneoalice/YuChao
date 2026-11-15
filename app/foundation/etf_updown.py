"""宽基/红利 + 行业主题 ETF · 10% 涨跌逻辑量化（与前端「涨跌统计」卡同一口径）。

名单分三组（前端 tab）：饭钱 33 只宽基/红利、菜钱 29 只行业/主题、酒钱 8 只行业/主题。

口径来源：`frontend/src/updown-stats.ts`（行情页右列「涨跌统计」卡 + 主图波段线段）。

- 拐点取「日内最高 / 最低价」所在的那根 K 线；上一段的终点与下一段起点是同一个
  拐点、同一个价。
- 有效阈值 10%：低点 → 高点涨 >10% 才算一段有效上涨；回落到 10% 才确认转跌，
  否则原上涨段继续延伸、起点不变（**没超过 10% 就不否定原逻辑**）。下跌同理。
- 8%~10% 的回撤 / 反弹记为「无效线段」（灰色），说明趋势为何继续。
- K 线一律用**前复权**（qfq）：分红除权造成的价格缺口不算跌，波段百分比才可比。

数据来自腾讯日线（`sources.fetch_kline_tx`，本机可用；东财 push2his 目前被掐），
实时价与今日涨跌来自腾讯 qt 快照。结果缓存到 `data/etf_updown.json`：
日线按「数据日」缓存 6 小时，实时报价缓存 60 秒，页面刷新不会每次都打 33 次 HTTP。
"""
from __future__ import annotations

import json
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from ..config import settings
from ..updater.collectors import sources

logger = logging.getLogger("yuchao.etf")

UD_VALID = 0.10        # 有效波段阈值（与前端 UD_VALID 一致）
UD_NEAR = 0.08         # 8%~10% 记无效线段（灰色）

#: 用户名单·饭钱（两页截图 1~33，顺序与简称严格照截图）：
#: (代码, 名单简称, 全称) —— 简称沿用截图，全称取东财/腾讯口径
RICE: tuple[tuple[str, str, str], ...] = (
    ("510210", "综指ETF", "上证指数ETF富国"),
    ("510760", "上证ETF", "上证指数ETF国泰"),
    ("510300", "300ETF", "沪深300ETF华泰柏瑞"),
    ("159919", "沪深300", "沪深300ETF嘉实"),
    ("510330", "华夏300", "沪深300ETF华夏"),
    ("510310", "HS300ETF", "沪深300ETF易方达"),
    ("510050", "50ETF", "上证50ETF华夏"),
    ("159351", "A500中证", "A500ETF嘉实"),
    ("159901", "深100ETF", "深证100ETF易方达"),
    ("159338", "中证A500", "中证A500ETF国泰"),
    ("510500", "500ETF", "中证500ETF南方"),
    ("159922", "CSI500", "中证500ETF嘉实"),
    ("512100", "1000ETF", "中证1000ETF南方"),
    ("159845", "中证1000", "中证1000ETF华夏"),
    ("159915", "创业板", "创业板ETF易方达"),
    ("159952", "创业ETF", "创业板ETF广发"),
    ("159682", "创业五零", "创业板50ETF景顺"),
    ("159949", "创业板50", "创业板50ETF华安"),
    ("588080", "科创板50", "科创50ETF易方达"),
    ("588000", "科创50", "科创50ETF华夏"),
    ("588050", "科创ETF", "科创50ETF工银"),
    ("588090", "科创板", "科创50ETF华泰柏瑞"),
    ("588060", "上证科创", "科创50ETF广发"),
    ("588030", "科创指基", "科创100ETF博时"),
    ("588190", "科创100", "科创100ETF银华"),
    ("588290", "芯片科创", "科创芯片ETF华安"),
    ("588200", "科创芯片", "科创芯片ETF嘉实"),
    ("515080", "中证红利", "中证红利ETF招商"),
    ("510880", "红利ETF", "红利ETF华泰柏瑞"),
    ("512890", "红利低波", "红利低波ETF华泰柏瑞"),
    ("510720", "红利国泰", "红利国企ETF国泰"),
    ("515300", "红利300", "300红利低波ETF嘉实"),
    ("515180", "100红利", "红利ETF易方达"),
)

#: 用户名单·菜钱（自选股「菜钱」标签页截图 1~29，行业/主题 ETF）：
VEG: tuple[tuple[str, str, str], ...] = (
    ("562800", "稀有金属", "稀有金属ETF嘉实"),
    ("512070", "证券保险", "证券保险ETF易方达"),
    ("515210", "钢铁ETF", "钢铁ETF国泰"),
    ("159870", "化工ETF", "化工ETF鹏华"),
    ("159766", "旅游ETF", "旅游ETF富国"),
    ("159667", "工业母机", "工业母机ETF国泰"),
    ("159865", "养殖ETF", "养殖ETF国泰"),
    ("159825", "农业ETF", "农业ETF富国"),
    ("516780", "稀土ETF", "稀土ETF华泰柏瑞"),
    ("159755", "电池ETF", "电池ETF广发"),
    ("516510", "云计算", "云计算ETF易方达"),
    ("516160", "新能源", "新能源ETF南方"),
    ("159611", "电力ETF", "电力ETF广发"),
    ("512980", "传媒ETF", "传媒ETF广发"),
    ("512400", "有色ETF", "有色金属ETF南方"),
    ("515170", "食品饮料", "食品饮料ETF华夏"),
    ("159928", "消费ETF", "消费ETF汇添富"),
    ("512690", "酒ETF", "酒ETF鹏华"),
    ("512880", "证券ETF", "证券ETF国泰"),
    ("159995", "芯片ETF", "芯片ETF华夏"),
    ("512480", "半导体", "半导体ETF国联安"),
    ("515050", "5GETF", "5GETF华夏"),
    ("515880", "通信ETF", "通信ETF国泰"),
    ("159852", "软件ETF", "软件ETF嘉实"),
    ("515220", "煤炭ETF", "煤炭ETF国泰"),
    ("159992", "创新药", "创新药ETF银华"),
    ("512010", "医药ETF", "医药ETF易方达"),
    ("512170", "医疗ETF", "医疗ETF华宝"),
    ("512800", "银行ETF", "银行ETF华宝"),
)

#: 用户名单·酒钱（自选股「酒钱」标签页截图，8 只行业/主题 ETF）：
WINE: tuple[tuple[str, str, str], ...] = (
    ("159227", "航空航天", "航空航天ETF华夏"),
    ("159206", "卫星ETF", "卫星ETF永赢"),
    ("159732", "消费电子", "消费电子ETF华夏"),
    ("515000", "科技ETF", "科技ETF华宝"),
    ("159819", "AI智能", "人工智能ETF易方达"),
    ("562500", "机器人", "机器人ETF华夏"),
    ("159851", "金科ETF", "金融科技ETF华宝"),
    ("159869", "游戏ETF", "游戏ETF华夏"),
)

#: 分组：key 前后端共用；label 是页面 tab 文案。顺序即 tab 顺序。
GROUPS: tuple[tuple[str, str, tuple[tuple[str, str, str], ...]], ...] = (
    ("rice", "饭钱", RICE),
    ("veg", "菜钱", VEG),
    ("wine", "酒钱", WINE),
)

#: 全部名单（饭钱 + 菜钱 + 酒钱），供日线/报价批量拉取与行情页兜底识别。
ETFS: tuple[tuple[str, str, str], ...] = RICE + VEG + WINE

_QUOTE_TTL = 60                    # 实时报价缓存（秒）
_BARS_TTL = 6 * 3600               # 日线缓存（秒）：盘中每 6 小时重取一次，收盘后无需重取
_lock = threading.Lock()
_mem: dict | None = None           # 进程内缓存（避免每次请求都读 JSON）


def _as_bar(r: dict) -> dict:
    return {"t": str(r.get("t"))[:10], "o": float(r.get("o") or 0),
            "h": float(r.get("h") or 0), "l": float(r.get("l") or 0),
            "c": float(r.get("c") or 0), "v": float(r.get("v") or 0)}


#: 全部 ETF 代码集合（供行情页 K 线 / 快照兜底）
ETF_CODES: frozenset[str] = frozenset(c for c, _, _ in ETFS)


def etf_code(symbol: str) -> str | None:
    """从 510050 / 510050.SH / sh.510050 等形态里认出 ETF 代码；不是名单内返回 None。"""
    digits = "".join(ch for ch in str(symbol) if ch.isdigit())
    code = digits[-6:]
    return code if code in ETF_CODES else None


def updown_stats(bars: list[dict], valid: float = UD_VALID,
                 near: float = UD_NEAR) -> tuple[dict, dict | None]:
    """10% 波段统计（updown-stats.ts 的逐行翻译）。

    返回 (stats, tail)：stats 含 upN/downN/upPct/upAvg/downAvg/segs；
    tail 为当前未反转段的 {dir, anchor, ext, pend}（全序列没走出 10% 时是 None）。
    """
    segs: list[dict] = []
    n = len(bars)
    if n < 3:
        return {"upN": 0, "downN": 0, "upPct": 0.0, "upAvg": 0.0,
                "downAvg": 0.0, "segs": segs}, None

    def ext(i: int, p: float) -> dict:
        return {"i": i, "p": p}

    def push(f: dict, t: dict, d: int) -> None:
        if f["p"] <= 0 or t["p"] <= 0 or f["i"] == t["i"]:
            return
        pct = (t["p"] - f["p"]) / f["p"] * 100
        segs.append({"from": f["i"], "to": t["i"], "from_price": f["p"],
                     "to_price": t["p"], "dir": d, "pct": pct,
                     "valid": abs(pct) > valid * 100})

    def finish() -> dict:
        segs.sort(key=lambda s: (s["from"], s["to"]))
        ups = [s for s in segs if s["valid"] and s["dir"] == 1]
        downs = [s for s in segs if s["valid"] and s["dir"] == -1]
        total = len(ups) + len(downs)

        def mean(items: list[dict]) -> float:
            return sum(s["pct"] for s in items) / len(items) if items else 0.0

        return {"upN": len(ups), "downN": len(downs),
                "upPct": (len(ups) / total * 100) if total else 0.0,
                "upAvg": mean(ups), "downAvg": mean(downs), "segs": segs}

    hi = ext(0, bars[0]["h"])
    lo = ext(0, bars[0]["l"])
    direction = 0
    anchor = lo
    peak = hi
    start = 1
    for i in range(1, n):
        b = bars[i]
        if b["h"] > hi["p"]:
            hi = ext(i, b["h"])
        if b["l"] < lo["p"]:
            lo = ext(i, b["l"])
        if hi["i"] == lo["i"]:
            continue
        span = hi["p"] - lo["p"]
        if lo["i"] < hi["i"] and span / lo["p"] >= valid:
            anchor, peak, direction = lo, hi, 1
        elif hi["i"] < lo["i"] and span / hi["p"] >= valid:
            anchor, peak, direction = hi, lo, -1
        else:
            continue
        start = max(hi["i"], lo["i"]) + 1
        break
    if not direction:
        if hi["i"] != lo["i"]:
            up = lo["i"] < hi["i"]
            push(lo if up else hi, hi if up else lo, 1 if up else -1)
        return finish(), None

    pend: dict | None = None
    for i in range(start, n):
        b = bars[i]
        if direction == 1:
            if b["h"] > peak["p"]:
                if pend:
                    push(peak, pend, -1)     # 8%~10% 的无效下跌补灰线，起点不变
                peak = ext(i, b["h"])
                pend = None
            else:
                dd = (peak["p"] - b["l"]) / peak["p"]
                if dd > valid:
                    push(anchor, peak, 1)    # 反转确认：终点即下一段起点
                    anchor = peak
                    direction = -1
                    peak = ext(i, b["l"])
                    pend = None
                elif dd > near and (not pend or b["l"] < pend["p"]):
                    pend = ext(i, b["l"])
        else:
            if b["l"] < peak["p"]:
                if pend:
                    push(peak, pend, 1)
                peak = ext(i, b["l"])
                pend = None
            else:
                rb = (b["h"] - peak["p"]) / peak["p"]
                if rb > valid:
                    push(anchor, peak, -1)
                    anchor = peak
                    direction = 1
                    peak = ext(i, b["h"])
                    pend = None
                elif rb > near and (not pend or b["h"] > pend["p"]):
                    pend = ext(i, b["h"])

    push(anchor, peak, direction)
    if pend:
        push(peak, pend, -1 if direction == 1 else 1)
    return finish(), {"dir": direction, "anchor": dict(anchor), "ext": dict(peak),
                      "pend": dict(pend) if pend else None}


def _extreme(segs: list[dict], direction: int, dates: list[str]) -> dict | None:
    pool = [s for s in segs if s["valid"] and s["dir"] == direction]
    if not pool:
        return None
    best = max(pool, key=lambda s: abs(s["pct"]))
    return {"pct": round(best["pct"], 2),
            "from_date": dates[best["from"]] if best["from"] < len(dates) else "",
            "to_date": dates[best["to"]] if best["to"] < len(dates) else "",
            "from_price": best["from_price"], "to_price": best["to_price"]}


def _live_bar(last: dict, t: tuple, quote_date: str) -> dict | None:
    """用实时快照补出「今天」这根日线（后复权口径），让盘中就参与 10% 波段判定。

    - 复权比例 = 最后一根日线收盘 / 快照昨收（hfq 与裸价的固定比例；裸价比例≈1）。
    - 只在快照归属日晚于最后一根日线时补；数据源延迟/休市（同日快照）不补，
      避免凭空多出一根重复 K 线。
    """
    price, o, h, l, prev = t[1], t[4], t[5], t[6], t[7]
    if not price or not prev or last["c"] <= 0 or last["t"] >= quote_date:
        return None
    factor = last["c"] / prev
    o = o if o and o > 0 else price
    h = h if h and h > 0 else max(price, o)
    l = l if l and l > 0 else min(price, o)
    bar = {"t": quote_date, "o": o * factor, "h": h * factor,
           "l": l * factor, "c": price * factor}
    if not (0.75 <= bar["c"] / last["c"] <= 1.35):      # 复权比例异常，宁可不补
        return None
    tol = last["c"] * 0.002
    if all(abs(bar[k] - last[k]) <= tol for k in ("o", "h", "l", "c")):
        return None                                     # 与最后一根重复（休市快照）
    return bar


def analyse(code: str, short: str, full: str, bars: list[dict],
            quote: tuple | None, adj: str = "hfq",
            quote_date: str | None = None) -> dict:
    """单只 ETF：今日涨跌 + 当前逻辑 + 历史极值 / 次数。"""
    work = bars
    live = bars[-1]["c"]                    # 与日线同口径（复权后）的最新价
    new_day = bool(quote_date and quote_date > bars[-1]["t"])
    if quote:
        live_raw, prev = quote[1], quote[7]
        if live_raw:
            if adj == "hfq" and prev:
                # 复权比例取「同一交易日」的 hfq/裸价：新交易日用最后一根，当天用倒数第二根。
                ref = (bars[-1]["c"] if (new_day or len(bars) < 2)
                       else bars[-2]["c"])
                live = live_raw * (ref / prev)
            else:
                live = live_raw                      # raw 序列本身就是裸价
        tb = _live_bar(bars[-1], quote, quote_date) if quote_date else None
        if tb:
            work = bars + [tb]
            live = tb["c"]
    dates = [b["t"] for b in work]
    last = work[-1]
    stats, tail = updown_stats(work)
    price = quote[1] if quote and quote[1] else last["c"]
    chg_pct = quote[3] if quote else None
    if chg_pct is None:
        prev = bars[-2]["c"] if len(bars) > 1 else last["c"]
        chg_pct = (last["c"] - prev) / prev * 100 if prev else 0.0
    chg = quote[2] if quote else (price - (bars[-2]["c"] if len(bars) > 1 else price))

    item: dict = {
        "code": code, "name": short, "full_name": full,
        "price": round(price, 4), "chg": round(chg, 4), "chg_pct": round(chg_pct, 2),
        "data_from": dates[0], "data_to": dates[-1], "bars": len(work), "adj": adj,
        "upN": stats["upN"], "downN": stats["downN"],
        "upPct": round(stats["upPct"], 1),
        "upAvg": round(stats["upAvg"], 2), "downAvg": round(stats["downAvg"], 2),
        "maxUp": _extreme(stats["segs"], 1, dates),
        "maxDn": _extreme(stats["segs"], -1, dates),
        "lastSeg": None, "run": None,
    }
    valid_segs = [s for s in stats["segs"] if s["valid"]]
    if valid_segs:
        s = valid_segs[-1]
        item["lastSeg"] = {"dir": s["dir"], "pct": round(s["pct"], 2),
                           "from_date": dates[s["from"]], "to_date": dates[s["to"]]}

    if tail:
        d = tail["dir"]
        a, e = tail["anchor"], tail["ext"]
        cur_pct = (live - a["p"]) / a["p"] * 100 if a["p"] else 0.0
        ext_pct = (e["p"] - a["p"]) / a["p"] * 100 if a["p"] else 0.0
        against = ((e["p"] - live) / e["p"] * 100 if d == 1
                   else (live - e["p"]) / e["p"] * 100)
        item["run"] = {
            "dir": d,
            "anchor_date": dates[a["i"]], "anchor_price": round(a["p"], 4),
            "ext_date": dates[e["i"]], "ext_price": round(e["p"], 4),
            "cur_pct": round(cur_pct, 2),        # 起点 → 最新收盘（带符号）
            "ext_pct": round(ext_pct, 2),        # 起点 → 段内极值（带符号）
            "against_pct": round(max(against, 0.0), 2),   # 极值 → 最新（反向回撤/反弹）
            "confirmed": abs(ext_pct) >= UD_VALID * 100,  # 本轮是否已走出 10%
            "thresh": UD_VALID * 100,
        }
    return item


def _load_cache() -> dict | None:
    try:
        return json.loads(settings.etf_updown_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except Exception:
        logger.warning("[ETF] 缓存读取失败，重建", exc_info=True)
        return None


def _save_cache(payload: dict) -> None:
    try:
        settings.etf_updown_path.parent.mkdir(parents=True, exist_ok=True)
        settings.etf_updown_path.write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError:
        logger.warning("[ETF] 缓存写入失败（不影响本次请求）", exc_info=True)


def _fetch_bars(code: str) -> tuple[list[dict], str]:
    """日线：优先后复权（稳定、不随请求端日期漂移），没有再退回裸价（不复权）。

    腾讯的 qfq（前复权）序列在**按日期翻页**时每页基准不同，拼起来会出现
    2005 年 0.01 元这类假价（实测 510050 会造出 +2000% 的假波段），所以这里
    不用 qfq；hfq 是绝对口径，翻页拼接连续。裸价仅用于源站没有复权序列的 7 只
    （159338/159952/159682/159949/588060/588030/588190），日线涨跌幅只有
    分红除权的 1~3% 缺口，对 10% 阈值无影响，页面上标「不复权」。
    """
    for fqt, adj in (("hfq", "hfq"), ("", "raw")):
        try:
            raw = sources.fetch_kline_tx(code, 6000, fqt)
        except Exception as exc:
            logger.warning("[ETF] %s(%s) 拉取失败：%s: %s", code, adj or "raw",
                           type(exc).__name__, str(exc)[:120])
            continue
        rows = [_as_bar(r) for r in raw if r.get("t")]
        if rows:
            return rows, adj
    return [], "none"


def _fetch_quotes(codes: list[str]) -> tuple[dict, dict]:
    """qt 快照 → ({代码: 元组}, {代码: 快照归属日})；归属日用于判断是否要补今天这根 K。"""
    try:
        snap = sources.fetch_qt_snapshot(codes, with_date=True)
    except Exception as exc:
        logger.warning("[ETF] 快照拉取失败：%s: %s", type(exc).__name__, str(exc)[:120])
        return {}, {}
    out, dates = {}, {}
    for full, t in snap.items():
        code = full.split(".")[0]
        out[code] = t
        if len(t) > 23 and t[-1]:
            dates[code] = str(t[-1])[:10]
    return out, dates


def load(refresh: bool = False, with_quotes: bool = True) -> dict:
    """读缓存 → 必要时补日线 / 报价 → 返回整页数据。"""
    global _mem
    now = time.time()
    with _lock:
        cache = _mem or _load_cache() or {}
        bars_map = cache.get("bars") or {}
        adj_map = cache.get("adj") or {}
        quote_dates = cache.get("quote_dates") or {}
        items = cache.get("items") or []
        bars_at = float(cache.get("bars_at") or 0)
        quote_at = float(cache.get("quote_at") or 0)
        need_bars = refresh or not bars_map or (now - bars_at) > _BARS_TTL
        if not need_bars and any(c not in bars_map for c, _, _ in ETFS):
            need_bars = True              # 名单新增了代码：旧缓存缺日线，强制补齐
        cached_quotes = cache.get("quotes") or {}
        need_quote = with_quotes and (refresh or not items or not cached_quotes
                                      or (now - quote_at) > _QUOTE_TTL
                                      or any(c not in cached_quotes for c, _, _ in ETFS))

        if need_bars:
            codes = [c for c, _, _ in ETFS]
            t0 = time.time()
            with ThreadPoolExecutor(max_workers=6) as pool:
                fetched = dict(zip(codes, pool.map(_fetch_bars, codes)))
            bars_map = {k: v[0] for k, v in fetched.items() if v[0]}
            adj_map = {k: v[1] for k, v in fetched.items() if v[0]}
            if not bars_map:
                cached_items = items
                return {"as_of": None, "items": cached_items, "stale": True,
                        "message": "行情源暂时取不到 ETF 日线，请稍后重试"}
            bars_at = now
            logger.info("[ETF] 日线刷新完成：%d 只有数据，%.1fs",
                        len(bars_map), time.time() - t0)

        if need_quote:
            quotes, quote_dates = _fetch_quotes([f"{c}" for c, _, _ in ETFS])
            quote_at = now
        else:
            quotes = cached_quotes

        items = []
        for gkey, _glabel, members in GROUPS:
            for code, short, full in members:
                bars = bars_map.get(code) or []
                if not bars:
                    items.append({"code": code, "name": short, "full_name": full,
                                  "group": gkey,
                                  "price": None, "chg": None, "chg_pct": None,
                                  "data_from": None, "data_to": None, "bars": 0,
                                  "upN": 0, "downN": 0, "upPct": 0.0, "upAvg": 0.0,
                                  "downAvg": 0.0, "maxUp": None, "maxDn": None,
                                  "lastSeg": None, "run": None, "missing": True})
                    continue
                item = analyse(code, short, full, bars,
                               quotes.get(code), adj_map.get(code, "hfq"),
                               quote_dates.get(code))
                item["group"] = gkey
                items.append(item)

        groups = [{"key": gkey, "label": glabel, "count": len(members),
                   "summary": _summary([i for i in items if i.get("group") == gkey])}
                  for gkey, glabel, members in GROUPS]
        payload = {"as_of": max((i["data_to"] or "") for i in items) or None,
                   "built_at": datetime.now().isoformat(timespec="seconds"),
                   "bars_at": bars_at, "quote_at": quote_at,
                   "items": items, "groups": groups, "bars": bars_map, "adj": adj_map,
                   "quotes": quotes, "quote_dates": quote_dates}
        _mem = payload
        if need_bars or need_quote:
            _save_cache({k: payload[k] for k in ("as_of", "built_at", "bars_at",
                                                 "quote_at", "items", "bars", "adj",
                                                 "quote_dates", "quotes")})
        out = dict(payload)
        out.pop("bars", None)
        out.pop("quotes", None)
        out["summary"] = _summary(items)
        out["stale"] = False
        return out


def _cached_bars(code: str) -> list[dict]:
    data = _mem or _load_cache() or {}
    return (data.get("bars") or {}).get(code) or []


def chart_kline(code: str, adjust: str = "qfq", limit: int = 5000) -> dict:
    """行情页 K 线兜底：ETF 不在 DuckDB，用本模块缓存的后复权日线，按最新价线性重定基。

    - 序列形状 = 后复权（无分红缺口）；整体乘以「实时价 / 最后收盘」，让图上末价
      与顶部报价一致，等价于一条数据源正常的前复权序列。
    - 成交量取腾讯原始股数；涨跌幅按重定基后的收盘价现算。
    """
    data = load()                            # 保证缓存/报价值与列表页一致
    item = next((i for i in data["items"] if i["code"] == code), None)
    bars = _cached_bars(code)
    if not bars:
        raise ValueError(f"ETF 日线缓存缺失：{code}")
    bars = bars[-max(1, min(limit, 5000)):]
    t = ((_mem or {}).get("quotes") or {}).get(code)
    last = bars[-1]
    new_day = bool(item and item.get("data_to") and item["data_to"] > last["t"])
    # 复权比例：hfq 收盘 / 同一交易日的裸价（新交易日用快照昨收；当天用现价）。
    raw_ref = (t[7] if new_day and t and t[7] else (t[1] if t else None))
    factor = raw_ref / last["c"] if raw_ref and last["c"] > 0 else 1.0
    out: list[dict] = []
    prev: float | None = None
    for b in bars:
        close = b["c"] * factor
        out.append({
            "date": b["t"],
            "open": round(b["o"] * factor, 4),
            "high": round(b["h"] * factor, 4),
            "low": round(b["l"] * factor, 4),
            "close": round(close, 4),
            "volume": b.get("v") or 0,
            "amount": None,
            "pct_chg": round((close / prev - 1) * 100, 2) if prev else None,
            "turnover_rate": None,
            "live": None,
        })
        prev = close
    if new_day and t and item.get("price"):
        # 补今天的盘中 bar：日期用快照归属日，OHLC/量用腾讯实时快照（已经是裸价）
        out.append({
            "date": item["data_to"],
            "open": round(t[4] or item["price"], 4),
            "high": round(t[5] or item["price"], 4),
            "low": round(t[6] or item["price"], 4),
            "close": round(item["price"], 4),
            "volume": float(t[10] or 0) * 100.0,
            "amount": None,
            "pct_chg": item.get("chg_pct"),
            "turnover_rate": None,
            "live": True,
        })
    return {"symbol": code, "name": (item or {}).get("full_name") or code,
            "period": "day", "adjust": adjust, "bars": out}


def chart_quote(code: str) -> dict:
    """行情页快照兜底：ETF 名称 / 实时价 / 今日 OHLC / 涨跌幅，来源同列表页。"""
    data = load()
    item = next((i for i in data["items"] if i["code"] == code), None)
    bars = _cached_bars(code)
    if not item or not bars:
        raise ValueError(f"ETF 快照缺失：{code}")
    last = bars[-1]
    t = ((_mem or {}).get("quotes") or {}).get(code)
    q = {
        "symbol": code,
        "name": item.get("full_name") or code,
        "market": "sh" if code.startswith("5") else "sz",
        "date": item.get("data_to") or last["t"],
        "open": last["o"], "high": last["h"], "low": last["l"],
        "close": item.get("price") or last["c"],
        "pct_chg": item.get("chg_pct"),
        "volume": 0.0, "amount": 0.0,
        "rt_price": item.get("price"),
        "rt_time": None,
        "rt_date": item.get("data_to"),
        "rt_live": bool(item.get("run")),
        "rt_prev_close": None,
    }
    if t:
        q.update({
            "open": t[4] or last["o"], "high": t[5] or last["h"],
            "low": t[6] or last["l"],
            "volume": float(t[10] or 0) * 100.0,     # 腾讯快照成交量单位 = 手
            "amount": float(t[11] or 0),
            "rt_prev_close": t[7],
        })
    return q


def _summary(items: list[dict]) -> dict:
    have = [i for i in items if not i.get("missing")]
    live = [i for i in have if i.get("run")]
    up = [i for i in live if i["run"]["dir"] == 1]
    down = [i for i in live if i["run"]["dir"] == -1]
    today_up = [i for i in have if (i.get("chg_pct") or 0) > 0]
    today_down = [i for i in have if (i.get("chg_pct") or 0) < 0]
    rated = [i for i in have if i.get("chg_pct") is not None]
    avg = sum(i["chg_pct"] for i in rated) / len(rated) if rated else 0.0
    return {
        "total": len(items), "covered": len(have), "missing": len(items) - len(have),
        "live": len(live),
        "logicUp": len(up), "logicDown": len(down),
        "undecided": len(have) - len(live),
        "todayUp": len(today_up), "todayDown": len(today_down),
        "todayFlat": len(have) - len(today_up) - len(today_down),
        "todayAvg": round(avg, 2),
        "validNow": len([i for i in live if i["run"]["confirmed"]]),
    }


if __name__ == "__main__":        # python -m app.foundation.etf_updown
    logging.basicConfig(level=logging.INFO)
    data = load(refresh=True)
    print("as_of:", data["as_of"], "| summary:", data["summary"])

    def num(v, fmt: str = "{:.2f}", suffix: str = "") -> str:
        return f"{v:{fmt}}{suffix}" if isinstance(v, (int, float)) else "-"

    for it in data["items"]:
        run = it.get("run") or {}
        logic = ("上涨" if run.get("dir") == 1 else
                 "下跌" if run.get("dir") == -1 else "待定")
        print(f"{it['code']} {it['name']:<6} {(it.get('full_name') or '')[:12]:<12} "
              f"价 {num(it.get('price'), '.3f')} 今 {num(it.get('chg_pct'), '+.2f', '%')} "
              f"逻辑 {logic} "
              f"段内 {num(run.get('ext_pct'), '+.2f', '%')} "
              f"现 {num(run.get('cur_pct'), '+.2f', '%')} "
              f"回撤 {num(run.get('against_pct'), '.2f', '%')} "
              f"次数 {it['upN']}/{it['downN']} "
              f"极值 {num((it.get('maxUp') or {}).get('pct'), '+.2f', '%')}/"
              f"{num((it.get('maxDn') or {}).get('pct'), '+.2f', '%')} "
              f"{'' if not it.get('missing') else '（无数据）'}")
