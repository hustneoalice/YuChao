"""按需获取十大流通股东；季度快照与股数比较，不参与行情补数。"""
from datetime import date, timedelta
from math import isfinite
import time

from ..contracts.market import ShareholderItem, ShareholdersOut
from ..updater.collectors.http import client, _UA

_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
_CACHE: dict[str, tuple[float, list[dict]]] = {}


class ReportUnavailable(ValueError):
    pass


def _number(value):
    if value is None or value == "":
        return None
    result = float(value)
    return result if isfinite(result) else None


def _identity(row):
    return str(row.get("HOLDER_CODE") or row["HOLDER_NAME"]).strip()


def build_report(symbol: str, rows: list[dict], report_date: str | None = None) -> ShareholdersOut:
    groups: dict[str, list[dict]] = {}
    for row in rows:
        end = row["END_DATE"][:10]
        if end[5:] in ("03-31", "06-30", "09-30", "12-31"):
            groups.setdefault(end, []).append(row)
    dates = sorted(groups, reverse=True)
    if report_date and report_date not in groups:
        raise ReportUnavailable("该报告期暂无十大流通股东数据")
    if not dates:
        return ShareholdersOut(symbol=symbol)
    selected = report_date or dates[0]
    day = date.fromisoformat(selected)
    prior = (day.replace(month=((day.month - 1) // 3) * 3 + 1, day=1) - timedelta(days=1)).isoformat()
    current = sorted(groups[selected], key=lambda r: int(r["HOLDER_RANK"]))[:10]
    older = groups.get(prior, [])
    # 不完整的前期十大名单不能证明“上季度不在名单”。
    comparable = {int(r["HOLDER_RANK"]) for r in older} == set(range(1, 11))
    by_id = {_identity(r): r for r in older} if comparable else {}
    items = []
    for row in current:
        shares = _number(row.get("HOLD_NUM"))
        ratio = _number(row.get("HOLD_RATIO"))
        old = by_id.get(_identity(row))
        old_shares = _number(old.get("HOLD_NUM")) if old else None
        old_ratio = _number(old.get("HOLD_RATIO")) if old else None
        delta = int(shares - old_shares) if shares is not None and old_shares is not None else None
        change = "无法比较"
        if comparable and shares is not None:
            if old is None:
                change = "进入"
            elif delta is not None:
                change = "加仓" if delta > 0 else "减仓" if delta < 0 else "不变"
        items.append(ShareholderItem(
            rank=int(row["HOLDER_RANK"]), name=row["HOLDER_NAME"],
            shares=int(shares) if shares is not None else None, ratio=ratio,
            change=change, share_change=delta,
            ratio_change=ratio - old_ratio if ratio is not None and old_ratio is not None else None,
            is_social_security="社保基金" in row["HOLDER_NAME"],
        ))
    total = sum(x.ratio for x in items) if all(x.ratio is not None for x in items) else None
    old_ratios = [_number(r.get("HOLD_RATIO")) for r in older]
    old_total = sum(old_ratios) if comparable and all(r is not None for r in old_ratios) else None
    notices = [r["NOTICE_DATE"][:10] for r in current if r.get("NOTICE_DATE")]
    return ShareholdersOut(
        symbol=symbol, report_dates=dates, report_date=selected,
        previous_report_date=prior if older else None,
        notice_date=max(notices) if notices else None, total_ratio=total,
        ratio_change=total - old_total if total is not None and old_total is not None else None,
        items=items,
    )


def stock_shareholders(symbol: str, report_date: str | None = None) -> ShareholdersOut:
    hit = _CACHE.get(symbol)
    if hit and time.monotonic() - hit[0] < 3600:
        return build_report(symbol, hit[1], report_date)
    rows = []
    page, pages = 1, 1
    while page <= pages:
        response = client.get(_URL, params={
            "reportName": "RPT_F10_EH_FREEHOLDERS",
            "columns": "END_DATE,HOLDER_NAME,HOLDER_CODE,HOLDER_RANK,HOLD_NUM,HOLD_RATIO,NOTICE_DATE",
            "filter": f'(SECURITY_CODE="{symbol}")(IS_REPORT="1")',
            "sortColumns": "END_DATE,HOLDER_RANK", "sortTypes": "-1,1",
            "pageSize": 500, "pageNumber": page,
        }, headers={"User-Agent": _UA, "Referer": "https://data.eastmoney.com/"}, timeout=15)
        response.raise_for_status()
        data = response.json()
        if not data.get("success"):
            # 东财无匹配数据返回 success=false / code=9201。
            if data.get("code") == 9201:
                break
            raise RuntimeError("股东数据源暂不可用")
        result = data.get("result") or {}
        rows.extend(result.get("data") or [])
        pages = int(result.get("pages") or 0)
        page += 1
    if len(_CACHE) >= 64:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[symbol] = (time.monotonic(), rows)
    return build_report(symbol, rows, report_date)
