"""账户与 license 服务（自 1.0 auth.py 提炼；PBKDF2 + JWT + 激活码原子兑换）。

安全约定：
- 密码哈希 PBKDF2-HMAC-SHA256（120k 轮，stdlib，零新增依赖）；
- JWT HS256，生产必须 YUCHAO_JWT_SECRET（多 worker 共享同一密钥）；
- tier 以 SQLite 为准实时判定（令牌里的 tier 只是快照）——VIP 过期即刻回落
  free，这就是「VIP 脱敏穿透测试」要打穿的面。
"""
import hashlib
import hmac
import json
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


def issue_token(user_id: str, email: str, tier: str, role: str,
                ttl_days: int | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user_id), "email": email, "tier": tier, "role": role,
               "exp": now + timedelta(days=ttl_days or settings.token_ttl_days),
               "iat": now}
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


def login(identifier: str, password: str, remember: bool = True) -> dict:
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
    # 记住我：30 天；否则 1 天会话令牌（TradingView 同款语义）
    ttl = settings.token_ttl_days if remember else 1
    return {"token": issue_token(row["id"], row["email"], user["tier"], user["role"], ttl),
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


def list_users() -> list[dict]:
    """全部账户（最小字段）。飞书推送等批量遍历用。"""
    conn = get_conn()
    try:
        rows = conn.execute("SELECT id, email FROM users ORDER BY created_at").fetchall()
    finally:
        conn.close()
    return [{"id": r["id"], "email": r["email"]} for r in rows]


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


# -- F04 · 按用户设置云同步 -------------------------------------------------

PREFS_LIMIT = 64 * 1024                    # prefs_json 体积上限（防滥用）


def get_prefs(user_id: str) -> dict:
    conn = get_conn()
    try:
        row = conn.execute(
            "SELECT prefs_json FROM user_prefs WHERE user_id=?", (user_id,)).fetchone()
        return json.loads(row["prefs_json"]) if row else {}
    finally:
        conn.close()


def put_prefs(user_id: str, prefs: dict) -> dict:
    """深合并写入：部分键更新不影响其他键（多端并存）。"""
    def merge(base: dict, patch: dict) -> dict:
        out = dict(base)
        for k, v in (patch or {}).items():
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k] = merge(out[k], v)
            else:
                out[k] = v
        return out

    stored = merge(get_prefs(user_id), prefs)
    raw = json.dumps(stored, ensure_ascii=False)
    if len(raw) > PREFS_LIMIT:
        raise AuthError("偏好数据过大")
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO user_prefs (user_id, prefs_json) VALUES (?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET prefs_json=excluded.prefs_json",
            (user_id, raw))
        conn.commit()
    finally:
        conn.close()
    return stored


def get_watchlist(user_id: str) -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT symbol, name, group_id, created_at FROM watchlists "
            "WHERE user_id=? ORDER BY created_at DESC, symbol", (user_id,)).fetchall()
    finally:
        conn.close()
    return [{"symbol": r["symbol"], "name": r["name"] or r["symbol"],
             "group": r["group_id"] or "默认", "ts": r["created_at"]} for r in rows]


def put_watchlist(user_id: str, items: list[dict]) -> list[dict]:
    """整表替换（前端拥有状态，服务端只存）：≤500 条。"""
    if len(items) > 500:
        raise AuthError("自选最多 500 条")
    now = datetime.now().isoformat(timespec="seconds")
    rows = []
    seen: set[str] = set()
    for it in items:
        sym = str(it.get("symbol") or "").strip()
        if not sym or sym in seen:
            continue
        seen.add(sym)
        rows.append((user_id, sym, str(it.get("group") or "默认"),
                     str(it.get("name") or sym), now))
    conn = get_conn()
    try:
        conn.execute("BEGIN")
        conn.execute("DELETE FROM watchlists WHERE user_id=?", (user_id,))
        conn.executemany(
            "INSERT INTO watchlists (user_id, symbol, group_id, name, created_at) "
            "VALUES (?,?,?,?,?)", rows)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return get_watchlist(user_id)


def get_cards(user_id: str) -> list[dict]:
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT card_id, enabled, sort, mode FROM card_config "
            "WHERE user_id=? ORDER BY sort, card_id", (user_id,)).fetchall()
    finally:
        conn.close()
    return [{"card_id": r["card_id"], "enabled": bool(r["enabled"]),
             "sort": r["sort"], "mode": r["mode"] or "simple"} for r in rows]


def put_cards(user_id: str, items: list[dict]) -> list[dict]:
    if len(items) > 100:
        raise AuthError("卡片配置异常")
    conn = get_conn()
    try:
        conn.execute("BEGIN")
        conn.execute("DELETE FROM card_config WHERE user_id=?", (user_id,))
        conn.executemany(
            "INSERT INTO card_config (user_id, card_id, enabled, sort, mode) "
            "VALUES (?,?,?,?,?)",
            [(user_id, str(it["card_id"]), 1 if it.get("enabled", True) else 0,
              int(it.get("sort") or 0),
              "detailed" if it.get("mode") == "detailed" else "simple")
             for it in items])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return get_cards(user_id)
