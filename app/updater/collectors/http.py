"""采集 HTTP 层：统一会话 / 多域名重试 / 代码前缀换算（1.0 语义移植）。

- trust_env=False：数据采集不走系统代理（1.0 _get_session 同款）；
- 东财 push2 有多个域名，逐个换域名重试是限流下的正事（1.0 _get_json）；
- 市场前缀判定收敛到一处（1.0 symbol.py 教训：各模块各判一套必出 920 段错标）。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Iterable, Optional, Tuple

import httpx

logger = logging.getLogger("yuchao.updater")

_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")

client = httpx.Client(trust_env=False, timeout=httpx.Timeout(15.0), follow_redirects=True)


def get_json(url: str, params: Dict[str, Any], referer: str,
             timeout: float = 15.0) -> Any:
    r = client.get(url, params=params, timeout=timeout,
                   headers={"User-Agent": _UA, "Referer": referer,
                            "Accept": "*/*"})
    r.raise_for_status()
    return r.json()


def get_json_hosts(path: str, params: Dict[str, Any], hosts: Iterable[str],
                   referer: str, timeout: float = 15.0) -> Any:
    """多域名轮换重试：全部失败才抛（1.0 _get_json 语义）。"""
    last: Exception = RuntimeError("no host")
    for host in hosts:
        try:
            return get_json(host + path, params, referer, timeout)
        except Exception as e:
            last = e
            logger.debug("[Sources] %s 失败: %s", host, type(e).__name__)
    raise RuntimeError(f"全部接口域名不可用（{type(last).__name__}: {str(last)[:80]}）")


# ---------------------------------------------------------------------------
# 代码前缀（市场判定唯一出处；先特判 920 北交所段，再看首位）
# ---------------------------------------------------------------------------

def market_prefix(pure: str) -> str:
    s = str(pure or "").strip()
    if not re.fullmatch(r"\d{6}", s):
        raise ValueError(f"非法代码: {pure!r}")
    if s.startswith(("4", "8", "920")):
        return "bj"
    if s.startswith(("5", "6", "9")):
        return "sh"
    return "sz"


def pure_of(symbol: str) -> str:
    """库内 symbol → 6 位裸码。个股为裸码原样；指数/ETF（000001.SH）剥后缀。"""
    s = str(symbol or "").strip()
    if "." in s:
        s = s.split(".", 1)[0]
    return s


def suffixed_symbol(pure: str) -> str:
    """6 位裸码 → 库内指数风格（600519 → 600519.SH）。"""
    return f"{pure}.{market_prefix(pure).upper()}"


def tx_symbol(symbol: str) -> Optional[str]:
    """库内 symbol → 腾讯带前缀代码。指数用库内后缀直判，裸码走 market_prefix。"""
    s = str(symbol or "").strip()
    if "." in s:
        pure, suf = s.split(".", 1)
        suf = suf.lower()
        if suf in ("sh", "sz", "bj"):
            return f"{suf}{pure}"
        return None
    try:
        return market_prefix(s) + s
    except ValueError:
        return None


def sina_symbol(symbol: str) -> str:
    """库内 symbol → 新浪格式（sh/sz/bj 前缀）。"""
    s = pure_of(symbol)
    try:
        return market_prefix(s) + s
    except ValueError:
        return ""
