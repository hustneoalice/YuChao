"""问答服务：规则模式（零依赖，永远可用）+ LLM 模式（pydantic-ai，可选）。

规则模式负责"能确定的事"：识别代码/名称 → 调工具 → 套模板 → 标注数据日期。
LLM 模式只做三件事：理解问法、选工具、组织语言；工具与数据完全相同。
未安装 [ai] extra 或用户未配模型时，自动退回规则模式，不报错。
"""
from __future__ import annotations

import re
import time
from typing import Any, Optional

from . import tools

SYSTEM_PROMPT = """你是驭潮的 A 股数据助手，只回答个股行情、财务与本地数据相关问题。

铁律：
1. 任何数字必须来自工具返回，工具没给就说"本地未收录"，绝不推测。
2. 回答末尾标注数据日期（取自返回的 trade_date / updated_at）。
3. 用户没说代码时，先确认是哪只票；上下文已给出标的就直接用。
4. 不复述 JSON，用简短中文；一次最多 3 句话。
5. 超出能力范围（预测、内幕、投资建议）明确说"当前不具备"。
"""

# 本地答不上来时的补答提示：描述性内容允许用模型常识，但必须标注来源、禁止编数字
KNOWLEDGE_PROMPT = """你是驭潮的 A 股数据助手，本地数据只是补充，不是唯一来源。

规则：
1. 工具返回 missing=true 或"本地未收录"时，若用户问的是公司主营、业务构成、所属行业这类描述性问题，用你自己的常识回答。
2. 用常识回答时必须先写「本地未收录，以下为模型知识，仅供参考」，再给答案。
3. 任何具体数字（价格、涨跌幅、换手率、成交额、财务数据）只能来自工具，绝不推测；工具没给就不写数字。
4. 不确定或超出常识范围时，直接说「这个问题本地资料不足，我暂时答不上来」，不要硬编。
5. 回答简短中文，最多 3 句话，不复述 JSON。
"""

_PROFILE_KW = ("主营", "做什么", "干什么", "业务", "靠什么", "公司是", "产品", "行业", "简介")
_QUOTE_KW = ("多少", "现价", "价格", "收盘", "涨", "跌", "成交", "换手")
_ANALYZE_KW = ("分析", "怎么样", "如何看", "点评", "研判")
_CODE_RE = re.compile(r"(?<!\d)(\d{6})(?!\d)")


def resolve_symbol(conn, question: str, ctx_symbol: Optional[str]) -> tuple[Optional[str], list[dict]]:
    """解析标的：显式代码 > 显式名称 > 页面上下文；名称模糊时返回候选。"""
    m = _CODE_RE.search(question)
    if m:
        return m.group(1), []
    rows = conn.execute(
        "SELECT symbol, name FROM stock_universe WHERE name IS NOT NULL"
    ).fetchall()
    hits = [(s, n) for s, n in rows if n and n in question]
    if hits:
        hits.sort(key=lambda r: len(r[1]), reverse=True)
        if len(hits) > 1 and len(hits[0][1]) == len(hits[1][1]):
            return None, [{"symbol": s, "name": n} for s, n in hits[:5]]
        return hits[0][0], []
    if ctx_symbol:
        return ctx_symbol, []
    return None, []


def _fmt_amount(v: Any) -> str:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return "—"
    if n >= 1e8:
        return f"{n / 1e8:.2f} 亿元"
    if n >= 1e4:
        return f"{n / 1e4:.2f} 万元"
    return f"{n:.0f} 元"


def _profile_text(d: dict) -> tuple[str, list[str]]:
    name = d.get("name") or d.get("symbol")
    mb = str(d.get("main_business") or "").strip()
    ind = str(d.get("industry") or "").strip()
    if not mb:
        return (f"{name}（{d['symbol']}）的主营业务本地暂未收录"
                f"（资料更新于 {d.get('updated_at') or '—'}）。",
                ["stock_profile.main_business"])
    text = f"{name}（{d['symbol']}）主营业务：{mb}"
    if ind:
        text += f"\n所属行业：{ind}"
    text += f"\n资料更新：{d.get('updated_at') or '—'}"
    return text, []


