"""行情读取：K 线（复权派生视图）/ 快照 / 搜索。"""
from typing import Optional
from threading import Lock

from .. import db
from ..symbol import INDEX_CATALOG, INDEX_NAMES, index_form, is_bj, normalize_symbol
from ...config import settings
from ...errors import not_found
from ...contracts.common import Adjust
from ...foundation.indicators import standard_indicators

_UNIVERSE_COLS = "symbol, name, market, industry, status"


def universe_entry(conn, symbol: str) -> Optional[dict]:
    if not settings.bj_enabled and is_bj(symbol):
        return None                             # 北交所开关关闭：档案视为不存在
    row = conn.execute(
        f"SELECT {_UNIVERSE_COLS} FROM stock_universe WHERE symbol = ?", [symbol]
    ).fetchone()
    if not row:
        return None
    return dict(zip(_UNIVERSE_COLS.replace(", ", ",").split(","), row))


def _index_entry(conn, symbol: str) -> Optional[dict]:
    """指数形态（000001.SH）且 daily_ohlcv 有数据 → 返回替代条目，避免裸码歧义。"""
    idx = index_form(symbol)
    if idx is None:
        return None
    if not conn.execute(
        "SELECT 1 FROM daily_ohlcv WHERE symbol = ? LIMIT 1", [idx]
    ).fetchone():
        return None
    return {"symbol": idx, "name": INDEX_NAMES.get(idx),
            "market": idx.split(".")[1].lower(), "industry": None, "status": None}


def get_kline(
    conn,
    symbol: str,
    adjust: Adjust = Adjust.qfq,
    with_param: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 500,
) -> dict:
    """K 线：复权口径由 PRICE_VIEW_DDL 的视图保证（qfq 看盘 / hfq 收益 / raw 原始价）。

    指数（000001.SH 等带后缀形态）优先走指数分支：不剥裸码（否则与个股
    000001.SZ 歧义），名称取常用指数表，无因子自动退化为原始价。
    """
    meta = _index_entry(conn, symbol)
    symbol = meta["symbol"] if meta else normalize_symbol(symbol)
    if meta is None:
        meta = universe_entry(conn, symbol)
        if meta is None:
            # 指数等池外品种：daily_ohlcv 有数据即放行，名称留空
            if not conn.execute(
                "SELECT 1 FROM daily_ohlcv WHERE symbol = ? LIMIT 1", [symbol]
            ).fetchone():
                raise not_found(f"未收录标的：{symbol}", {"symbol": symbol})

    src = db.source_for(adjust.value)
    conds, params = ["symbol = ?"], [symbol]
    if start:
        conds.append("date >= ?")
        params.append(start)
    if end:
        conds.append("date <= ?")
        params.append(end)
    # DESC 取最新 N 根后反转回时间正序（ASC+LIMIT 会取到最早段；指标按正序计算）
    rows = conn.execute(
        f"""
        SELECT symbol, date, open, high, low, close, volume, amount, pct_chg, turnover_rate
        FROM {src}
        WHERE {' AND '.join(conds)}
        ORDER BY date DESC
        LIMIT ?
        """,
        [*params, limit],
    ).fetchall()
    rows.reverse()

    closes = [r[5] for r in rows]
    inds = standard_indicators(closes) if with_param == "indicator" else None
    bars = []
    for i, r in enumerate(rows):
        bar = {
            "date": str(r[1]), "open": r[2], "high": r[3], "low": r[4], "close": r[5],
            "volume": r[6], "amount": r[7], "pct_chg": r[8], "turnover_rate": r[9],
        }
        if inds is not None:
            bar["indicators"] = {k: v[i] for k, v in inds.items()}
        bars.append(bar)
    return {
        "symbol": symbol,
        "name": meta["name"] if meta else None,
        "period": "day",
        "adjust": adjust.value,
        "with": with_param,
        "bars": bars,
    }


