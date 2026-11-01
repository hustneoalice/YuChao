"""众赢财富通公开板块接口（逆向，通达信系清单，匿名 GET）。

仅低频日级任务使用（清单/成分是慢变量）；行情一律走自有 market_snapshot
聚合——小厂源不进默认行情链路（项目既定边界）。端点：
  GET {host}/api/v2/sc/blocks                       板块全清单（5 组分层）
  GET {host}/api/v2/sc/blocks/{code}/symbols        板块成分（带 .SZ/.SH 后缀）
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from .http import get_json

_ZY_HOST = "https://api.zhongyingtougu.com"
_ZY_HEADERS = {"User-Agent": "zytg/5.0", "Referer": "https://www.zhongyingtougu.com/"}

# typeCode → 中文名（清单组序号即展示顺序：地域/概念/行业/风格/题材）
TYPE_NAMES = {1: "地域", 2: "概念", 4: "行业", 8: "风格", 9: "题材"}


def _zy_get(path: str, params: Optional[Dict[str, Any]] = None,
            timeout: float = 15.0) -> Any:
    d = get_json(_ZY_HOST + path, params or {}, _ZY_HEADERS["Referer"], timeout)
    if not isinstance(d, dict) or d.get("code") != 0:
        raise RuntimeError(f"众赢接口异常：{str(d)[:120]}")
    return d


def fetch_zy_blocks(progress=None, cancel=None) -> List[Dict[str, Any]]:
    """板块全清单 → [{block_code, block_name, type_code, parent_code, sort_no}]。
    行业组一级带内嵌子级（H110000 农林牧渔 → H110100 种植业…），摊平两行。"""
    d = _zy_get("/api/v2/sc/blocks")
    out: List[Dict[str, Any]] = []
    sort_no = 0
    for grp in (d.get("data") or []):
        for b in (grp.get("block") or []):
            code = str(b.get("blockCode") or "").strip()
            name = str(b.get("blockName") or "").strip()
            if not code or not name:
                continue
            tc = int(b.get("typeCode") or 0)
            out.append({"block_code": code, "block_name": name,
                        "type_code": tc, "parent_code": None, "sort_no": sort_no})
            sort_no += 1
            for sub in (b.get("block") or []):       # 行业一级内嵌子级
                scode = str(sub.get("blockCode") or "").strip()
                sname = str(sub.get("blockName") or "").strip()
                if not scode or not sname:
                    continue
                out.append({"block_code": scode, "block_name": sname,
                            "type_code": tc, "parent_code": code, "sort_no": sort_no})
                sort_no += 1
        if cancel and cancel():
            break
    if progress:
        progress(done=len(out), total=len(out), log=f"板块清单 {len(out)} 个")
    return out


def fetch_zy_block_symbols(block_code: str, timeout: float = 15.0) -> List[Dict[str, str]]:
    """板块成分 → [{symbol(裸码), stock_name}]；非交易日/无成分返回空（容忍）。
    上游 symbol 带 .SZ/.SH 后缀，剥成裸码与 market_snapshot 主键同口径。"""
    d = _zy_get(f"/api/v2/sc/blocks/{block_code}/symbols", {"sortType": 1}, timeout)
    out: List[Dict[str, str]] = []
    for r in (d.get("data") or []):
        sym = str(r.get("symbol") or "").strip()
        if "." in sym:
            sym = sym.split(".", 1)[0]
        if len(sym) == 6 and sym.isdigit():
            out.append({"symbol": sym,
                        "stock_name": str(r.get("name") or "").strip() or None})
    return out


def fetch_zy_block_members_all(codes: List[str], progress=None, cancel=None,
                               pause: float = 0.15) -> Dict[str, List[Dict[str, str]]]:
    """逐板块拉成分（1075 次请求，日级一次可接受）→ {block_code: members}。
    单板块失败静默跳过（周一验证期常见：题材/部分板块公开清单无成分）。"""
    out: Dict[str, List[Dict[str, str]]] = {}
    for i, code in enumerate(codes):
        if cancel and cancel():
            break
        try:
            m = fetch_zy_block_symbols(code)
            if m:
                out[code] = m
        except Exception:
            continue
        if i % 20 == 0 and progress:
            progress(done=i + 1, total=len(codes), log=f"成分映射 {i + 1}/{len(codes)} 板块")
        time.sleep(pause)
    if progress:
        progress(done=len(codes), total=len(codes),
                 log=f"成分映射完成 {sum(len(v) for v in out.values())} 行")
    return out
