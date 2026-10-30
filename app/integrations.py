"""F10/F11 · 外部集成：大模型 BYOK + 飞书推送。

配置存储：直接挂在 user_prefs 子树（llm / feishu 键）——
零 migration，天然获得 F04 云同步（多端共享配置）。
api_key / webhook 属敏感凭据：单机自部署场景（PRD 关键决策「自部署零门槛」）
存 SQLite 明文与 .env 同级风险；对外契约永不回显完整 key（只回 key_set 布尔）。

飞书签名：webhook 可选加签（secret 非空时），
sign = base64(hmac_sha256(key=secret, msg=f"{ts}\n{secret}"))，body 带 timestamp+sign。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import time

import httpx

from .auth import service

_LLM_TIMEOUT = 15.0
_FEISHU_TIMEOUT = 10.0


# -- 配置读写（prefs 子树） ---------------------------------------------------
# get_* 返回存储全集（含 api_key/webhook/secret）——仅限服务端内部使用
# （连通测试、推送任务）；对外回显一律走 me.py 的 _llm_out/_feishu_out 布尔脱敏。

def get_llm(user_id: str) -> dict:
    return dict(service.get_prefs(user_id).get("llm") or {})


def put_llm(user_id: str, patch: dict) -> dict:
    cur = service.get_prefs(user_id).get("llm") or {}
    new = dict(cur)
    for k in ("base_url", "model"):
        if patch.get(k) is not None:
            new[k] = str(patch[k]).strip()
    key = patch.get("api_key")
    if key is not None:                    # None=不改；""=清除
        new["api_key"] = key.strip()
    if patch.get("enabled") is not None:
        new["enabled"] = bool(patch["enabled"])
    service.put_prefs(user_id, {"llm": new})
    return new


def get_feishu(user_id: str) -> dict:
    return dict(service.get_prefs(user_id).get("feishu") or {})


def put_feishu(user_id: str, patch: dict) -> dict:
    cur = service.get_prefs(user_id).get("feishu") or {}
    new = dict(cur)
    if patch.get("webhook_url") is not None:
        new["webhook_url"] = str(patch["webhook_url"]).strip()
    if patch.get("secret") is not None:
        new["secret"] = str(patch["secret"]).strip()
    if patch.get("enabled") is not None:
        new["enabled"] = bool(patch["enabled"])
    service.put_prefs(user_id, {"feishu": new})
    return new


# -- 飞书发送 -----------------------------------------------------------------

def _feishu_sign(secret: str, ts: int) -> str:
    string_to_sign = f"{ts}\n{secret}"
    digest = hmac.new(string_to_sign.encode("utf-8"), b"", hashlib.sha256).digest()
    return base64.b64encode(digest).decode("utf-8")


def feishu_send(webhook: str, secret: str, payload: dict) -> tuple[bool, str]:
    """发飞书自定义机器人消息。返回 (ok, 人话消息)。"""
    if not webhook:
        return False, "未配置 webhook 地址"
    body = dict(payload)
    if secret:
        ts = int(time.time())
        body["timestamp"] = str(ts)
        body["sign"] = _feishu_sign(secret, ts)
    try:
        r = httpx.post(webhook, json=body, timeout=_FEISHU_TIMEOUT)
        data = r.json()
    except Exception as e:
        return False, f"请求失败：{type(e).__name__}"
    if data.get("code") == 0:
        return True, "已送达飞书"
    return False, f"飞书返回错误：{data.get('msg') or data.get('code')}"


def feishu_text(text: str) -> dict:
    return {"msg_type": "text", "content": {"text": text}}


def feishu_card(title: str, lines: list[tuple[str, str]]) -> dict:
    """简单卡片：header + 多行 (label, value) markdown 字段。"""
    elements = [[
        {"tag": "div", "text": {
            "tag": "lark_md",
            "content": f"**{lbl}**\n{val}",
        }}
    ] for lbl, val in lines]
    return {
        "msg_type": "interactive",
        "card": {
            "header": {
                "title": {"tag": "plain_text", "content": title},
                "template": "blue",
            },
            "elements": elements,
        },
    }


# -- 大模型连通测试 ------------------------------------------------------------

def llm_test(base_url: str, api_key: str, model: str) -> tuple[bool, str]:
    """OpenAI 兼容 /chat/completions 连通测试（max_tokens=1 省钱）。"""
    url = base_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url += "/chat/completions"
    try:
        r = httpx.post(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": model, "messages": [{"role": "user", "content": "ping"}],
                  "max_tokens": 1},
            timeout=_LLM_TIMEOUT,
        )
    except Exception as e:
        return False, f"连接失败：{type(e).__name__}"
    if r.status_code == 200:
        return True, f"连接成功（{model}）"
    if r.status_code == 401:
        return False, "鉴权失败（401）— 检查 API Key"
    return False, f"HTTP {r.status_code}：{r.text[:120]}"


# -- 核心标推送内容 ------------------------------------------------------------

def corepicks_message(conn, date: str | None = None) -> dict | None:
    """最新核心标名单 → 飞书卡片 payload；名单为空返回 None。"""
    from .foundation.repo.corepicks import list_corepicks
    result = list_corepicks(conn, date=date, limit=30)
    items = result.get("items") or []
    if not items:
        return None
    by_pool: dict[str, list[dict]] = {}
    for it in items:
        by_pool.setdefault(str(it.get("pool") or "other"), []).append(it)
    pool_names = {"chase": "追涨池", "dip": "低吸池"}
    seg_names = {str(i): n for i, n in enumerate(
        ("一段", "二段", "三段", "四段", "五段", "六段"), start=1)}
    lines = []
    for pool, lst in by_pool.items():
        seg = " / ".join(
            f"{x.get('symbol','')} {x.get('name','')}"
            f"（{seg_names.get(str(x.get('seg')), '—')}）"
            for x in lst[:10])
        lines.append((pool_names.get(pool, pool), seg or "—"))
    title = f"驭潮核心标 · {result.get('date') or ''}"
    return feishu_card(title, lines)
