"""账户 / license 端点（M3）：注册登录 · VIP 激活 · vip.changed 广播。

鉴权约定（设计文档 07）：公开行情/板块/名单不强制登录；VIP 端点在服务端
脱敏（未授权不返回数据，而不是返回后靠前端隐藏）。
"""
import logging

from fastapi import APIRouter, Depends
from pydantic import TypeAdapter

from ...auth import deps, service
from ...auth.deps import resolve_token
from ...contracts.auth import (ActivationCode, CodesIn, LoginIn, RedeemIn,
                               RedeemOut, RegisterIn, TokenPair, UserPublic)
from ...config import settings
from ...errors import ApiError
from ...stream.bus import make_publisher

logger = logging.getLogger("yuchao.auth")
router = APIRouter(tags=["auth"])

_TYPE_USER = TypeAdapter(UserPublic)


@router.post("/auth/register", response_model=TokenPair, summary="注册（邮箱+密码）")
def register(body: RegisterIn):
    try:
        out = service.register(body.email, body.password, body.username)
    except service.AuthError as e:
        raise ApiError("auth_error", e.message, e.status_code)
    out["user"] = _TYPE_USER.validate_python(out["user"])
    return out


@router.post("/auth/login", response_model=TokenPair, summary="登录（邮箱或用户名）")
def login(body: LoginIn):
    try:
        out = service.login(body.identifier, body.password, body.remember)
    except service.AuthError as e:
        raise ApiError("auth_error", e.message, e.status_code)
    out["user"] = _TYPE_USER.validate_python(out["user"])
    return out


@router.get("/auth/me", response_model=UserPublic, summary="当前用户（tier 实时判定）")
def me(token: str | None = Depends(resolve_token)):
    try:
        user = deps.require_user(token)
    except ApiError:
        raise
    return _TYPE_USER.validate_python(user)


@router.post("/license/redeem", response_model=RedeemOut,
             summary="激活码兑换 VIP（一码一用，原子兑换）")
def redeem(body: RedeemIn, token: str | None = Depends(resolve_token)):
    user = deps.require_user(token)
    try:
        out = service.redeem_license(user["id"], body.code)
    except service.AuthError as e:
        raise ApiError("license_error", e.message, e.status_code)
    # vip.changed → license:{user_id} 频道（06.2 协议；支付核销/兑换/撤销触发）
    try:
        make_publisher().publish(
            f"license:{user['id']}", "vip.changed",
            {"status": out["tier"], "expires_at": out["pro_expires_at"],
             "plan": out["plan"]})
    except Exception:                      # 广播失败不影响兑换本身
        logger.debug("vip.changed 广播失败", exc_info=True)
    return TypeAdapter(RedeemOut).validate_python(out)


@router.post("/license/codes", response_model=list[ActivationCode],
             summary="生成激活码（admin）")
def create_codes(body: CodesIn, token: str | None = Depends(resolve_token)):
    deps.require_admin(deps.require_user(token))
    return TypeAdapter(list[ActivationCode]).validate_python(
        service.generate_codes(body.count, body.plan, body.duration_days))


@router.get("/license/codes", response_model=list[ActivationCode],
            summary="激活码列表（admin）")
def list_codes(limit: int = 100, token: str | None = Depends(resolve_token)):
    deps.require_admin(deps.require_user(token))
    return TypeAdapter(list[ActivationCode]).validate_python(
        service.list_codes(limit))
