"""updater 写连接：DuckDB 唯一写者。

约束（设计文档 03/05 节）：
  - DuckDB 多进程只允许全 read_only → 全系统写路径只有本模块这一条读写连接；
  - 连接非线程安全，编排器串行消费队列，写连接只在编排器工作线程里使用；
  - 落账：record_update → update_log 表（1.0 为内存/文件日志，2.0 显式化成表，
    API 进程只读该表即可看见每次更新的结果）。
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime
from pathlib import Path

import duckdb

from ..config import settings
from ..foundation.db import MIGRATIONS, NEW_TABLES_DDL, PRICE_VIEW_DDL

logger = logging.getLogger("yuchao.updater")

# 2.0 新增落账表（编排器账本；schema 见设计文档 04.1 update_log）
UPDATE_LOG_DDL = """
    CREATE TABLE IF NOT EXISTS update_log (
        id VARCHAR PRIMARY KEY,
        data_type VARCHAR NOT NULL,
        trade_date VARCHAR,
        status VARCHAR NOT NULL,          -- completed | failed | skipped | cancelled
        rows BIGINT DEFAULT 0,
        error VARCHAR,
        detail VARCHAR,
        duration_s DOUBLE,
        trigger VARCHAR,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
"""

_local = threading.local()


class Writer:
    """独占写连接持有者。updater 进程内单例；连接随线程缓存（与 API 同规约）。"""

    def __init__(self, db_path: str | Path | None = None):
        self.db_path = Path(db_path or settings.duckdb_path)

    # -- 连接 -------------------------------------------------------------

    def conn(self) -> duckdb.DuckDBPyConnection:
        if not self.db_path.exists():
            raise FileNotFoundError(
                f"DuckDB 文件不存在：{self.db_path}（先用 scripts/ensure_schema.py 初始化）")
        c = getattr(_local, "wconn", None)
        if c is None:
            # 跨进程锁协调：API 进程的只读连接空闲 90s 后由 reaper 自动关闭让锁，
            # 这里写连接拿不到锁时重试等待（3s × 50 = 150s，覆盖空闲窗口 + 余量）
            import time
            for i in range(50):
                try:
                    c = duckdb.connect(str(self.db_path), read_only=False)
                    break
                except duckdb.IOException as e:
                    if "Could not set lock" not in str(e) or i == 49:
                        raise
                    if i == 0:
                        logger.warning("写锁被占用（API 只读连接），等待释放后重试…")
                    time.sleep(3)
            _local.wconn = c
        return c

    def reset(self) -> None:
        c = getattr(_local, "wconn", None)
        if c is not None:
            try:
                c.close()
            except Exception:
                pass
            _local.wconn = None

    # -- schema（幂等；含复权视图口径单处定义） ---------------------------

    def ensure_schema(self) -> None:
        c = self.conn()
        for stmt in UPDATE_LOG_DDL.split(";"):
            stmt = stmt.strip()
            if stmt:
                c.execute(stmt)
        for stmt in NEW_TABLES_DDL.split(";"):
            stmt = stmt.strip()
            if stmt:
                c.execute(stmt)
        for stmt in MIGRATIONS:        # 存量表迁移（幂等）
            c.execute(stmt)
        for stmt in PRICE_VIEW_DDL.split(";"):
            stmt = stmt.strip()
            if stmt:
                c.execute(stmt)
        c.commit()

    # -- 落账 -------------------------------------------------------------

    def record_update(self, data_type: str, status: str, rows: int = 0,
                      error: str = "", detail: str = "",
                      duration_s: float | None = None,
                      trigger: str = "", trade_date: str | None = None) -> None:
        """编排器账本：任何一次外部触发的更新都必须在这里留一行——
        否则任务失败只躺在 logger 里，等于「静默消失」（1.0 教训）。"""
        import uuid

        try:
            self.conn().execute(
                "INSERT OR REPLACE INTO update_log "
                "(id, data_type, trade_date, status, rows, error, detail, "
                " duration_s, trigger, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                [uuid.uuid4().hex[:16], data_type, trade_date, status, int(rows),
                 (error or "")[:2000], (detail or "")[:500], duration_s,
                 trigger, datetime.now()],
            )
            self.conn().commit()
        except Exception as e:                      # 落账失败不影响任务本身
            logger.error("[Writer] update_log 落账失败: %s", e)


writer = Writer()
