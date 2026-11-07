"""流式问股：SSE 推送「思考过程 / 工具调用 / 正文」。

规则模式能答就先答（毫秒级）；答不上来再用 OpenAI 兼容端点的 stream=True，
把 reasoning_content（有则透传）与工具调用实时推给前端，最后给 meta。
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncIterator, Optional

import httpx

from ..foundation.db import open_conn
from . import service, tools

TOOL_SPECS: list[dict] = [
    {"type": "function", "function": {
        "name": "get_stock_profile",
        "description": "查询个股主营业务与所属行业。symbol 必须是 6 位股票代码。",
        "parameters": {"type": "object", "properties": {"symbol": {"type": "string"}},
                       "required": ["symbol"]}}},
    {"type": "function", "function": {
        "name": "get_stock_quote",
        "description": "查询个股最新收盘价、涨跌幅、换手率与成交额。symbol 必须是 6 位股票代码。",
        "parameters": {"type": "object", "properties": {"symbol": {"type": "string"}},
                       "required": ["symbol"]}}},
]


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _chat_url(base_url: str) -> str:
    u = (base_url or "").rstrip("/")
    if not u:
        raise ValueError("未配置接口地址")
    return u if u.endswith("/chat/completions") else u + "/chat/completions"


def _prepare(question: str, ctx_symbol: Optional[str]) -> dict:
    """同步：解析标的 + 规则答复（在请求线程里跑，避免阻塞事件循环）。"""
    conn = open_conn()
    try:
        symbol, candidates = service.resolve_symbol(conn, question, ctx_symbol)
        if not symbol:
            names = "、".join(f"{c['name']}（{c['symbol']}）" for c in candidates)
            return {"symbol": None, "candidates": candidates,
                    "answer": (f"你说的是哪一只？{names}" if candidates
                               else "请给出股票代码或名称，例如「000001 主营业务是什么」。")}
        out = service.rule_answer(conn, question, symbol)
        gap = any(str(m).startswith("stock_profile") for m in out["missing"]) \
            or not out["answer"].strip()
        covered = service._rule_covered(conn, question, symbol)
        return {"symbol": symbol, "candidates": [], "rule": out, "gap": gap, "covered": covered}
    finally:
        conn.close()


def _run_tool(name: str, args: dict, symbol: str) -> dict:
    sym = str(args.get("symbol") or symbol)
    conn = open_conn()
    try:
        if name == "get_stock_profile":
            d = tools.stock_profile(conn, sym)
            d["name"] = service._name_of(conn, sym)
            return d
        if name == "get_stock_quote":
            d = tools.stock_quote(conn, sym)
            d["name"] = service._name_of(conn, sym)
            return d
        return {"error": f"未知工具 {name}"}
    finally:
        conn.close()


async def _llm_events(question: str, symbol: str, cfg: dict, knowledge: bool) -> AsyncIterator[str]:
    """逐块转发模型输出；工具调用在服务端执行后继续下一轮。"""
    url = _chat_url(cfg.get("base_url") or "")
    headers = {"Authorization": f"Bearer {cfg.get('api_key')}", "Content-Type": "application/json"}
    messages: list[dict] = [
        {"role": "system", "content": service.KNOWLEDGE_PROMPT if knowledge else service.SYSTEM_PROMPT},
        {"role": "user", "content": question + f"\n（当前上下文标的：{symbol}，可直接查它）"},
    ]
    calls: list[dict] = []
    answer_text = ""
    data_date: Optional[str] = None
    answer_started = False

    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        for _round in range(3):
            tool_slots: dict[int, dict] = {}
            content = ""
            body = {"model": cfg["model"], "messages": messages, "stream": True,
                    "tools": TOOL_SPECS, "temperature": 0.3}
            async with client.stream("POST", url, headers=headers, json=body) as r:
                if r.status_code >= 400:
                    raw = (await r.aread()).decode("utf-8", "ignore")[:300]
                    raise RuntimeError(f"HTTP {r.status_code} {raw}")
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except ValueError:
                        continue
                    choice = (chunk.get("choices") or [{}])[0]
                    delta = choice.get("delta") or {}
                    think = delta.get("reasoning_content") or delta.get("reasoning") or ""
                    if think:
                        yield sse("thinking", {"t": think})
                    if delta.get("content"):
                        content += delta["content"]
                        answer_text += delta["content"]
                        answer_started = True
                        yield sse("token", {"t": delta["content"]})
                    for tc in delta.get("tool_calls") or []:
                        slot = tool_slots.setdefault(int(tc.get("index") or 0),
                                                     {"id": "", "name": "", "args": ""})
                        if tc.get("id"):
                            slot["id"] = str(tc["id"])
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            slot["name"] += fn["name"]
                        if fn.get("arguments"):
                            slot["args"] += fn["arguments"]

            if not tool_slots:
                break
            messages.append({"role": "assistant", "content": content or None,
                             "tool_calls": [{"id": s["id"] or s["name"],
                                             "type": "function",
                                             "function": {"name": s["name"], "arguments": s["args"] or "{}"}}
                                            for s in tool_slots.values()]})
            for slot in tool_slots.values():
                name = slot["name"]
                try:
                    args = json.loads(slot["args"] or "{}")
                except ValueError:
                    args = {}
                t0 = time.time()
                try:
                    d = await asyncio.to_thread(_run_tool, name, args, symbol)
                except Exception as e:                     # 工具失败也要让模型继续
                    d = {"error": f"{type(e).__name__}: {e}"}
                ms = int((time.time() - t0) * 1000)
                date = d.get("updated_at") or d.get("trade_date") if isinstance(d, dict) else None
                data_date = date or data_date
                call = {"tool": name, "args": args, "ms": ms,
                        "data_date": date, "rows": 1}
                calls.append(call)
                yield sse("tool", call)
                messages.append({"role": "tool", "tool_call_id": slot["id"] or name,
                                 "content": json.dumps(d, ensure_ascii=False)})

    if not answer_started:
        # 模型只调工具没给正文：用最后一条工具结果兜底（极少见）
        answer_text = "已查到本地数据，但模型没有给出总结，请再问一次或换个问法。"
        yield sse("token", {"t": answer_text})

    yield sse("meta", {"mode": "llm", "fallback": bool(knowledge),
                       "missing": [], "warnings": [], "data_date": data_date,
                       "tool_calls": calls})


async def stream_answer(question: str, ctx_symbol: Optional[str],
                         user: Optional[dict], model: Optional[str] = None) -> AsyncIterator[str]:
    question = (question or "").strip()
    if not question:
        yield sse("answer", {"answer": "请先输入问题。"})
        yield sse("meta", {"mode": "rule", "missing": [], "warnings": [], "data_date": None})
        return

    stage = await asyncio.to_thread(_prepare, question, ctx_symbol)
    if not stage.get("symbol"):
        yield sse("answer", {"answer": stage["answer"]})
        yield sse("meta", {"mode": "rule", "missing": [], "warnings": [],
                           "data_date": None, "candidates": stage["candidates"]})
        return

    symbol = stage["symbol"]
    rule = stage["rule"]
    cfg = service.llm_config(user, model)
    if cfg and (stage["gap"] or not stage["covered"]):
        try:
            async for ev in _llm_events(question, symbol, cfg, knowledge=stage["gap"]):
                yield ev
            return
        except Exception as e:                        # 模型不可用 → 保留规则结果
            yield sse("warn", {"message": f"模型调用失败，已退回规则模式：{type(e).__name__}: {str(e)[:160]}"})

    yield sse("answer", {"answer": rule["answer"]})
    yield sse("meta", {"mode": "rule", "fallback": False, "missing": rule["missing"],
                       "warnings": [], "data_date": rule["data_date"],
                       "tool_calls": rule["tool_calls"]})
