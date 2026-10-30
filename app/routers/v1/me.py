"""F04/F10/F11 · 按用户设置端点：偏好 / 自选 / 功能卡 / 大模型 BYOK / 飞书推送。"""
from fastapi import APIRouter, Depends

from ...auth import deps, service
from ...auth.deps import resolve_token
from ...contracts.auth import (CardsIn, CardsOut, FeishuIn, FeishuOut, LlmIn,
                               LlmOut, PrefsIn, PrefsOut, TestOut,
                               WatchlistIn, WatchlistOut)
from ...errors import ApiError
from ... import integrations

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


# ── F11 · 大模型 BYOK（配置挂 prefs.llm，随 F04 云同步） ─────────────────

def _llm_out(cfg: dict) -> LlmOut:
    return LlmOut(base_url=cfg.get("base_url") or "", model=cfg.get("model") or "",
                  enabled=bool(cfg.get("enabled")),
                  key_set=bool(cfg.get("api_key")))


@router.get("/me/llm", response_model=LlmOut, summary="大模型 BYOK 配置（key 不回显）")
def get_llm(user: dict = Depends(_user)):
    return _llm_out(integrations.get_llm(user["id"]))


@router.put("/me/llm", response_model=LlmOut, summary="写入大模型配置（api_key 传空串清除）")
def put_llm(body: LlmIn, user: dict = Depends(_user)):
    cfg = integrations.put_llm(user["id"], body.model_dump())
    return _llm_out(cfg)


@router.post("/me/llm/test", response_model=TestOut, summary="大模型连通测试（chat/completions）")
def test_llm(user: dict = Depends(_user)):
    """用已保存配置实测一次（max_tokens=1）。key 不回显 → 修改 key 后请先 PUT 再测试。"""
    cfg = integrations.get_llm(user["id"])
    ok, msg = integrations.llm_test(
        cfg.get("base_url") or "", cfg.get("api_key") or "", cfg.get("model") or "")
    return TestOut(ok=ok, message=msg)


# ── F10 · 飞书推送（配置挂 prefs.feishu） ─────────────────────────────────

def _feishu_out(cfg: dict) -> FeishuOut:
    return FeishuOut(enabled=bool(cfg.get("enabled")),
                     webhook_set=bool(cfg.get("webhook_url")),
                     has_secret=bool(cfg.get("secret")))


@router.get("/me/feishu", response_model=FeishuOut, summary="飞书推送配置（webhook 不回显）")
def get_feishu(user: dict = Depends(_user)):
    return _feishu_out(integrations.get_feishu(user["id"]))


@router.put("/me/feishu", response_model=FeishuOut, summary="写入飞书推送配置")
def put_feishu(body: FeishuIn, user: dict = Depends(_user)):
    cfg = integrations.put_feishu(user["id"], body.model_dump())
    return _feishu_out(cfg)


@router.post("/me/feishu/test", response_model=TestOut, summary="发送飞书测试消息")
def test_feishu(user: dict = Depends(_user)):
    cfg = integrations.get_feishu(user["id"])
    ok, msg = integrations.feishu_send(
        cfg.get("webhook_url") or "", cfg.get("secret") or "",
        integrations.feishu_text("驭潮 · 飞书推送测试消息 ✅"))
    return TestOut(ok=ok, message=msg)