def get_quote(conn, symbol: str) -> dict:
    """快照 = 最新日线（qfq 口径）+ 估值 + 当日资金流 + 池内档案；指数走精简分支。"""
    meta = _index_entry(conn, symbol)
    if meta is not None:
        # 指数快照：仅最新日线（估值/资金流/档案均不适用）
        bar_row = conn.execute(
            """
            SELECT date, open, high, low, close, volume, amount, pct_chg, turnover_rate
            FROM v_daily_ohlcv_qfq WHERE symbol = ? ORDER BY date DESC LIMIT 1
            """,
            [meta["symbol"]],
        ).fetchone()
        if bar_row is None:
            raise not_found(f"未收录标的：{meta['symbol']}", {"symbol": meta["symbol"]})
        keys = ["date", "open", "high", "low", "close", "volume", "amount", "pct_chg", "turnover_rate"]
        out = {**meta, **dict(zip(keys, bar_row))}
        out["date"] = str(out["date"])
        return out

    symbol = normalize_symbol(symbol)
    meta = universe_entry(conn, symbol)
    bar_row = conn.execute(
        """
        SELECT date, open, high, low, close, volume, amount, pct_chg, turnover_rate
        FROM v_daily_ohlcv_qfq WHERE symbol = ? ORDER BY date DESC LIMIT 1
        """,
        [symbol],
    ).fetchone()
    if meta is None and bar_row is None:
        raise not_found(f"未收录标的：{symbol}", {"symbol": symbol})

    out = {"symbol": symbol, **(meta or {})}
    if bar_row:
        keys = ["date", "open", "high", "low", "close", "volume", "amount", "pct_chg", "turnover_rate"]
        out.update(dict(zip(keys, bar_row)))
        out["date"] = str(out["date"])

    val = conn.execute(
        """
        SELECT date, pe_ttm, pb, ps_ttm, total_mv, circ_mv FROM daily_valuation
        WHERE symbol = ? ORDER BY date DESC LIMIT 1
        """,
        [symbol],
    ).fetchone()
    if val:
        out["valuation"] = {"date": str(val[0]), "pe_ttm": val[1], "pb": val[2],
                            "ps_ttm": val[3], "total_mv": val[4], "circ_mv": val[5]}

    flow = conn.execute(
        """
        SELECT date, net_main, net_super, net_large, net_medium, net_small FROM capital_flow
        WHERE symbol = ? ORDER BY date DESC LIMIT 1
        """,
        [symbol],
    ).fetchone()
    if flow:
        fkeys = ["date", "net_main", "net_super", "net_large", "net_medium", "net_small"]
        out["capital_flow"] = dict(zip(fkeys, flow))
        out["capital_flow"]["date"] = str(out["capital_flow"]["date"])
    return out


_FLOW_KEYS = ("net_main", "net_super", "net_large", "net_medium", "net_small")


def get_capital_flow_range(
    conn,
    symbol: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 400,
) -> dict:
    """区间资金流明细 + 合计（K 线框选统计 → 右列资金卡同步）。

    capital_flow 只有个股（更新器口径：指数无资金流），指数形态直接返回
    available=False + note，前端降级为「仅成交额」，不当作 404。
    返回行按日期正序，totals 为区间内各档净额的代数和（缺值为 None 不参与求和）。
    """
    idx = index_form(symbol)
    if idx is not None and conn.execute(
        "SELECT 1 FROM daily_ohlcv WHERE symbol = ? LIMIT 1", [idx]
    ).fetchone():
        return {
            "symbol": idx,
            "start": start, "end": end,
            "items": [], "totals": None, "covered": 0,
            "available": False,
            "note": "指数无个股资金流（capital_flow 仅覆盖个股），区间资金请参考成交额",
        }

    sym = normalize_symbol(symbol)
    conds, params = ["symbol = ?"], [sym]
    if start:
        conds.append("date >= ?")
        params.append(start)
    if end:
        conds.append("date <= ?")
        params.append(end)
    rows = conn.execute(
        f"""
        SELECT date, {', '.join(_FLOW_KEYS)} FROM capital_flow
        WHERE {' AND '.join(conds)}
        ORDER BY date DESC LIMIT ?
        """,
        [*params, limit],
    ).fetchall()
    rows.reverse()
    items = [
        {"date": str(r[0]), **dict(zip(_FLOW_KEYS, r[1:]))}
        for r in rows
    ]
    totals = {
        k: (sum(x[k] for x in items if x[k] is not None)
            if any(x[k] is not None for x in items) else None)
        for k in _FLOW_KEYS
    }
    return {
        "symbol": sym, "start": start, "end": end,
        "items": items,
        "totals": totals if items else None,
        "covered": len(items),
        "available": bool(items),
        "note": None if items else "区间内无资金流数据（该标的未采集 capital_flow）",
    }


