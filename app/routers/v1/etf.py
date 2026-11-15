"""ETF 涨跌逻辑端点：GET /etf/updown —— 饭钱/菜钱/酒钱三组 ETF 的 10% 有效波段量化。

口径与行情页右列「涨跌统计」卡一致（frontend/src/updown-stats.ts）：
低点→高点涨 >10% 才算有效上涨段；回撤/反弹不足 10% 不否定原趋势。
数据缓存见 app/foundation/etf_updown.py，不写 DuckDB、不影响 stock_universe。
"""
from fastapi import APIRouter, Query

from ...foundation import etf_updown

router = APIRouter(tags=["etf"])


@router.get("/etf/updown", summary="ETF 涨跌逻辑量化（饭钱/菜钱/酒钱 · 10% 有效波段）")
def updown(
    refresh: bool = Query(default=False, description="忽略缓存，重取日线与报价"),
    quotes: bool = Query(default=True, description="是否带实时报价（false = 只用日线收盘）"),
):
    return etf_updown.load(refresh=refresh, with_quotes=quotes)
