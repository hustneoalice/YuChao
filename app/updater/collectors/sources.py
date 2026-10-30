"""数据源适配层：东财 clist / datacenter · 腾讯 qt+kline · 新浪资金流。

只取数、标准化输出，不碰库（写库在任务层）。字段口径全部自 1.0 原样移植：
  · 估值 f115=PE(TTM) f23=PB f20/f21=总/流通市值（元） f6=成交额（'-'=停牌）
    f26=上市日期 f100=东财行业（'-'=无分类）
  · 财务 RPT_LICO_FN_CPD（归母净利润/同比/加权ROE）+ RPT_DMSK_FN_BALANCE（负债率）
    + RPT_DMSK_FN_CASHFLOW（经营现金流）——按报告期全量分页，绝不能按股取
  · 腾讯 qt：[39] PE(TTM) 与东财同口径；[44]/[45] 市值单位亿；[37] 成交额万元
  · 腾讯 fqkline：不复权原始价（全系统统一入库基准，前复权在查询层派生）
  · 新浪 MoneyFlow：netamount=主力净流入(超大+大单)、r0/r1/r2/r3=四档
"""
from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional, Tuple

from .http import get_json, get_json_hosts, sina_symbol, tx_symbol

_CLIST_HOSTS = ("https://push2.eastmoney.com", "https://push2delay.eastmoney.com")
_DATACENTER_HOSTS = ("https://datacenter-web.eastmoney.com", "https://data.eastmoney.com")

# 全市场 A 股（沪深主板/创业板/科创板/北交所）
_FS_SCOPE = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
_VAL_FIELDS = "f12,f115,f23,f20,f21,f6,f26,f100"
_PAGE_SIZE = 200
_MAX_PAGES = 60


def _num(v: Any) -> Optional[float]:
    if v in (None, "", "-"):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _parse_f26(v: Any) -> Optional[str]:
    """上市日期（东财以毫秒时间戳或日期串返回）。"""
    if v in (None, "", "-"):
        return None
    if isinstance(v, (int, float)):
        try:
            from datetime import datetime

            return datetime.fromtimestamp(float(v) / 1000).strftime("%Y-%m-%d")
        except Exception:
            return None
    s = str(v)[:10]
    return s if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) else None


# ---------------------------------------------------------------------------
# 东财：估值快照（16:20 主车道）
# ---------------------------------------------------------------------------

def fetch_valuation_snapshot(progress=None, cancel=None) -> Tuple[
        Dict[str, Tuple], Dict[str, str], Dict[str, str]]:
    """全市场快照 → ({sym: (pe,pb,total_mv,circ_mv,amount)}, {sym: 上市日}, {sym: 行业})。

    顺带取回上市日期（新股 list_date 缺失补齐用）与 f100 行业（回填
    stock_universe.industry）——同一分页请求，零额外开销（1.0 语义）。
    """
    out: Dict[str, Tuple] = {}
    listed: Dict[str, str] = {}
    industries: Dict[str, str] = {}
    page, total = 1, None
    while page <= _MAX_PAGES and (total is None or len(out) < total):
        params = {"pn": page, "pz": _PAGE_SIZE, "po": 0, "np": 1, "fltt": 2, "invt": 2,
                  "fid": "f12", "fs": _FS_SCOPE, "fields": _VAL_FIELDS}
        data = get_json_hosts("/api/qt/clist/get", params, _CLIST_HOSTS,
                              "https://quote.eastmoney.com/")
        d = data.get("data") or {}
        if total is None:
            total = int(d.get("total") or 0)
            _emit(progress, stage="采集估值快照", total=total, done=0,
                  message=f"全市场 {total} 个标的，每页 {_PAGE_SIZE} 条")
        diff = d.get("diff") or []
        if not diff:
            break
        for r in diff:
            sym = str(r.get("f12") or "").strip()
            if not (len(sym) == 6 and sym.isdigit()):
                continue
            out[sym] = (_num(r.get("f115")), _num(r.get("f23")),
                        _num(r.get("f20")), _num(r.get("f21")), _num(r.get("f6")))
            ld = _parse_f26(r.get("f26"))
            if ld:
                listed[sym] = ld
            ind = str(r.get("f100") or "").strip()
            if ind and ind != "-":            # 退市/无分类返回 '-'，不写
                industries[sym] = ind
        _emit(progress, done=len(out), total=total,
              log=f"估值快照 [{len(out)}/{total}] 第 {page} 页")
        if cancel and cancel():
            break
        page += 1
        time.sleep(0.12)                       # 限流礼貌间隔
    return out, listed, industries


