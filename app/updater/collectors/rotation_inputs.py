"""核心标计算前补齐同日资金分母；实时快照只写入它自身的行情日期。"""
from ..writer import writer


def _tx_quotes(symbols):
    from ...foundation.live import _tx_quotes as fetch
    return fetch(symbols)


def complete_rotation_inputs(day, progress=None, cancel=None):
    conn = writer.conn()
    missing = [r[0] for r in conn.execute(
        'SELECT DISTINCT f.symbol FROM capital_flow f '
        'LEFT JOIN daily_valuation v ON v.symbol=f.symbol AND CAST(v.date AS DATE)=CAST(f.date AS DATE) '
        'LEFT JOIN daily_ohlcv o ON o.symbol=f.symbol AND CAST(o.date AS DATE)=CAST(f.date AS DATE) '
        'WHERE CAST(f.date AS DATE)=? AND '
        '(COALESCE(NULLIF(o.amount,0),v.amount,0)<=0 OR COALESCE(v.circ_mv,0)<=0)', [day]).fetchall()]
    writer.reset()
    rows = []
    for offset in range(0, len(missing), 50):
        if cancel and cancel():
            break
        quotes = _tx_quotes(missing[offset:offset+50])
        for symbol, quote in quotes.items():
            if quote.get('qdate') != str(day):
                continue
            amount, circ = quote.get('amount'), quote.get('circ_mv_yi')
            amount = amount if amount is not None and amount > 0 else None
            circ = circ * 1e8 if circ is not None and circ > 0 else None
            if amount is not None or circ is not None:
                rows.append((symbol, day, amount, circ))
        if progress:
            progress(stage='补齐同日成交额与流通市值', total=len(missing),
                     done=min(offset+50,len(missing)), message=f'有效同日快照 {len(rows)} 只')
    if rows:
        conn = writer.conn()
        conn.executemany(
            'INSERT INTO daily_valuation (symbol,date,amount,circ_mv) VALUES (?,?,?,?) '
            'ON CONFLICT (symbol,date) DO UPDATE SET '
            'amount=CASE WHEN daily_valuation.amount>0 THEN daily_valuation.amount ELSE excluded.amount END, '
            'circ_mv=CASE WHEN daily_valuation.circ_mv>0 THEN daily_valuation.circ_mv ELSE excluded.circ_mv END', rows)
        conn.commit()
        writer.reset()
    return len(rows)
