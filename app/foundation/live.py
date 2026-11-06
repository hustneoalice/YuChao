"""实时外联资讯源：个股新闻 · 个股研报 · 行业研报（东财，进程内 TTL 缓存）。

与 updater 采集链路（批量落库）不同，这里是按请求实时取数的轻车道：
  - 复用 updater.http 的会话与 UA（trust_env=False 直连）；
  - 结果进程内 TTL 缓存：资讯 10min / 研报 2h，避免重复打外网；
  - 行业研报需要东财数字行业码（industryCode，如 473=证券Ⅱ），与板块 BK 代码
    无关。采用「自举字典」：拉近 90 天行业研报第一页 500 条，industryName 归一化
    （去掉 Ⅰ/Ⅱ/Ⅲ 后缀）→ 数字码，24h 刷新。未收录的小行业返回空列表。

对 1.0（策影）实现的取舍：
  - 个股新闻/研报的数据源接口原样沿用；
  - 研报不再全量翻 5×100 页（策影 eastmoney_reports），近 1 年单页即够看盘用；
  - 行业研报为 2.0 新增（策影只有个股维度）。
"""
from __future__ import annotations

import json
import re
import time
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

import httpx

from ..updater.collectors.http import client, _UA, pure_of
from .symbol import GLOBAL_INDICES, INDEX_NAMES, TICKER_INDICES

_CACHE: Dict[str, tuple[float, Any]] = {}          # key → (到期时间戳, 数据)

_REPORT_API = "https://reportapi.eastmoney.com/report/list"
_SEARCH_API = "https://search-api-web.eastmoney.com/search/jsonp"
_EM_REFERER = "https://data.eastmoney.com/"
_TTL_NEWS = 600          # 资讯 10min
_TTL_REPORT = 7200       # 研报 2h
_TTL_INDCODE = 86400     # 行业码字典 24h

_TAG_RE = re.compile(r"<[^>]+>")
_SUFFIX_RE = re.compile(r"[ⅠⅡⅢⅣ]+$")


def _cached(prefix: str, ttl: float):
    """装饰器：进程内 TTL 缓存，key = prefix + 调用参数（同参共享，异参隔离）。"""
    def deco(fn):
        def wrapper(*args, **kw):
            key = prefix + "|" + repr(args) + "|" + repr(sorted(kw.items()))
            hit = _CACHE.get(key)
            if hit and hit[0] > time.time():
                return hit[1]
            data = fn(*args, **kw)
            _CACHE[key] = (time.time() + ttl, data)
            return data
        return wrapper
    return deco


_EM_TIMEOUT = 3.0        # 东财单请求超时：掐死连接时快速降级（曾 8s 卡死 quote 链路）


def _em_get(url: str, *, params: dict, referer: str = _EM_REFERER) -> "httpx.Response":
    """东财 GET：共享连接池失败（RemoteProtocolError=服务端掐死 keep-alive 连接）
    时换一次性新连接重试一次，仍失败才抛出。避免 httpx 复用死连接反复 8s 挂起。"""
    headers = {"User-Agent": _UA, "Referer": referer}
    try:
        return client.get(url, params=params, timeout=_EM_TIMEOUT, headers=headers)
    except httpx.RemoteProtocolError:
        with httpx.Client(http2=False) as tmp:
            return tmp.get(url, params=params, timeout=_EM_TIMEOUT, headers=headers)


def _norm_industry(name: Optional[str]) -> str:
    """行业名归一化：去掉东财分级后缀 Ⅰ/Ⅱ/Ⅲ，便于 universe.industry（一级名）比对。"""
    return _SUFFIX_RE.sub("", str(name or "").strip())


# ---------------------------------------------------------------------------
# 个股新闻（东财搜索 JSONP，策影同款接口）
# ---------------------------------------------------------------------------

