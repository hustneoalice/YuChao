"""众赢板块读取：清单 × 当日快照本地聚合（零上游，DuckDB 单条 SQL）。

板块行情不落表：zy_block_member JOIN market_snapshot 查询时聚合——
板块涨跌口径 = 成分股涨跌幅平均（自有源，众赢清单只当分类体系用）。
"""
from typing import Optional

# 板块列表排序白名单（SQL 片段，键来自 API 查询参数）
_BLOCK_SORT = {
    "-avg_change":  "avg_change DESC NULLS LAST",
    "avg_change":   "avg_change ASC NULLS LAST",
    "-amount":      "amount DESC NULLS LAST",
    "-up_rate":     "(up_count * 1.0 / NULLIF(members, 0)) DESC NULLS LAST",
    "block_code":   "b.sort_no",
}


# 行业（type=4）在众赢是一级板块 + 内嵌子级（采集摊平成两行，parent_code 挂一级）。
# 列表只展示一级（众赢 39 个）；成分按子树合并（一级自身的成分 ∪ 各子级成分，按
# symbol 去重），避免同一只票既在一级又在子级时被重复计数。
_TOP_LEVEL = "COALESCE(NULLIF(NULLIF(b.parent_code, ''), '0'), '') = ''"
_MEMBER_TREE = (
    "WITH mm AS ("
    "  SELECT DISTINCT"
    "    COALESCE(NULLIF(NULLIF(c.parent_code, ''), '0'), c.block_code) AS root_code,"
    "    mem.symbol"
    "  FROM zy_block c JOIN zy_block_member mem ON mem.block_code = c.block_code"
    ")")


def list_blocks(conn, type_code: int, sort: str = "-avg_change",
                page: int = 1, size: int = 50, q: Optional[str] = None):
    """板块列表（成分 × 当日快照聚合）→ (rows, total)。

    行：block_code/block_name/type_code/parent_code/members/up_count/
    down_count/flat_count/avg_change/amount/leader/leader_change。
    无成分或成分无快照 → members=0、行情字段 NULL（前端置灰）。
    仅返回一级板块（行业 39 个）；子级成分合并进一级聚合。
    """
    order = _BLOCK_SORT.get(sort, _BLOCK_SORT["-avg_change"])
    cond, params = f"b.type_code = ? AND {_TOP_LEVEL}", [type_code]
    if q:
        cond += " AND b.block_name LIKE ?"
        params.append(f"%{q}%")
    total = conn.execute(
        f"SELECT COUNT(*) FROM zy_block b WHERE {cond}", params).fetchone()[0]
    day = conn.execute("SELECT MAX(trade_date) FROM market_snapshot").fetchone()[0]
    if not day:
        return [], total
    off = max(0, (max(1, page) - 1) * size)
    rows = conn.execute(
        f"{_MEMBER_TREE} "
        "SELECT b.block_code, b.block_name, b.type_code, b.parent_code, "
        "       COUNT(s.symbol) AS members, "
        "       SUM(CASE WHEN s.change_rate > 0 THEN 1 ELSE 0 END) AS up_count, "
        "       SUM(CASE WHEN s.change_rate < 0 THEN 1 ELSE 0 END) AS down_count, "
        "       AVG(s.change_rate) AS avg_change, "
        "       SUM(s.amount) AS amount, "
        "       ARG_MAX(s.name, s.change_rate) AS leader, "
        "       MAX(s.change_rate) AS leader_change "
        "FROM zy_block b "
        "LEFT JOIN mm ON mm.root_code = b.block_code "
        "LEFT JOIN market_snapshot s ON s.symbol = mm.symbol "
        "     AND s.trade_date = ? AND s.kind = 'stock' "
        f"WHERE {cond} "
        "GROUP BY b.block_code, b.block_name, b.type_code, b.parent_code, b.sort_no "
        f"ORDER BY {order} LIMIT ? OFFSET ?",
        [day] + params + [size, off]).fetchall()
    cols = ("block_code block_name type_code parent_code members up_count "
            "down_count avg_change amount leader leader_change").split()
    out = [dict(zip(cols, r)) for r in rows]
    for d in out:
        d["flat_count"] = max(0, (d["members"] or 0) - (d["up_count"] or 0)
                              - (d["down_count"] or 0))
    return out, total


