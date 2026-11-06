"""公司资料 → stock_profile（东财 F10 全量分页）。

一次全量约 50 页（pageSize 500，约 2.5 万行，含退市/港美股），落库只保留
6 位 A 股代码；同一代码优先保留有主营描述与行业分类的记录。
主营问答与个股资料页共用这张表。
"""
from __future__ import annotations

import logging
import time
from datetime import datetime

from ..writer import writer
from .http import get_json_hosts

logger = logging.getLogger("yuchao.updater")

_HOSTS = ("https://datacenter-web.eastmoney.com", "https://data.eastmoney.com")
_REPORT = "RPT_F10_BASIC_ORGINFO"
_COLS = "SECUCODE,SECURITY_NAME_ABBR,MAIN_BUSINESS,EM2016"
_PAGE = 500
_MAX_PAGES = 80


def _symbol(secucode: str) -> str | None:
    s = str(secucode or "").split(".")[0].strip()
    return s if len(s) == 6 and s.isdigit() else None


def fetch_profiles(progress=None, cancel=None) -> dict[str, tuple[str, str, str]]:
    """{symbol: (name, main_business, industry)}；同名代码取信息更全的一条。"""
    progress = progress or (lambda **k: None)
    out: dict[str, tuple[str, str, str]] = {}
    page = 1
    while page <= _MAX_PAGES:
        if cancel and cancel():
            break
        data = get_json_hosts(
            "/api/data/v1/get",
            {"reportName": _REPORT, "columns": _COLS, "pageNumber": page,
             "pageSize": _PAGE, "source": "HSF10", "client": "PC"},
            _HOSTS, "https://data.eastmoney.com/", timeout=25,
        )
        res = data.get("result") or {}
        chunk = res.get("data") or []
        if not chunk:
            break
        for r in chunk:
            sym = _symbol(r.get("SECUCODE"))
            if not sym:
                continue
            name = str(r.get("SECURITY_NAME_ABBR") or "").strip()
            mb = str(r.get("MAIN_BUSINESS") or "").strip()
            ind = str(r.get("EM2016") or "").strip()
            prev = out.get(sym) or ("", "", "")
            out[sym] = (name or prev[0], mb or prev[1], ind or prev[2])
        if page == 1:
            progress(stage="采集公司资料", total=int(res.get("count") or 0), done=0,
                     message=f"共 {res.get('pages') or '?'} 页")
        progress(stage="采集公司资料", total=int(res.get("count") or 0), done=len(out),
                 message=f"第 {page} 页 · 已收 {len(out)} 只")
        page += 1
        time.sleep(0.15)
    return out


def update_stock_profile(progress=None, ctx=None) -> dict:
    start = time.time()
    progress = progress or (lambda **k: None)
    cancel = (ctx or {}).get("cancel_check")
    result: dict = {"task": "stock_profile", "status": "running", "rows": 0}
    try:
        rows = fetch_profiles(progress=progress, cancel=cancel)
        if not rows:
            result.update(status="failed", error="东财 F10 未返回数据")
            return result
        now = datetime.now()
        payload = [(sym, n, mb, ind, now) for sym, (n, mb, ind) in rows.items()]
        conn = writer.conn()
        conn.execute("DELETE FROM stock_profile")     # 全量重建，幂等
        conn.executemany(
            "INSERT INTO stock_profile (symbol,name,main_business,industry,updated_at)"
            " VALUES (?,?,?,?,?)", payload)
        conn.commit()
        writer.reset()
        with_mb = sum(1 for _, _, mb, _, _ in payload if mb)
        result.update(status="success", rows=len(payload),
                      detail=f"写入 {len(payload)} 只公司资料（含主营 {with_mb} 只）")
        progress(log=result["detail"], level="success")
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Profile] 公司资料更新失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