@_cached("live:news", _TTL_NEWS)
def stock_news(symbol: str, limit: int = 12) -> List[Dict[str, str]]:
    code = pure_of(symbol)
    inner = json.dumps({
        "uid": "", "keyword": code, "type": ["cmsArticleWebOld"],
        "client": "web", "clientType": "web", "clientVersion": "curr",
        "param": {"cmsArticleWebOld": {"searchScope": "default", "sort": "time",
                  "pageIndex": 1, "pageSize": int(limit), "preTag": "", "postTag": ""}},
    }, separators=(",", ":"))
    r = _em_get(_SEARCH_API, params={"cb": "cb", "param": inner},
                referer="https://so.eastmoney.com/")
    r.raise_for_status()
    text = r.text
    d = json.loads(text[text.index("(") + 1: text.rindex(")")])
    articles = (d.get("result") or {}).get("cmsArticleWebOld") or []
    out = []
    for a in articles:
        out.append({
            "time": str(a.get("date") or "")[:16],
            "source": str(a.get("mediaName") or ""),
            "title": _TAG_RE.sub("", str(a.get("title") or "")),
            "summary": _TAG_RE.sub("", str(a.get("content") or ""))[:160],
            "url": str(a.get("url") or ""),
        })
    return out


# ---------------------------------------------------------------------------
# 实时行情快照（腾讯批量 qt.gtimg.cn，策影同款源）：盘中价兜底，10s 缓存
# ---------------------------------------------------------------------------

_TX_API = "https://qt.gtimg.cn/q="
# 腾讯批量行情字段位（策影同款解析）：
# 1=名称 3=现价 4=昨收 5=今开 31=涨跌额 32=涨跌幅% 33=最高 34=最低 36=成交量(手) 37=成交额(万元)
# 扩展位（个股才有，指数为空）：38=换手% 39=PE(TTM) 43=振幅% 44=流通市值(亿) 45=总市值(亿) 46=PB


_TX_GLOBAL_RE = re.compile(r"^(us|hk|jp|uk|de|fr|in)[A-Za-z]{2,}$", re.IGNORECASE)


def _tx_symbol(symbol: str) -> str:
    """腾讯形式：600519→sh600519、000001.SH→sh000001、399001.SZ→sz399001。

    市场规则与策影一致：5/6/9→sh、4/8（含920段）→bj、其余→sz；
    带市场后缀（.SH/.SZ/.BJ）直接按后缀。"""
    s = str(symbol).strip()
    # 海外腾讯码（usDJI / hkHSI 等小写市场前缀+大写词）原样直通，不做 A 股规则转换
    if _TX_GLOBAL_RE.match(s):
        return s
    s = s.upper()
    code = s.split(".")[0] if "." in s else s
    if "." in s:
        mkt = s.split(".")[1].lower()
        return f"{mkt}{code}"
    if code.startswith("920") or code[0] in "48":
        return f"bj{code}"
    return f"{'sh' if code[0] in '569' else 'sz'}{code}"