def get_quotes(conn, symbols: list[str]) -> tuple[list[dict], list[str]]:
    """批量快照（自选股卡片底座能力）：N 只三段 IN 查询（日线截面/估值/资金流），
    每段 QUALIFY 取各 symbol 最新行——单只 get_quote 循环 N 次的批量版。

    逐只走与 get_quote 相同的归一链路（指数形态→universe→daily_ohlcv 放行），
    任何表都查不到的进 missing；items 顺序与入参一致（重复入参只出一次）。"""
    items: dict[str, dict] = {}
    missing: list[str] = []
    for s in symbols:
        meta = _index_entry(conn, s)
        sym = meta["symbol"] if meta else normalize_symbol(s)
        if meta is None:
            meta = universe_entry(conn, sym)
        if meta is None:
            # 池外品种：daily_ohlcv 有数据即放行（指数等），否则 missing
            if not conn.execute(
                "SELECT 1 FROM daily_ohlcv WHERE symbol = ? LIMIT 1", [sym]
            ).fetchone():
                if s not in missing:
                    missing.append(s)
                continue
            meta = {"symbol": sym, "name": None, "market": None,
                    "industry": None, "status": None}
        if sym in items:
            continue
        items[sym] = {**meta}
    if not items:
        return [], missing

    want = list(items)
    ph = ",".join(["?"] * len(want))
    keys = ["date", "open", "high", "low", "close", "volume", "amount",
            "pct_chg", "turnover_rate"]
    for r in conn.execute(
        f"""
        SELECT symbol, {', '.join(keys)} FROM v_daily_ohlcv_qfq
        WHERE symbol IN ({ph})
        QUALIFY row_number() OVER (PARTITION BY symbol ORDER BY date DESC) = 1
        """,
        want,
    ).fetchall():
        items[r[0]].update({**dict(zip(keys, r[1:])), "date": str(r[1])})

    val_keys = ["pe_ttm", "pb", "ps_ttm", "total_mv", "circ_mv"]
    vals = {r[0]: r[1:] for r in conn.execute(
        f"""
        SELECT symbol, date, {', '.join(val_keys)} FROM daily_valuation
        WHERE symbol IN ({ph})
        QUALIFY row_number() OVER (PARTITION BY symbol ORDER BY date DESC) = 1
        """,
        want,
    ).fetchall()}
    flow_keys = ["net_main", "net_super", "net_large", "net_medium", "net_small"]
    flows = {r[0]: r[1:] for r in conn.execute(
        f"""
        SELECT symbol, date, {', '.join(flow_keys)} FROM capital_flow
        WHERE symbol IN ({ph})
        QUALIFY row_number() OVER (PARTITION BY symbol ORDER BY date DESC) = 1
        """,
        want,
    ).fetchall()}

    for sym, q in items.items():
        if "date" not in q:                       # universe 有档案但日线无行
            missing.append(sym)
        v = vals.get(sym)
        if v:
            q["valuation"] = {"date": str(v[0]), **dict(zip(val_keys, v[1:]))}
        f = flows.get(sym)
        if f:
            q["capital_flow"] = {"date": str(f[0]), **dict(zip(flow_keys, f[1:]))}
    items = {k: v for k, v in items.items() if "date" in v}
    return list(items.values()), missing


def search(conn, q: str, limit: int = 10) -> list[dict]:
    """代码 / 名称 / 拼音检索（代码与名称 SQL LIKE；纯字母查询叠加拼音缩写/全拼匹配）。"""
    like = f"%{q.upper()}%"
    rows = conn.execute(
        f"""
        SELECT {_UNIVERSE_COLS} FROM stock_universe
        WHERE UPPER(symbol) LIKE ? OR UPPER(name) LIKE ?
        ORDER BY CASE WHEN UPPER(symbol) = ? THEN 0
                       WHEN UPPER(name) = ? THEN 1
                       ELSE 2 END, symbol
        LIMIT ?
        """,
        [like, like, q.upper(), q.upper(), limit],
    ).fetchall()
    keys = _UNIVERSE_COLS.replace(", ", ",").split(",")
    hits = [dict(zip(keys, r)) for r in rows]
    if len(hits) >= limit or not q.isascii():
        return _bj_scoped(hits)

    # 纯字母且 SQL 未取满：叠加拼音缩写（东山精密→dsjm）与全拼（dongshan）匹配。
    # 全表 ~5千行，进程内一次性构建缓存，universe 变更由重启/更新任务兜底。
    seen = {h["symbol"] for h in hits}
    for row in conn.execute(f"SELECT {_UNIVERSE_COLS} FROM stock_universe").fetchall():
        item = dict(zip(keys, row))
        if item["symbol"] in seen:
            continue
        py = _pinyin_variants(item["name"])
        if q.lower() in py["abbr"] or q.lower() in py["full"]:
            hits.append(item)
            seen.add(item["symbol"])
            if len(hits) >= limit:
                break
    return _bj_scoped(hits)


