"""行情端点：GET /market/kline · /market/minute · /market/quote · /market/search · 资讯/研报。"""
import time as _time
from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from ...contracts.common import Adjust, Page, WithParam
from ...contracts.market import (FundFlowRange, Kline, Quote, QuotesOut, SearchHit,
                                 TargetCondItem, TargetScanOut)
from ...errors import not_found, vip_required
from ...foundation import repo, screening
from ...foundation.db import get_conn
from ...foundation import live
from ...foundation.symbol import index_form, normalize_symbol
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


# 分时源域名（2026-11-01 实测 web.ifzq 整体 501，同路径在 ifzq.gtimg.cn /
# proxy.finance.qq.com/ifzqgtimg 均可用；依次降级，全挂才抛）
_TX_MINUTE_HOSTS = ("https://ifzq.gtimg.cn", "https://proxy.finance.qq.com/ifzqgtimg")


def _tx_minute_fetch(path: str, params: Optional[dict] = None):
    last: Optional[Exception] = None
    for host in _TX_MINUTE_HOSTS:
        try:
            return _tx_fetch(f"{host}{path}", params=params)
        except Exception as e:                       # noqa: BLE001 域名级降级
            last = e
    raise last  # type: ignore[misc]


@router.get("/market/fundflow", response_model=FundFlowRange,
            summary="区间资金流明细 + 合计（K 线框选统计同步右列资金卡）")
def fundflow(
    symbol: str = Query(description="6 位代码，兼容 600519.SH / sh.600519；指数返回 available=false"),
    start: Optional[str] = Query(default=None, description="起始日期 YYYY-MM-DD"),
    end: Optional[str] = Query(default=None, description="结束日期 YYYY-MM-DD"),
    limit: int = Query(default=400, ge=1, le=1200),
    conn=Depends(get_conn),
):
    """逐日 capital_flow（新浪唯一事实表）+ 区间合计。

    框选区间统计的资金口径与 K 线同源：前端框出 [startDate, endDate] 后一次拉齐，
    合计由服务端代数和给出，避免前端逐行累加口径漂移。
    """
    return repo.market.get_capital_flow_range(conn, symbol, start, end, limit)


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
        j = _tx_minute_fetch("/appstock/app/minute/query",
                             params={"code": txc})
        d = (j.get("data") or {}).get(txc) or {}
        body = d.get("data") or {}
        # 昨收按 txc 键精确取（qt dict 混有空的 v_ff_* 键，values()[0] 会拿到空数组）
        qt = (d.get("qt") or {}).get(txc) or []
        prev_close = None
        if len(qt) > 4 and qt[4]:
            prev_close = float(qt[4])
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
        # 盘前腾讯只给一个 09:30、累计量额全 0 的占位点：不是真实分时，
        # 丢掉（否则开盘前分时图/分时K就多出一根今天的柱）
        if len(bars) == 1 and not (bars[0].get("volume") or 0) and not (bars[0].get("amount") or 0):
            bars = []
        return {"symbol": symbol, "date": day, "prev_close": prev_close, "bars": bars}
    return _cached(f"m|{symbol}", 30, fetch)