def _tx_quotes(symbols: List[str]) -> Dict[str, Dict[str, Any]]:
    """腾讯批量实时行情（一次 HTTP 拿多只，0.4s 级，比东财稳定）。

    返回 {symbol: {name, price, prev_close, open, high, low, chg, pct, amount, volume}}；
    amount 已换算为元，volume 为股。拉取失败的标的不在结果里。"""
    if not symbols:
        return {}
    tx_list = [_tx_symbol(s) for s in symbols]
    by_tx = dict(zip(tx_list, symbols))
    by_code = {s.split(".")[0]: s for s in symbols}      # 6位码兜底（防 p[0] 形式变化）
    out: Dict[str, Dict[str, Any]] = {}
    for i in range(0, len(tx_list), 50):                 # 腾讯单次上限 50
        batch = tx_list[i:i + 50]
        try:
            r = client.get(_TX_API + ",".join(batch), timeout=4,
                           headers={"User-Agent": _UA, "Referer": "https://gu.qq.com/"})
            r.raise_for_status()
            r.encoding = "gbk"
            lines = [l for l in r.text.strip().split(";") if "~" in l]
        except Exception:
            continue
        for line in lines:
            p = line.split("~")
            if len(p) < 38 or not p[3]:
                continue
            num = lambda k: float(p[k]) if p[k] else None    # noqa: E731
            # p[0] 形如 v_sh000001="1 → 清洗 "=" 尾巴后反查腾讯码；再以 p[2] 兜底
            tx_key = p[0].split("=", 1)[0].split("_", 1)[-1]
            sym = by_tx.get(tx_key) or by_code.get(p[2]) or p[2]
            # 海外行（usDJI/hkHSI）：核心位 3/4/5/31/32/33/34 与 A 股一致，扩展位是文本 → 关闭
            ext = len(p) > 46 and not _TX_GLOBAL_RE.match(sym)
            # p[30] = 行情时间 "20261030150003"：K 线合并今日浮根时用它判归属日，
            # 周末/节假日快照停在上个交易日，靠本地时间会补出假 bar
            raw_ts = p[30] if len(p) > 30 else ""
            qdate = (f"{raw_ts[:4]}-{raw_ts[4:6]}-{raw_ts[6:8]}"
                     if len(raw_ts) >= 8 and raw_ts[:8].isdigit() else None)
            # 成交量单位：全系统口径为股。腾讯科创板（sh688/689）p[36] 原始即股，
            # 其余板块为手（normalize.py 同款先验；2026-11-02 实测 688420
            # 「1213715 / 2400万元 / 20.12元」自证即股，×100 会让末根量柱高 100 倍）
            star = tx_key.startswith("sh") and str(p[2] or "")[:3] in ("688", "689")
            vol = num(36)
            nv = lambda k: float(p[k]) if k < len(p) and p[k] else None   # noqa: E731
            # 五档盘口：9~18 买一~买五（价/量交替），19~28 卖一~卖五；量单位为手
            bids = [{"price": nv(9 + 2 * k), "volume": int(nv(10 + 2 * k) or 0)}
                    for k in range(5)]
            asks = [{"price": nv(19 + 2 * k), "volume": int(nv(20 + 2 * k) or 0)}
                    for k in range(5)]
            bids = [x for x in bids if x["price"] and x["price"] > 0]
            asks = [x for x in asks if x["price"] and x["price"] > 0]
            out[sym] = {
                "name": p[1], "price": num(3), "prev_close": num(4),
                "open": num(5), "high": num(33), "low": num(34),
                "chg": num(31), "pct": num(32),
                "qdate": qdate,
                "amount": num(37) * 1e4 if num(37) is not None else None,   # 万元 → 元
                "volume": (int(vol) if star else int(vol * 100)) if vol is not None else None,
                # 扩展位（基本信息卡用；指数行这些位为空 → None）
                "turnover": num(38) if ext else None,      # 换手率%
                "pe_ttm": num(39) if ext else None,        # 市盈率 TTM
                "circ_mv_yi": num(44) if ext else None,    # 流通市值（亿）
                "total_mv_yi": num(45) if ext else None,   # 总市值（亿）
                "pb": num(46) if ext else None,            # 市净率
                # 盘口扩展（仅个股；指数五档为空）
                "bids": bids, "asks": asks,
                "avg_price": nv(51) if ext else None,      # 均价
                "limit_up": nv(47) if ext else None,
                "limit_down": nv(48) if ext else None,
                "vol_ratio": nv(49) if ext else None,      # 量比
                "outer_vol": int(nv(7)) if ext and nv(7) is not None else None,   # 外盘（手）
                "inner_vol": int(nv(8)) if ext and nv(8) is not None else None,   # 内盘（手）
                "amplitude": nv(43) if ext else None,
                "board_time": (raw_ts[8:10] + ":" + raw_ts[10:12] + ":" + raw_ts[12:14]
                               if len(raw_ts) >= 14 and raw_ts[8:14].isdigit() else None),
            }
    return out


@_cached("live:rt", 10)
def realtime_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """实时快照（策影同款腾讯批量源，10s 缓存；失败 None 同样入缓存——
    网络被掐时 10s 内不重复撞超时）。

    返回 {price, high, low, open, prev_close, pct, amount, volume, ts}。"""
    d = _tx_quotes([symbol]).get(symbol)
    if not d or d.get("price") is None:
        return None
    return {
        "price": d["price"], "high": d["high"], "low": d["low"], "open": d["open"],
        "prev_close": d["prev_close"],
        "pct": d["pct"],                                     # 腾讯已是百分数
        "amount": d["amount"], "volume": d["volume"],
        "turnover": d.get("turnover"), "pe_ttm": d.get("pe_ttm"), "pb": d.get("pb"),
        "total_mv_yi": d.get("total_mv_yi"), "circ_mv_yi": d.get("circ_mv_yi"),
        "qdate": d.get("qdate"),                             # 行情归属日（腾讯 p[30]）
        "ts": time.strftime("%Y-%m-%d %H:%M"),
    }