def _bj_scoped(rows: list[dict]) -> list[dict]:
    """北交所开关（YUCHAO_BJ_ENABLED，默认关）：关闭时全系统不考虑北交所标的。"""
    return rows if settings.bj_enabled else [r for r in rows if not is_bj(r["symbol"])]


_TGT_SEGNAME = ("", "超卖", "低位", "弱势", "回升", "强势", "超买")
_TGT_CACHE: dict = {"key": None, "rows": [], "meta": {}}
_TGT_COLS = ("symbol, name, close, pct_chg, vol_ma40, vol_ratio, vol_hit,"
             " short_orange, mid_orange, limit_up_20d, limit_up_cnt,"
             " seg, seg_name, pullback")

# 全市场目标指标：一次窗口 SQL 算完（条件无关层），按 (最新K线日期, 标的数, 北交开关) 缓存
_TGT_SQL = (
    "WITH t AS ("
    "  SELECT symbol, date, close, volume, pct_chg,"
    "         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn"
    "  FROM daily_ohlcv),"
    "u AS ("
    "  SELECT *, MAX(CASE WHEN rn = 1 THEN close END) OVER (PARTITION BY symbol) AS lc"
    "  FROM t WHERE rn <= 60)"
    "SELECT symbol,"
    "       MAX(CASE WHEN rn = 1 THEN close END) AS close,"
    "       MAX(CASE WHEN rn = 1 THEN pct_chg END) AS pct_chg,"
    "       MAX(CASE WHEN rn = 1 THEN volume END) AS vol,"
    "       AVG(CASE WHEN rn <= 7 THEN close END) AS ma7,"
    "       AVG(CASE WHEN rn <= 10 THEN close END) AS ma10,"
    "       AVG(CASE WHEN rn <= 45 THEN close END) AS ma45,"
    "       AVG(CASE WHEN rn <= 40 THEN volume END) AS vol_ma40,"
    "       SUM(CASE WHEN rn <= 20 AND pct_chg >= (CASE"
    "             WHEN symbol LIKE '30%' OR symbol LIKE '68%' THEN 19.9"
    "             ELSE 9.9 END) THEN 1 ELSE 0 END) AS up20,"
    "       SUM(CASE WHEN close < lc THEN 1 ELSE 0 END) AS below,"
    "       COUNT(*) AS n"
    " FROM u GROUP BY symbol")


def _live_overlay(conn) -> Optional[dict]:
    """今日尚未落库（或 K 线增量跑到一半）时的实时截面 → 目标页最新口径。

    K 线增量 17:00 才落库且逐只写入，期间若只读日线，会出现「目标页涨 3 个点、
    点进行情却跌 6 个点」的口径错位（2026-11-02 实测）。这里把快照当日行
    （current/change_rate/volume）当作临时日线拼进指标层，条件判定、涨跌幅、
    量比立刻与行情页一致；预计算表追上当日（target_scan.as_of >= 快照日）后退出。

    守卫：快照行数 < 3000 视为不足全市场覆盖（旧残留），不拼接；快照日早于
    日线最新日也视为过期。volume > 0 过滤停牌零量行，避免污染 MA40。"""
    try:
        head = conn.execute("""
            SELECT MAX(trade_date), COUNT(*), MAX(updated_at) FROM market_snapshot
            WHERE kind = 'stock' AND current IS NOT NULL AND volume > 0
        """).fetchone()
        if not head or not head[0] or int(head[1] or 0) < 3000:
            return None
        latest = conn.execute("SELECT MAX(date) FROM daily_ohlcv").fetchone()
        if latest and latest[0] and str(head[0]) < str(latest[0]):
            return None                            # 快照落后于日线：无当日缺口
        try:
            table_as_of = conn.execute("SELECT MAX(as_of) FROM target_scan").fetchone()[0]
        except Exception:
            table_as_of = None
        if table_as_of and str(table_as_of) >= str(head[0]):
            return None                            # 预计算已含当日：直接读表更快
        return {"date": str(head[0]), "updated_at": str(head[2]), "rows": int(head[1])}
    except Exception:                               # 旧库无快照表：退化纯日线口径
        return None


