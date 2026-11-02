#!/usr/bin/env python
"""创建/提权应用管理员账号（幂等）。

项目本身没有默认管理员：/auth/register 只会产生 role=user 的普通账户，
管理员是把 users 表里的 role 改成 admin（并给永久 VIP）。服务器部署后
用户库是空的，所以先用本脚本建一个管理员再登录网页。

用法（在服务器项目根目录）：
  .venv/bin/python scripts/create_admin.py \
      --email you@example.com --username you --password '你的密码'

已存在同邮箱/用户名时：更新密码并提权为 admin + 永久 VIP。
"""
import argparse
import secrets
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.auth.store import SCHEMA, _migrate  # noqa: E402
from app.auth.service import EMAIL_RE, USERNAME_RE, hash_password  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="创建或提权管理员")
    ap.add_argument("--email", required=True)
    ap.add_argument("--username", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--userdb", default=str(ROOT / "data/users.sqlite3"))
    a = ap.parse_args()

    email = a.email.strip().lower()
    username = a.username.strip()
    if not EMAIL_RE.match(email):
        print("邮箱格式不正确", file=sys.stderr)
        return 2
    if not USERNAME_RE.match(username):
        print("用户名需 3-20 位字母、数字、下划线", file=sys.stderr)
        return 2
    if len(a.password) < 8:
        print("密码至少 8 位", file=sys.stderr)
        return 2

    path = Path(a.userdb)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    _migrate(conn)

    salt = secrets.token_hex(16)
    pw_hash = hash_password(a.password, salt)
    row = conn.execute(
        "SELECT id FROM users WHERE email=? OR username=?", (email, username)).fetchone()
    if row:
        conn.execute(
            "UPDATE users SET email=?, username=?, password_hash=?, salt=?, "
            "tier='pro', pro_expires_at=NULL, role='admin' WHERE id=?",
            (email, username, pw_hash, salt, row["id"]))
        action = "已提权为管理员（密码已更新）"
    else:
        conn.execute(
            "INSERT INTO users (id,email,username,password_hash,salt,tier,pro_expires_at,"
            "role,created_at) VALUES (?,?,?,?,?,'pro',NULL,'admin',?)",
            (secrets.token_hex(8), email, username, pw_hash, salt,
             datetime.now().isoformat(timespec="seconds")))
        action = "已创建管理员"
    conn.commit()
    conn.close()
    print(f"{action}：{username} / {email}（永久 VIP）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
