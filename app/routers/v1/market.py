"""行情端点：GET /market/kline · /market/minute · /market/quote · /market/search · 资讯/研报。"""
import time as _time
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query

from ...contracts.common import Adjust, Page, WithParam
from ...contracts.market import Kline, Quote, QuotesOut, SearchHit
from ...errors import vip_required
from ...foundation import repo
from ...foundation.db import get_conn
from ...foundation import live
from ...updater.collectors.http import _UA, client as tx_client, tx_symbol
from pydantic import TypeAdapter

router = APIRouter(tags=["market"])

_TX_REFERER = "https://gu.qq.com/"
_MINUTE_FREQS = {"60": ("m60", 320)}          # 对标策影周期集：分时 + 60 分先行
_m_cache: dict = {}                           # key -> (ts, payload) 简单 TTL 缓存


def _cached(key: str, ttl: float, fetch):
    hit = _m_cache.get(key)
    now = _time.time()
    if hit and now - hit[0] < ttl:
        return hit[1]
    data = fetch()
    _m_cache[key] = (now, data)
    if len(_m_cache) > 300:                   # 防 LEAK：清过期项
        stale = [k for k, v in _m_cache.items() if now - v[0] > ttl]
        for k in stale[:150]:
            _m_cache.pop(k, None)
    return data


def _tx_fetch(url: str, params: Optional[dict] = None):
    r = tx_client.get(url, params=params, timeout=8,
                      headers={"User-Agent": _UA, "Referer": _TX_REFERER})
    r.raise_for_status()
    return r.json()


@router.get("/market/minute", summary="当日分时（价格线 + 均价线，腾讯实时，1 分钟粒度）")
def minute(symbol: str = Query(description="6 位代码，兼容 sh.600519 形态")):
    """策影 /api/data/intraday 同源移植：腾讯 minute/query。

    返回 bars：date 装到分钟的 datetime，o/h/l/c=分钟价（策影同款假 K 线渲染），
    avg=累计成交额/累计成交量/100（VWAP 均价线），prev_close 供涨跌幅坐标。
    """
    def fetch():
        txc = tx_symbol(symbol)
        if not txc:
            raise ValueError(f"非法代码: {symbol}")
        j = _tx_fetch("https://web.ifzq.gtimg.cn/appstock/app/minute/query",
                      params={"code": txc})
        d = (j.get("data") or {}).get(txc) or {}
        body = d.get("data") or {}
        qt = list((d.get("qt") or {}).values())
        prev_close = None
        if qt and len(qt[0]) > 4 and qt[0][4]:
            prev_close = float(qt[0][4])
        raw_day = body.get("date") or date.today().strftime("%Y%m%d")
        day = f"{raw_day[:4]}-{raw_day[4:6]}-{raw_day[6:]}"
        bars, pv, pa = [], 0, 0.0
        for it in body.get("data") or []:
            p = str(it).split(" ")
            if len(p) < 4:
                continue
            price = float(p[1])
            cum_v, cum_a = int(p[2]), float(p[3])
            pv, pa, v, a = cum_v, cum_a, cum_v - pv, cum_a - pa
            # VWAP：腾讯 volume 单位为手（1手=100股）。指数分时无 VWAP 概念，
            # 算出来会掉到地上 —— 偏离现价 ±60% 直接置空，前端不画均价线。
            avg = round(cum_a / (cum_v * 100), 3) if cum_v > 0 else None
            if avg is not None and (price * 0.4 > avg or avg > price * 1.6):
                avg = None
            bars.append({
                "date": f"{day} {p[0][:2]}:{p[0][2:]}",
                "open": price, "high": price, "low": price, "close": price,
                "volume": v, "amount": a,
                "avg": avg if avg is not None else price,
                "has_avg": avg is not None,
            })
        return {"symbol": symbol, "date": day, "prev_close": prev_close, "bars": bars}
    return _cached(f"m|{symbol}", 30, fetch)