@_cached("live:depth", 3)
def order_book(symbol: str) -> Optional[Dict[str, Any]]:
    """五档盘口（腾讯 qt，3s 缓存）：买卖五档 + 委比/委差 + 内外盘/均价/涨跌停。

    指数、停牌或无五档的标的返回 applicable=False（前端降级为空态）。"""
    d = _tx_quotes([symbol]).get(symbol)
    if not d:
        return None
    bids = d.get("bids") or []
    asks = d.get("asks") or []
    bid_total = int(sum(x["volume"] for x in bids))
    ask_total = int(sum(x["volume"] for x in asks))
    denom = bid_total + ask_total
    for x in bids + asks:
        x["amount"] = round(x["price"] * x["volume"] * 100, 2)   # 手 → 股
    return {
        "symbol": symbol, "name": d.get("name"),
        "applicable": bool(bids and asks),
        "time": d.get("board_time"),
        "price": d.get("price"), "prev_close": d.get("prev_close"),
        "open": d.get("open"), "high": d.get("high"), "low": d.get("low"),
        "chg": d.get("chg"), "pct": d.get("pct"),
        "avg_price": d.get("avg_price"),
        "limit_up": d.get("limit_up"), "limit_down": d.get("limit_down"),
        "bids": bids, "asks": asks,
        "bid_total": bid_total, "ask_total": ask_total,
        "bid_ask_diff": bid_total - ask_total,
        "bid_ask_ratio": round((bid_total - ask_total) / denom * 100, 2) if denom else None,
        "outer_vol": d.get("outer_vol"), "inner_vol": d.get("inner_vol"),
        "volume": d.get("volume"), "amount": d.get("amount"),
        "turnover_rate": d.get("turnover"), "vol_ratio": d.get("vol_ratio"),
        "amplitude": d.get("amplitude"),
    }


_EM_DETAILS = "https://push2.eastmoney.com/api/qt/stock/details/get"


@_cached("live:trades", 5)
def trades(symbol: str, limit: int = 20) -> List[Dict[str, Any]]:
    """逐笔成交明细（东财 details，5s 缓存）：时间 / 价 / 手数 / 买卖方向。

    返回按时间倒序（最新在前）；指数/外盘/接口失败返回空列表。"""
    txs = _tx_symbol(symbol)
    code = pure_of(symbol)
    if not code.isdigit():
        return []
    secid = f"{'1' if txs.startswith('sh') else '0'}.{code}"
    try:
        r = _em_get(_EM_DETAILS, params={
            "secid": secid,
            "fields1": "f1,f2,f3,f4",
            "fields2": "f51,f52,f53,f54,f55",
            "pos": str(-max(1, min(limit, 100))),
        })
        data = (r.json() or {}).get("data") or {}
    except Exception:                                   # noqa: BLE001
        return []
    out: List[Dict[str, Any]] = []
    for line in reversed(data.get("details") or []):    # 东财返回时间正序 → 倒序
        parts = str(line).split(",")
        if len(parts) < 3:
            continue
        try:
            out.append({
                "time": parts[0], "price": float(parts[1]), "volume": int(float(parts[2])),
                "direction": int(parts[4]) if len(parts) > 4 and parts[4].lstrip("-").isdigit() else None,
            })
        except (TypeError, ValueError):
            continue
    return out


_EM_F10 = "https://datacenter-web.eastmoney.com/api/data/v1/get"


