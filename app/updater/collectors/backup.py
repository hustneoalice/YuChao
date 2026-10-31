"""18:10 库快照备份（2.x 新增；策影仅有启动期 WAL checkpoint，零副本）。

DuckDB 单文件损坏 = 全库归零，恢复靠多车道重采数天。CHECKPOINT 把 WAL
合并进主文件后原子复制整库，滚动保留 BACKUP_KEEP 份；副本再用 read_only
连接读一遍才算成功——复制损坏当场暴露，而不是等恢复那天才发现。
同日已有快照则秒跳：一天一份足够，重复备份只浪费磁盘。
"""
from __future__ import annotations

import logging
import shutil
import time
from datetime import datetime
from pathlib import Path

import duckdb

from ...config import settings
from ..writer import writer

logger = logging.getLogger("yuchao.updater")

BACKUP_KEEP = 7


def run_backup(progress=None, ctx=None) -> dict:
    start = time.time()
    result: dict = {"task": "backup", "status": "running", "rows": 0}
    progress = progress or (lambda **k: None)   # 允许无进度上报直调
    try:
        src = Path(settings.duckdb_path)
        if not src.exists():
            raise FileNotFoundError(f"库文件不存在：{src}")
        bdir = src.parent / "backups"
        stamp = datetime.now().strftime("%Y%m%d")
        dst = bdir / f"{src.stem}_{stamp}.duckdb"
        if dst.exists():
            result.update(status="skipped",
                          detail=f"今日快照已存在（{dst.name}），秒跳")
            return result

        c = writer.conn()
        c.execute("CHECKPOINT")     # WAL 合并进主文件，复制窗口内文件自洽
        writer.reset()

        bdir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)

        # 副本可读校验：连得上、表数读得出，这份快照才敢算数
        chk = duckdb.connect(str(dst), read_only=True)
        try:
            tables = chk.execute(
                "SELECT COUNT(*) FROM information_schema.tables").fetchone()[0]
        finally:
            chk.close()
        size_mb = dst.stat().st_size / 1048576

        # 滚动清理：只留最近 BACKUP_KEEP 份
        olds = sorted(bdir.glob(f"{src.stem}_*.duckdb"),
                      key=lambda p: p.stat().st_mtime)
        pruned = 0
        for p in olds[:-BACKUP_KEEP]:
            p.unlink(missing_ok=True)
            pruned += 1

        result.update(status="success", rows=1,
                      detail=f"快照 {dst.name}（{size_mb:.1f} MB，{tables} 张表）"
                             + (f"，清理 {pruned} 份旧快照" if pruned else ""))
    except Exception as e:
        result.update(status="failed", error=f"{type(e).__name__}: {str(e)[:200]}")
        logger.exception("[Backup] 库快照失败")
    result["elapsed"] = round(time.time() - start, 1)
    return result
