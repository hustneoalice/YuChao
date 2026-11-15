"""批量写入（DuckDB）：CSV → 无主键临时堆表 → 按键 DELETE + INSERT SELECT。

## 为什么需要它

DuckDB 的 `executemany` 是「逐行绑定 Python 对象」+「逐行维护主键索引」，本机实测
（duckdb 2.0.0，daily_ohlcv 已有 8 万行）只有 ~180 行/秒：20,000 行要 110 秒。
按这个速度，全市场首轮 K 线回补（5,400 标的 × 3,000 根 ≈ 1,600 万行）光写库就要
约 25 小时，HTTP 并发再快也没用（`kline.py` 的写库是主线程串行）。

改成「csv 模块落盘（~30 万行/秒）→ COPY 进无主键临时表（~10 万行/秒）→ 一条
DELETE + 一条 INSERT SELECT」后，同样的 20,000 行只要 0.2 秒（约 1,000 倍），
且**不引入任何新依赖**（不用 pyarrow / pandas，DuckDB 原生 COPY 即可）。

## 语义

- `bulk_upsert(conn, table, columns, rows, keys=(...))`：先按 `keys` 删掉旧行写入新行，
  等价于原来的 `INSERT OR REPLACE`（本仓库里 PK 都是业务键，不依赖 REPLACE 的
  「同键多行取最后一条」副作用）。
- `bulk_insert(conn, table, columns, rows)`：纯追加，用于调用方已 `DELETE` 全表的场景
  （如 target_scan 全量重算）。
- `bulk_update(conn, table, columns, rows, keys=(...))`：只更新 `columns` 里的非键列，
  等价于逐行 `UPDATE ... WHERE 键=...`（quotes.py 的换手率/简称补写）。

任何一步失败（磁盘满、COPY 解析报错、列类型是数组/结构体等）都会自动回退到原来的
`executemany`，语义等价、任务不会失败；回退时打 warning 便于发现。临时表与 CSV 文件
在 `finally` 里清掉，绝不留在库里。
"""
from __future__ import annotations

import csv
import itertools
import logging
import tempfile
from pathlib import Path

logger = logging.getLogger("yuchao.bulk")

# CSV 里的 NULL 哨兵：股票/行情数据里不会出现反斜杠 + N 的组合
_NULL = "\\N"
_types_cache: dict[tuple[str, tuple[str, ...]], tuple[str, ...] | None] = {}
_seq = itertools.count(1)
# 临时表名带序号，避免同一连接上两次写入互相覆盖
_STAGE_PREFIX = "_bulk_stage_"


def _column_types(conn, table: str, columns: tuple[str, ...]) -> tuple[str, ...] | None:
    """从目标表 DESCRIBE 拿列类型；出现数组/结构体等 CSV 装不下的类型返回 None。"""
    cache_key = (table, columns)
    if cache_key in _types_cache:
        return _types_cache[cache_key]
    try:
        described = {r[0].lower(): r[1] for r in conn.execute(f"DESCRIBE {table}").fetchall()}
    except Exception:
        _types_cache[cache_key] = None
        return None
    types: list[str] = []
    for col in columns:
        decl = described.get(col.lower())
        if not decl or "[" in decl or "STRUCT" in decl.upper() or "MAP" in decl.upper():
            _types_cache[cache_key] = None
            return None
        types.append(decl)
    result = tuple(types)
    _types_cache[cache_key] = result
    return result


def _fallback(conn, table, columns, rows, keys, on_conflict: bool) -> int:
    """回退到老的 executemany 路径（逐行绑定，慢但稳）。"""
    cols = ",".join(columns)
    marks = ",".join("?" * len(columns))
    verb = "INSERT OR REPLACE" if (on_conflict and keys) else "INSERT"
    conn.executemany(f"{verb} INTO {table} ({cols}) VALUES ({marks})", rows)
    return len(rows)


def _load_stage(conn, table: str, columns: tuple[str, ...], rows: list) -> str | None:
    """CSV + COPY 把行灌进无主键临时表，返回临时表名；不可用时返回 None。"""
    types = _column_types(conn, table, columns)
    if not types:
        return None
    stage = f"{_STAGE_PREFIX}{next(_seq)}"
    quoted = ", ".join(f'"{c}" {t}' for c, t in zip(columns, types))
    conn.execute(f"CREATE OR REPLACE TEMP TABLE {stage} ({quoted})")
    path = Path(tempfile.mkstemp(suffix=".csv", prefix="yuchao_bulk_")[1])
    try:
        with path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerows([_NULL if v is None else v for v in row] for row in rows)
        cols = ", ".join(f'"{c}"' for c in columns)
        conn.execute(
            f"COPY {stage} ({cols}) FROM '{path.as_posix()}' "
            f"(FORMAT csv, HEADER false, NULLSTR '{_NULL}', QUOTE '\"', ESCAPE '\"')")
    except Exception:
        conn.execute(f"DROP TABLE IF EXISTS {stage}")
        raise
    finally:
        try:
            path.unlink()
        except OSError:
            pass
    return stage