# ---------------------------------------------------------------------------
# 东财：行业板块快照（15:35）
# ---------------------------------------------------------------------------

def fetch_sector_snapshot(progress=None, cancel=None) -> List[Dict[str, Any]]:
    """东财行业板块清单（fs=m:90+t:2）→ [{industry, code, close, pct_change,
    up_count, down_count, leader, leader_change}]。"""
    out: List[Dict[str, Any]] = []
    page, total = 1, None
    while page <= 10 and (total is None or len(out) < total):
        params = {"pn": page, "pz": 100, "po": 0, "np": 1, "fltt": 2, "invt": 2,
                  "fid": "f3", "fs": "m:90+t:2",
                  "fields": "f12,f14,f2,f3,f104,f105,f128,f136"}
        data = get_json_hosts("/api/qt/clist/get", params, _CLIST_HOSTS,
                              "https://quote.eastmoney.com/")
        d = data.get("data") or {}
        if total is None:
            total = int(d.get("total") or 0)
        diff = d.get("diff") or []
        if not diff:
            break
        for r in diff:
            name = str(r.get("f14") or "").strip()
            if not name or name == "-":
                continue
            out.append({
                "industry": name,
                "code": str(r.get("f12") or ""),
                "close": _num(r.get("f2")),
                "pct_change": _num(r.get("f3")),
                "up_count": int(r["f104"]) if _num(r.get("f104")) is not None else None,
                "down_count": int(r["f105"]) if _num(r.get("f105")) is not None else None,
                "leader": str(r.get("f128") or "") or None,
                "leader_change": _num(r.get("f136")),
            })
        _emit(progress, done=len(out), total=total, log=f"板块快照 [{len(out)}/{total}]")
        if cancel and cancel():
            break
        page += 1
        time.sleep(0.12)
    return out


# ---------------------------------------------------------------------------
# 东财数据中心：财务（17:30，按报告期）
# ---------------------------------------------------------------------------

def fetch_financial_period(period: str) -> List[Tuple]:
    """业绩报表 → [(symbol, report_date, net_profit, yoy, roe)]。"""
    rows: List[Tuple] = []
    page, total = 1, None
    while page <= 200 and (total is None or len(rows) < total):
        params = {"reportName": "RPT_LICO_FN_CPD",
                  "columns": "SECURITY_CODE,PARENT_NETPROFIT,SJLTZ,WEIGHTAVG_ROE",
                  "pageSize": 500, "pageNumber": page,
                  "filter": f"(REPORTDATE='{period}')"}
        data = get_json_hosts("/api/data/v1/get", params, _DATACENTER_HOSTS,
                              "https://data.eastmoney.com/", timeout=25)
        res = data.get("result") or {}
        if total is None:
            total = int(res.get("count") or 0)
            if total == 0:
                return []
        chunk = res.get("data") or []
        if not chunk:
            break
        for k in chunk:
            sym = str(k.get("SECURITY_CODE") or "").strip()
            if not (len(sym) == 6 and sym.isdigit()):
                continue
            rows.append((sym, period, _num(k.get("PARENT_NETPROFIT")),
                         _num(k.get("SJLTZ")), _num(k.get("WEIGHTAVG_ROE"))))
        page += 1
        time.sleep(0.15)
    return rows


