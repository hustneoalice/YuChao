"""独立主力军情接口。"""
from datetime import date
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from ...foundation.db import get_conn
from ...foundation.repo.mainforce import SORTS
from ...foundation.repo.mainforce_cache import cached_mainforce

router = APIRouter(tags=['mainforce'])


@router.get('/market/mainforce')
def mainforce(view: Literal['blocks', 'stocks'] = 'blocks',
              type_code: int = 4, block_code: Optional[str] = None,
              period: int = 1,
              end: Optional[date] = None, q: Optional[str] = None,
              sort: str = '-main_net', page: int = Query(1, ge=1),
              size: int = Query(50, ge=1, le=200), conn=Depends(get_conn)):
    if type_code not in (1, 2, 4) or period not in (1, 3, 5, 10, 34, 55):
        raise HTTPException(status_code=422, detail='不支持的分类或周期')
    if sort.lstrip('-') not in SORTS or sort.startswith('--'):
        raise HTTPException(status_code=422, detail='不支持的排序字段')
    return cached_mainforce(conn, view, type_code, block_code, period, end, q, sort, page, size)


@router.get('/market/mainforce-motion', summary='主力动向试验榜单（非众赢原模型）')
def mainforce_motion(end: Optional[date] = None, conn=Depends(get_conn)):
    from ...updater.util import now_cst
    from ...foundation.repo.mainforce_motion import list_motion
    if end and end > now_cst().date():
        raise HTTPException(422, '请选择今天或之前的日期')
    return list_motion(conn, str(end) if end else None)


@router.get('/market/limit-chase', summary='涨停追击：精确快照收盘统计')
def limit_chase(end: Optional[date] = None, markets: str = 'main,chi,star,bj',
                show_st: bool = False, period: int = 3, conn=Depends(get_conn)):
    from ...updater.util import now_cst
    from ...foundation.repo.limit_chase import list_chase
    selected=tuple(filter(None,markets.split(',')))
    if not selected or any(m not in ('main','chi','star','bj') for m in selected) or period not in (3,5,10) or end and end>now_cst().date():
        raise HTTPException(422,'请选择有效市场及今天或之前的日期')
    return list_chase(conn,str(end) if end else None,selected,show_st,period)
