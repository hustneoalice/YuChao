"""账户/license 契约（M3）。"""
from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class RegisterIn(BaseModel):
    email: str = Field(..., description="邮箱（登录标识）")
    password: str = Field(..., description="密码 ≥8 位（服务层校验）")
    username: Optional[str] = Field(None, description="用户名（3-20 位字母数字下划线，可空）")


class LoginIn(BaseModel):
    identifier: str = Field(..., description="邮箱或用户名")
    password: str = Field(...)
    remember: bool = Field(True, description="记住我：30 天令牌；否则 1 天")


class UserPublic(BaseModel):
    id: str
    email: str
    username: Optional[str] = None
    tier: str                                  # free | pro（实时判定，非令牌快照）
    role: str
    pro_expires_at: Optional[datetime] = None
    created_at: Optional[datetime] = None


class TokenPair(BaseModel):
    token: str
    user: UserPublic


class RedeemIn(BaseModel):
    code: str = Field(..., description="激活码（YC-XXXX-XXXX）")


class RedeemOut(BaseModel):
    tier: str
    pro_expires_at: datetime
    plan: str
    days: int


class CodesIn(BaseModel):
    count: int = Field(1, ge=1, le=100)
    plan: str = "pro_year"
    duration_days: int = Field(365, ge=1, le=3650)


class ActivationCode(BaseModel):
    code: str
    plan: str
    duration_days: int
    status: str
    redeemed_by: Optional[str] = None
    redeemed_at: Optional[datetime] = None


# ── F04 · 按用户设置云同步 ────────────────────────────────────────────────

class PrefsIn(BaseModel):
    prefs: dict = Field(..., description="偏好键值（深合并写入）")


class PrefsOut(BaseModel):
    prefs: dict


class WatchItem(BaseModel):
    symbol: str = Field(..., max_length=16)
    name: str = ""
    group: str = "默认"
    ts: Optional[str] = None                 # ISO 时间（None 则服务端补）


class WatchlistIn(BaseModel):
    items: list[WatchItem] = Field(..., max_length=500)


class WatchlistOut(BaseModel):
    items: list[WatchItem]


class CardItem(BaseModel):
    card_id: str = Field(..., max_length=32)
    enabled: bool = True
    sort: int = 0
    mode: str = "simple"                     # simple | detailed


class CardsIn(BaseModel):
    items: list[CardItem]


class CardsOut(BaseModel):
    items: list[CardItem]
