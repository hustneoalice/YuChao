"""智能助手端点：能力清单 + 健康状态 + 问股对话。

规则模式零依赖（不需要模型 key）；配置了模型才走 pydantic-ai。
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ...ai import registry, service, streaming
from ...auth.deps import current_user
from ...foundation.db import get_conn

router = APIRouter(tags=["ai"])


class ChatIn(BaseModel):
    q: str = Field(min_length=1, max_length=500)
    symbol: Optional[str] = Field(default=None, max_length=16)


@router.get("/ai/tools")
def list_tools():
    """能力清单：前端能力页与未来 /mcp 共用同一份注册表。"""
    return {"items": registry.catalog(), "count": len(registry.specs())}


@router.get("/ai/health")
def health(user: Optional[dict] = Depends(current_user)):
    cfg = service.llm_config(user)
    return {
        "llm": bool(cfg),
        "mode": "llm" if cfg else "rule",
        "model": (cfg or {}).get("model"),
        "reason": None if cfg else "未配置模型，使用规则模式",
    }


@router.post("/ai/chat")
def chat(body: ChatIn, user: Optional[dict] = Depends(current_user),
         conn=Depends(get_conn)):
    out = service.answer(conn, body.q, body.symbol, user)
    out["question"] = body.q
    return out


@router.post("/ai/chat/stream")
def chat_stream(body: ChatIn, user: Optional[dict] = Depends(current_user)):
    """SSE：thinking（推理流）/ tool（工具调用）/ token（正文）/ answer（规则整段）/ meta。"""
    return StreamingResponse(
        streaming.stream_answer(body.q, body.symbol, user),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
