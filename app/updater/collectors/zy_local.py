"""Windows BlockConfig 本地快照导入；市场与层级以原字段为准。"""
from pathlib import Path
import hashlib
import xml.etree.ElementTree as ET

from ...config import settings
from .http import market_prefix

LOCAL_CONFIG = settings.duckdb_path.parent / 'zy_block_config.xml'
TYPES = {'地域': 1, '概念': 2, '行业': 4, '雷达': 6, '风格': 8, '题材': 9}
MARKETS = {'1': 'SH', '1001': 'SZ', '1008': 'SZ', '7': 'SH', '5001': 'BJ'}


def parse_config(path):
    raw = Path(path).read_bytes()
    encoding = 'gb18030' if b'gb' in raw[:100].lower() else 'utf-8-sig'
    root = ET.fromstring(raw.decode(encoding))
    blocks, members = [], []
    for group in root:
        kind = TYPES.get(group.get('name'))
        if kind is None:
            continue
        parent = None
        for node in group:
            code, name = node.get('code'), node.get('n')
            if not code or not name:
                continue
            level = node.get('level')
            if level == '1':
                parent = code
            elif level != '2' or parent is None:
                raise ValueError('板块层级缺失或子级无父级')
            blocks.append(dict(block_code=code, block_name=name, type_code=kind,
                               parent_code=parent if level == '2' else None, sort_no=len(blocks)))
            for item in node:
                symbol, market = item.get('c', ''), MARKETS.get(item.get('m'))
                if len(symbol) == 6 and symbol.isascii() and symbol.isdigit() and market:
                    members.append((code, symbol, market))
    if not blocks or not members or len({b['block_code'] for b in blocks}) != len(blocks):
        raise ValueError('板块配置为空或代码重复，保留原数据')
    return blocks, members


def import_config(conn, path):
    blocks, members = parse_config(path)
    universe = {(s, (m or market_prefix(s)).upper()): n
                for s, n, m in conn.execute('SELECT symbol,name,market FROM stock_universe').fetchall()}
    rows = list({(code, s, universe[s, m]) for code, s, m in members if (s, m) in universe})
    if not rows:
        raise ValueError('板块成分与本地股票池没有交集，保留原数据')
    conn.execute('BEGIN TRANSACTION')
    try:
        conn.executemany('INSERT OR REPLACE INTO zy_block (block_code,block_name,type_code,parent_code,sort_no) VALUES (?,?,?,?,?)',
                         [(b['block_code'],b['block_name'],b['type_code'],b['parent_code'],b['sort_no']) for b in blocks])
        for b in blocks:
            conn.execute('DELETE FROM zy_block_member WHERE block_code=?', [b['block_code']])
        conn.execute('INSERT INTO zy_block_member SELECT UNNEST(?),UNNEST(?),UNNEST(?)',
                     [list(col) for col in zip(*rows)])
        conn.execute('COMMIT')
    except Exception:
        conn.execute('ROLLBACK')
        raise
    return dict(blocks=len(blocks), members=len(rows), stocks=len({r[1] for r in rows}),
                source=str(path), sha256=hashlib.sha256(Path(path).read_bytes()).hexdigest())