def _tgt_sql(live_date: Optional[str]) -> str:
    """指标层 SQL：live_date 非空时用快照当日行替换当日日线（避免部分落库重复）。"""
    if not live_date:
        return _TGT_SQL
    live = (
        "(SELECT symbol, date, close, volume, pct_chg FROM daily_ohlcv"
        f" WHERE date < DATE '{live_date}'"
        " UNION ALL"
        " SELECT symbol, trade_date AS date, current AS close,"
        " volume * 100 AS volume, change_rate AS pct_chg FROM market_snapshot"
        f" WHERE kind = 'stock' AND trade_date = DATE '{live_date}'"
        " AND current IS NOT NULL AND volume > 0)"
    )
    return _TGT_SQL.replace("FROM daily_ohlcv),", f"FROM {live}),", 1)


def target_scan_snapshot(conn) -> Optional[tuple[list[dict], dict]]:
    """后台预计算的指标层（target_scan 表）；None = 表缺失/数据日已过期。

    定时任务在 K 线增量落库后重算落表，端点只读现成结果——
    打开目标页不再触发全市场窗口 SQL。
    as_of 允许比日线新（预计算时用了实时快照），只有落后日线才算过期。"""
    try:
        head = conn.execute("SELECT MAX(as_of), COUNT(*) FROM target_scan").fetchone()
        if not head or not head[0] or int(head[1] or 0) < 500:
            return None
        latest = conn.execute("SELECT MAX(date) FROM daily_ohlcv").fetchone()
        if latest and latest[0] and str(head[0]) < str(latest[0]):
            return None                            # 预计算落后于最新数据：走即时兜底
        rows = [dict(zip(_TGT_COLS.replace(", ", ",").split(","), r))
                for r in conn.execute(f"SELECT {_TGT_COLS} FROM target_scan").fetchall()]
        db_as_of = str(latest[0]) if latest and latest[0] else str(head[0])
        return rows, {"as_of": str(head[0]), "scanned": len(rows),
                      "trend_as_of": db_as_of,
                      "provisional": str(head[0]) != db_as_of}
    except Exception:                               # 旧库未建表 / 只读模式：兜底直算
        return None


def stock_targets_universe(conn) -> tuple[list[dict], dict]:
    """目标页全市场扫描：优先读后台定时预计算表，冷启动/过期时才即时算。

    六分段/均线/量比/涨停次数一次算好；条件过滤与排序由端点即时完成——
    用户改条件即刻重筛，与是否预计算无关。
    快照比日线新（今日 K 线未落库）时先走实时拼接，避免与行情页口径错位。"""
    if _live_overlay(conn) is None:
        snap = target_scan_snapshot(conn)
        if snap is not None:
            return snap
    return compute_target_scan(conn)


