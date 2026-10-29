"""F04 · 按用户设置云同步：偏好深合并 · 自选/卡片整表替换 · 鉴权门控。"""
import pytest

from app.auth import store
from app.config import settings


@pytest.fixture()
def userdb(tmp_path, monkeypatch):
    from app.auth import store as s
    monkeypatch.setattr(settings, "userdb_path", tmp_path / "users.sqlite3")
    monkeypatch.setattr(settings, "stream_events_path", tmp_path / "events.jsonl")
    s._init_for = None
    yield
    s._init_for = None


def _token(client) -> str:
    r = client.post("/api/v1/auth/register",
                    json={"email": "sync@yuchao.dev", "password": "password8"})
    return r.json()["token"]


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_prefs_roundtrip_and_deep_merge(userdb, client):
    token = _token(client)
    h = _auth(token)
    assert client.get("/api/v1/me/prefs", headers=h).json() == {"prefs": {}}
    r = client.put("/api/v1/me/prefs", headers=h,
                   json={"prefs": {"theme": "dark", "k": {"a": 1}}})
    assert r.status_code == 200 and r.json()["prefs"]["theme"] == "dark"
    # 深合并：第二次只写部分键，其余保留
    r = client.put("/api/v1/me/prefs", headers=h,
                   json={"prefs": {"k": {"b": 2}, "accent": "teal"}})
    prefs = r.json()["prefs"]
    assert prefs["theme"] == "dark" and prefs["k"] == {"a": 1, "b": 2}

    # 未登录 401
    assert client.get("/api/v1/me/prefs").status_code == 401
    # 无效令牌 401
    assert client.get("/api/v1/me/prefs",
                      headers={"Authorization": "Bearer bad"}).status_code == 401


def test_watchlist_replace_and_isolation(userdb, client):
    t1 = _token(client)
    r = client.post("/api/v1/auth/register",
                    json={"email": "u2@yuchao.dev", "password": "password8"})
    t2 = r.json()["token"]

    items = [{"symbol": "600519.SH", "name": "贵州茅台", "group": "白酒"},
             {"symbol": "000001.SH", "name": "上证指数", "group": "默认"},
             {"symbol": "600519.SH", "name": "重复项应去重"}]
    r = client.put("/api/v1/me/watchlist", headers=_auth(t1), json={"items": items})
    assert r.status_code == 200
    got = r.json()["items"]
    assert len(got) == 2                            # 重复 symbol 去重
    by_sym = {i["symbol"]: i for i in got}
    assert by_sym["600519.SH"]["group"] == "白酒"
    assert by_sym["000001.SH"]["name"] == "上证指数"

    # 用户隔离：u2 为空
    assert client.get("/api/v1/me/watchlist", headers=_auth(t2)).json()["items"] == []
    # 整表替换：删一个 → 只剩 1 条
    r = client.put("/api/v1/me/watchlist", headers=_auth(t1),
                   json={"items": [{"symbol": "600519.SH", "name": "贵州茅台"}]})
    assert len(r.json()["items"]) == 1
    # 超限 500 → 400（422 由 pydantic 先拦 500+，这里恰好 500 条上限边界）
    assert client.put("/api/v1/me/watchlist", headers=_auth(t1),
                      json={"items": [{"symbol": f"s{i:03d}.SZ"} for i in range(501)]}
                      ).status_code == 422
    # 未登录 401
    assert client.put("/api/v1/me/watchlist", json={"items": []}).status_code == 401


def test_cards_roundtrip(userdb, client):
    token = _token(client)
    h = _auth(token)
    items = [{"card_id": "info", "enabled": True, "sort": 0, "mode": "detailed"},
             {"card_id": "moneyflow", "enabled": False, "sort": 1}]
    r = client.put("/api/v1/me/cards", headers=h, json={"items": items})
    assert r.status_code == 200
    got = {i["card_id"]: i for i in r.json()["items"]}
    assert got["info"]["mode"] == "detailed" and got["info"]["enabled"] is True
    assert got["moneyflow"]["enabled"] is False and got["moneyflow"]["mode"] == "simple"
    # 回读一致
    again = client.get("/api/v1/me/cards", headers=h).json()["items"]
    assert len(again) == 2
    # 未登录 401
    assert client.get("/api/v1/me/cards").status_code == 401


def test_login_remember_token_ttl(userdb, client):
    """记住我：默认 30 天；remember=False → 1 天令牌。"""
    import jwt as pyjwt
    from app.auth import service as svc

    client.post("/api/v1/auth/register",
                json={"email": "ttl@yuchao.dev", "password": "password8"})
    long_r = client.post("/api/v1/auth/login",
                         json={"identifier": "ttl@yuchao.dev", "password": "password8"})
    short_r = client.post("/api/v1/auth/login",
                          json={"identifier": "ttl@yuchao.dev",
                                "password": "password8", "remember": False})
    lt = pyjwt.decode(long_r.json()["token"], options={"verify_signature": False})
    st = pyjwt.decode(short_r.json()["token"], options={"verify_signature": False})
    assert (lt["exp"] - lt["iat"]) == pytest.approx(settings.token_ttl_days * 86400)
    assert (st["exp"] - st["iat"]) == pytest.approx(86400)
    # store 列迁移存在（name / mode）
    conn = store.get_conn()
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(watchlists)")}
    assert "name" in cols
    conn.close()