@_cached("live:profile", 600)
def profile(symbol: str) -> Optional[Dict[str, Any]]:
    """概念标签（东财 F10 核心题材-所属板块，10 分钟缓存）。

    走 datacenter-web（push2 在部分服务器 IP 会被掐连接，datacenter 稳定可达）；
    指数、外盘或接口失败返回 None。行业仍以 stock_universe.industry 为准。"""
    code = pure_of(symbol)
    if not code.isdigit():
        return None
    try:
        r = _em_get(_EM_F10, params={
            "reportName": "RPT_F10_CORETHEME_BOARDTYPE",
            "columns": "SECUCODE,SECURITY_CODE,BOARD_NAME,BOARD_CODE",
            "filter": f'(SECURITY_CODE="{code}")',
            "pageNumber": 1, "pageSize": 60,
            "source": "HSF10", "client": "PC",
        }, referer="https://emweb.securities.eastmoney.com/")
        data = ((r.json() or {}).get("result") or {}).get("data") or []
    except Exception:                                   # noqa: BLE001
        return None
    names = [str(d.get("BOARD_NAME")).strip() for d in data if d.get("BOARD_NAME")]
    if not names:
        return None
    return {"concept": ",".join(names)}


_RTS_CACHE: Dict[str, tuple[float, Any]] = {}


def realtime_quotes(symbols: List[str]) -> Dict[str, Dict[str, Any]]:
    """批量实时快照（自选股卡片等 N 只一次渲染）：腾讯批量源一次 HTTP ≤50 只。

    key 用排序去重后的组合（同组合 10s 内共享）；容量上限防 symbol 组合爆炸
    （_cached 装饰器按 repr 缓存且不清理，组合自由的批量调用不能用）。"""
    uniq = sorted({str(s).strip() for s in symbols if str(s).strip()})
    if not uniq:
        return {}
    key = "live:rts|" + ",".join(uniq)
    now = time.time()
    hit = _RTS_CACHE.get(key)
    if hit and hit[0] > now:
        return hit[1]
    raw = _tx_quotes(uniq)
    ts = time.strftime("%Y-%m-%d %H:%M")
    out = {s: {**raw[s], "ts": ts} for s in uniq if s in raw and raw[s].get("price") is not None}
    if len(_RTS_CACHE) > 200:                  # 防 LEAK：清过期项
        for k, (exp, _) in list(_RTS_CACHE.items()):
            if exp <= now:
                _RTS_CACHE.pop(k, None)
    _RTS_CACHE[key] = (now + 10, out)
    return out


@_cached("live:idx", 10)
def realtime_indices() -> Dict[str, Any]:
    """常用指数批量实时（策影同款腾讯批量源，一次 HTTP，10s 缓存）：ticker 数据源。

    A 股指数 + 海外主要指数（GLOBAL_INDICES，仅展示不可点）；
    返回 {"items": [{symbol, name, price, chg, pct, amount}], "total_amount": 沪+深之和}；
    pct 为小数（0.0063），前端 ×100 显示。
    """
    syms = [s for s, _, _ in TICKER_INDICES] + [s for s, _ in GLOBAL_INDICES]
    raw = _tx_quotes(syms)
    out: List[Dict[str, Any]] = []
    for sym, name, _secid in TICKER_INDICES:
        d = raw.get(sym)
        if not d:
            continue
        out.append({"symbol": sym, "name": name, "price": d["price"],
                    "chg": d["chg"],
                    "pct": d["pct"] / 100 if d["pct"] is not None else None,
                    "amount": d["amount"]})
    for sym, name in GLOBAL_INDICES:          # 海外段：A股段之后追加展示
        d = raw.get(sym)
        if not d:
            continue
        out.append({"symbol": sym, "name": name, "price": d["price"],
                    "chg": d["chg"],
                    "pct": d["pct"] / 100 if d["pct"] is not None else None,
                    "amount": None})          # 美股/港股指数成交额口径不同，ticker 不展示
    total = sum(i["amount"] for i in out
                if i["amount"] and i["symbol"] in ("000001.SH", "399001.SZ"))
    return {"items": out, "total_amount": total}


# ---------------------------------------------------------------------------
# 研报（个股 qType=0 / 行业 qType=1，东财 reportapi）
# ---------------------------------------------------------------------------