def compute_target_scan(conn) -> tuple[list[dict], dict]:
    """即时计算指标层（定时任务写表 / 预计算缺失时的兜底），按数据指纹进缓存。"""
    fp = conn.execute(
        "SELECT MAX(date), COUNT(*), COUNT(DISTINCT symbol), SUM(pct_chg)"
        " FROM daily_ohlcv").fetchone()
    live = _live_overlay(conn)
    bj = settings.bj_enabled
    key = (str(fp[0]), int(fp[1] or 0), int(fp[2] or 0), round(float(fp[3] or 0), 4), bj,
           live["date"] if live else None, live["updated_at"] if live else None)
    if _TGT_CACHE["key"] == key:
        return _TGT_CACHE["rows"], _TGT_CACHE["meta"]

    names = dict(conn.execute("SELECT symbol, name FROM stock_universe").fetchall())
    out: list[dict] = []
    for r in conn.execute(_tgt_sql(live["date"] if live else None)).fetchall():
        sym, name = r[0], names.get(r[0])
        if name and "ST" in str(name).upper():          # ST 直接剔除
            continue
        if not bj and is_bj(sym):                       # 北交所开关（默认关）
            continue
        close, ma7, ma10, ma45 = r[1], r[4], r[5], r[6]
        vol, vol_ma40 = r[3], r[7]
        seg = min(6, int((r[9] / r[10]) * 6) + 1)       # 60 窗口收盘分位 → 1..6
        cnt = int(r[8] or 0)
        out.append({
            "symbol": sym, "name": name, "close": close, "pct_chg": r[2],
            "vol_ma40": vol_ma40,
            "vol_ratio": (vol / vol_ma40) if (vol is not None and vol_ma40) else None,
            "vol_hit": bool(vol_ma40 and vol is not None and vol >= vol_ma40),
            "short_orange": bool(ma10 and close > ma10),
            "mid_orange": bool(ma45 and close > ma45),
            "limit_up_20d": cnt > 0, "limit_up_cnt": cnt,
            "seg": seg, "seg_name": _TGT_SEGNAME[seg],
            "pullback": bool(ma7 and close < ma7),
        })
    db_as_of = str(fp[0])
    as_of = live["date"] if live else db_as_of
    meta = {"as_of": as_of, "scanned": len(out),
            "trend_as_of": db_as_of, "provisional": as_of != db_as_of}
    _TGT_CACHE["key"], _TGT_CACHE["rows"], _TGT_CACHE["meta"] = key, out, meta
    return out, meta


_PY_CACHE: dict[str, dict[str, str]] = {}


def _pinyin_variants(name: str) -> dict[str, str]:
    """名称 → {abbr: 首字母缩写, full: 无分隔全拼}；首调后缓存。"""
    cached = _PY_CACHE.get(name)
    if cached is not None:
        return cached
    try:
        from pypinyin import Style, lazy_pinyin
        pys = lazy_pinyin(name, style=Style.NORMAL, errors="ignore")
        abbr = "".join(lazy_pinyin(name, style=Style.FIRST_LETTER, errors="ignore"))
        full = "".join(pys)
    except Exception:  # pypinyin 缺失时优雅降级：仅代码/名称检索
        abbr, full = "", ""
    out = {"abbr": abbr.lower(), "full": full.lower()}
    _PY_CACHE[name] = out
    return out


# -- 2.2 全景大页（market_snapshot 派生层：一条本地 SQL，零上游） -------------

_TAB_WHERE = {
    "hsa":     "kind = 'stock' AND market IN ('SH','SZ')",
    "sha":     "kind = 'stock' AND market = 'SH'",
    "sza":     "kind = 'stock' AND market = 'SZ'",
    "cyb":     "kind = 'stock' AND market = 'SZ' AND symbol LIKE '30%'",
    "kc":      "kind = 'stock' AND market = 'SH' AND symbol LIKE '68%'",
    "bj":      "kind = 'stock' AND market = 'BJ'",
    "fund":    "kind = 'fund'",
    "fund_sh": "kind = 'fund' AND market = 'SH'",
    "fund_sz": "kind = 'fund' AND market = 'SZ'",
}
_BOARD_SORT = {
    "-change_rate": "change_rate DESC", "change_rate": "change_rate ASC",
    "-amount": "amount DESC", "-turnover_rate": "turnover_rate DESC",
    "-vol_ratio": "vol_ratio DESC", "-amplitude": "amplitude DESC",
    "symbol": "symbol", "name": "name",
}