def _merge_live_bar(bars: list, symbol: str, adjust: Adjust) -> list:
    """盘中合并「今日未收盘 bar」（策影同款 + 三守卫，2026-10-28 用户：
    科创50 顶部已实时转涨、K 线末根还是昨日 —— 实时价此前只进 quote 不进 K 线）。

    守卫 1 _quote_is_today：行情必须属于今天才允许改/补 K 线 —— 盘前腾讯返回
    昨收快照，不守卫会补出一根与昨日逐位相同的「假今日 bar」。
    守卫 2 分支：末根==今天 → 原地更新（close 覆盖 / high 取大 / low 取小）；
    末根<今天 → 补一根（open 兜底 prev_close）。
    守卫 3 一致性：行情归属日 < K 线末根 → 丢弃实时（上游延迟/跨日残留）。
    复权：实时价是原始价，库内 qfq/hfq —— 按昨收比缩放实时段（当日形态不变）；
    qfq 锚定最新价，比值常态为 1，缩放只是除息日当天的保险。
    volume/amount 由 _tx_quotes 已统一为股/元，直接落位。
    """
    if not bars:
        return bars
    try:
        rt = live.realtime_quote(symbol)
    except Exception:
        return bars
    if not rt or not rt.get("price"):
        return bars
    today = date.today().isoformat()
    rt_date = (rt.get("ts") or "")[:10]
    if rt_date != today:                                # 守卫 1
        return bars
    last = bars[-1]
    last_date = (last.get("date") or "")[:10]
    if rt_date < last_date:                             # 守卫 3
        return bars
    scale = 1.0
    if adjust is not Adjust.raw and rt.get("prev_close"):
        prev_qfq = bars[-2]["close"] if last_date == today and len(bars) > 1 else last["close"]
        if prev_qfq and rt["prev_close"]:
            scale = prev_qfq / rt["prev_close"] or 1.0
    f = lambda v: (v * scale) if v is not None else None  # noqa: E731
    o, h, l, c = f(rt.get("open")), f(rt.get("high")), f(rt.get("low")), f(rt["price"])
    c_l = min((v for v in (l, o, c) if v is not None), default=None)
    if last_date == today:                              # 守卫 2a：原地更新
        last["close"] = c
        if h: last["high"] = max(last.get("high") or h, h)
        if c_l is not None:
            last["low"] = min(last.get("low") or c_l, c_l)
        if o: last["open"] = o
        if rt.get("volume"): last["volume"] = rt["volume"]
        if rt.get("amount"): last["amount"] = rt["amount"]
        if rt.get("turnover"): last["turnover_rate"] = rt["turnover"]
        last["live"] = True
    else:                                               # 守卫 2b：补今日 bar
        prev = last["close"]
        bars.append({
            "date": today, "open": o or prev, "high": h or c or prev,
            "low": c_l if c_l is not None else (c or prev), "close": c,
            "volume": rt.get("volume"), "amount": rt.get("amount"),
            "pct_chg": rt.get("pct"), "turnover_rate": rt.get("turnover"),
            "live": True,
        })
    return bars


@router.get("/market/kline", response_model=Kline, summary="K 线（复权在查询层派生；freq=60 为 60 分钟K）")
def kline(
    symbol: str = Query(description="6 位代码，兼容 sh.600519 / 600519.SH 形态"),
    adjust: Adjust = Query(default=Adjust.qfq, description="qfq 看盘 / hfq 收益 / raw 原始价"),
    with_param: Optional[WithParam] = Query(
        default=None, alias="with",
        description="indicator=标准指标（开源）；vip=闭源通道（未授权 403，不返回数据）",
    ),
    start: Optional[str] = Query(default=None, description="起始日期 YYYY-MM-DD"),
    end: Optional[str] = Query(default=None, description="结束日期 YYYY-MM-DD"),
    limit: int = Query(default=500, ge=1, le=5000),
    freq: Optional[str] = Query(default=None, description="60=60 分钟K（腾讯 mkline 实时，不落库）"),
    conn=Depends(get_conn),
):
    if with_param == WithParam.vip:
        raise vip_required("VIP 通道未授权：短线/中线操盘通道数据不返回（M1 桩）")
    if freq in _MINUTE_FREQS:
        tag, want = _MINUTE_FREQS[freq]

        def fetch():
            txc = tx_symbol(symbol)
            if not txc:
                raise ValueError(f"非法代码: {symbol}")
            j = _tx_fetch("https://ifzq.gtimg.cn/appstock/app/kline/mkline",
                          params={"param": f"{txc},{tag},,{want}"})
            rows = (((j.get("data") or {}).get(txc) or {}).get(tag)) or []
            # 字段序实测：[ymdHHMM, open, close, high, low, volume(股), {}, ...]
            bars = []
            for r in rows:
                if len(r) < 6:
                    continue
                raw = str(r[0])
                dt = f"{raw[:4]}-{raw[4:6]}-{raw[6:8]} {raw[8:10]}:{raw[10:12]}"
                bars.append({"date": dt, "open": float(r[1]), "close": float(r[2]),
                             "high": float(r[3]), "low": float(r[4]),
                             "volume": float(r[5]), "live": False})
            return bars

        bars = _cached(f"k{freq}|{symbol}", 120, fetch)
        return TypeAdapter(Kline).validate_python(
            {"symbol": symbol, "period": freq, "adjust": "raw", "bars": bars})
    data = repo.market.get_kline(conn, symbol, adjust, with_param.value if with_param else None,
                                 start, end, limit)
    # 盘中实时：把「今日未收盘 bar」合并进尾部（守卫见 _merge_live_bar）；
    # 显式 start/end 查历史区间时不并（用户在翻历史，不应出现今天的浮根）
    if not (start or end):
        data["bars"] = _merge_live_bar(data["bars"], data["symbol"], adjust)
    return TypeAdapter(Kline).validate_python(data)