def _norm_reports(rows: List[Dict[str, Any]], limit: int) -> List[Dict[str, str]]:
    out = []
    for k in rows[:limit]:
        info = str(k.get("infoCode") or "")
        out.append({
            "date": str(k.get("publishDate") or "")[:10],
            "org": str(k.get("orgSName") or k.get("orgName") or ""),
            "rating": str(k.get("emRatingName") or ""),
            "title": str(k.get("title") or ""),
            "industry": str(k.get("industryName") or ""),
            "url": f"https://data.eastmoney.com/report/info/{info}.html" if info else "",
        })
    return out


def _fetch_reports(qtype: int, params_extra: Dict[str, Any],
                   days: int, limit: int) -> List[Dict[str, Any]]:
    end = date.today()
    params = {
        "pageSize": str(max(limit, 50)), "pageNo": "1", "qType": str(qtype),
        "beginTime": (end - timedelta(days=days)).isoformat(), "endTime": end.isoformat(),
        **params_extra,
    }
    r = _em_get(_REPORT_API, params=params)
    r.raise_for_status()
    return r.json().get("data") or []


@_cached("live:reports", _TTL_REPORT)
def stock_reports(symbol: str, limit: int = 12) -> List[Dict[str, str]]:
    """个股研报：近 1 年按时间倒序单页（改进策影的全量 5×100 翻页）。"""
    rows = _fetch_reports(0, {"code": pure_of(symbol), "industryCode": "*",
                              "industry": "*", "rating": "*", "ratingChange": "*"},
                          days=365, limit=limit)
    return _norm_reports(rows, limit)


# ---------------------------------------------------------------------------
# 行业研报：universe.industry（东财 f100 一级行业名）→ reportapi 数字码自举
# ---------------------------------------------------------------------------

def _industry_of(conn, symbol: str) -> str:
    try:
        row = conn.execute(
            "SELECT industry FROM stock_universe WHERE symbol = ?", [pure_of(symbol)]
        ).fetchone()
        return str(row[0]) if row and row[0] else ""
    except Exception:
        return ""


@_cached("live:indcodes", _TTL_INDCODE)
def _industry_codes() -> Dict[str, str]:
    """近 90 天行业研报翻页聚合 → {归一化行业名: 数字码}（自举，24h 刷新）。

    reportapi 服务端把 pageSize 钳到 100，单页只覆盖 ~35 个活跃行业；
    按时间倒序翻至多 30 页（≈3000 条 ≈ 90 天全量 94%），长尾行业也收录。"""
    codes: Dict[str, str] = {}
    end = date.today()
    for page in range(1, 31):
        r = _em_get(_REPORT_API, params={
            "pageSize": "100", "pageNo": str(page), "qType": "1",
            "beginTime": (end - timedelta(days=90)).isoformat(), "endTime": end.isoformat(),
        })
        r.raise_for_status()
        rows = r.json().get("data") or []
        for k in rows:
            name = _norm_industry(k.get("industryName"))
            code = str(k.get("industryCode") or "")
            if name and code and name not in codes:
                codes[name] = code
        if len(rows) < 100:
            break
        time.sleep(0.15)                       # 限流礼貌间隔
    return codes


def industry_reports(conn, symbol: str, limit: int = 12) -> Dict[str, Any]:
    """行业研报。行业码字典未收录该行业时返回 {industry, skipped: true}（前端提示）。
    （不含 conn 入缓存 key：行业归属以库内 universe 为准，结果只随 symbol/limit 变。）"""
    industry = _industry_of(conn, symbol)
    if not industry:
        return {"industry": "", "items": [], "skipped": True}
    key = f"live:indrep|{pure_of(symbol)}|{limit}"
    hit = _CACHE.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    code = _industry_codes().get(_norm_industry(industry))
    if not code:
        out = {"industry": industry, "items": [], "skipped": True}
    else:
        rows = _fetch_reports(1, {"industryCode": code, "code": ""}, days=365, limit=limit)
        out = {"industry": industry, "items": _norm_reports(rows, limit), "skipped": False}
    _CACHE[key] = (time.time() + _TTL_REPORT, out)
    return out
