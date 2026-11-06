"""收盘聚合磁盘缓存；搜索排序分页不再触发全市场统计。"""
import hashlib
import json
import logging
import os
import tempfile
from pathlib import Path
from threading import Lock

from . import mainforce

_locks = [Lock() for _ in range(32)]
_log = logging.getLogger(__name__)
_DEPENDENCIES = ('capital_flow', 'valuation', 'kline_update', 'zy_block_sync',
                 'quotes', 'market_snapshot', 'backfill', 'package_import', 'corepicks')


def _identity(conn):
    db = conn.execute('PRAGMA database_list').fetchone()[2]
    if not db:
        return None, None
    latest = conn.execute('SELECT MAX(date),COUNT(*) FROM capital_flow').fetchone()
    has_log = conn.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_name='update_log'").fetchone()[0]
    updates = conn.execute(
        'SELECT data_type,MAX(created_at),COUNT(*) FROM update_log WHERE data_type IN '
        '(SELECT UNNEST(?)) GROUP BY data_type ORDER BY data_type', [list(_DEPENDENCIES)]).fetchall() if has_log else []
    members = conn.execute('SELECT COUNT(*),BIT_XOR(HASH(block_code,symbol,stock_name)) FROM zy_block_member').fetchone()
    blocks = conn.execute('SELECT COUNT(*),BIT_XOR(HASH(block_code,block_name,type_code,parent_code)) FROM zy_block').fetchone()
    version = hashlib.sha256(repr((latest, updates, members, blocks)).encode()).hexdigest()
    return Path(db).parent / 'mainforce_cache' / Path(db).name, version


def cached_mainforce(conn, view='blocks', type_code=4, block_code=None, period=1,
                     end=None, q=None, sort='-main_net', page=1, size=50, force=False):
    # 所有个股一次计算，板块成分只做结果过滤，避免每次打开都重复查询55日。
    folder, version = _identity(conn)
    scope = (view, type_code if view == 'blocks' else 0, period, str(end or 'latest'))
    key = hashlib.sha256(repr(('v1', scope)).encode()).hexdigest()
    with _locks[int(key[:8], 16) % len(_locks)]:
        path = folder / f'{key}.json' if folder else None
        data = None
        if path and not force:
            try:
                saved = json.loads(path.read_text())
                if saved['version'] == version:
                    data = saved['data']
            except (OSError, ValueError, KeyError):
                pass
        if data is None:
            data = mainforce.list_mainforce(conn, view=view, type_code=type_code,
                                            period=period, end=end, size=100000)
            if path:
                tmp = None
                try:
                    folder.mkdir(parents=True, exist_ok=True)
                    with tempfile.NamedTemporaryFile(mode='w', dir=folder, delete=False) as f:
                        tmp = f.name
                        json.dump(dict(version=version, data=data), f, ensure_ascii=False)
                    os.replace(tmp, path)
                except OSError:
                    _log.warning('军情缓存写入失败，返回本次计算结果', exc_info=True)
                finally:
                    if tmp and os.path.exists(tmp):
                        os.unlink(tmp)
    if view == 'stocks' and block_code:
        members = {r[0] for r in conn.execute(
            'SELECT DISTINCT symbol FROM zy_block_member WHERE block_code=? OR block_code IN '
            '(SELECT block_code FROM zy_block WHERE parent_code=?)', [block_code, block_code]).fetchall()}
        name = conn.execute('SELECT block_name FROM zy_block WHERE block_code=?', [block_code]).fetchone()
        data = dict(data, items=[r for r in data['items'] if r['symbol'] in members],
                    block_name=name[0] if name else None)
    return mainforce.select_mainforce(data, q=q, sort=sort, page=page, size=size)


def prewarm_mainforce(conn, progress=None, cancel=None):
    done = 0
    for period in (1, 3, 5, 10, 34, 55):
        for view, kind in (('blocks', 4), ('blocks', 2), ('blocks', 1), ('stocks', 4)):
            if cancel and cancel():
                return dict(status='cancelled', rows=done)
            cached_mainforce(conn, view=view, type_code=kind, period=period, force=True)
            done += 1
            if progress:
                progress(stage='预计算收盘资金', total=24, done=done, message=f'{period}日 / {view} / {kind}')
    return dict(status='completed', rows=done)