def block_meta(conn, block_code: str) -> Optional[dict]:
    row = conn.execute(
        "SELECT block_code, block_name, type_code, parent_code "
        "FROM zy_block WHERE block_code = ?", [block_code]).fetchone()
    if not row:
        return None
    return dict(zip(("block_code", "block_name", "type_code", "parent_code"), row))


_MEMBERS_TREE = (
    "WITH mm AS ("
    "  SELECT symbol, ANY_VALUE(stock_name) AS stock_name"
    "  FROM zy_block_member"
    "  WHERE block_code = ? OR block_code IN ("
    "    SELECT block_code FROM zy_block WHERE parent_code = ?)"
    "  GROUP BY symbol"
    ")")


def block_members(conn, block_code: str, sort: str = "-change_rate",
                  page: int = 1, size: int = 50, q: Optional[str] = None):
    """板块成分 × 当日快照（股票口径）→ (rows[BoardRow 形态], total)。
    成分不在快照（停牌/未采）→ 行情字段 NULL，仍返回（清单完整性优先）。
    一级行业自动合并子级成分（按 symbol 去重）。"""
    cond, params = "1 = 1", []
    if q:
        cond += " AND (mm.symbol LIKE ? OR mm.stock_name LIKE ?)"
        params += [f"%{q}%", f"%{q}%"]
    scope = [block_code, block_code]
    total = conn.execute(
        f"{_MEMBERS_TREE} SELECT COUNT(*) FROM mm WHERE {cond}",
        scope + params).fetchone()[0]
    day = conn.execute("SELECT MAX(trade_date) FROM market_snapshot").fetchone()[0]
    if not day:
        return [], total
    order = {"-change_rate": "s.change_rate DESC NULLS LAST",
             "change_rate": "s.change_rate ASC NULLS LAST",
             "-amount": "s.amount DESC NULLS LAST",
             "symbol": "mm.symbol", "name": "mm.stock_name"}.get(sort,
                                                               "s.change_rate DESC NULLS LAST")
    off = max(0, (max(1, page) - 1) * size)
    rows = conn.execute(
        f"{_MEMBERS_TREE} "
        "SELECT COALESCE(s.symbol, mm.symbol) AS symbol, "
        "       COALESCE(s.name, mm.stock_name) AS name, "
        "       s.current, s.change_amount, s.change_rate, s.open, s.high, s.low, "
        "       s.pre_close, s.volume, s.amount, s.turnover_rate, s.vol_ratio, "
        "       s.amplitude, s.bid1, s.bid1_vol, s.ask1, s.ask1_vol, "
        "       s.outer_vol, s.inner_vol, s.market_value, s.circ_value, "
        "       s.up_limit, s.down_limit, s.updated_at "
        "FROM mm "
        "LEFT JOIN market_snapshot s ON s.symbol = mm.symbol "
        "     AND s.trade_date = ? AND s.kind IN ('stock','fund') "
        f"WHERE {cond} ORDER BY {order} LIMIT ? OFFSET ?",
        scope + [day] + params + [size, off]).fetchall()
    out = []
    for r in rows:
        d = dict(zip(("symbol name current change_amount change_rate open high low "
                      "pre_close volume amount turnover_rate vol_ratio amplitude "
                      "bid1 bid1_vol ask1 ask1_vol outer_vol inner_vol "
                      "market_value circ_value up_limit down_limit updated_at").split(), r))
        d["updated_at"] = str(d["updated_at"]) if d["updated_at"] else None
        out.append(d)
    return out, total


def type_counts(conn) -> list[dict]:
    """各类型板块数量（tab 徽标用）。"""
    rows = conn.execute(
        "SELECT type_code, COUNT(*) AS n FROM zy_block GROUP BY type_code").fetchall()
    return [{"type_code": r[0], "n": r[1]} for r in rows]
