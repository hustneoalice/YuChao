"""行情读取：K 线（复权派生视图）/ 快照 / 搜索。"""
import json
import time
from collections import deque
from pathlib import Path
from typing import Optional
from threading import Lock
from datetime import datetime

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

    # 概念标签：sector_member（东财概念成分快照）→ 逗号串，前端拆 chip
    cons = conn.execute(
        "SELECT DISTINCT bk_name FROM sector_member WHERE symbol = ? ORDER BY bk_name",
        [symbol],
    ).fetchall()
    if cons:
        out["concept"] = ",".join(c[0] for c in cons if c[0])
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


_SEARCH_KINDS = ("stock", "fund", "index", "sector")
_KIND_ORDER = {"stock": 0, "index": 1, "fund": 2, "sector": 3}


def search(conn, q: str, limit: int = 10,
           kinds: Optional[set[str]] = None) -> list[dict]:
    """代码 / 名称 / 拼音检索：个股 + 场内基金 + 指数 + 板块（kind 区分）。

    顶部全局搜索用：一次查询覆盖四类标的，按同一套打分排序（精确代码 0 /
    精确名称 1 / 前缀 2 / 包含 3 / 拼音 4），同级按 个股→指数→基金→板块。
    纯字母查询在原始命中不足时再叠拼音缩写（东山精密→dsjm）与全拼。
    """
    kinds = kinds or set(_SEARCH_KINDS)
    qs = q.strip()
    qu, ql = qs.upper(), qs.lower()
    want_pinyin = qs.isascii() and qs.isalpha()   # 纯字母才走拼音（代码查询不拼表）
    # (打分, 类别序, 热度, 行)：拼音命中同分时按总市值降序，让「cd」优先出长电科技
    cand: list[tuple[int, int, float, dict]] = []
    seen: set[tuple[str, str]] = set()

    # 各类原始行：stock 走池内档案，fund 走场内基金清单，index 取静态目录，
    # sector 取最新交易日的板块清单（id 用板块名，前端据此跳板块页）。
    rows: dict[str, list[tuple]] = {}
    if "stock" in kinds:
        rows["stock"] = [
            (r[0], r[1], r[2], r[3], r[4])
            for r in conn.execute(
                "SELECT symbol, name, market, industry, status FROM stock_universe"
            ).fetchall()
            if settings.bj_enabled or not is_bj(r[0])
        ]
    if "fund" in kinds:
        rows["fund"] = [
            (r[0], r[1], r[2], None, None)
            for r in conn.execute(
                "SELECT symbol, name, market FROM fund_universe"
            ).fetchall()
        ]
    if "index" in kinds:
        rows["index"] = [(s, n, s.split(".")[1].lower(), None, None)
                         for s, n in INDEX_CATALOG]
    if "sector" in kinds:
        rows["sector"] = [
            # symbol=板块名（即板块页 id）；row[5]=kind（industry|concept）
            (r[0], r[0], None, None, None, r[1] or "industry")
            for r in conn.execute(
                "SELECT industry, kind FROM sector_index"
                " WHERE trade_date = (SELECT MAX(trade_date) FROM sector_index)"
            ).fetchall()
        ]

    def grade(symbol: str, name: Optional[str]) -> Optional[int]:
        s = (symbol or "").upper()
        n = name or ""
        if s == qu:
            return 0
        if n == qs:
            return 1
        if s.startswith(qu) or n.startswith(qs):
            return 2
        if qu in s or qs in n:
            return 3
        return None

    def put(kind: str, row: tuple, sc: int, pop: float = 0.) -> None:
        key = (kind, row[0])
        if key in seen:
            return
        seen.add(key)
        cand.append((sc, _KIND_ORDER[kind], -pop, {
            "symbol": row[0], "name": row[1], "market": row[2],
            "industry": row[3], "status": row[4], "kind": kind,
            "sub": (row[5] if len(row) > 5 else None),
        }))

    for kind, items in rows.items():
        for row in items:
            sc = grade(row[0], row[1])
            if sc is not None:
                put(kind, row, sc)

    # 拼音兜底：原始命中不足时才展开（避免每次请求都拼全表）；板块/指数同享。
    # 同分（如 cd 命中 长电科技/成都燃气/崇达技术…）按总市值降序，大票优先。
    if want_pinyin and len(cand) < limit:
        _load_pinyin_disk(conn)                    # 命中落盘索引则跳过全表拼音解析
        caps = _market_caps(conn) if "stock" in kinds else {}
        for kind, items in rows.items():
            for row in items:
                if (kind, row[0]) in seen or not row[1]:
                    continue
                sc = _py_grade(_pinyin_variants(row[1]), ql)
                if sc is not None:
                    put(kind, row, sc, caps.get(row[0], 0.) if kind == "stock" else 0.)
        _save_pinyin_disk(conn)

    cand.sort(key=lambda x: x[:3])
    return [c[3] for c in cand[:limit]]


_TGT_SEGNAME = ("", "超跌", "反弹", "突破", "超涨", "回踩", "跌破")
# 操作优先级（列表排序用，越大越靠前）：突破 > 回踩 > 超涨 > 跌破 > 反弹 > 超跌
SEG_RANK = {0: 0, 1: 0, 2: 1, 6: 2, 4: 3, 5: 5, 3: 6}
_TGT_CACHE: dict = {"key": None, "rows": [], "meta": {}}
_TGT_COLS = ("symbol, name, close, pct_chg, vol_ma40, vol_ratio, vol_hit,"
             " short_orange, mid_orange, limit_up_20d, limit_up_cnt,"
             " seg, seg_name, pullback, acc_strength, dkx_gold_ago, dkx_death_ago")