def fetch_financial_extras(period: str) -> Dict[str, Tuple[Optional[float], Optional[float]]]:
    """按期取负债率与经营现金流 → {symbol: (debt_ratio, operating_cashflow)}。

    必须按期取（一期 ~12 次分页），按股取要 5500+ 次请求（1.0 教训）。"""
    out: Dict[str, Tuple[Optional[float], Optional[float]]] = {}

    def _all(report: str, columns: str):
        rows: List[Dict[str, Any]] = []
        page, total = 1, None
        while page <= 200 and (total is None or len(rows) < total):
            params = {"reportName": report, "columns": columns,
                      "pageSize": 500, "pageNumber": page,
                      "filter": f"(REPORT_DATE='{period}')"}
            data = get_json_hosts("/api/data/v1/get", params, _DATACENTER_HOSTS,
                                  "https://data.eastmoney.com/", timeout=25)
            res = data.get("result") or {}
            if total is None:
                total = int(res.get("count") or 0)
                if total == 0:
                    return rows
            chunk = res.get("data") or []
            if not chunk:
                break
            rows.extend(chunk)
            page += 1
            time.sleep(0.15)
        return rows

    for r in _all("RPT_DMSK_FN_BALANCE", "SECURITY_CODE,DEBT_ASSET_RATIO"):
        sym = str(r.get("SECURITY_CODE") or "").strip()
        if len(sym) == 6 and sym.isdigit():
            out[sym] = (_num(r.get("DEBT_ASSET_RATIO")), None)
    for r in _all("RPT_DMSK_FN_CASHFLOW", "SECURITY_CODE,NETCASH_OPERATE"):
        sym = str(r.get("SECURITY_CODE") or "").strip()
        if not (len(sym) == 6 and sym.isdigit()):
            continue
        prev = out.get(sym) or (None, None)
        out[sym] = (prev[0], _num(r.get("NETCASH_OPERATE")))
    return out


# ---------------------------------------------------------------------------
# 腾讯：qt 批量报价（行情快照 16:00 / 估值备用车道）
# ---------------------------------------------------------------------------

_QT_BATCH = 60


def fetch_qt_batch(codes: List[str], progress=None, cancel=None) -> Dict[str, Tuple]:
    """腾讯 qt 批量报价 → {sym: (name, price, pe, pb, total_mv, circ_mv, amount, turnover)}。

    字段口径（1.0 实测对齐）：[1]名称 [3]现价 [37]成交额(万元) [38]换手率
    [39]PE(TTM) [44]流通市值(亿) [45]总市值(亿) [46]PB。市值/成交额换算成元后
    与东财对齐。"""
    out: Dict[str, Tuple] = {}
    from .http import tx_symbol           # 裸码 → sh/sz/bj 前缀（腾讯丢弃裸码请求）
    total = len(codes)
    for i in range(0, total, _QT_BATCH):
        chunk = codes[i:i + _QT_BATCH]
        prefixed = [c for c in (tx_symbol(s) for s in chunk) if c]
        if not prefixed:
            continue
        url = f"https://qt.gtimg.cn/q={','.join(prefixed)}"
        resp = _get_text(url)
        for m in re.finditer(r'v_(?:sh|sz|bj)(\d{6})="([^"]*)"', resp):
            sym, payload = m.group(1), m.group(2).split("~")
            if len(payload) <= 46:
                continue
            name = payload[1]
            price = _num(payload[3])
            pe = _num(payload[39])
            pb = _num(payload[46])
            total_mv = _num(payload[45])
            circ_mv = _num(payload[44])
            amt = _num(payload[37]) if len(payload) > 37 else None
            turn = _num(payload[38]) if len(payload) > 38 else None
            out[sym] = (name, price, pe, pb,
                        total_mv * 1e8 if total_mv is not None else None,
                        circ_mv * 1e8 if circ_mv is not None else None,
                        (amt * 1e4) if amt else None, turn)
        _emit(progress, done=min(i + _QT_BATCH, total), total=total,
              log=f"腾讯报价 [{min(i + _QT_BATCH, total)}/{total}]")
        if cancel and cancel():
            break
        time.sleep(0.12)
    return out


def _get_text(url: str) -> str:
    from .http import client, _UA

    r = client.get(url, headers={"User-Agent": _UA}, timeout=15.0)
    r.raise_for_status()
    r.encoding = "gbk"                          # 腾讯 qt 固定 GBK
    return r.text


# ---------------------------------------------------------------------------
# 东财：日 K 线（17:00 增量主车道，不复权）· 腾讯 fqkline 备用
# ---------------------------------------------------------------------------

