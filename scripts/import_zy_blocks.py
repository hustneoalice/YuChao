#!/usr/bin/env python3
"""导入本地众赢BlockConfig快照，默认只预览；--apply事务写入。

运行前停用持有目标DuckDB连接的服务；原软件文件仅保留在本地data目录。
"""
import argparse
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import duckdb
from app.config import settings
from app.updater.collectors.zy_local import LOCAL_CONFIG, import_config, parse_config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    blocks, members = parse_config(args.path)
    if not args.apply:
        print(json.dumps(dict(blocks=len(blocks), raw_members=len(members)), ensure_ascii=False))
        return
    with duckdb.connect(str(settings.duckdb_path)) as conn:
        result = import_config(conn, args.path)
    if args.path.resolve() != LOCAL_CONFIG.resolve():
        shutil.copy2(args.path, LOCAL_CONFIG)
    (LOCAL_CONFIG.parent / 'zy_block_import.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
