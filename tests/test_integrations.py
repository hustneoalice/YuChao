"""F10/F11 · 大模型 BYOK + 飞书推送：配置读写、key 不回显、鉴权门控、测试端点。"""
import httpx
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


def _auth(client) -> dict:
    r = client.post("/api/v1/auth/register",
                    json={"email": "byok@yuchao.dev", "password": "password8"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


# ---------------------------------------------------------------------------
# F11 · 大模型 BYOK
# ---------------------------------------------------------------------------

def test_llm_config_roundtrip_and_key_never_echoed(userdb, client):
    h = _auth(client)
    assert client.get("/api/v1/me/llm", headers=h).json() == {
        "base_url": "", "model": "", "enabled": False, "key_set": False}
    r = client.put("/api/v1/me/llm", headers=h, json={
        "base_url": "https://api.example.com/v1", "api_key": "sk-secret-123",
        "model": "glm-4", "enabled": True})
    assert r.status_code == 200
    body = r.json()
    assert body["key_set"] is True and body["enabled"] is True
    assert "sk-secret" not in r.text                    # key 永不回显
    # 部分更新：只改 model，key 保留
    r = client.put("/api/v1/me/llm", headers=h, json={"model": "glm-5"})
    assert r.json()["model"] == "glm-5" and r.json()["key_set"] is True
    # key 清除：传空串
    r = client.put("/api/v1/me/llm", headers=h, json={"api_key": ""})
    assert r.json()["key_set"] is False


def test_llm_config_requires_auth(userdb, client):
    assert client.get("/api/v1/me/llm").status_code == 401
    assert client.put("/api/v1/me/llm", json={"enabled": True}).status_code == 401


def test_llm_test_endpoint(userdb, client, monkeypatch):
    h = _auth(client)
    client.put("/api/v1/me/llm", headers=h, json={
        "base_url": "https://api.example.com/v1", "api_key": "sk-x",
        "model": "glm-4", "enabled": True})
    captured = {}

    def fake_test(base_url, api_key, model):
        captured.update(base_url=base_url, api_key=api_key, model=model)
        return True, f"连接成功（{model}）"

    monkeypatch.setattr("app.routers.v1.me.integrations.llm_test", fake_test)
    r = client.post("/api/v1/me/llm/test", headers=h)
    assert r.status_code == 200 and r.json()["ok"] is True
    assert captured == {"base_url": "https://api.example.com/v1",
                        "api_key": "sk-x", "model": "glm-4"}


def test_llm_test_real_request_shape(userdb, client, monkeypatch):
    """llm_test 的真实 HTTP 契约：Bearer 头 + max_tokens=1 + 根地址自动补路径。"""
    h = _auth(client)
    calls = []

    def fake_post(url, **kw):
        calls.append({"url": url, "headers": kw.get("headers"),
                      "json": kw.get("json")})

        class R:
            status_code = 200

            def json(self):
                return {}
        return R()

    monkeypatch.setattr(httpx, "post", fake_post)
    from app import integrations
    ok, msg = integrations.llm_test("https://api.x.com/v1", "sk-y", "glm-4")
    assert ok and calls[0]["url"] == "https://api.x.com/v1/chat/completions"
    assert calls[0]["headers"]["Authorization"] == "Bearer sk-y"
    assert calls[0]["json"]["max_tokens"] == 1


# ---------------------------------------------------------------------------
# F10 · 飞书推送
# ---------------------------------------------------------------------------

def test_feishu_config_roundtrip_no_echo(userdb, client):
    h = _auth(client)
    hook = "https://open.feishu.cn/open-apis/bot/v2/hook/abc-123"
    r = client.put("/api/v1/me/feishu", headers=h, json={
        "webhook_url": hook, "secret": "sec-999", "enabled": True})
    assert r.status_code == 200 and r.json() == {
        "enabled": True, "webhook_set": True, "has_secret": True}
    assert "abc-123" not in r.text and "sec-999" not in r.text
    # secret 清除
    r = client.put("/api/v1/me/feishu", headers=h, json={"secret": ""})
    assert r.json()["has_secret"] is False


def test_feishu_test_endpoint(userdb, client, monkeypatch):
    h = _auth(client)
    client.put("/api/v1/me/feishu", headers=h, json={
        "webhook_url": "https://open.feishu.cn/hook/x", "enabled": True})
    seen = {}

    def fake_send(webhook, secret, payload):
        seen.update(webhook=webhook, payload=payload)
        return True, "已送达飞书"

    monkeypatch.setattr("app.routers.v1.me.integrations.feishu_send", fake_send)
    r = client.post("/api/v1/me/feishu/test", headers=h)
    assert r.json()["ok"] is True and seen["webhook"] == "https://open.feishu.cn/hook/x"


def test_feishu_sign_and_card_payload(userdb, client, monkeypatch):
    """加签契约：timestamp+sign 注入 body；卡片结构合法。"""
    h = _auth(client)
    bodies = []

    class R:
        status_code = 200

        def json(self):
            return {"code": 0, "msg": "success"}

    monkeypatch.setattr(httpx, "post",
                        lambda url, json=None, timeout=None: bodies.append(json) or R())
    from app import integrations
    ok, msg = integrations.feishu_send("https://hook", "mysecret",
                                       integrations.feishu_text("hi"))
    assert ok
    b = bodies[0]
    assert b["timestamp"] and b["sign"] and b["content"]["text"] == "hi"
    # 无签模式：不注入
    ok, _ = integrations.feishu_send("https://hook", "", integrations.feishu_text("hi"))
    assert ok and "sign" not in bodies[1]
    # 卡片
    card = integrations.feishu_card("标题", [("追涨池", "600519 贵州茅台")])
    assert card["msg_type"] == "interactive"
    assert card["card"]["header"]["title"]["content"] == "标题"


def test_corepicks_message_from_fixture_data(userdb, client, duckdb_file,
                                             monkeypatch):
    """夹具库含核心标数据 → 组装出卡片；日期与名单来自库内最新结果日。"""
    monkeypatch.setattr(settings, "duckdb_path", duckdb_file)
    from app.foundation.db import open_conn
    from app import integrations
    conn = open_conn()
    try:
        card = integrations.corepicks_message(conn)
    finally:
        conn.close()
    assert card is not None
    assert card["msg_type"] == "interactive"
    title = card["card"]["header"]["title"]["content"]
    assert title.startswith("驭潮核心标 · ")
    text = str(card["card"]["elements"])
    assert "600519" in text                      # 夹具数据里的追涨池标的
