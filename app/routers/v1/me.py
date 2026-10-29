"""F04 · 按用户设置云同步端点：偏好 / 自选 / 功能卡（require_user）。"""
from fastapi import APIRouter, Depends

from ...auth import deps, service
from ...auth.deps import resolve_token
from ...contracts.auth import (CardsIn, CardsOut, PrefsIn, PrefsOut,
                               WatchlistIn, WatchlistOut)
from ...errors import ApiError

router = APIRouter(tags=["me"])


def _user(token: str | None = Depends(resolve_token)) -> dict:
    return deps.require_user(token)


@router.get("/me/prefs", response_model=PrefsOut, summary="当前用户偏好")
def get_prefs(user: dict = Depends(_user)):
    return PrefsOut(prefs=service.get_prefs(user["id"]))


@router.put("/me/prefs", response_model=PrefsOut, summary="写入偏好（深合并）")
def put_prefs(body: PrefsIn, user: dict = Depends(_user)):
    try:
        stored = service.put_prefs(user["id"], body.prefs)
    except service.AuthError as e:
        raise ApiError("prefs_error", e.message, e.status_code)
    return PrefsOut(prefs=stored)


@router.get("/me/watchlist", response_model=WatchlistOut, summary="云端自选列表")
def get_watchlist(user: dict = Depends(_user)):
    return WatchlistOut(items=service.get_watchlist(user["id"]))


@router.put("/me/watchlist", response_model=WatchlistOut,
            summary="整表替换云端自选（≤500）")
def put_watchlist(body: WatchlistIn, user: dict = Depends(_user)):
    try:
        items = service.put_watchlist(user["id"], [i.model_dump() for i in body.items])
    except service.AuthError as e:
        raise ApiError("watchlist_error", e.message, e.status_code)
    return WatchlistOut(items=items)  # type: ignore[arg-type]


@router.get("/me/cards", response_model=CardsOut, summary="云端功能卡配置")
def get_cards(user: dict = Depends(_user)):
    return CardsOut(items=service.get_cards(user["id"]))


@router.put("/me/cards", response_model=CardsOut, summary="整表替换功能卡配置")
def put_cards(body: CardsIn, user: dict = Depends(_user)):
    try:
        items = service.put_cards(user["id"], [i.model_dump() for i in body.items])
    except service.AuthError as e:
        raise ApiError("cards_error", e.message, e.status_code)
    return CardsOut(items=items)
