"""行情端点：GET /market/kline · /market/quote · /market/search · 资讯/研报。"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query

from ...contracts.common import Adjust, Page, WithParam
from ...contracts.market import Kline, Quote, SearchHit
from ...errors import vip_required
from ...foundation import repo
from ...foundation.db import get_conn
from ...foundation import live
from pydantic import TypeAdapter

router = APIRouter(tags=["market"])


@router.get("/market/kline", response_model=Kline, summary="K 线（复权在查询层派生）")
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
    conn=Depends(get_conn),
):
    if with_param == WithParam.vip:
        raise vip_required("VIP 通道未授权：短线/中线操盘通道数据不返回（M1 桩）")
    data = repo.market.get_kline(conn, symbol, adjust, with_param.value if with_param else None,
                                 start, end, limit)
    return TypeAdapter(Kline).validate_python(data)


@router.get("/market/quote", response_model=Quote, summary="个股快照（最新日线+估值+资金流，盘中叠实时价）")
def quote(symbol: str, conn=Depends(get_conn)):
    q = repo.market.get_quote(conn, symbol)
    try:                                    # 实时兜底：成功则带 rt_* 字段，失败静默降级
        rt = live.realtime_quote(symbol)
        if rt:
            q["rt_price"] = rt["price"]
            q["rt_time"] = rt["ts"]
            if rt.get("prev_close") is not None:
                q["rt_prev_close"] = rt["prev_close"]   # 东财昨收：指数等跨源时防错位
            # 盘中（快照为今日）时用实时值覆盖价格字段，尾部日线日期改标实时时间
            if rt["ts"] and rt["ts"][:10] == date.today().isoformat():
                q["date"] = rt["ts"]
                if rt.get("open") is not None: q["open"] = rt["open"]
                if rt.get("high") is not None: q["high"] = rt["high"]
                if rt.get("low") is not None: q["low"] = rt["low"]
                if rt.get("price") is not None: q["close"] = rt["price"]
                if rt.get("pct") is not None: q["pct_chg"] = rt["pct"]
                if rt.get("volume") is not None: q["volume"] = rt["volume"]
                if rt.get("amount") is not None: q["amount"] = rt["amount"]
                # 基本信息卡兜底：daily_valuation 未落库时用腾讯扩展位
                # （38=换手% 39=PE(TTM) 44/45=流通/总市值(亿) 46=PB；指数行为空不触发）
                if rt.get("turnover") and not q.get("turnover_rate"):
                    q["turnover_rate"] = rt["turnover"]
                if rt.get("total_mv_yi") and not q.get("valuation"):
                    q["valuation"] = {
                        "date": date.today().isoformat(),
                        "pe_ttm": rt.get("pe_ttm"), "pb": rt.get("pb"),
                        "total_mv": rt["total_mv_yi"] * 1e8,
                        "circ_mv": (rt.get("circ_mv_yi") or rt["total_mv_yi"]) * 1e8,
                    }
    except Exception:
        pass
    return q


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
