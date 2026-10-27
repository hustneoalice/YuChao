"""账户与 license 服务（自 1.0 auth.py 提炼；PBKDF2 + JWT + 激活码原子兑换）。

安全约定：
- 密码哈希 PBKDF2-HMAC-SHA256（120k 轮，stdlib，零新增依赖）；
- JWT HS256，生产必须 YUCHAO_JWT_SECRET（多 worker 共享同一密钥）；
- tier 以 SQLite 为准实时判定（令牌里的 tier 只是快照）——VIP 过期即刻回落
  free，这就是「VIP 脱敏穿透测试」要打穿的面。
"""
import hashlib
import hmac
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import jwt

from ..config import settings
from .store import get_conn

logger = logging.getLogger("yuchao.auth")

ALGORITHM = "HS256"
PBKDF2_ITERATIONS = 120_000

EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,20}$")


class AuthError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        self.message = message
        self.status_code = status_code
        super().__init__(message)


# -- 密码与令牌 ------------------------------------------------------------

def hash_password(password: str, salt: str) -> str:
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITERATIONS)
    return dk.hex()


def issue_token(user_id: str, email: str, tier: str, role: str) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user_id), "email": email, "tier": tier, "role": role,
               "exp": now + timedelta(days=settings.token_ttl_days), "iat": now}
    return jwt.encode(payload, settings.jwt_secret, algorithm=ALGORITHM)


def decode_token(token: str) -> Optional[dict[str, Any]]:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        return None


# -- 账户 ------------------------------------------------------------------

def register(email: str, password: str, username: str | None = None) -> dict:
    email = (email or "").strip().lower()
    username = (username or "").strip() or None
    if not EMAIL_RE.match(email):
        raise AuthError("邮箱格式不正确")
    if username and not USERNAME_RE.match(username):
        raise AuthError("用户名格式不正确（3-20 位字母、数字、下划线）")
    if not password or len(password) < 8:
        raise AuthError("密码至少 8 位")

    conn = get_conn()
    try:
        if conn.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            raise AuthError("该邮箱已注册，请直接登录")
        if username and conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
            raise AuthError("该用户名已被使用")
        user_id = secrets.token_hex(8)
        salt = secrets.token_hex(16)
        conn.execute(
            "INSERT INTO users (id, email, username, password_hash, salt, tier, role, created_at) "
            "VALUES (?,?,?,?,?,'free','user',?)",
            (user_id, email, username, hash_password(password, salt), salt,
             datetime.now().isoformat(timespec="seconds")),
        )
        conn.commit()
    finally:
        conn.close()
    return {"token": issue_token(user_id, email, "free", "user"),
            "user": {"id": user_id, "email": email, "username": username,
                     "tier": "free", "role": "user"}}


def login(identifier: str, password: str) -> dict:
    identifier = (identifier or "").strip()
    is_email = bool(EMAIL_RE.match(identifier))
    if is_email:
        identifier = identifier.lower()
    conn = get_conn()
    try:
        col = "email" if is_email else "username"
        row = conn.execute(
            f"SELECT id, email, username, password_hash, salt, tier, pro_expires_at, role "
            f"FROM users WHERE {col}=?", (identifier,)).fetchone()
    finally:
        conn.close()
    if not row or not hmac.compare_digest(
            hash_password(password or "", row["salt"]), row["password_hash"]):
        raise AuthError("用户名/邮箱或密码错误", 401)
    user = _public_user(dict(row))
    return {"token": issue_token(row["id"], row["email"], user["tier"], user["role"]),
            "user": user}


def get_user(user_id: str) -> Optional[dict]:
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT id, email, username, tier, pro_expires_at, role, created_at "
            "FROM users WHERE id=?", (user_id,)).fetchone()
    finally:
        conn.close()
    return _public_user(dict(row)) if row else None


def effective_tier(user: dict) -> str:
    """VIP 过期自动回落 free（只读判断）。pro_expires_at 为空 = 永久 VIP。"""
    if user.get("tier") != "pro":
        return "free"
    raw = user.get("pro_expires_at")
    if raw in (None, ""):
        return "pro"
    try:
        exp = datetime.fromisoformat(str(raw))
    except ValueError:
        logger.warning("pro_expires_at 解析失败，按过期处理: %r", raw)
        return "free"
    return "pro" if exp > datetime.now() else "free"


def _public_user(row: dict) -> dict:
    tier = effective_tier(row)
    return {"id": row["id"], "email": row["email"], "username": row.get("username"),
            "tier": tier, "role": row.get("role") or "user",
            "pro_expires_at": row.get("pro_expires_at") if tier == "pro" else None,
            "created_at": row.get("created_at")}


# -- license（激活码） ------------------------------------------------------

def redeem_license(user_id: str, code: str) -> dict:
    code = (code or "").strip().upper()
    if not code:
        raise AuthError("请输入激活码")
    conn = get_conn()
    try:
        user = conn.execute(
            "SELECT id, tier, pro_expires_at FROM users WHERE id=?", (user_id,)).fetchone()
        if not user:
            raise AuthError("用户不存在", 401)
        # 原子兑换：仅当 status 仍为 unused 时占用，防并发「读后写」一码多用
        redeemed = conn.execute(
            "UPDATE licenses SET status='redeemed', redeemed_by=?, redeemed_at=? "
            "WHERE code=? AND status='unused' RETURNING plan, duration_days",
            (user_id, datetime.now().isoformat(timespec="seconds"), code)).fetchone()
        if not redeemed:
            if not conn.execute("SELECT 1 FROM licenses WHERE code=?", (code,)).fetchone():
                raise AuthError("激活码不存在")
            raise AuthError("该激活码已被使用")
        base = datetime.now()
        if effective_tier(dict(user)) == "pro":
            try:
                prev = datetime.fromisoformat(user["pro_expires_at"]) if user["pro_expires_at"] else None
                if prev and prev > base:
                    base = prev          # 续期：在剩余时长上累加
            except ValueError:
                pass
        new_expires = base + timedelta(days=redeemed["duration_days"])
        conn.execute("UPDATE users SET tier='pro', pro_expires_at=? WHERE id=?",
                     (new_expires.isoformat(), user_id))
        conn.commit()
    finally:
        conn.close()
    return {"tier": "pro", "pro_expires_at": new_expires.isoformat(),
            "plan": redeemed["plan"], "days": redeemed["duration_days"]}


def generate_codes(count: int = 1, plan: str = "pro_year", duration_days: int = 365) -> list[dict]:
    conn = get_conn()
    codes: list[dict] = []
    try:
        for _ in range(min(int(count), 100)):
            code = "YC-" + secrets.token_hex(4).upper() + "-" + secrets.token_hex(4).upper()
            conn.execute("INSERT INTO licenses (code, plan, duration_days, status) VALUES (?,?,?,'unused')",
                         (code, plan, int(duration_days)))
            codes.append({"code": code, "plan": plan, "duration_days": int(duration_days),
                          "status": "unused"})
        conn.commit()
    finally:
        conn.close()
    return codes


def list_codes(limit: int = 100) -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT code, plan, duration_days, status, redeemed_by, redeemed_at "
            "FROM licenses ORDER BY redeemed_at DESC, code LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()
