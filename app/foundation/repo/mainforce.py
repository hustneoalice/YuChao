"""独立军情：当前成分的收盘资金统计，不回填估值或引用未来快照。"""
from datetime import date
from functools import cmp_to_key

from .zyblock import _MEMBER_TREE, _TOP_LEVEL

SORTS = {f'{group}_{metric}' for group in ('main', 'medium', 'small')
         for metric in ('net', 'participation', 'ratio')} | {
             'continuous_inflow_days', 'change_rate', 'limit_up_count', 'name'}


def list_mainforce(conn, view='blocks', type_code=4, block_code=None, period=1,
                   end=None, q=None, sort='-main_net', page=1, size=50):
    as_of = conn.execute('SELECT MAX(CAST(date AS DATE)) FROM capital_flow WHERE CAST(date AS DATE) <= ?',
                         [end or date.max]).fetchone()[0]
    result = dict(items=[], total=0, as_of=str(as_of) if as_of else None,
                  start=None, period=period, days=[],
                  source='驭潮资金统计 / 新浪资金源（收盘）',
                  note='按当前成分聚合历史资金，不能还原历史成分；缺数据不当零，比例仅配对有资金的同日分母，成交额采用同日日线、缺失或零值时采用同日估值表成交额，缺分母返回空；涨停数仅使用同日快照精确涨停价，缺失返回空。',
                  block_name=None)
    blocks = conn.execute(f'SELECT block_code, block_name FROM zy_block b WHERE type_code=? AND {_TOP_LEVEL}',
                          [type_code]).fetchall()
    membership = conn.execute(f'{_MEMBER_TREE} SELECT root_code, symbol FROM mm').fetchall()
    names = dict(conn.execute('SELECT symbol, ANY_VALUE(stock_name) FROM zy_block_member GROUP BY symbol').fetchall())
    universe = dict(conn.execute('SELECT symbol, name FROM stock_universe').fetchall())
    names.update({symbol: name for symbol, name in universe.items() if name})
    groups = {code: set() for code, _ in blocks}
    for code, symbol in membership:
        if code in groups:
            groups[code].add(symbol)
    if block_code:
        meta = conn.execute('SELECT block_name FROM zy_block WHERE block_code=?', [block_code]).fetchone()
        result['block_name'] = meta[0] if meta else None
        scoped = {r[0] for r in conn.execute(
            'SELECT DISTINCT symbol FROM zy_block_member WHERE block_code=? OR block_code IN '
            '(SELECT block_code FROM zy_block WHERE parent_code=?)', [block_code, block_code]).fetchall()}
    else:
        scoped = set(universe) if view == 'stocks' else (set().union(*groups.values()) if groups else set())
    entities = [(s, names.get(s) or s, {s}) for s in sorted(scoped)] if view == 'stocks' else [
        (code, name, groups[code]) for code, name in blocks]
    if q:
        entities = [e for e in entities if q.lower() in e[0].lower() or q.lower() in e[1].lower()]
    result['total'] = len(entities)
    if not as_of:
        return result
    # Only dates are scanned across history; data joins below are bounded to 55 sessions.
    calendar = [r[0] for r in conn.execute(
        'SELECT DISTINCT CAST(date AS DATE) AS d FROM daily_ohlcv WHERE CAST(date AS DATE)<=? '
        'UNION SELECT DISTINCT CAST(date AS DATE) FROM capital_flow WHERE CAST(date AS DATE)<=? '
        'ORDER BY d DESC LIMIT 55', [as_of, as_of]).fetchall()]
    days = sorted(calendar[:period])
    result.update(start=str(days[0]), days=[str(d) for d in days])
    first = min(calendar)
    symbols = sorted(set().union(*(e[2] for e in entities))) if entities else []
    if not symbols:
        symbols = ['']
    rows = conn.execute(
        'SELECT f.symbol, CAST(f.date AS DATE), f.net_main,f.net_medium,f.net_small, '
        'v.circ_mv, COALESCE(NULLIF(o.amount,0),v.amount) FROM capital_flow f '
        'LEFT JOIN daily_valuation v ON v.symbol=f.symbol AND CAST(v.date AS DATE)=CAST(f.date AS DATE) '
        'LEFT JOIN daily_ohlcv o ON o.symbol=f.symbol AND CAST(o.date AS DATE)=CAST(f.date AS DATE) '
        'WHERE CAST(f.date AS DATE) BETWEEN ? AND ? AND f.symbol IN (SELECT UNNEST(?))',
        [first, as_of, symbols]).fetchall()
    flows = {(r[0], r[1]): r[2:] for r in rows}
    quotes = dict((r[0], r[1]) for r in conn.execute(
        'SELECT symbol,pct_chg FROM daily_ohlcv WHERE CAST(date AS DATE)=? AND symbol IN (SELECT UNNEST(?))',
        [as_of, symbols]).fetchall())
    # Precise limit prices are only available in the matching day's snapshot.
    limits = dict(conn.execute(
        "SELECT symbol, CASE WHEN current IS NOT NULL AND up_limit>0 THEN current>=up_limit ELSE NULL END "
        "FROM market_snapshot WHERE CAST(trade_date AS DATE)=? AND kind='stock' AND symbol IN (SELECT UNNEST(?))",
        [as_of, symbols]).fetchall())
    stock_totals = {}
    for symbol in symbols:
        paired = [flows[symbol,d] for d in days if (symbol,d) in flows]
        totals = []
        for i in range(3):
            valid = [r for r in paired if r[i] is not None]
            totals.append((sum(r[i] for r in valid) if valid else None,
                           [sum(r[j] for r in valid) if valid and all(r[j] is not None and r[j] > 0 for r in valid) else None
                            for j in (3,4)]))
        stock_totals[symbol] = (len(paired), totals)
    items = []
    for key, name, members in entities:
        covered = sum(stock_totals[s][0] for s in members)
        row = dict(key=key, name=name, symbol=key if view == 'stocks' else None,
                   block_code=key if view == 'blocks' else None, members=len(members),
                   covered=covered, expected=len(members)*len(days))
        for i, group in enumerate(('main', 'medium', 'small')):
            valid = [stock_totals[s][1][i] for s in members if stock_totals[s][1][i][0] is not None]
            net = sum(r[0] for r in valid) if valid else None
            def percentage(index):
                if not valid or any(r[1][index] is None for r in valid):
                    return None
                return net / sum(r[1][index] for r in valid) * 100
            row[group] = dict(net=net, participation=percentage(0), ratio=percentage(1))
        streak = 0
        for d in calendar:
            daily = [flows.get((s,d)) for s in members]
            if not daily or any(r is None or r[0] is None for r in daily):
                if streak == 0:
                    streak = None
                break
            if sum(r[0] for r in daily) <= 0:
                break
            streak += 1
        changes = [quotes[s] for s in members if quotes.get(s) is not None]
        leaders = [(stock_totals[s][1][0][0], s) for s in members
                   if stock_totals[s][1][0][0] is not None]
        leader = max(leaders)[1] if leaders else None
        row.update(continuous_inflow_days=streak, streak_capped=streak == 55,
                   change_rate=sum(changes)/len(changes) if changes else None,
                   limit_up_count=sum(bool(limits[s]) for s in members) if members and all(limits.get(s) is not None for s in members) else None,
                   top_stock_name=names.get(leader) if leader else None, top_stock_symbol=leader)
        items.append(row)
    result['items'] = items
    return select_mainforce(result, sort=sort, page=page, size=size)


def select_mainforce(result, q=None, sort='-main_net', page=1, size=50):
    items = list(result['items'])
    if q:
        items = [r for r in items if q.lower() in r['key'].lower() or q.lower() in r['name'].lower()]
    result = dict(result, total=len(items))
    field = sort.lstrip('-')
    def value(row):
        if field in ('continuous_inflow_days', 'change_rate', 'limit_up_count', 'name'):
            return row[field]
        group, metric = field.split('_', 1)
        return row[group][metric]
    def compare(a, b):
        av, bv = value(a), value(b)
        if av is None or bv is None:
            return (av is None) - (bv is None)
        return ((av > bv) - (av < bv)) * (-1 if sort.startswith('-') else 1)
    items.sort(key=cmp_to_key(compare))
    result['items'] = items[(page-1)*size:page*size]
    return result
