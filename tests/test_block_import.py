import duckdb
import pytest

from app.updater.collectors import zy_blocks
from app.updater.collectors.zy_local import import_config, parse_config


XML = '''<?xml version="1.0" encoding="gbk"?>
<XMLDATA><b0 name="行业"><b1 n="保险" code="H490200" level="1"><m c="601318" m="1"/></b1>
<b1 n="子级" code="H490201" level="2"><m c="601318" m="1"/><m c="000001" m="1"/></b1></b0>
<b0 name="概念"><b1 n="样本" code="G1" level="1"><m c="601318" m="1"/></b1></b0></XMLDATA>'''


def database():
    c = duckdb.connect()
    c.execute('create table stock_universe(symbol varchar,name varchar,market varchar)')
    c.execute("insert into stock_universe values ('601318','中国平安','SH'),('000001','平安银行','SZ')")
    c.execute('create table zy_block(block_code varchar primary key,block_name varchar,type_code int,parent_code varchar,sort_no int,sync_date date default current_date)')
    c.execute('create table zy_block_member(block_code varchar,symbol varchar,stock_name varchar,primary key(block_code,symbol))')
    return c


def test_gbk_level_and_market_identity(tmp_path):
    path = tmp_path / 'blocks.xml'
    path.write_bytes(XML.encode('gbk'))
    blocks, members = parse_config(path)
    assert blocks[0]['parent_code'] is None  # 不能由 H490200 后缀推断层级
    assert blocks[1]['parent_code'] == 'H490200'
    c = database()
    result = import_config(c, path)
    assert result['members'] == 3  # 错市场的上证000001不冒充平安银行
    assert c.execute('select count(*) from zy_block_member where symbol=\'000001\'').fetchone()[0] == 0
    assert c.execute("select stock_name from zy_block_member limit 1").fetchone()[0] == '中国平安'
    import_config(c, path)
    assert c.execute('select count(*) from zy_block_member').fetchone()[0] == 3


def test_invalid_or_empty_config_preserves_database(tmp_path):
    c = database()
    path = tmp_path / 'blocks.xml'
    path.write_bytes(XML.encode('gbk'))
    import_config(c, path)
    path.write_text('<XMLDATA/>')
    with pytest.raises(ValueError):
        import_config(c, path)
    assert c.execute('select count(*) from zy_block_member').fetchone()[0] == 3


def test_import_accepts_lowercase_and_missing_local_market(tmp_path):
    c = database()
    c.execute("update stock_universe set market='sh' where symbol='601318'")
    path = tmp_path / 'blocks.xml'
    path.write_bytes(XML.encode('gbk'))
    assert import_config(c, path)['members'] == 3
    c.execute("update stock_universe set market=NULL where symbol='601318'")
    assert import_config(c, path)['members'] == 3


def test_remote_partial_success_does_not_clear_other_blocks(monkeypatch):
    c = database()
    c.execute("insert into zy_block values ('A','A',2,NULL,0,current_date),('B','B',2,NULL,1,current_date)")
    c.execute("insert into zy_block_member values ('A','601318','旧'),('B','000001','平安银行')")
    monkeypatch.setattr(zy_blocks.writer, 'conn', lambda: c)
    monkeypatch.setattr(zy_blocks, 'LOCAL_CONFIG', None)
    monkeypatch.setattr(zy_blocks.zy_source, 'fetch_zy_blocks', lambda **kw: [
        dict(block_code=x, block_name=x, type_code=2, parent_code=None, sort_no=i) for i,x in enumerate(['A','B'])])
    monkeypatch.setattr(zy_blocks.zy_source, 'fetch_zy_block_members_all', lambda *a, **kw: {'A':[dict(symbol='601318',stock_name='新')]})
    assert zy_blocks.update_zy_blocks()['status'] == 'success'
    assert c.execute("select stock_name from zy_block_member where block_code='A'").fetchone()[0] == '新'
    assert c.execute("select count(*) from zy_block_member where block_code='B'").fetchone()[0] == 1


def test_parent_child_browsing_counts_members_without_quotes(duckdb_file):
    from app.foundation.repo.zyblock import list_blocks, block_members

    c = duckdb.connect(str(duckdb_file))
    c.execute("insert into zy_block(block_code,block_name,type_code,parent_code,sort_no) values ('ROOT','父行业',4,NULL,1),('CHILD','子行业',4,'ROOT',2)")
    c.execute("insert into zy_block_member values ('ROOT','600519','贵州茅台'),('CHILD','600519','贵州茅台'),('CHILD','888888','无快照样本')")
    roots, _ = list_blocks(c, 4)
    parent = next(r for r in roots if r['block_code'] == 'ROOT')
    assert parent['children'] == 1 and parent['total_members'] == 2 and parent['members'] == 1
    children, total = list_blocks(c, 4, parent_code='ROOT')
    assert total == 1 and children[0]['total_members'] == 2 and children[0]['members'] == 1
    members, total = block_members(c, 'ROOT')
    assert total == 2 and sum(r['symbol'] == '600519' for r in members) == 1
