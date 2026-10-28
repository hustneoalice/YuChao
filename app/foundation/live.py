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

from ..updater.collectors.http import client, _UA, pure_of
from .symbol import INDEX_NAMES, TICKER_INDICES

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
    r = client.get(_SEARCH_API, params={"cb": "cb", "param": inner}, timeout=12,
                   headers={"User-Agent": _UA, "Referer": "https://so.eastmoney.com/"})
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
# 实时行情快照（东财 push2）：盘中价兜底，10s 缓存
# ---------------------------------------------------------------------------

_RT_FIELDS = "f43,f44,f45,f46,f47,f48,f60,f86,f169,f170,f57,f58"


def _secid_of(symbol: str) -> str:
    """东财 secid：带后缀（000001.SH/399001.SZ）按后缀映射；裸码按首位数字猜。"""
    s = str(symbol).strip().upper()
    if "." in s:
        code, mkt = s.split(".", 1)
        return f"1.{code}" if mkt == "SH" else f"0.{code}"
    code = pure_of(s)
    return f"1.{code}" if code.startswith(("6", "9", "5")) else f"0.{code}"


@_cached("live:rt", 10)
def realtime_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """东财实时快照。返回 {price, high, low, open, prev_close, pct, amount,
    volume, ts}；secid 映射见 _secid_of（指数带后缀直达，如 000001.SH→1.000001）。"""
    secid = _secid_of(symbol)
    r = client.get("https://push2.eastmoney.com/api/qt/stock/get",
                   params={"secid": secid, "fields": _RT_FIELDS, "invt": "2"},
                   timeout=8, headers={"User-Agent": _UA, "Referer": _EM_REFERER})
    r.raise_for_status()
    d = (r.json().get("data") or {})
    if not d.get("f43") or d.get("f43") == "-":
        return None
    scale = 10 ** int(d.get("f59") or 2)     # 价格精度（北交所 3 位）
    amt = d.get("f48")
    vol = d.get("f47")
    return {
        "price": d["f43"] / scale,
        "high": d["f44"] / scale if isinstance(d.get("f44"), (int, float)) else None,
        "low": d["f45"] / scale if isinstance(d.get("f45"), (int, float)) else None,
        "open": d["f46"] / scale if isinstance(d.get("f46"), (int, float)) else None,
        "prev_close": d["f60"] / scale if isinstance(d.get("f60"), (int, float)) else None,
        "pct": d["f170"] / 100 if isinstance(d.get("f170"), (int, float)) else None,
        "amount": amt if isinstance(amt, (int, float)) else None,        # f48 已是元
        "volume": vol * 100 if isinstance(vol, (int, float)) else None,  # f47 单位手 → 股
        "ts": time.strftime("%Y-%m-%d %H:%M", time.localtime(d["f86"])) if d.get("f86") else None,
    }


@_cached("live:idx", 10)
def realtime_indices() -> Dict[str, Any]:
    """常用指数批量实时（东财 push2 /qt/stock/get 逐个拉取，10s 缓存）：ticker 数据源。

    ulist.np 批量接口已被东财断连（RemoteProtocolError），退化为 7 次单标的
    请求（与 realtime_quote 同端点，已验证可用）。返回
    {"items": [{symbol, name, price, chg, pct, amount}], "total_amount": 沪+深之和}。
    """
    out: List[Dict[str, Any]] = []
    for sym, name, secid in TICKER_INDICES:
        d: Dict[str, Any] = {}
        for attempt in range(2):                    # 连发被东财偶发掐断，重试一次
            try:
                r = client.get("https://push2.eastmoney.com/api/qt/stock/get",
                               params={"secid": secid, "fltt": "2", "invt": "2",
                                       "fields": "f43,f48,f169,f170"},
                               timeout=6, headers={"User-Agent": _UA, "Referer": _EM_REFERER})
                r.raise_for_status()
                d = (r.json().get("data") or {})
                if d.get("f43") is not None:
                    break
            except Exception:
                pass
            time.sleep(0.25)
        if d.get("f43") is None:
            continue
        price, chg, pct, amt = d.get("f43"), d.get("f169"), d.get("f170"), d.get("f48")
        num = lambda v: v if isinstance(v, (int, float)) else None      # noqa: E731
        out.append({"symbol": sym, "name": name, "price": num(price),
                    "chg": num(chg),
                    "pct": pct / 100 if isinstance(pct, (int, float)) else None,
                    "amount": amt if isinstance(amt, (int, float)) else None})   # f48 已是元
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
    r = client.get(_REPORT_API, params=params, timeout=15,
                   headers={"User-Agent": _UA, "Referer": _EM_REFERER})
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
        r = client.get(_REPORT_API, params={
            "pageSize": "100", "pageNo": str(page), "qType": "1",
            "beginTime": (end - timedelta(days=90)).isoformat(), "endTime": end.isoformat(),
        }, timeout=15, headers={"User-Agent": _UA, "Referer": _EM_REFERER})
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