def _quote_text(d: dict) -> tuple[str, list[str]]:
    if d.get("missing"):
        return (f"（{d.get('symbol')}）暂无最新快照：{d.get('reason') or '未采集'}。",
                ["stock_quote"])
    name = d.get("name") or d.get("symbol")
    rate = d.get("change_rate")
    sign = "+" if isinstance(rate, (int, float)) and rate > 0 else ""
    text = (f"{name}（{d['symbol']}）最新 {d.get('trade_date')} 收盘 "
            f"{d.get('current')} 元，涨跌幅 {sign}{rate}%，"
            f"换手率 {d.get('turnover_rate')}%，成交额 {_fmt_amount(d.get('amount'))}。")
    return text, []


def _name_of(conn, symbol: str) -> str:
    row = conn.execute(
        "SELECT name FROM stock_universe WHERE symbol = ?", [symbol]
    ).fetchone()
    return str(row[0]) if row and row[0] else symbol


def rule_answer(conn, question: str, symbol: str) -> dict:
    calls: list[dict] = []
    parts: list[str] = []
    missing: list[str] = []
    data_date: Optional[str] = None

    has_profile = any(k in question for k in _PROFILE_KW)
    has_quote = any(k in question for k in _QUOTE_KW)
    has_analyze = any(k in question for k in _ANALYZE_KW)
    want_profile = has_profile or has_analyze or not has_quote   # 只说代码时默认答主营
    want_quote = has_quote or has_analyze

    if want_profile:
        t0 = time.time()
        d = tools.stock_profile(conn, symbol)
        d["name"] = _name_of(conn, symbol)
        calls.append({"tool": "stock_profile", "args": {"symbol": symbol},
                      "ms": int((time.time() - t0) * 1000),
                      "data_date": d.get("updated_at") or None,
                      "rows": 1})
        text, miss = _profile_text(d)
        parts.append(text)
        missing += miss
        data_date = d.get("updated_at") or data_date

    if want_quote:
        t0 = time.time()
        q = tools.stock_quote(conn, symbol)
        q["name"] = _name_of(conn, symbol)
        calls.append({"tool": "stock_quote", "args": {"symbol": symbol},
                      "ms": int((time.time() - t0) * 1000),
                      "data_date": q.get("trade_date") or None,
                      "rows": 1})
        text, miss = _quote_text(q)
        parts.append(text)
        missing += miss
        data_date = q.get("trade_date") or data_date

    return {"answer": "\n\n".join(parts), "tool_calls": calls, "missing": missing,
            "data_date": data_date}


def llm_config(user: Optional[dict]) -> Optional[dict]:
    """模型配置优先级：用户偏好（已启用+有 key）> 环境变量兜底。

    环境变量只在本机 .env 或进程环境里，代码与仓库中不出现任何密钥。
    """
    from ..config import settings
    cfg: dict = {}
    if user:
        from ..auth.service import get_prefs
        cfg = (get_prefs(user["id"]).get("llm") or {})
    if cfg.get("enabled") and cfg.get("api_key") and cfg.get("model"):
        return cfg
    if settings.llm_api_key and settings.llm_model:
        return {"enabled": True, "api_key": settings.llm_api_key,
                "model": settings.llm_model, "base_url": settings.llm_base_url}
    return None


def llm_answer(conn, question: str, symbol: Optional[str], cfg: dict,
               knowledge: bool = False) -> dict:
    """pydantic-ai 路径：工具集合与规则模式完全一致。

    knowledge=True 用于「本地答不上来」的补答：允许模型用常识补充描述性内容，
    但必须标注来源且不得编造数字。
    """
    import httpx
    from ..foundation.db import open_conn
    from openai import AsyncOpenAI
    from pydantic_ai import Agent
    from pydantic_ai.providers.openai import OpenAIProvider
    try:                                  # pydantic-ai 2.x
        from pydantic_ai.models.openai import OpenAIChatModel as ChatModel
    except ImportError:                   # 0.x/1.x
        from pydantic_ai.models.openai import OpenAIModel as ChatModel

    # 上游偶发排队/超时：显式超时保证接口不会无限挂住，失败即退回规则模式
    client = AsyncOpenAI(
        api_key=cfg["api_key"],
        base_url=cfg.get("base_url") or None,
        timeout=httpx.Timeout(20.0, connect=8.0),
        max_retries=0,
    )
    model = ChatModel(model_name=cfg["model"],
                      provider=OpenAIProvider(openai_client=client))

    calls: list[dict] = []
    agent = Agent(model, system_prompt=KNOWLEDGE_PROMPT if knowledge else SYSTEM_PROMPT)

    @agent.tool_plain
    def get_stock_profile(symbol: str) -> dict:
        """查询个股主营业务与所属行业。symbol 必须是 6 位股票代码。"""
        t0 = time.time()
        c = open_conn()               # 模型侧工具独立连接：长时间调用不占用请求连接
        try:
            d = tools.stock_profile(c, symbol)
        finally:
            c.close()
        calls.append({"tool": "stock_profile", "args": {"symbol": symbol},
                      "ms": int((time.time() - t0) * 1000),
                      "data_date": d.get("updated_at") or None, "rows": 1})
        return d

    @agent.tool_plain
    def get_stock_quote(symbol: str) -> dict:
        """查询个股最新收盘价、涨跌幅、换手率与成交额。symbol 必须是 6 位股票代码。"""
        t0 = time.time()
        c = open_conn()
        try:
            d = tools.stock_quote(c, symbol)
            d["name"] = _name_of(c, symbol)
        finally:
            c.close()
        calls.append({"tool": "stock_quote", "args": {"symbol": symbol},
                      "ms": int((time.time() - t0) * 1000),
                      "data_date": d.get("trade_date") or None, "rows": 1})
        return d

    hint = f"\n（当前上下文标的：{symbol}，可直接查它）" if symbol else ""
    # pydantic-ai 2.x 的 run 是异步入口；同步请求线程里用 run_sync
    result = agent.run_sync(question + hint)
    text = getattr(result, "output", None) or getattr(result, "data", "")
    data_date = next((c["data_date"] for c in reversed(calls) if c.get("data_date")), None)
    return {"answer": str(text).strip(), "tool_calls": calls, "missing": [],
            "data_date": data_date}