def board_rows(conn, tab: str = "hsa", sort: str = "-change_rate",
               page: int = 1, size: int = 50, q: Optional[str] = None):
    """全景大表：快照表排序分页（毫秒级），market tab 走 kind/market 过滤。"""
    where = _TAB_WHERE.get(tab, _TAB_WHERE["hsa"])
    if tab == "bj" and not settings.bj_enabled:
        return [], 0                                # 北交开关关闭：视图为空
    order = _BOARD_SORT.get(sort, _BOARD_SORT["-change_rate"])
    cond, params = where, []
    if q:
        cond += " AND (symbol LIKE ? OR name LIKE ?)"
        params += [f"%{q}%", f"%{q}%"]
    total = conn.execute(
        f"SELECT COUNT(*) FROM market_snapshot WHERE trade_date = "
        f"(SELECT MAX(trade_date) FROM market_snapshot) AND {cond}", params
    ).fetchone()[0]
    off = max(0, (max(1, page) - 1) * size)
    rows = conn.execute(
        f"SELECT symbol, name, current, change_amount, change_rate, open, high, "
        f"low, pre_close, volume, amount, turnover_rate, vol_ratio, amplitude, "
        f"bid1, bid1_vol, ask1, ask1_vol, outer_vol, inner_vol, "
        f"market_value, circ_value, up_limit, down_limit, updated_at "
        f"FROM market_snapshot WHERE trade_date = "
        f"(SELECT MAX(trade_date) FROM market_snapshot) AND {cond} "
        f"ORDER BY {order} LIMIT ? OFFSET ?",
        params + [size, off]).fetchall()
    cols = ("symbol name current change_amount change_rate open high low "
            "pre_close volume amount turnover_rate vol_ratio amplitude "
            "bid1 bid1_vol ask1 ask1_vol outer_vol inner_vol "
            "market_value circ_value up_limit down_limit updated_at").split()
    out = []
    for r in rows:
        d = dict(zip(cols, r))
        d["updated_at"] = str(d["updated_at"]) if d["updated_at"] else None
        out.append(d)
    return out, total


def index_bar(conn) -> list[dict]:
    """底部指数条：INDEX_CATALOG 顺序 × 当日快照（缺失指数 null 占位，前端隐藏）。"""
    day = conn.execute(
        "SELECT MAX(trade_date) FROM market_snapshot").fetchone()[0]
    if not day:
        return []
    rows = conn.execute(
        "SELECT symbol, name, current, change_amount, change_rate, amount "
        "FROM market_snapshot WHERE trade_date = ? AND kind = 'index'", [day]
    ).fetchall()
    by = {r[0]: r for r in rows}
    out = []
    for sym, name in INDEX_CATALOG:
        r = by.get(sym)
        out.append({
            "symbol": sym, "name": name,
            "current": r[2] if r else None,
            "change_amount": r[3] if r else None,
            "change_rate": r[4] if r else None,
            "amount": r[5] if r else None,
        })
    return out


def market_breadth(conn) -> dict:
    """市场总貌：涨跌家数/涨跌停精确家数（现价 vs 涨跌停价）/两市成交额。"""
    row = conn.execute(
        "SELECT SUM(CASE WHEN change_rate > 0 THEN 1 ELSE 0 END),"
        "       SUM(CASE WHEN change_rate < 0 THEN 1 ELSE 0 END),"
        "       SUM(CASE WHEN change_rate = 0 THEN 1 ELSE 0 END),"
        "       SUM(CASE WHEN up_limit > 0 AND current >= up_limit THEN 1 ELSE 0 END),"
        "       SUM(CASE WHEN down_limit > 0 AND current <= down_limit THEN 1 ELSE 0 END),"
        "       SUM(amount), MAX(updated_at)"
        " FROM market_snapshot WHERE trade_date = "
        " (SELECT MAX(trade_date) FROM market_snapshot) AND kind = 'stock'"
    ).fetchone()
    return {"up": row[0] or 0, "down": row[1] or 0, "flat": row[2] or 0,
            "limit_up": row[3] or 0, "limit_down": row[4] or 0,
            "amount": row[5] or 0.0,
            "updated_at": str(row[6]) if row[6] else None}


_SNAP_COLS = ("symbol name current change_amount change_rate open high low "
              "pre_close volume amount turnover_rate vol_ratio amplitude "
              "bid1 bid1_vol ask1 ask1_vol outer_vol inner_vol "
              "market_value circ_value up_limit down_limit updated_at").split()


def snapshot_one(conn, symbol: str) -> Optional[dict]:
    """单标的当日快照（个股详情页盘口网格）。
    表中个股存裸码、指数存全码，000001 双重身份——两段精确查询：
    目录内指数请求只认全码（000001.SH 绝不落回平安银行裸码）；
    其余（含个股带后缀形态）先裸码后退全码。"""
    idx = index_form(symbol)
    bare = normalize_symbol(symbol)
    if idx and bare in {s.split(".")[0] for s, _ in INDEX_CATALOG}:
        cands = [idx]
    elif idx:
        cands = [bare, idx]
    else:
        cands = [bare]
    for cand in cands:
        row = conn.execute(
            f"SELECT {', '.join(_SNAP_COLS)} FROM market_snapshot "
            f"WHERE trade_date = (SELECT MAX(trade_date) FROM market_snapshot) "
            f"AND symbol = ?", [cand]).fetchone()
        if row:
            d = dict(zip(_SNAP_COLS, row))
            d["updated_at"] = str(d["updated_at"]) if d["updated_at"] else None
            return d
    return None


