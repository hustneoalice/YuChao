"""采集 HTTP 层：统一会话 / 多域名重试 / 请求加固 / 代码前缀换算。

- trust_env=False：数据采集不走系统代理（1.0 _get_session 同款）；
- 东财 push2 有多个域名，逐个换域名重试是限流下的正事（1.0 _get_json）；
- 请求加固（对策影 eastmoney_request 的裁剪重写）：UA 池随机轮换；
  瞬时错误（断连/超时/5xx/限流伪装页）单域名内指数退避重试——WAF 拦截
  页常以 HTTP 200 + HTML/空体伪装，json 解析失败即视为失败参与重试；
- 市场前缀判定收敛到一处（1.0 symbol.py 教训：各模块各判一套必出 920 段错标）。
"""
from __future__ import annotations

import json
import logging
import random
import re
import time
from typing import Any, Dict, Iterable, Optional, Tuple

import httpx

logger = logging.getLogger("yuchao.updater")

# UA 池（随机轮换降低指纹聚类拦截概率；策影 eastmoney_request 同思路）
_UA_POOL = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.6 Safari/605.1.15",
)
_UA = _UA_POOL[0]                            # 兼容旧引用（qt 文本接口用）

# 单域名内瞬时错误重试：断连/超时/5xx/限流伪装页（退避 0.5s → 1.5s）；
# 4xx 不在此重试——封禁态换域名（get_json_hosts）才是正事，原地重试无意义。
_RETRIES = 2
_BACKOFF_S = (0.5, 1.5)

client = httpx.Client(trust_env=False, timeout=httpx.Timeout(15.0), follow_redirects=True)


def get_json(url: str, params: Dict[str, Any], referer: str,
             timeout: float = 15.0) -> Any:
    last: Exception = RuntimeError("unreachable")
    for attempt in range(_RETRIES + 1):
        try:
            r = client.get(url, params=params, timeout=timeout,
                           headers={"User-Agent": random.choice(_UA_POOL),
                                    "Referer": referer, "Accept": "*/*"})
            r.raise_for_status()
            data = r.json()                  # 限流伪装页（HTML/空体）在此抛错
            if data is None:
                raise ValueError("空响应")
            return data
        except Exception as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            transient = not (isinstance(e, httpx.HTTPStatusError)
                             and status is not None and status < 500)
            if not transient or attempt >= _RETRIES:
                raise
            last = e
            logger.debug("[Sources] %s 瞬时失败（%s），%.1fs 后重试",
                         url[:60], type(e).__name__, _BACKOFF_S[attempt])
            time.sleep(_BACKOFF_S[attempt])
    raise last


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