def _apply_rt(q: dict, rt: dict) -> None:
    """实时快照就地叠加进库内快照（单只 /market/quote 与批量 /market/quotes 共用）。

    总是带 rt_price/rt_time/rt_prev_close；盘中（快照日==今天）时价格字段改用实时值，
    基本信息卡兜底：daily_valuation 未落库时用腾讯扩展位
    （38=换手% 39=PE(TTM) 44/45=流通/总市值(亿) 46=PB）。"""
    q["rt_price"] = rt["price"]
    q["rt_time"] = rt.get("ts")
    if rt.get("prev_close") is not None:
        q["rt_prev_close"] = rt["prev_close"]   # 东财昨收：指数等跨源时防错位
    if rt.get("ts") and rt["ts"][:10] == date.today().isoformat():
        q["date"] = rt["ts"]
        if rt.get("open") is not None: q["open"] = rt["open"]
        if rt.get("high") is not None: q["high"] = rt["high"]
        if rt.get("low") is not None: q["low"] = rt["low"]
        if rt.get("price") is not None: q["close"] = rt["price"]
        if rt.get("pct") is not None: q["pct_chg"] = rt["pct"]
        if rt.get("volume") is not None: q["volume"] = rt["volume"]
        if rt.get("amount") is not None: q["amount"] = rt["amount"]
        if rt.get("turnover") and not q.get("turnover_rate"):
            q["turnover_rate"] = rt["turnover"]
        if rt.get("total_mv_yi") and not q.get("valuation"):
            q["valuation"] = {
                "date": date.today().isoformat(),
                "pe_ttm": rt.get("pe_ttm"), "pb": rt.get("pb"),
                "total_mv": rt["total_mv_yi"] * 1e8,
                "circ_mv": (rt.get("circ_mv_yi") or rt["total_mv_yi"]) * 1e8,
            }


@router.get("/market/quote", response_model=Quote, summary="个股快照（最新日线+估值+资金流，盘中叠实时价）")
def quote(symbol: str, conn=Depends(get_conn)):
    q = repo.market.get_quote(conn, symbol)
    try:                                    # 实时兜底：成功则带 rt_* 字段，失败静默降级
        rt = live.realtime_quote(symbol)
        if rt:
            _apply_rt(q, rt)
    except Exception:
        pass
    return q


@router.get("/market/quotes", response_model=QuotesOut,
            summary="批量快照（自选股卡片：N 只一次渲染，一次腾讯实时 HTTP）")
def quotes(symbols: str = Query(
        description="逗号分隔 ≤50 只，兼容 sh.600519 / 600519.SH / 000001.SH 指数形态"),
        conn=Depends(get_conn)):
    syms, seen = [], set()
    for s in symbols.split(","):
        s = s.strip()
        if s and s.upper() not in seen:
            seen.add(s.upper())
            syms.append(s)
    if not syms:
        return QuotesOut(items=[], missing=[])
    items, missing = repo.market.get_quotes(conn, syms[:50])
    try:                                    # 批量实时兜底：一次腾讯 HTTP（10s 缓存），失败降级为纯库内截面
        rts = live.realtime_quotes([q["symbol"] for q in items])
        for q in items:
            rt = rts.get(q["symbol"])
            if rt:
                _apply_rt(q, rt)
    except Exception:
        pass
    return TypeAdapter(QuotesOut).validate_python({"items": items, "missing": missing})


@router.get("/market/search", response_model=Page[SearchHit], summary="代码/名称搜索")
def search(
    q: str = Query(min_length=1, max_length=20),
    limit: int = Query(default=10, ge=1, le=50),
    conn=Depends(get_conn),
):
    hits = repo.market.search(conn, q, limit)
    return Page(items=[SearchHit(**h) for h in hits], total=len(hits))


@router.get("/market/indices", summary="指数 ticker 实时行情（东财批量，10s 缓存）")
def indices():
    try:
        return live.realtime_indices()
    except Exception:
        return {"items": [], "total_amount": 0}


# ── 实时资讯/研报（东财直连 + live 层 TTL 缓存；失败降级为空列表不 5xx） ──

@router.get("/market/news", summary="个股资讯（东财搜索，10min 缓存）")
def news(symbol: str, limit: int = Query(default=12, ge=1, le=30)):
    try:
        return {"items": live.stock_news(symbol, limit)}
    except Exception:
        return {"items": []}


@router.get("/market/reports", summary="个股研报（东财 reportapi，2h 缓存）")
def reports(symbol: str, limit: int = Query(default=12, ge=1, le=30)):
    try:
        return {"items": live.stock_reports(symbol, limit)}
    except Exception:
        return {"items": []}


@router.get("/market/industry-reports", summary="行业研报（按 universe 行业归属，2h 缓存）")
def industry_reports(symbol: str, limit: int = Query(default=12, ge=1, le=30),
                     conn=Depends(get_conn)):
    try:
        return live.industry_reports(conn, symbol, limit)
    except Exception:
        return {"industry": "", "items": [], "skipped": True}