# 全市场目标指标：一次窗口 SQL 算完（条件无关层），按 (最新K线日期, 标的数, 北交开关) 缓存
_TGT_SQL = (
    "WITH t AS ("
    "  SELECT symbol, date, close, high, low, volume, pct_chg,"
    "         LAG(close) OVER (PARTITION BY symbol ORDER BY date) AS prev_close,"
    "         ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn"
    "  FROM daily_ohlcv),"
    "u AS ("
    "  SELECT symbol, close, volume, pct_chg, rn,"
    "         GREATEST(high - low, ABS(high - COALESCE(prev_close, close)),"
    "                  ABS(low - COALESCE(prev_close, close))) AS tr,"
    "         MAX(CASE WHEN rn = 1 THEN close END) OVER (PARTITION BY symbol) AS lc"
    "  FROM t WHERE rn <= 60)"
    "SELECT symbol,"
    "       MAX(CASE WHEN rn = 1 THEN close END) AS close,"
    "       MAX(CASE WHEN rn = 1 THEN pct_chg END) AS pct_chg,"
    "       MAX(CASE WHEN rn = 1 THEN volume END) AS vol,"
    "       AVG(CASE WHEN rn <= 7 THEN close END) AS ma7,"
    "       AVG(CASE WHEN rn <= 10 THEN close END) AS ma10,"
    "       AVG(CASE WHEN rn <= 45 THEN close END) AS ma45,"
    "       AVG(CASE WHEN rn <= 40 THEN volume END) AS vol_ma40,"
    "       AVG(CASE WHEN rn <= 14 THEN tr END) AS atr14,"
    "       SUM(CASE WHEN rn <= 20 AND pct_chg >= (CASE"
    "             WHEN symbol LIKE '30%' OR symbol LIKE '68%' THEN 19.9"
    "             ELSE 9.9 END) THEN 1 ELSE 0 END) AS up20"
    " FROM u GROUP BY symbol")