_TGT_TREND_CACHE = {"keys": {}, "rows": {}}
_TGT_TREND_LOCK = Lock()
_TGT_TREND_CHUNK = 150   # 逐块查询股票数：全市场一次查会打满 DuckDB 1.5GiB 内存上限


def target_trend_snapshot(conn) -> Optional[dict]:
    """后台预计算的趋势柱线（target_trend 表）；None = 表缺失/落后于最新数据日。"""
    try:
        head = conn.execute("SELECT MAX(data_date), COUNT(*) FROM target_trend").fetchone()
        if not head or not head[0] or int(head[1] or 0) < 500:
            return None
        latest = conn.execute("SELECT MAX(date) FROM daily_ohlcv").fetchone()
        if not latest or str(latest[0]) != str(head[0]):
            return None
        rows = conn.execute(
            "SELECT symbol, data_date, trend_value, cross_date, cross_ago, above_days"
            " FROM target_trend").fetchall()
        return {r[0]: dict(trend_data_date=r[1], trend_value=r[2],
                           trend_cross_date=r[3], trend_cross_ago=r[4],
                           trend_above_days=r[5]) for r in rows}
    except Exception:
        return None


def stock_target_trends(conn):
    """趋势柱线汇总：优先读后台预计算表，缺失/过期时即时分块补算。"""
    snap = target_trend_snapshot(conn)
    if snap is not None:
        return snap
    return compute_target_trends(conn)


def compute_target_trends(conn):
    """逐股票内容缓存、按块查询：行情增量更新只重算变化的股票。

    分块是硬约束——一次查全市场 5550×2000 根会让 DuckDB 撞内存上限 OOM
    （2026-11-02 线上实测，连带后续 quotes 请求一起 500）。"""
    from itertools import groupby
    from ..target_trend import trend_histogram, trend_summary

    with _TGT_TREND_LOCK:
        fingerprints = conn.execute("""
            SELECT symbol, COUNT(*), MAX(date), SUM(hash(date, high, low, close))
            FROM daily_ohlcv WHERE symbol IN (SELECT symbol FROM stock_universe)
            GROUP BY symbol
        """).fetchall()
        factors = dict(conn.execute("""
            SELECT symbol, SUM(hash(ex_date, fore_adjust_factor)) FROM adjust_factor GROUP BY symbol
        """).fetchall())
        keys = {r[0]: (*r[1:], factors.get(r[0])) for r in fingerprints}
        changed = [symbol for symbol, key in keys.items() if _TGT_TREND_CACHE['keys'].get(symbol) != key]
        if changed:
            calendar = {str(row[0]): i for i, row in enumerate(conn.execute(
                "SELECT DISTINCT date FROM daily_ohlcv ORDER BY date").fetchall())}
            cursor = conn.cursor()
            try:
                for i in range(0, len(changed), _TGT_TREND_CHUNK):
                    part = changed[i:i + _TGT_TREND_CHUNK]
                    placeholders = ','.join('?' for _ in part)
                    cursor.execute(f"""
                        SELECT symbol, date, high, low, close FROM v_daily_ohlcv_qfq
                        WHERE symbol IN ({placeholders})
                        QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) <= 2000
                        ORDER BY symbol, date
                    """, part)
                    def records():
                        while batch := cursor.fetchmany(8192):
                            yield from batch
                    for symbol, group in groupby(records(), key=lambda row: row[0]):
                        rows = list(group)
                        if any(any(value is None for value in row[2:]) for row in rows):
                            _TGT_TREND_CACHE['rows'].pop(symbol, None)
                            continue
                        bars = [dict(high=r[2], low=r[3], close=r[4]) for r in rows]
                        _TGT_TREND_CACHE['rows'][symbol] = trend_summary(
                            [str(r[1]) for r in rows], trend_histogram(bars), calendar)
                    for symbol in part:                    # 分块完成即记账，重跑不重复
                        _TGT_TREND_CACHE['keys'][symbol] = keys[symbol]
            finally:
                cursor.close()
        return {symbol: row for symbol, row in _TGT_TREND_CACHE['rows'].items() if symbol in keys}
