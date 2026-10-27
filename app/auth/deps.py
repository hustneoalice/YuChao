"""鉴权依赖：令牌解析（header 或 query）→ 用户 → VIP/admin 门控。

EventSource 不支持自定义 header（设计文档 06.2）——SSE 的 JWT 走 query 参数，
同一解析函数两条路都吃。
"""
from fastapi import Query, Request

from ..errors import forbidden, unauthorized, vip_required
from . import service


def resolve_token(request: Request, token: str | None = Query(default=None)) -> str | None:
    """优先 Authorization: Bearer；回退 query ?token=（SSE 专用通道）。"""
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return token


def current_user(token: str | None = None) -> dict | None:
    """可选鉴权：无效/缺失返回 None（公开端点不因带错令牌而 500）。"""
    if not token:
        return None
    payload = service.decode_token(token)
    if not payload:
        return None
    return service.get_user(str(payload.get("sub") or ""))


def require_user(token: str | None = None) -> dict:
    user = current_user(token)
    if not user:
        raise unauthorized()
    return user


def require_vip(user: dict | None) -> dict:
    """VIP 门控（服务端脱敏语义）：匿名/无效令牌/过期一律 403 vip_required，
    不返回数据——不区分「没登录」与「非 VIP」，避免泄露授权状态。
    tier 以 SQLite 实时判定，令牌快照不算数（穿透测试面）。"""
    if not user or service.effective_tier(user) != "pro":
        raise vip_required("VIP 通道未授权：明细数据不返回（激活码兑换后可用）")
    return user


def require_admin(user: dict = None) -> dict:
    if user.get("role") != "admin":
        raise forbidden()
    return user