def fetch_kline_em(code: str, count: int = 3000) -> List[Dict[str, Any]]:
    """东财 push2his 日线（fqt=0 不复权）→ [{t,o,h,l,c,v,amount,pct_chg,turnover}]。

    一次请求带回 amount/pct_chg/turnover（腾讯车道只有价量），增量行不留空。
    v 统一换算成**股**（东财 f56 为手 ×100；科创板 688/689 东财亦按手返回）。
    """
    from .http import market_prefix, pure_of

    s = pure_of(code)
    mkt = market_prefix(s)
    secid = f"{'1' if mkt == 'sh' else '0'}.{s}"
    params = {
        "secid": secid, "klt": 101, "fqt": 0,
        "beg": "0", "end": "20500101", "lmt": max(count, 120),
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    }
    data = get_json_hosts("/api/qt/stock/kline/get", params, _CLIST_HOSTS,
                          "https://quote.eastmoney.com/", timeout=15)
    d = data.get("data") or {}
    klines = d.get("klines") or []
    rows: List[Dict[str, Any]] = []
    for k in klines:
        p = str(k).split(",")
        if len(p) < 7:
            continue
        try:
            v = float(p[5]) if p[5] not in ("", "-") else 0.0
            rows.append({
                "t": p[0][:10],
                "o": _num(p[1]), "c": _num(p[2]), "h": _num(p[3]), "l": _num(p[4]),
                "v": int(v * 100) if v else 0,          # 手 → 股
                "amount": _num(p[6]),
                "pct_chg": _num(p[8]) if len(p) > 8 else None,
                "turnover_rate": _num(p[10]) if len(p) > 10 else None,
            })
        except (TypeError, ValueError):
            continue
    return rows


def fetch_kline_tx(code: str, count: int = 3200) -> List[Dict[str, Any]]:
    """腾讯 fqkline 日线（不复权原始价）→ [{t,o,h,l,c,v,amount,...}]（备用车道）。

    v 换算成股：科创板（688/689）腾讯原始即股，其余为手 ×100；amount 腾讯不
    返回，写 None（涨跌幅由写库侧按前收盘补算）。"""
    from .http import pure_of          # 局部导入避免环（fetch_kline_em 同款）
    tx = tx_symbol(code)
    if not tx:
        return []
    url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
    data = get_json(url, {"param": f"{tx},day,,,{count},"},
                    "https://gu.qq.com/", timeout=10)
    stock = (data.get("data") or {}).get(tx) or {}
    klines = stock.get("day") or stock.get("qfqday") or []
    sci = pure_of(code).startswith(("688", "689"))
    rows: List[Dict[str, Any]] = []
    for k in klines:
        if len(k) >= 6:
            try:
                v = float(k[5]) if k[5] else 0
                rows.append({
                    "t": str(k[0])[:10],
                    "o": float(k[1]), "c": float(k[2]),
                    "h": float(k[3]), "l": float(k[4]),
                    "v": int(v if sci else v * 100),
                    "amount": None, "pct_chg": None, "turnover_rate": None,
                })
            except (TypeError, ValueError):
                continue
    return rows


# ---------------------------------------------------------------------------
# 新浪：个股资金流（16:30 唯一写入路径）
# ---------------------------------------------------------------------------

_SINA_FF_URL = ("https://vip.stock.finance.sina.com.cn/quotes_service/api/"
                "json_v2.php/MoneyFlow.ssl_qsfx_lscjfb")


def fetch_fund_flow_sina(symbol: str, days: int = 5) -> Optional[List[Dict]]:
    """新浪逐只资金流 → [{date, main_net, super_net, large_net, mid_net, small_net}]。

    字段映射（1.0 定案）：netamount=主力净流入（超大+大单合计），
    r0/r1/r2/r3=超大/大/中/小单。指数无此数据（接口只覆盖个股）。
    """
    daima = sina_symbol(symbol)
    if not daima:
        return None
    try:
        r = get_json(_SINA_FF_URL,
                     {"page": "1", "num": str(days), "sort": "opendate",
                      "asc": "0", "daima": daima},
                     "https://finance.sina.com.cn/", timeout=10)
        if not r:
            return None
        result = []
        for item in r:
            try:
                result.append({
                    "date": item["opendate"],
                    "main_net": float(item.get("netamount", 0) or 0),
                    "super_net": float(item.get("r0_net", 0) or 0),
                    "large_net": float(item.get("r1_net", 0) or 0),
                    "mid_net": float(item.get("r2_net", 0) or 0),
                    "small_net": float(item.get("r3_net", 0) or 0),
                })
            except (KeyError, ValueError, TypeError):
                continue
        return result or None
    except Exception:
        return None


def _emit(progress, **fields):
    if progress:
        progress(**fields)