def _live_overlay(conn, force: bool = False) -> Optional[dict]:
    """今日尚未落库（或 K 线增量跑到一半）时的实时截面 → 目标页最新口径。

    K 线增量 17:00 才落库且逐只写入，期间若只读日线，会出现「目标页涨 3 个点、
    点进行情却跌 6 个点」的口径错位（2026-11-02 实测）。这里把快照当日行
    （current/change_rate/volume）当作临时日线拼进指标层，条件判定、涨跌幅、
    量比立刻与行情页一致；预计算表追上当日（target_scan.as_of >= 快照日）后退出。

    force=True 供盘中定时任务用：表里已有当日行也要拿最新快照重算（每轮快照
    更新后指标层跟着刷新），不因「表已覆盖当日」而提前返回。

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
        if not force and table_as_of and str(table_as_of) >= str(head[0]):
            return None                            # 预计算已含当日：直接读表更快
        # date = 拼接进指标层的日线槽位（快照 trade_date，收盘前是上一交易日）；
        # as_of = 快照实际抓取日（盘中即今天；非交易日则是上一交易日），
        # 用于展示与「含实时快照」标记
        return {"date": str(head[0]), "updated_at": str(head[2]), "rows": int(head[1]),
                "as_of": str(head[2])[:10]}
    except Exception:                               # 旧库无快照表：退化纯日线口径
        return None


def _tgt_sql(live_date: Optional[str]) -> str:
    """指标层 SQL：live_date 非空时用快照当日行替换当日日线（避免部分落库重复）。"""
    if not live_date:
        return _TGT_SQL
    live = (
        "(SELECT symbol, date, close, high, low, volume, pct_chg FROM daily_ohlcv"
        f" WHERE date < DATE '{live_date}'"
        " UNION ALL"
        " SELECT symbol, trade_date AS date, current AS close,"
        " COALESCE(high, current) AS high, COALESCE(low, current) AS low,"
        " volume * 100 AS volume, change_rate AS pct_chg FROM market_snapshot"
        f" WHERE kind = 'stock' AND trade_date = DATE '{live_date}'"
        " AND current IS NOT NULL AND volume > 0)"
    )
    return _TGT_SQL.replace("FROM daily_ohlcv),", f"FROM {live}),", 1)


# 主力吸筹（众赢「主力吸筹」柱线移植，口径与 frontend/src/accumulation.ts 一致）：
# 只由最低价序列驱动，柱子只出现在 38 日新低当天；柱高量纲随个股波动剧烈
# （实测 250 根内：上证 79 / 宁德 95 / 招行 252 / 茅台 1194），不能跨股比较。
# 因此指标层落「个股内百分位」acc_strength：近 20 日吸筹柱峰值，在本股过去
# 一年各 20 日窗口峰值的分位（0-100）。用滚动窗口峰值做分母而非单根柱值，
# 避免「取近 20 日最大值」天然高分位导致大半市场同时命中（80 分位≈80% 命中）。
# 80 = 当前这段的吸筹力度进入本股一年内的前 20% 窗口。
_ACC_BARS = 250          # 计算窗口（约一年交易日）
_ACC_WARMUP = 38         # 前 38 根处于 38 日窗口/var8 平滑预热期，不计入分位
_ACC_RECENT = 20         # 「近期」= 近 20 个交易日的柱峰值
_ACC_FLOOR = 5.0         # 柱高低于该值视为噪声（0.1~1 量级的碎柱不参与分位）


def _acc_sql(live_date: Optional[str]) -> str:
    """吸筹取数：每股最近 250 根最低价（live 时同 _tgt_sql 拼接快照当日）。"""
    if live_date:
        src = (
            "(SELECT symbol, date, low FROM v_daily_ohlcv_qfq"
            f" WHERE date < DATE '{live_date}'"
            " UNION ALL"
            " SELECT symbol, trade_date AS date, COALESCE(low, current) AS low"
            " FROM market_snapshot"
            f" WHERE kind = 'stock' AND trade_date = DATE '{live_date}'"
            " AND current IS NOT NULL AND volume > 0)")
    else:
        src = "v_daily_ohlcv_qfq"
    return (
        "WITH t AS (SELECT symbol, date, low,"
        " ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn"
        f" FROM {src} WHERE symbol IN (SELECT symbol FROM stock_universe)),"
        " s AS (SELECT symbol, date, low FROM t WHERE rn <= 250)"
        " SELECT symbol, date, low FROM s ORDER BY symbol, date")


def _acc_series(lows: list[float]) -> list[Optional[float]]:
    """众赢主力吸筹柱高（与 accumulation.ts 逐点同口径）。

    diff = low - prevLow；absSma / upSma 为 3 期递推 SMA；upSma=0 时当日无柱
    且不推进 var8；今日最低 ≤ 近 38 日最低才给 target，否则 target=0（var8
    逐日减半回落）。返回 var8/618，空值为 None。单调队列维护窗口最小/最大值。
    """
    n = len(lows)
    out: list[Optional[float]] = [None] * n
    abs_sma = up_sma = 0.0
    var4: Optional[float] = None
    var8: Optional[float] = None
    lo_q: deque = deque()            # (i, low) 单调递增 → 窗口最小值
    hi_q: deque = deque()            # (i, var4) 单调递减 → 窗口最大值
    for i in range(n):
        low = float(lows[i])
        diff = low - float(lows[i - 1]) if i else 0.0
        abs_sma = (2 * abs_sma + abs(diff)) / 3
        up_sma = (2 * up_sma + max(diff, 0.0)) / 3
        while lo_q and lo_q[-1][1] >= low:
            lo_q.pop()
        lo_q.append((i, low))
        while lo_q[0][0] <= i - 38:
            lo_q.popleft()
        if up_sma == 0:                  # 上影无穷：无柱，var4/var8 不推进
            continue
        input_v = abs_sma / up_sma * 100 * 10
        var4 = input_v if var4 is None else (input_v + var4) / 2
        while hi_q and hi_q[-1][1] <= var4:
            hi_q.pop()
        hi_q.append((i, var4))
        while hi_q[0][0] <= i - 38:
            hi_q.popleft()
        target = (var4 + hi_q[0][1] * 2) / 2 if low <= lo_q[0][1] else 0.0
        var8 = target if var8 is None else (target + var8) / 2
        out[i] = var8 / 618
    return out


def _acc_roll_max(vals: list[Optional[float]], window: int) -> list[Optional[float]]:
    """柱值序列的滚动窗口峰值（窗口按数组下标，None 不参与）。"""
    q: deque = deque()               # (i, v) 单调递减
    out: list[Optional[float]] = []
    for i, v in enumerate(vals):
        if v is not None:
            while q and q[-1][1] <= v:
                q.pop()
            q.append((i, v))
        while q and q[0][0] <= i - window:
            q.popleft()
        out.append(q[0][1] if q else None)
    return out


def _acc_strength_map(conn, live_date: Optional[str] = None) -> dict[str, float]:
    """全市场 acc_strength：近 20 日窗口峰值在本股一年各 20 日窗口峰值中的分位。"""
    lows_by_sym: dict[str, list[float]] = {}
    for sym, _d, low in conn.execute(_acc_sql(live_date)).fetchall():
        if low is None:
            continue
        lows_by_sym.setdefault(sym, []).append(float(low))
    out: dict[str, float] = {}
    start = _ACC_WARMUP + _ACC_RECENT - 1
    for sym, lows in lows_by_sym.items():
        vals = _acc_series(lows[: _ACC_BARS])
        rm = _acc_roll_max(vals, _ACC_RECENT)       # 各 20 日窗口的柱峰值
        peak = rm[-1] if rm else None               # 当前这段（近 20 日）的峰值
        hist = [v for v in rm[start:] if v is not None]
        if peak is None or peak < _ACC_FLOOR or not hist:
            out[sym] = 0.0                          # 无柱/全是噪声碎柱：无参考意义
            continue
        out[sym] = round(sum(1 for v in hist if v <= peak) / len(hist) * 100, 1)
    return out


# DKX（多空线）：20 日加权收盘（权重 20..1）再取 10 日均线 MADKX；
# 与 frontend/src/pages/kline.ts 的 dkx 指标同口径。取 60 根即可覆盖「近 30 日」筛选。
_DKX_BARS = 60
_DKX_N = 20
_DKX_M = 10


def _dkx_sql(live_date: Optional[str]) -> str:
    """DKX 取数：每股最近 60 根前复权收盘价（live 时拼接快照当日，与 _acc_sql 同法）。"""
    if live_date:
        src = (
            "(SELECT symbol, date, close FROM v_daily_ohlcv_qfq"
            f" WHERE date < DATE '{live_date}'"
            " UNION ALL"
            " SELECT symbol, trade_date AS date, current AS close"
            " FROM market_snapshot"
            f" WHERE kind = 'stock' AND trade_date = DATE '{live_date}'"
            " AND current IS NOT NULL AND volume > 0)")
    else:
        src = "v_daily_ohlcv_qfq"
    return (
        "WITH t AS (SELECT symbol, date, close,"
        " ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn"
        f" FROM {src} WHERE symbol IN (SELECT symbol FROM stock_universe)),"
        f" s AS (SELECT symbol, date, close FROM t WHERE rn <= {_DKX_BARS})"
        " SELECT symbol, close FROM s ORDER BY symbol, date")


def dkx_cross_ago(closes: list[float]) -> tuple[Optional[int], Optional[int]]:
    """最近一次 DKX 金叉/死叉距今天数（0=当日，None=窗口内未出现）。

    DKX = Σ close[i-j]·(20-j) / 210；MADKX = DKX 的 10 日均值。
    DKX 上穿 MADKX → 金叉，下穿 → 死叉；等号归入穿越（与前端绘制同规则）。"""
    n, m = _DKX_N, _DKX_M
    L = len(closes)
    if L < n + m - 1:
        return None, None
    wsum = n * (n + 1) / 2
    dkx: list[Optional[float]] = [None] * L
    for i in range(n - 1, L):
        dkx[i] = sum(closes[i - j] * (n - j) for j in range(n)) / wsum
    mad: list[Optional[float]] = [None] * L
    for i in range(n + m - 2, L):
        mad[i] = sum(dkx[i - j] for j in range(m)) / m
    gold = death = None
    for i in range(n + m - 2, L):
        prev, prev_mad = dkx[i - 1], mad[i - 1]
        if prev is None or prev_mad is None or mad[i] is None:
            continue
        ago = L - 1 - i
        if prev <= prev_mad and dkx[i] > mad[i]:
            gold = ago if gold is None else min(gold, ago)
        elif prev >= prev_mad and dkx[i] < mad[i]:
            death = ago if death is None else min(death, ago)
    return gold, death


def _dkx_cross_map(conn, live_date: Optional[str] = None) -> dict[str, tuple]:
    """全市场 DKX 交叉：symbol → (金叉距今天数, 死叉距今天数)。"""
    series: dict[str, list[float]] = {}
    for sym, close in conn.execute(_dkx_sql(live_date)).fetchall():
        if close is None:
            continue
        series.setdefault(sym, []).append(float(close))
    return {sym: dkx_cross_ago(closes) for sym, closes in series.items()}


def _scan_computed_at(conn) -> str:
    """target_scan 最近一次预计算完成时间（update_log 成功账，YYYY-MM-DD HH:MM）。"""
    try:
        ts = conn.execute(
            "SELECT MAX(created_at) FROM update_log"
            " WHERE data_type IN ('target_scan', 'target_scan_live')"
            " AND status = 'completed'"
        ).fetchone()[0]
    except Exception:
        return ""
    return str(ts)[:16] if ts else ""


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
                      "computed_at": _scan_computed_at(conn),
                      "provisional": str(head[0]) != db_as_of}
    except Exception:                               # 旧库未建表 / 只读模式：兜底直算
        return None


def stock_targets_universe(conn) -> tuple[list[dict], dict]:
    """目标页全市场扫描：优先读后台定时预计算表，冷启动/过期时才即时算。

    六分段/均线/量比/涨停次数一次算好；条件过滤与排序由端点即时完成——
    用户改条件即刻重筛，与是否预计算无关。
    快照比日线新（今日 K 线未落库）时先走实时拼接，避免与行情页口径错位。"""
    live = _live_overlay(conn)
    if live is None:
        snap = target_scan_snapshot(conn)
        if snap is not None:
            return snap
    return compute_target_scan(conn)


def six_segment(close, ma7, ma10, atr14) -> int:
    """六分段（趋势线六位置）：以短线操盘 MA7 快 / MA10 慢为基准。

    1 超跌 → 2 反弹 → 3 突破 → 4 超涨 → 5 回踩 → 6 跌破；偏离阈值按
    ATR(14)/收盘价自适应（1.5 倍，最低 1%），与前端 indicators.ts 同口径。"""
    try:
        close, ma7, ma10 = float(close), float(ma7), float(ma10)
        atr = float(atr14 or 0)
    except (TypeError, ValueError):
        return 0
    if not ma10 or not ma7 or close <= 0:
        return 0
    deep = 1.5 * max(atr / close, 0.01)
    dev = close / ma10 - 1
    if close >= ma10:
        if ma7 > ma10 and dev >= deep:
            return 4                                   # 超涨（趋势已转多后远离慢线）
        if ma7 >= ma10 and close < ma7:
            return 5                                   # 回踩快线
        return 3                                       # 突破 / 上升趋势
    if ma7 > ma10:
        return 6                                       # 跌破慢线（趋势线跌破）
    return 1 if dev <= -deep else 2                    # 超跌 / 反弹


def compute_target_scan(conn, live: Optional[dict] = None) -> tuple[list[dict], dict]:
    """即时计算指标层（定时任务写表 / 预计算缺失时的兜底），按数据指纹进缓存。

    live 显式传入时（盘中定时任务）不再自行探测：任务先拿最新快照，再算，
    避免「写表后 overlay 提前退出」导致下一轮拿不到实时价格。"""
    fp = conn.execute(
        "SELECT MAX(date), COUNT(*), COUNT(DISTINCT symbol), SUM(pct_chg)"
        " FROM daily_ohlcv").fetchone()
    if live is None:
        live = _live_overlay(conn)
    bj = settings.bj_enabled
    key = (str(fp[0]), int(fp[1] or 0), int(fp[2] or 0), round(float(fp[3] or 0), 4), bj,
           live["date"] if live else None, live["updated_at"] if live else None)
    if _TGT_CACHE["key"] == key:
        return _TGT_CACHE["rows"], _TGT_CACHE["meta"]

    names = dict(conn.execute("SELECT symbol, name FROM stock_universe").fetchall())
    acc_map = _acc_strength_map(conn, live["date"] if live else None)
    dkx_map = _dkx_cross_map(conn, live["date"] if live else None)
    out: list[dict] = []
    for r in conn.execute(_tgt_sql(live["date"] if live else None)).fetchall():
        sym, name = r[0], names.get(r[0])
        if name is None:                                # 基金/指数等池外品种不进目标页
            continue
        if "ST" in str(name).upper():                   # ST 直接剔除
            continue
        if not bj and is_bj(sym):                       # 北交所开关（默认关）
            continue
        close, ma7, ma10, ma45 = r[1], r[4], r[5], r[6]
        vol, vol_ma40 = r[3], r[7]
        seg = six_segment(close, ma7, ma10, r[8])        # 趋势线六位置 → 1..6
        cnt = int(r[9] or 0)
        gold_ago, death_ago = dkx_map.get(sym, (None, None))
        out.append({
            "symbol": sym, "name": name, "close": close, "pct_chg": r[2],
            "vol_ma40": vol_ma40,
            "vol_ratio": (vol / vol_ma40) if (vol is not None and vol_ma40) else None,
            "vol_hit": bool(vol_ma40 and vol is not None and vol >= vol_ma40),
            "short_orange": bool(ma10 and close >= ma10),
            "mid_orange": bool(ma45 and close >= ma45),
            "limit_up_20d": cnt > 0, "limit_up_cnt": cnt,
            "seg": seg, "seg_name": _TGT_SEGNAME[seg],
            "pullback": bool(ma7 and close < ma7),
            "acc_strength": acc_map.get(sym),
            "dkx_gold_ago": gold_ago, "dkx_death_ago": death_ago,
        })
    db_as_of = str(fp[0])
    as_of = live["as_of"] if live else db_as_of
    meta = {"as_of": as_of, "scanned": len(out),
            "trend_as_of": db_as_of, "provisional": as_of != db_as_of,
            "computed_at": datetime.now().strftime("%Y-%m-%d %H:%M")}
    _TGT_CACHE["key"], _TGT_CACHE["rows"], _TGT_CACHE["meta"] = key, out, meta
    return out, meta


_PY_CACHE: dict[str, dict] = {}

# 总市值截面缓存（拼音同分排序用）：10 分钟 TTL + 估值日期键，避免每次搜索扫表
_MV_CACHE: dict = {"at": 0., "rows": {}, "key": ""}


def _market_caps(conn) -> dict[str, float]:
    """各标的最新总市值（元）；只用于搜索结果的同分热度排序，失败即空表降级。"""
    try:
        head = conn.execute("SELECT MAX(date) FROM daily_valuation").fetchone()
        key = str(head[0]) if head and head[0] else ""
        now = time.time()
        if key and _MV_CACHE["key"] == key and now - _MV_CACHE["at"] < 600:
            return _MV_CACHE["rows"]
        rows = {r[0]: float(r[1] or 0) for r in conn.execute(
            "SELECT symbol, total_mv FROM daily_valuation"
            " QUALIFY row_number() OVER (PARTITION BY symbol ORDER BY date DESC) = 1"
        ).fetchall()}
        _MV_CACHE.update(at=now, rows=rows, key=key)
        return rows
    except Exception:                       # 估值表缺失/未初始化：热度全部置 0
        return {}


def _py_grade(py: dict, ql: str) -> Optional[int]:
    """拼音命中度（越小越靠前）：缩写全等 4 / 前缀 5 / 包含 6。

    「cd」这类缩写前缀要先出长电科技(cdkj)、成都燃气(cdrq)，而不是被一堆
    中间含 cd 的名称（如辽宁成大 lncd）挤占 limit 名额。"""
    if not ql:
        return None
    abbrs = py.get("abbrs") or [py.get("abbr", "")]
    fulls = py.get("fulls") or [py.get("full", "")]
    if any(a == ql for a in abbrs):
        return 4
    if any(a.startswith(ql) for a in abbrs) or any(f.startswith(ql) for f in fulls):
        return 5
    if any(ql in a for a in abbrs) or any(ql in f for f in fulls):
        return 6
    return None


def abbr_grade(name: Optional[str], ql: str, abbr: Optional[str] = None) -> int:
    """搜索排序用命中度：0 缩写全等 / 1 前缀 / 2 包含 / 9 未命中。

    腾讯联想自带市场口径缩写（长电科技 = cdkj），优先用它；本地行没有该
    字段时用 pypinyin 多音字变体兜底（长 = zhang/chang 两种缩写都试）。
    """
    if not name or not ql:
        return 9
    py = _pinyin_variants(name)
    alts = set(py.get("abbrs") or [py.get("abbr", "")])
    fulls = py.get("fulls") or [py.get("full", "")]
    if abbr:
        alts.add(abbr.lower())
    alts.discard("")
    if not alts:
        return 9
    if ql in alts:
        return 0
    if any(a.startswith(ql) for a in alts) or any(f.startswith(ql) for f in fulls):
        return 1
    if any(ql in a for a in alts) or any(ql in f for f in fulls):
        return 2
    return 9


# 单字拼音缓存：全市场约五千个名称只共享两千多个汉字，按字缓存后
# 一次全表拼音扫描从「逐名解析」的数十秒降到数百毫秒。
_PY_CHAR: dict[str, tuple[list[str], list[str]]] = {}


def _char_py(ch: str) -> tuple[list[str], list[str]]:
    """单字 → (首字母读音变体, 全拼音节变体)。非汉字原样保留；多音字给全部读音。"""
    hit = _PY_CHAR.get(ch)
    if hit is not None:
        return hit
    try:
        from pypinyin import Style, pinyin
        errors = lambda x: list(x)          # noqa: E731
        ini = pinyin(ch, style=Style.FIRST_LETTER, heteronym=True, errors=errors)
        syl = pinyin(ch, style=Style.NORMAL, heteronym=True, errors=errors)
        out = (sorted({o.lower() for o in (ini[0] if ini else [ch])})[:8],
               sorted({o.lower() for o in (syl[0] if syl else [ch])})[:8])
    except Exception:                       # pypinyin 缺失时退化为原字符
        out = ([ch.lower()], [ch.lower()])
    _PY_CHAR[ch] = out
    return out


def _pinyin_variants(name: str) -> dict:
    """名称 → {abbr: 主缩写, abbrs: 多音字缩写变体, full: 全拼, fulls: 全拼变体}。"""
    cached = _PY_CACHE.get(name)
    if cached is not None:
        return cached
    abbrs, fulls = [""], [""]
    for ch in name:
        ini, syl = _char_py(ch)
        abbrs = [a + i for a in abbrs for i in ini][:32]
        fulls = [f + s for f in fulls for s in syl][:32]
    abbr, full = abbrs[0], fulls[0]
    out = {"abbr": abbr, "abbrs": sorted(set(abbrs) | {abbr}),
           "full": full, "fulls": fulls}
    _PY_CACHE[name] = out
    _PY_DISK["dirty"] += 1
    return out


# 拼音索引落盘：全表冷扫描约 3~4s，落盘后重启直接加载（名称极少变化）。
# 文件与 DuckDB 同目录，首次全表扫描后写一次，新增名称增量补写。
_PY_DISK = {"loaded": False, "dirty": 0}
_PY_DISK_LOCK = Lock()


def _py_disk_path(conn) -> Optional[Path]:
    try:
        row = conn.execute("PRAGMA database_list").fetchone()
        return Path(row[2]).parent / "pinyin_cache.json" if row and row[2] else None
    except Exception:
        return None


def _load_pinyin_disk(conn) -> None:
    with _PY_DISK_LOCK:
        if _PY_DISK["loaded"]:
            return
        _PY_DISK["loaded"] = True
        path = _py_disk_path(conn)
        if not path or not path.exists():
            return
        try:
            saved = json.loads(path.read_text())
        except (OSError, ValueError):
            return
        if isinstance(saved, dict):
            _PY_CACHE.update({k: v for k, v in saved.items()
                              if k not in _PY_CACHE and isinstance(v, dict)})


def _save_pinyin_disk(conn) -> None:
    if not _PY_DISK["dirty"]:
        return
    path = _py_disk_path(conn)
    if not path:
        return
    with _PY_DISK_LOCK:
        _PY_DISK["dirty"] = 0
        try:
            path.write_text(json.dumps(_PY_CACHE, ensure_ascii=False, separators=(",", ":")))
        except OSError:
            pass


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

# 目标页行内缩略图缓存：(代码, 最新数据日, 根数) → 近 N 根 K 线/MA45/趋势柱线。
# 只回 300 根历史给 EMA 预热（最长 89 周期衰减后权重 ≈0.1%，肉眼不可见），
# 避免 50 行页面一次按 2000 根做前复权连接把 API 请求拖到数秒。
_SPARK_CACHE: dict[str, dict] = {}
_SPARK_LOCK = Lock()
_SPARK_MAX = 600
_SPARK_HISTORY = 300


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
            "SELECT symbol, data_date, trend_value, cross_date, cross_ago, above_days,"
            " neg_run, neg_abs, money_date, money_ago, money_cnt,"
            " mine_date, mine_ago, mine_cnt FROM target_trend").fetchall()
        return {r[0]: dict(trend_data_date=r[1], trend_value=r[2],
                           trend_cross_date=r[3], trend_cross_ago=r[4],
                           trend_above_days=r[5],
                           # 旧行（neg_run 补列前算的）为 NULL，统一成 0 才能过契约校验
                           neg_run=r[6] or 0, neg_abs=r[7],
                           money_date=r[8], money_ago=r[9],
                           # 旧行（补列前算的）money_cnt 为 NULL，统一成 0 才能过契约校验
                           money_cnt=r[10] or 0,
                           mine_date=r[11], mine_ago=r[12],
                           # 旧行（高点反转补列前算的）mine_cnt 为 NULL，统一成 0
                           mine_cnt=r[13] or 0)
                for r in rows}
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
    from ..target_trend import qyjj_summary, trend_histogram, trend_summary

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
                        summary = trend_summary(
                            [str(r[1]) for r in rows], trend_histogram(bars), calendar)
                        summary.update(qyjj_summary(
                            [str(r[1]) for r in rows], bars))
                        _TGT_TREND_CACHE['rows'][symbol] = summary
                    for symbol in part:                    # 分块完成即记账，重跑不重复
                        _TGT_TREND_CACHE['keys'][symbol] = keys[symbol]
            finally:
                cursor.close()
        return {symbol: row for symbol, row in _TGT_TREND_CACHE['rows'].items() if symbol in keys}


_TAIL_CHUNK = 150       # 与 target_trend 同分块：全市场一次窗口会打满 1.5GiB 内存
_TAIL_HISTORY = 800     # ZigZag 极值判定只依赖近端拐点，800 根足够且显著省内存


def compute_target_tail(conn, live: Optional[dict] = None) -> tuple[list[dict], dict]:
    """尾盘估算：把实时快照价当作「今日收盘」，算阶段反转六字段。

    只在 14:50 之后的盘中任务里调用（收盘前最后 15 分钟价格基本定型）。
    历史取最近 800 根 qfq + 当日快照 close，再跑与正式口径同一个 qyjj；
    ST / 北交所与 target_scan 同规则剔除，快照无成交的标的跳过（无法估算）。
    返回 (rows, meta)，rows 直接写 target_tail；meta 用于审计与展示。"""
    from itertools import groupby
    from ..target_trend import qyjj_summary

    if live is None:
        live = _live_overlay(conn, force=True)
    if live is None:
        return [], {"as_of": "", "snapshot_at": "", "computed_at": "", "scanned": 0}
    day = str(live["date"])
    names = dict(conn.execute("SELECT symbol, name FROM stock_universe").fetchall())
    bj = settings.bj_enabled
    symbols = [s for s, n in names.items()
               if n and "ST" not in str(n).upper() and (bj or not is_bj(s))]
    snap = {r[0]: float(r[1]) for r in conn.execute(
        "SELECT symbol, current FROM market_snapshot"
        " WHERE trade_date = ? AND kind = 'stock'"
        " AND current IS NOT NULL AND volume > 0", [day]).fetchall()}
    if not snap:
        return [], {"as_of": day, "snapshot_at": str(live["updated_at"])[11:16],
                    "computed_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
                    "scanned": 0}
    symbols = [s for s in symbols if s in snap]
    snap_at = str(live["updated_at"])[11:16]
    computed_at = datetime.now().strftime("%Y-%m-%d %H:%M")
    out: list[dict] = []
    cursor = conn.cursor()
    try:
        for i in range(0, len(symbols), _TAIL_CHUNK):
            part = symbols[i:i + _TAIL_CHUNK]
            placeholders = ','.join('?' for _ in part)
            cursor.execute(f"""
                SELECT symbol, date, close FROM v_daily_ohlcv_qfq
                WHERE symbol IN ({placeholders}) AND date < ?
                QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) <= {_TAIL_HISTORY}
                ORDER BY symbol, date
            """, [*part, day])

            def records():
                while batch := cursor.fetchmany(8192):
                    yield from batch

            for symbol, group in groupby(records(), key=lambda row: row[0]):
                rows = list(group)
                if not rows or any(row[2] is None for row in rows):
                    continue
                dates = [str(r[1]) for r in rows] + [day]
                bars = [{"close": float(r[2])} for r in rows] + [{"close": snap[symbol]}]
                out.append({"symbol": symbol, "data_date": day,
                            "snapshot_at": snap_at, "computed_at": computed_at,
                            **qyjj_summary(dates, bars)})
    finally:
        cursor.close()
    return out, {"as_of": day, "snapshot_at": snap_at,
                 "computed_at": computed_at, "scanned": len(out)}


def target_tail_snapshot(conn) -> Optional[dict]:
    """尾盘估算表最新一日；None = 未生成 / 覆盖不足 / 旧库无表。

    是否采用由调用方判定（估算日必须新于正式 target_trend 且等于快照日），
    这里只负责取数。"""
    try:
        head = conn.execute(
            "SELECT MAX(data_date), MAX(snapshot_at), MAX(computed_at) FROM target_tail"
        ).fetchone()
        if not head or not head[0]:
            return None
        cnt = conn.execute("SELECT COUNT(*) FROM target_tail WHERE data_date = ?",
                           [head[0]]).fetchone()[0]
        if int(cnt or 0) < 500:
            return None
        rows = conn.execute(
            "SELECT symbol, money_date, money_ago, money_cnt,"
            " mine_date, mine_ago, mine_cnt FROM target_tail WHERE data_date = ?",
            [head[0]]).fetchall()
        return {"data_date": str(head[0]), "snapshot_at": head[1] or "",
                "computed_at": head[2] or "",
                "rows": {r[0]: dict(money_date=r[1], money_ago=r[2], money_cnt=r[3] or 0,
                                    mine_date=r[4], mine_ago=r[5], mine_cnt=r[6] or 0)
                         for r in rows}}
    except Exception:
        return None


def target_sparks(conn, symbols, bars: int = 60) -> dict:
    """目标页行内缩略图：近 bars 根前复权日线 + MA45（中线趋势）+ STICKV 柱线。

    批量一次查询、按（代码, 最新数据日, 根数）缓存；单请求最多 60 只。
    与 target_trend 同口径（v_daily_ohlcv_qfq + trend_histogram），但只回
    300 根历史做 EMA 预热——缩略图看形态，不需要 2000 根全量重算。"""
    from itertools import groupby
    from ..target_trend import trend_histogram

    syms: list[str] = []
    seen: set[str] = set()
    for s in symbols:
        s = str(s or "").strip()
        if s and s not in seen:
            seen.add(s)
            syms.append(s)
    syms = syms[:60]
    n = max(20, min(int(bars or 60), 250))
    latest = conn.execute("SELECT MAX(date) FROM daily_ohlcv").fetchone()
    day = str(latest[0]) if latest and latest[0] else ""
    out: dict[str, dict] = {}
    todo: list[str] = []
    with _SPARK_LOCK:
        for s in syms:
            hit = _SPARK_CACHE.get(f"{s}|{day}|{n}")
            if hit is None:
                todo.append(s)
            else:
                out[s] = hit
    if not todo:
        return out

    placeholders = ",".join("?" for _ in todo)
    statement = (
        "SELECT symbol, date, open, high, low, close FROM v_daily_ohlcv_qfq "
        f"WHERE symbol IN ({placeholders}) "
        "QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) "
        f"<= {_SPARK_HISTORY} ORDER BY symbol, date")
    rows = conn.execute(statement, todo).fetchall()
    fresh: dict[str, dict] = {}
    for symbol, group in groupby(rows, key=lambda r: r[0]):
        recs = list(group)
        if len(recs) < 2 or any(v is None for r in recs for v in r[2:]):
            continue
        closes = [float(r[5]) for r in recs]
        ma45: list[Optional[float]] = []
        total = 0.0
        for i, c in enumerate(closes):
            total += c
            if i >= 45:
                total -= closes[i - 45]
            ma45.append(total / 45 if i >= 44 else None)
        trend = trend_histogram(
            [dict(high=r[3], low=r[4], close=r[5]) for r in recs])
        tail = recs[-n:]
        tail_closes = closes[-n:]
        tail_ma = ma45[-n:]
        fresh[symbol] = {
            "symbol": symbol,
            "dates": [str(r[1]) for r in tail],
            "open": [round(float(r[2]), 3) for r in tail],
            "high": [round(float(r[3]), 3) for r in tail],
            "low": [round(float(r[4]), 3) for r in tail],
            "close": [round(float(r[5]), 3) for r in tail],
            "ma45": [None if v is None else round(v, 3) for v in tail_ma],
            "strong": [None if v is None else tail_closes[i] >= v
                       for i, v in enumerate(tail_ma)],
            "trend": [None if v is None else round(v, 2) for v in trend[-n:]],
        }
    with _SPARK_LOCK:
        for symbol, item in fresh.items():
            _SPARK_CACHE[f"{symbol}|{day}|{n}"] = item
        while len(_SPARK_CACHE) > _SPARK_MAX:      # 简单 FIFO 淘汰，防长会话内存上涨
            _SPARK_CACHE.pop(next(iter(_SPARK_CACHE)))
    out.update(fresh)
    return out


def live_trend_summaries(conn, symbols, bars: int = 2000) -> dict:
    """盘中用快照合成当日临时日线，重算指定标的 STICKV（识别「今日上穿零轴」）。

    只给「中线橙 + 昨日负柱」候选集用——全市场盘中重算会撞 DuckDB 1.5GiB
    内存上限（与 compute_target_trends 同一教训）。快照缺价、快照落后于日线
    或当日已落库时返回 {}，调用方退回日线口径。"""
    wanted = {str(s) for s in symbols if s}
    if not wanted:
        return {}
    try:
        head = conn.execute("SELECT MAX(trade_date) FROM market_snapshot").fetchone()
        latest = conn.execute("SELECT MAX(date) FROM daily_ohlcv").fetchone()
        if not head or not head[0] or (latest and latest[0] and str(head[0]) < str(latest[0])):
            return {}
        live_date = str(head[0])
        live = {r[0]: (r[1], r[2], r[3]) for r in conn.execute(
            "SELECT symbol, high, low, current FROM market_snapshot"
            " WHERE trade_date = ? AND kind = 'stock' AND current IS NOT NULL"
            " AND high IS NOT NULL AND low IS NOT NULL AND volume > 0",
            [live_date]).fetchall() if r[0] in wanted}
        if not live:
            return {}
        calendar = {str(r[0]): i for i, r in enumerate(
            conn.execute("SELECT DISTINCT date FROM daily_ohlcv ORDER BY date").fetchall())}
        if live_date in calendar:            # 当日已落库：调用方本不该走这里
            return {}
        calendar[live_date] = len(calendar)
        from itertools import groupby
        from ..target_trend import trend_histogram, trend_summary
        out: dict = {}
        symbols = sorted(wanted & set(live))
        cursor = conn.cursor()
        try:
            for i in range(0, len(symbols), 200):
                part = symbols[i:i + 200]
                placeholders = ",".join("?" for _ in part)
                cursor.execute(
                    "SELECT symbol, date, high, low, close FROM v_daily_ohlcv_qfq"
                    f" WHERE symbol IN ({placeholders})"
                    f" QUALIFY ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC)"
                    f" <= {int(bars)} ORDER BY symbol, date", part)

                def records():
                    while batch := cursor.fetchmany(8192):
                        yield from batch

                for symbol, group in groupby(records(), key=lambda r: r[0]):
                    rows_ = list(group)
                    if not rows_ or any(any(v is None for v in r[2:]) for r in rows_):
                        continue
                    h, l, c = live[symbol]
                    hist = [dict(high=r[2], low=r[3], close=r[4]) for r in rows_]
                    hist.append(dict(high=h, low=l, close=c))
                    out[symbol] = trend_summary(
                        [str(r[1]) for r in rows_] + [live_date],
                        trend_histogram(hist), calendar)
        finally:
            cursor.close()
        return out
    except Exception:
        return {}
