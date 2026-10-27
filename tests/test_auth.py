"""M3 用户态 / license：注册登录 · VIP 穿透 · 激活码 · SSE license 频道鉴权。"""
import json

import pytest

from app.auth import service, store
from app.config import settings


@pytest.fixture()
def userdb(tmp_path, monkeypatch):
    """用户态与事件流都指向临时目录（不污染仓库 data/）。"""
    from app.auth import store as s
    monkeypatch.setattr(settings, "userdb_path", tmp_path / "users.sqlite3")
    monkeypatch.setattr(settings, "stream_events_path", tmp_path / "events.jsonl")
    s._init_for = None
    yield
    s._init_for = None


def _make_admin():
    import secrets
    from datetime import datetime
    salt = secrets.token_hex(16)
    conn = store.get_conn()
    conn.execute(
        "INSERT INTO users (id, email, username, password_hash, salt, tier, "
        "pro_expires_at, role, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("admin01", "admin@yuchao.dev", None, service.hash_password("admin-pass-1", salt),
         salt, "pro", None, "admin", datetime.now().isoformat(timespec="seconds")))
    conn.commit()
    conn.close()


def test_register_login_me(userdb, client):
    r = client.post("/api/v1/auth/register",
                    json={"email": "neo@yuchao.dev", "password": "password8"})
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["tier"] == "free" and body["user"]["email"] == "neo@yuchao.dev"
    token = body["token"]

    r = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200 and r.json()["tier"] == "free"

    # 重复注册 / 弱密码 / 坏邮箱
    assert client.post("/api/v1/auth/register",
                       json={"email": "neo@yuchao.dev", "password": "password8"}
                       ).json()["code"] == "auth_error"
    assert client.post("/api/v1/auth/register",
                       json={"email": "x@y.com", "password": "short"}
                       ).status_code == 400
    # 错误密码 → 401；正确密码登录（用户名/邮箱均可）
    assert client.post("/api/v1/auth/login",
                       json={"identifier": "neo@yuchao.dev", "password": "wrong-pass"}
                       ).status_code == 401
    assert client.post("/api/v1/auth/login",
                       json={"identifier": "neo@yuchao.dev", "password": "password8"}
                       ).status_code == 200
    # 无令牌 me → 401
    assert client.get("/api/v1/auth/me").status_code == 401


def test_vip_flow_and_penetration(userdb, duckdb_file, client, tmp_path):
    """激活码全链路 + VIP 脱敏穿透：未授权 403 → 兑换后 200 → 过期回落 403。"""
    _make_admin()
    admin = client.post("/api/v1/auth/login",
                        json={"identifier": "admin@yuchao.dev",
                              "password": "admin-pass-1"}).json()
    # 非 admin 生成激活码 → 403
    user = client.post("/api/v1/auth/register",
                       json={"email": "vip@yuchao.dev", "password": "password8"}).json()
    assert client.post("/api/v1/license/codes", json={"count": 1},
                       headers={"Authorization": f"Bearer {user['token']}"}
                       ).status_code == 403
    codes = client.post("/api/v1/license/codes", json={"count": 1},
                        headers={"Authorization": f"Bearer {admin['token']}"})
    assert codes.status_code == 200
    code = codes.json()[0]["code"]

    # 未授权：三因子明细不返回数据（403 vip_required）
    no_auth = client.get("/api/v1/corepicks/600519/factors")
    assert no_auth.status_code == 403 and no_auth.json()["code"] == "vip_required"

    # 兑换（原子，一码一用）：第二个请求消费同码 → 失败
    r1 = client.post("/api/v1/license/redeem", json={"code": code},
                     headers={"Authorization": f"Bearer {user['token']}"})
    assert r1.status_code == 200 and r1.json()["tier"] == "pro"
    r2 = client.post("/api/v1/license/redeem", json={"code": code},
                     headers={"Authorization": f"Bearer {user['token']}"})
    assert r2.status_code == 400 and "已被使用" in r2.json()["message"]

    # 授权后：VIP 端点返回真实因子
    ok = client.get("/api/v1/corepicks/600519/factors?pool=chase",
                    headers={"Authorization": f"Bearer {user['token']}"})
    assert ok.status_code == 200
    assert ok.json()["factors"] == {"trend": 0.82, "volume": 0.77, "position": 0.91}

    # 穿透：令牌仍是兑换时签发的（tier 快照），但库里改过期 → 立即 403
    conn = store.get_conn()
    conn.execute("UPDATE users SET pro_expires_at='2020-01-01T00:00:00' WHERE id=?",
                 (user["user"]["id"],))
    conn.commit()
    conn.close()
    expired = client.get("/api/v1/corepicks/600519/factors?pool=chase",
                         headers={"Authorization": f"Bearer {user['token']}"})
    assert expired.status_code == 403

    # vip.changed 广播：license:{uid} 频道（06.2 协议）
    events_file = tmp_path / "events.jsonl"
    recs = [json.loads(x) for x in events_file.read_text().splitlines() if x.strip()]
    vip_events = [r for r in recs if r["channel"] == f"license:{user['user']['id']}"
                  and r["event"] == "vip.changed"]
    assert vip_events and vip_events[0]["data"]["status"] == "pro"


def test_sse_license_channel_ownership(userdb, client):
    """license:{user_id} 频道属主校验：无 token 401 / 他人 token 403 / 本人可达。"""
    u1 = client.post("/api/v1/auth/register",
                     json={"email": "u1@yuchao.dev", "password": "password8"}).json()
    u2 = client.post("/api/v1/auth/register",
                     json={"email": "u2@yuchao.dev", "password": "password8"}).json()
    ch = f"license:{u1['user']['id']}"
    assert client.get(f"/api/v1/stream/sse?channels={ch}").status_code == 401
    assert client.get(f"/api/v1/stream/sse?channels={ch}&token={u2['token']}"
                      ).status_code == 403
    with client.stream("GET",
                       f"/api/v1/stream/sse?channels={ch}&token={u1['token']}") as r:
        assert r.status_code == 200
        first = next(r.iter_raw())           # retry 帧立即下发
        assert b"retry:" in first


def test_sse_public_channel_no_auth(userdb, client):
    """公开频道不需要令牌（行为数据不脱敏）。"""
    with client.stream("GET", "/api/v1/stream/sse?channels=data:update") as r:
        assert r.status_code == 200
        assert b"retry:" in next(r.iter_raw())