def _rule_covered(conn, question: str, symbol: str) -> bool:
    """规则是否明确理解问题：主营/行情/分析关键词，或只报了代码/名称。"""
    if any(k in question for k in _PROFILE_KW + _QUOTE_KW + _ANALYZE_KW):
        return True
    rest = _CODE_RE.sub("", question).replace(symbol, "")
    rest = rest.replace(_name_of(conn, symbol), "")
    rest = re.sub(r"[的了吗呢啊是请这股票只怎如何么？?，,。.、\s]", "", rest)
    return len(rest) <= 4


def answer(conn, question: str, ctx_symbol: Optional[str],
           user: Optional[dict]) -> dict:
    """本地规则优先；规则答不上来（资料缺失/问题超出规则范围）再走大模型补答。"""
    question = (question or "").strip()
    symbol, candidates = resolve_symbol(conn, question, ctx_symbol)
    warnings: list[str] = []

    if not symbol:
        if candidates:
            names = "、".join(f"{c['name']}（{c['symbol']}）" for c in candidates)
            return {"mode": "rule", "answer": f"你说的是哪一只？{names}",
                    "tool_calls": [], "candidates": candidates,
                    "missing": [], "warnings": [], "data_date": None}
        return {"mode": "rule",
                "answer": "请给出股票代码或名称，例如「000001 主营业务是什么」。",
                "tool_calls": [], "candidates": [], "missing": [],
                "warnings": [], "data_date": None}

    out = rule_answer(conn, question, symbol)
    cfg = llm_config(user)
    # 只有「主营业务等描述性资料缺失」才允许模型用常识补答；行情缺失不猜数字
    gap = any(str(m).startswith("stock_profile") for m in out["missing"]) \
        or not out["answer"].strip()
    covered = _rule_covered(conn, question, symbol)           # 规则是否听得懂

    if cfg and (gap or not covered):
        try:
            fb = llm_answer(conn, question, symbol, cfg, knowledge=gap)
            # 规则侧的「未收录」占位句不拼到模型答案前；只保留真实取到的本地数据
            local_text = "\n\n".join(
                p for p in out["answer"].split("\n\n") if "暂未收录" not in p and "暂无最新快照" not in p)
            text = (local_text + "\n\n" if gap and local_text else "") + fb["answer"]
            warnings.append("本地资料不全，已由模型补答，仅供参考" if gap
                            else "本地规则答不了，已由模型回答")
            return {"mode": "llm", "fallback": True, "answer": text,
                    "tool_calls": out["tool_calls"] + fb["tool_calls"],
                    "missing": out["missing"], "warnings": warnings,
                    "data_date": out["data_date"] or fb.get("data_date"),
                    "candidates": []}
        except Exception as e:  # 模型不可用不阻断：保留规则结果
            warnings.append(f"模型调用失败，已退回规则模式：{type(e).__name__}: {str(e)[:160]}")

    return {"mode": "rule", **out, "candidates": [], "warnings": warnings}