@router.get("/market/sparks", summary="批量当日走势（自选列表 sparkline：降采样价格点 + 昨收）")
def sparks(symbols: str = Query(description="逗号分隔代码，≤50 只")):
    """自选列表行内迷你走势：每只降采样 ≈40 点（首尾保留），昨收供涨跌着色与基线。

    腾讯 minute/query 一次一只 → 线程池 8 并发；单只失败归 missing 不拖垮整批。
    """
    from concurrent.futures import ThreadPoolExecutor

    syms = [s.strip() for s in symbols.split(",") if s.strip()][:50]

    def one(sym: str):
        try:
            txc = tx_symbol(sym)
            if not txc:
                return None
            j = _tx_minute_fetch("/appstock/app/minute/query",
                                 params={"code": txc})
            d = (j.get("data") or {}).get(txc) or {}
            body = d.get("data") or {}
            qt = (d.get("qt") or {}).get(txc) or []
            prev = float(qt[4]) if len(qt) > 4 and qt[4] else None
            pts = [float(str(it).split(" ")[1])
                   for it in body.get("data") or [] if len(str(it).split(" ")) >= 2]
            if len(pts) < 2:
                return None
            step = max(1, len(pts) // 40)               # 240 分钟 → ≈40 点
            down = pts[::step]
            if down[-1] != pts[-1]:
                down.append(pts[-1])
            return {"symbol": sym, "prev_close": prev, "points": down}
        except Exception:
            return None

    def fetch():
        items, missing = [], []
        with ThreadPoolExecutor(max_workers=8) as ex:
            for sym, r in zip(syms, ex.map(one, syms)):
                (items.append(r) if r is not None else missing.append(sym))
        return {"items": items, "missing": missing}

    return _cached(f"sparks|{symbols}", 30, fetch)


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
    # 守卫 1：行情归属日必须是今天。优先用腾讯快照的真实行情日（qdate），
    # 只有 ts（本地抓取时刻）会在周末/节假日把上一交易日的快照伪装成"今日"，
    # 从而补出一根假 bar（2026-10-31 周六实测：上证指数多出一根 3547 的假线）。
    rt_date = (rt.get("qdate") or rt.get("ts") or "")[:10]
    if rt_date != today:
        return bars
    if date.today().weekday() >= 5:                     # 周末双保险：无交易不可能有今日 bar
        return bars
    # 守卫 0 · 未开盘：腾讯在 09:00 左右就把 qdate 切到当天，但集合竞价前
    # open/high/low 全是 0、price 仍是昨收。没有成交量能就不可能有今日 bar
    # （2026-11-02 09:11 实测：上证指数被补出 low=0 的假今日线，主图 Y 轴被拉到 0）
    if not rt.get("open"):
        return bars
    last = bars[-1]
    last_date = (last.get("date") or "")[:10]
    if rt_date < last_date:                             # 守卫 3
        return bars
    scale = 1.0
    # 指数 / 海外指数无复权因子，实时价与库内同为原始价，任何缩放都是错
    is_index = index_form(symbol) is not None
    if adjust is not Adjust.raw and not is_index and rt.get("prev_close"):
        prev_qfq = bars[-2]["close"] if last_date == today and len(bars) > 1 else last["close"]
        if prev_qfq and rt["prev_close"]:
            ratio = prev_qfq / rt["prev_close"]
            # 守卫 4：跨源昨收对不上（>2%）说明快照陈旧或复权口径错位，
            # 此时宁可不合并，也不能把一根缩放过 3% 的假 bar 塞进 K 线尾巴
            if abs(ratio - 1) > 0.02:
                return bars
            scale = ratio or 1.0
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

    总是带 rt_price/rt_time/rt_date/rt_prev_close/rt_live；rt_live=True（归属日==今天
    且已有开盘价）时价格字段改用实时值，
    基本信息卡兜底：daily_valuation 未落库时用腾讯扩展位
    （38=换手% 39=PE(TTM) 44/45=流通/总市值(亿) 46=PB）。"""
    q["rt_price"] = rt["price"]
    q["rt_time"] = rt.get("ts")
    q["rt_date"] = rt.get("qdate")          # 行情归属日：盘前/周末仍是上一交易日
    # 今日是否已有真实成交（开盘前腾讯 qdate 已切到今天，但 open 还是 0）
    q["rt_live"] = bool(rt.get("qdate") == date.today().isoformat() and rt.get("open"))
    if rt.get("prev_close") is not None:
        q["rt_prev_close"] = rt["prev_close"]   # 东财昨收：指数等跨源时防错位
    # 盘前/周末：快照属于上一交易日（qdate == 库内最新日线日），价格字段保持库内值，
    # 但库内缺失的成交额/量可由同一天的快照补齐（不能丢当日成交额）
    if rt.get("qdate") and rt["qdate"] == (q.get("date") or "")[:10]:
        if not q.get("amount") and rt.get("amount"):
            q["amount"] = rt["amount"]
        if not q.get("volume") and rt.get("volume"):
            q["volume"] = rt["volume"]
    # 只有「归属日==今天 且 已有开盘价」才把快照叠加进库内快照。
    # 盘前/周末腾讯返回上一交易日或零开盘的占位快照，若按 ts 判定，
    # 会把昨收数据标成今天（2026-11-02 盘前实测：K 线多出一根假今日 bar）
    if q["rt_live"]:
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


@router.get("/market/search", response_model=Page[SearchHit], summary="代码/名称搜索（个股+基金+指数+板块）")
def search(
    q: str = Query(min_length=1, max_length=20),
    limit: int = Query(default=10, ge=1, le=50),
    kinds: Optional[str] = Query(default=None, description="限定类别：stock,fund,index,sector（缺省全部）"),
    conn=Depends(get_conn),
):
    want = {k.strip() for k in kinds.split(",") if k.strip()} if kinds else None
    hits = repo.market.search(conn, q, limit, want)
    # 新股兜底：stock_universe 是慢变量（当天 16:20 估值任务才入池），本地命中
    # 不足时补腾讯联想，避免刚上市的票搜不到；命中重复的以本地行为准。
    if len(hits) < limit and (want is None or "stock" in want):
        try:
            from ...updater.collectors import sources as up_sources   # 延迟导入，避免 API 启动耦合采集层
            remote = up_sources.search_suggest(q, min(limit - len(hits), 8))
        except Exception:
            remote = []
        have = {h["symbol"] for h in hits}
        for r in remote:
            if r["symbol"] in have:
                continue
            hits.append({"symbol": r["symbol"], "name": r["name"],
                         "market": r["market"].lower(), "industry": None,
                         "status": None, "kind": "stock", "sub": None})
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


@router.get("/market/targets/conditions", response_model=list[TargetCondItem],
            summary="目标页可选选股条件元数据（前端条件栏据此渲染）")
def target_conditions():
    """条件登记在 foundation/screening.CONDITIONS：新增指标（如主力吸筹）
    只改那处，前端条件栏与阈值输入自动出现。"""
    return screening.public_conditions()


@router.get("/market/targets", response_model=TargetScanOut,
            summary="目标页全市场扫描（多条件叠加 + 趋势柱线；ST 与北交所剔除）")
def targets(conds: str = Query(default="vol,short,mid,up20",
                               description="启用条件，逗号分隔（见 /market/targets/conditions）"),
            values: Optional[str] = Query(default=None,
                                          description='数值条件阈值 JSON，如 {"vol": 1.5}'),
            limit: int = Query(default=100, ge=1, le=10000),
            trend_mode: Literal["cross", "above"] = "cross",
            trend_recent: int = Query(default=5, ge=1, le=250),
            trend_still_above: bool = True,
            trend_above_days: int = Query(default=1, ge=1, le=250),
            conn=Depends(get_conn)):
    """指标层后台定时预计算（target_scan / target_trend），条件层即时过滤：
    改条件或阈值即刻重筛（毫秒级），只有数据更新才重算指标层。

    所有勾选条件同时满足（AND 叠加）；未勾选的不参与判定。
    flag 条件看布尔字段，value 条件按阈值比较（op 默认 >=），trend 走
    trend_matches 参数化判定；命中列表按六分段强势在前。"""
    items, meta, vals, provisional = _target_scan(
        conn, conds, values, trend_mode, trend_recent,
        trend_still_above, trend_above_days)
    return TargetScanOut(items=items[:limit], total_hits=len(items), values=vals,
                         provisional=provisional,
                         scanned=meta["scanned"], as_of=meta["as_of"],
                         computed_at=meta.get("computed_at", ""))


def _target_scan(conn, conds: str, values: Optional[str],
                 trend_mode: str, trend_recent: int,
                 trend_still_above: bool, trend_above_days: int):
    """目标页条件叠加（端点与 Excel 导出共用）：返回 (items, meta, vals, provisional)。"""
    from ...foundation.target_trend import trend_matches

    want = screening.enabled_keys(conds)
    vals = screening.parse_values(values, want)
    rows, meta = repo.market.stock_targets_universe(conn)
    trend_as_of = meta.get("trend_as_of") or meta["as_of"]
    provisional = bool(meta.get("provisional"))
    # 负柱收敛 / 距零轴也依赖 STICKV 预计算序列，启用时同样拼接趋势字段
    if screening.needs_trend(want):
        trends = repo.market.stock_target_trends(conn)
        rows = [{**row, **trends.get(row['symbol'], {}),
                 "trend_provisional": provisional}
                for row in rows]

    def trend_hit(t: dict) -> bool:
        return (t.get('trend_data_date') == trend_as_of and
                trend_matches(t, trend_mode, trend_recent, trend_still_above, trend_above_days))

    items = [t for t in rows if screening.matches(t, want, vals, trend_hit(t) if "trend" in want else None)]
    if "trend" in want:
        items.sort(key=lambda t:
            ((t.get('trend_cross_ago') if t.get('trend_cross_ago') is not None else 100000), -t['seg']))
    elif "negshrink" in want or "nearzero" in want:
        # 负柱收敛榜：越贴近零轴越靠前（neg_abs 升序），同幅度再按收敛天数/强势段
        items.sort(key=lambda t: (
            t.get('neg_abs') if t.get('neg_abs') is not None else 1e9,
            -(t.get('neg_run') or 0), -t['seg']))
    else:
        items.sort(key=lambda t: (-t['seg'], -(t['vol_ratio'] or 0)))
    return items, meta, vals, provisional


@router.get("/market/targets/spark", summary="目标页行内缩略图（K 线 + 中线趋势 + 趋势柱线，批量）")
def targets_spark(symbols: str = Query(description="逗号分隔代码，≤60 只"),
                  bars: int = Query(default=60, ge=20, le=250,
                                    description="回看的交易日根数（小 30 / 中 60 / 大 120）"),
                  conn=Depends(get_conn)):
    syms = [s.strip() for s in symbols.split(",") if s.strip()]
    if not syms:
        return {"bars": bars, "items": []}
    data = repo.market.target_sparks(conn, syms, bars)
    return {"bars": bars, "items": list(data.values())}


@router.get("/market/targets/export", summary="目标监控导出 Excel（当前条件命中的全量结果）")
def targets_export(conds: str = Query(default="vol,short,mid,up20"),
                   values: Optional[str] = Query(default=None),
                   trend_mode: Literal["cross", "above"] = "cross",
                   trend_recent: int = Query(default=5, ge=1, le=250),
                   trend_still_above: bool = True,
                   trend_above_days: int = Query(default=1, ge=1, le=250),
                   conn=Depends(get_conn)):
    """与 /market/targets 同一套条件判定，导出全量命中（不受分页 limit 限制），
    首个工作表含计算时间/数据截至说明行。"""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment
    from openpyxl.utils import get_column_letter
    import io
    from urllib.parse import quote

    items, meta, _vals, _provisional = _target_scan(
        conn, conds, values, trend_mode, trend_recent,
        trend_still_above, trend_above_days)
    with_trend = screening.needs_trend(screening.enabled_keys(conds))

    cols = [
        ("symbol", "代码", 11, None),
        ("name", "名称", 12, None),
        ("close", "现价", 9, "0.00"),
        ("pct_chg", "涨跌幅(%)", 10, "0.00"),
        ("vol_ratio", "40日均量比", 11, "0.00"),
        ("short_orange", "短线趋势橙", 10, None),
        ("mid_orange", "中线趋势橙", 10, None),
        ("limit_up_cnt", "20日涨停次数", 11, "0"),
        ("seg", "六分段", 20, None),
        ("state", "短线状态", 13, None),
    ]
    if with_trend:
        cols += [
            ("neg_run", "负柱收敛天数", 12, "0"),
            ("neg_abs", "距零轴", 9, "0.00"),
            ("trend_value", "STICKV", 9, "0.00"),
            ("trend_cross_date", "最近转正", 11, None),
            ("cross_ago", "距今交易日", 10, "0"),
            ("above_days", "连续上方天数", 12, "0"),
        ]

    def cell(t: dict, key: str):
        if key == "short_orange":
            return "橙" if t.get("short_orange") else "蓝"
        if key == "mid_orange":
            return "橙" if t.get("mid_orange") else "蓝"
        if key == "seg":
            return f"第{t.get('seg')}段·{t.get('seg_name') or ''}"
        if key == "state":
            return "回调中" if t.get("pullback") else "上行"
        if key == "cross_ago":
            n = t.get("trend_cross_ago")
            return "" if n is None else ("当日" if n == 0 else f"{n}日前")
        if key == "above_days":
            n = t.get("trend_above_days")
            return "" if n is None else n
        return t.get(key)

    wb = Workbook()
    ws = wb.active
    ws.title = "目标监控"
    last = get_column_letter(len(cols))
    ws.merge_cells(f"A1:{last}1")
    ws["A1"] = (f"目标监控 ｜ 计算于 {meta.get('computed_at') or '—'} ｜ "
                f"数据截至 {meta['as_of']} ｜ 命中 {len(items)} 只")
    ws["A1"].font = Font(bold=True, size=11)
    ws["A2"].alignment = Alignment(vertical="center")
    for i, (_k, label, width, _fmt) in enumerate(cols, start=1):
        c = ws.cell(row=2, column=i, value=label)
        c.font = Font(bold=True)
        c.fill = PatternFill("solid", fgColor="F2F2F2")
        ws.column_dimensions[get_column_letter(i)].width = width
    for r, t in enumerate(items, start=3):
        for i, (key, _label, _w, fmt) in enumerate(cols, start=1):
            v = cell(t, key)
            c = ws.cell(row=r, column=i, value=v if v is not None else "")
            if fmt:
                c.number_format = fmt
    ws.freeze_panes = "A3"

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    ts = date.today().strftime("%Y%m%d")
    fname = f"目标监控_{ts}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f"attachment; filename=\"targets_{ts}.xlsx\"; "
                                        f"filename*=UTF-8''{quote(fname)}"})


# -- 2.2 全景大页 ----------------------------------------------------------

from ...contracts.market import BoardOut, BoardRow, BreadthOut, IndexBarItem  # noqa: E402


@router.get("/market/board", response_model=BoardOut,
            summary="全景大表（market_snapshot 排序分页，盘中 5 分钟刷新）")
def board(tab: str = Query(default="hsa",
                           description="hsa=沪深A股 sha=沪市A股 sza=深市A股 cyb=创业板 "
                                       "kc=科创板 bj=北交所 fund=全部基金 "
                                       "fund_sh=上证基金 fund_sz=深证基金"),
          sort: str = Query(default="-change_rate"),
          page: int = Query(default=1, ge=1), size: int = Query(default=50, ge=1, le=200),
          q: Optional[str] = None, conn=Depends(get_conn)):
    rows, total = repo.market.board_rows(conn, tab=tab, sort=sort,
                                         page=page, size=size, q=q)
    day = conn.execute(
        "SELECT MAX(trade_date) FROM market_snapshot").fetchone()[0]
    return BoardOut(items=rows, total=total, tab=tab, as_of=str(day) if day else "")


@router.get("/market/index_bar", response_model=list[IndexBarItem],
            summary="指数条（INDEX_CATALOG × 当日快照）")
def index_bar_ep(conn=Depends(get_conn)):
    return repo.market.index_bar(conn)


@router.get("/market/breadth", response_model=BreadthOut,
            summary="市场总貌（涨跌家数/涨跌停精确家数/两市成交额）")
def breadth(conn=Depends(get_conn)):
    return repo.market.market_breadth(conn)


@router.get("/market/snapshot_one", response_model=Optional[BoardRow],
            summary="单标的当日快照（个股详情页盘口网格；无快照返回 null）")
def snapshot_one(symbol: str = Query(description="个股裸码 600519 或指数全码 000001.SH"),
                 conn=Depends(get_conn)):
    return repo.market.snapshot_one(conn, symbol)


# -- 众赢板块体系（清单逆向接口低频日级同步；行情 = 成分 × 当日快照本地聚合） --

from ...contracts.market import ZyBlockMembersOut, ZyBlocksOut  # noqa: E402

_ZY_TYPE_NAMES = {1: "地域", 2: "概念", 4: "行业", 8: "风格", 9: "题材"}


@router.get("/market/zy_blocks", response_model=ZyBlocksOut,
            summary="众赢板块列表（成分 × 当日快照聚合；type_code 1地域/2概念/4行业/8风格/9题材）")
def zy_blocks(type_code: int = Query(default=2),
              sort: str = Query(default="-avg_change"),
              page: int = Query(default=1, ge=1), size: int = Query(default=50, ge=1, le=200),
              q: Optional[str] = None, conn=Depends(get_conn)):
    if type_code not in _ZY_TYPE_NAMES:
        raise not_found("type_code 仅支持 1/2/4/8/9", {"type_code": type_code})
    rows, total = repo.zyblock.list_blocks(conn, type_code, sort=sort,
                                           page=page, size=size, q=q)
    day = conn.execute(
        "SELECT MAX(trade_date) FROM market_snapshot").fetchone()[0]
    return ZyBlocksOut(items=rows, total=total, type_code=type_code,
                       as_of=str(day) if day else "")


@router.get("/market/zy_blocks/{block_code}/members", response_model=ZyBlockMembersOut,
            summary="众赢板块成分 × 当日快照（股票/基金口径，未采成分行情字段为 null）")
def zy_block_members(block_code: str,
                     sort: str = Query(default="-change_rate"),
                     page: int = Query(default=1, ge=1),
                     size: int = Query(default=50, ge=1, le=200),
                     q: Optional[str] = None, conn=Depends(get_conn)):
    meta = repo.zyblock.block_meta(conn, block_code)
    if meta is None:
        raise not_found(f"板块不存在：{block_code}", {"block_code": block_code})
    rows, total = repo.zyblock.block_members(conn, block_code, sort=sort,
                                             page=page, size=size, q=q)
    day = conn.execute(
        "SELECT MAX(trade_date) FROM market_snapshot").fetchone()[0]
    return ZyBlockMembersOut(items=rows, total=total,
                             block_code=block_code,
                             block_name=meta["block_name"],
                             as_of=str(day) if day else "")
