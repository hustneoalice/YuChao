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
import re
import time

import httpx

from .auth import service

_LLM_TIMEOUT = 15.0
_FEISHU_TIMEOUT = 10.0
MAX_PUSH_TIMES = 12          # 每天最多推送时段数（防误配 + prefs 体积）
_TIME_RE = re.compile(r"^(\d{1,2}):(\d{2})$")


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


def normalize_times(raw) -> list[str]:
    """时间点规整：接受列表或逗号/分号/空白分隔的字符串，去重升序，最多 12 个。

    非法项静默丢弃（前端已提示，后端仍兜底——prefs 可被其他端直接写入）。
    """
    if isinstance(raw, str):
        raw = re.split(r"[,，;；\s]+", raw)
    out = set()
    for item in raw or ():
        m = _TIME_RE.match(str(item).strip())
        if not m:
            continue
        h, mi = int(m.group(1)), int(m.group(2))
        if 0 <= h <= 23 and 0 <= mi <= 59:
            out.add(f"{h:02d}:{mi:02d}")
    return sorted(out)[:MAX_PUSH_TIMES]


def put_feishu(user_id: str, patch: dict) -> dict:
    cur = service.get_prefs(user_id).get("feishu") or {}
    new = dict(cur)
    if patch.get("webhook_url") is not None:
        new["webhook_url"] = str(patch["webhook_url"]).strip()
    if patch.get("secret") is not None:
        new["secret"] = str(patch["secret"]).strip()
    if patch.get("enabled") is not None:
        new["enabled"] = bool(patch["enabled"])
    if patch.get("push_enabled") is not None:
        new["push_enabled"] = bool(patch["push_enabled"])
    if patch.get("push_times") is not None:
        new["push_times"] = normalize_times(patch["push_times"])
    service.put_prefs(user_id, {"feishu": new})
    return new


def mark_feishu_pushed(user_id: str, marker: str) -> None:
    """记一个「YYYY-MM-DD HH:MM」时段标记：同一时段重复 tick 不再推送。"""
    cfg = get_feishu(user_id)
    cfg["push_last"] = marker
    service.put_prefs(user_id, {"feishu": cfg})


def due_push_users(slot: str, day: str) -> list[dict]:
    """该分钟到期、且当日该时段尚未推送过的用户（webhook + 开关 + 时间点）。

    只读 SQLite prefs：调度器每分钟轻量探测，不碰 DuckDB / 不发网络请求。
    """
    out = []
    for u in service.list_users():
        cfg = get_feishu(u["id"])
        if not cfg.get("push_enabled") or not cfg.get("webhook_url"):
            continue
        if slot not in normalize_times(cfg.get("push_times")):
            continue
        if str(cfg.get("push_last") or "") == f"{day} {slot}":
            continue
        out.append({"id": u["id"], "email": u.get("email") or "", **cfg})
    return out


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


def feishu_card(title: str, lines: list[tuple[str, str]],
                template: str = "blue") -> dict:
    """简单卡片：header + 多行 (label, value) markdown 字段。"""
    elements = [
        {"tag": "div", "text": {
            "tag": "lark_md",
            "content": f"**{lbl}**\n{val}",
        }}
        for lbl, val in lines
    ]
    return {
        "msg_type": "interactive",
        "card": {
            "header": {
                "title": {"tag": "plain_text", "content": title},
                "template": template,
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
        ("超跌", "反弹", "突破", "超涨", "回踩", "跌破"), start=1)}
    lines = []
    for pool, lst in by_pool.items():
        seg = " / ".join(
            f"{x.get('symbol','')} {x.get('name','')}"
            f"（{seg_names.get(str(x.get('seg')), '—')}）"
            for x in lst[:10])
        lines.append((pool_names.get(pool, pool), seg or "—"))
    title = f"驭潮核心标 · {result.get('date') or ''}"
    return feishu_card(title, lines)


# -- 两点乾坤推送内容 ----------------------------------------------------------

_LD_MAX = 20            # 卡片最多逐只展示 20 条（超出只报数量）


def _fmt(v, pattern: str) -> str:
    try:
        return pattern % float(v)
    except (TypeError, ValueError):
        return "—"


def liangdian_message(conn, slot: str = "") -> dict | None:
    """两点乾坤：趋势柱线当日上穿零轴（STICKV 负转正）+ 中线趋势橙（站上 MA45）。

    盘中（当日 K 线尚未落库）时，用 market_snapshot 合成当日临时日线，只对
    「中线橙 + 昨日负柱」候选重算 STICKV，才能识别「今日上穿」；收盘后直接
    读 target_trend 预计算表。无命中返回 None（不发空消息打扰用户）。
    """
    from .foundation.repo import market as repo

    rows, meta = repo.stock_targets_universe(conn)
    trends = repo.stock_target_trends(conn)
    trend_as_of = str(meta.get("trend_as_of") or meta.get("as_of") or "")
    live = bool(meta.get("provisional"))            # 快照日比日线新 = 盘中口径
    target_date = str(meta.get("as_of") or "") if live else trend_as_of
    if live:
        cand = [r["symbol"] for r in rows if r.get("mid_orange")
                and (trends.get(r["symbol"]) or {}).get("trend_value") is not None
                and (trends.get(r["symbol"]) or {}).get("trend_value") <= 0]
        live_trends = repo.market.live_trend_summaries(conn, cand)
        if live_trends:
            trends = {**trends, **live_trends}
        else:                                       # 快照不可用：退回日线口径
            live, target_date = False, trend_as_of
    hits = []
    for row in rows:
        if not row.get("mid_orange"):
            continue
        t = trends.get(row["symbol"]) or {}
        if t.get("trend_data_date") != target_date:
            continue
        if t.get("trend_cross_ago") != 0 or (t.get("trend_value") or 0) <= 0:
            continue                           # 只认「当日刚刚上穿零轴」
        hits.append({**row, **t})
    if not hits:
        return None
    hits.sort(key=lambda x: (-repo.market.SEG_RANK.get(x.get("seg") or 0, 0),
                             -(x.get("pct_chg") or 0)))

    lines: list[tuple[str, str]] = [(
        f"命中 {len(hits)} 只 · 数据截至 {target_date}"
        + ("（盘中实时口径）" if live else ""),
        "趋势柱线当日上穿零轴 + 中线趋势橙（站上中线趋势线）",
    )]
    for i, t in enumerate(hits[:_LD_MAX], start=1):
        seg = f"第{t.get('seg')}段·{t.get('seg_name') or ''}"
        lines.append((
            f"{i}. {t.get('name') or ''} {t.get('symbol') or ''}",
            f"{seg} ｜ {_fmt(t.get('close'), '%.2f')} · {_fmt(t.get('pct_chg'), '%+.2f%%')}"
            f" ｜ STICKV {_fmt(t.get('trend_value'), '%+.1f')}",
        ))
    if len(hits) > _LD_MAX:
        lines.append(("…", f"另有 {len(hits) - _LD_MAX} 只未展示"))
    title = "驭潮 · 两点乾坤" + (f" · {slot}" if slot else "")
    return feishu_card(title, lines, template="orange")