def _drop(conn, stage: str) -> None:
    try:
        conn.execute(f"DROP TABLE IF EXISTS {stage}")
    except Exception:      # 连接已关闭/事务已回滚时忽略
        logger.debug("[Bulk] 临时表 %s 清理失败", stage, exc_info=True)


def bulk_upsert(conn, table: str, columns, rows, keys) -> int:
    """按 `keys` 覆盖写：DELETE 旧键 → INSERT 新行。等价于 INSERT OR REPLACE。"""
    columns = tuple(columns)
    keys = tuple(keys)
    rows = list(rows)
    if not rows:
        return 0
    stage = None
    inserted = False
    try:
        stage = _load_stage(conn, table, columns, rows)
        if stage is None:
            return _fallback(conn, table, columns, rows, keys, True)
        cols = ", ".join(f'"{c}"' for c in columns)
        key_sql = ", ".join(f'"{k}"' for k in keys)
        conn.execute(f"DELETE FROM {table} WHERE ({key_sql}) IN (SELECT {key_sql} FROM {stage})")
        conn.execute(f"INSERT INTO {table} ({cols}) SELECT {cols} FROM {stage}")
        inserted = True
        return len(rows)
    except Exception as exc:
        logger.warning("[Bulk] %s 批量写入失败，回退 executemany：%s: %s",
                       table, type(exc).__name__, str(exc)[:200])
        if inserted:
            return len(rows)
        return _fallback(conn, table, columns, rows, keys, True)
    finally:
        if stage:
            _drop(conn, stage)


def bulk_insert(conn, table: str, columns, rows) -> int:
    """纯追加（调用方已自行清空目标区间）。"""
    columns = tuple(columns)
    rows = list(rows)
    if not rows:
        return 0
    stage = None
    inserted = False
    try:
        stage = _load_stage(conn, table, columns, rows)
        if stage is None:
            return _fallback(conn, table, columns, rows, None, False)
        cols = ", ".join(f'"{c}"' for c in columns)
        conn.execute(f"INSERT INTO {table} ({cols}) SELECT {cols} FROM {stage}")
        inserted = True
        return len(rows)
    except Exception as exc:
        logger.warning("[Bulk] %s 批量写入失败，回退 executemany：%s: %s",
                       table, type(exc).__name__, str(exc)[:200])
        if inserted:
            return len(rows)
        return _fallback(conn, table, columns, rows, None, False)
    finally:
        if stage:
            _drop(conn, stage)


def bulk_update(conn, table: str, columns, rows, keys) -> int:
    """按 `keys` 更新 `columns` 里的非键列（等价于逐行 UPDATE ... WHERE 键）。"""
    columns = tuple(columns)
    keys = tuple(keys)
    rows = list(rows)
    if not rows:
        return 0
    stage = None
    done = False
    try:
        stage = _load_stage(conn, table, columns, rows)
        if stage is None:
            raise RuntimeError("列类型不支持批量装载")
        sets = ", ".join(f'"{c}" = s."{c}"' for c in columns if c not in keys)
        match = " AND ".join(f'{table}."{k}" = s."{k}"' for k in keys)
        conn.execute(f"UPDATE {table} SET {sets} FROM {stage} s WHERE {match}")
        done = True
        return len(rows)
    except Exception as exc:
        logger.warning("[Bulk] %s 批量更新失败，回退逐行 UPDATE：%s: %s",
                       table, type(exc).__name__, str(exc)[:200])
        if done:
            return len(rows)
        sets = ", ".join(f"{c} = ?" for c in columns if c not in keys)
        where = " AND ".join(f"{k} = ?" for k in keys)
        payload = [tuple(r[i] for i, c in enumerate(columns) if c not in keys)
                   + tuple(r[i] for i, c in enumerate(columns) if c in keys) for r in rows]
        conn.executemany(f"UPDATE {table} SET {sets} WHERE {where}", payload)
        return len(rows)
    finally:
        if stage:
            _drop(conn, stage)
