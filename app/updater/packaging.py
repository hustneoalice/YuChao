"""离线数据包：导出 / 校验 / 导入（PRD F14 · P1，M3）。

README 承诺「初始数据包 GitHub Release + SHA256 校验」在这里兑现。包协议：
    yuchao_data_YYYYMMDD_HHMMSS.duckdb   主文件（行情底座全量快照）
    yuchao_data_*.manifest.json          SHA256 / 大小 / 各表行数 / 抽样清单

导入导出全部经编排器在 updater 进程排队执行——与更新任务互斥（同一写者），
DuckDB 读取不受影响。导入 = 校验通过后换库（旧库留 .bak），再 ensure_schema
重建 update_log / 新表 / 复权视图。

抽样协议：manifest 记录各表前 3 行（按首列排序），导入/校验时逐表比对——
校 SHA256 之外再确认「行数对得上、数据真的是那张表」。
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Optional

from ..config import settings
from .writer import writer

# 数据包包含的表（与 repo.data._INVENTORY 同一口径；缺失的表跳过并记录）
EXPORT_TABLES: tuple[str, ...] = (
    "daily_ohlcv", "adjust_factor", "capital_flow", "financials",
    "stock_universe", "sector_index", "daily_valuation",
    "corepicks_result", "stock_profile",
)

_SAMPLE_N = 3


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _table_rows(conn, table: str) -> Optional[int]:
    try:
        return int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    except Exception:
        return None


def _sample(conn, table: str, catalog: str = "main") -> list[list]:
    try:
        cols = [r[0] for r in conn.execute(
            f"SELECT column_name FROM information_schema.columns "
            f"WHERE table_catalog='{catalog}' AND table_schema='main' AND table_name='{table}' "
            f"ORDER BY column_index").fetchall()]
        if not cols:
            return []
        first = cols[0]
        rows = conn.execute(
            f"SELECT * FROM {catalog}.{table} ORDER BY {first} LIMIT {_SAMPLE_N}").fetchall()
        return [[str(v) for v in r] for r in rows]
    except Exception:
        return []


def export_package(out_dir: str | None = None, progress: Optional[Callable] = None,
                   cancel_check: Optional[Callable] = None) -> dict:
    """当前底座 → 数据包 + manifest（updater 进程内执行，编排器排队）。"""
    out = Path(out_dir or settings.export_dir).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    pkg_path = out / f"yuchao_data_{ts}.duckdb"
    manifest_path = out / f"yuchao_data_{ts}.manifest.json"

    c = writer.conn()
    if progress:
        progress(stage="复制表数据")
    c.execute(f"ATTACH '{pkg_path.as_posix()}' AS pkg")
    try:
        copied: dict[str, int] = {}
        for i, t in enumerate(EXPORT_TABLES):
            if cancel_check and cancel_check():
                raise RuntimeError("已取消")
            rows = _table_rows(c, t)
            if rows is None:                       # 表未建（旧库缺新表）→ 跳过
                continue
            c.execute(f"CREATE OR REPLACE TABLE pkg.{t} AS SELECT * FROM {t}")
            copied[t] = rows
            if progress:
                progress(stage=f"导出 {t}", done=i + 1, total=len(EXPORT_TABLES),
                         rows=sum(copied.values()))
    finally:
        c.execute("DETACH pkg")

    # 行数 / 抽样以落盘后的包文件为准（不是源库口径）
    import duckdb
    pkg_conn = duckdb.connect(str(pkg_path), read_only=True)
    try:
        tables = {t: _table_rows(pkg_conn, t) or 0 for t in EXPORT_TABLES
                  if _table_rows(pkg_conn, t) is not None}
        sampled = {t: _sample(pkg_conn, t) for t in tables}
    finally:
        pkg_conn.close()

    manifest = {
        "format": "yuchao-data-package",
        "format_version": 1,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "source_path": str(writer.db_path),
        "package": pkg_path.name,
        "sha256": _sha256(pkg_path),
        "size_bytes": pkg_path.stat().st_size,
        "tables": tables,
        "sampled": sampled,
        "total_rows": sum(tables.values()),
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                             encoding="utf-8")
    if progress:
        progress(stage="完成", rows=manifest["total_rows"],
                 message=f"{pkg_path.name} · SHA256 {manifest['sha256'][:16]}…")
    return {"status": "completed", "rows": manifest["total_rows"],
            "package": str(pkg_path), "manifest": str(manifest_path),
            "sha256": manifest["sha256"],
            "detail": f"导出 {len(tables)} 表 {manifest['total_rows']} 行"}


def verify_package(pkg_path: str | Path,
                   manifest_path: str | Path | None = None) -> dict:
    """SHA256 → 行数 → 抽样 三级校验（导入前的唯一关卡）。"""
    pkg = Path(pkg_path).expanduser().resolve()
    if not pkg.exists():
        raise FileNotFoundError(f"数据包不存在：{pkg}")
    mpath = Path(manifest_path) if manifest_path else pkg.with_name(
        pkg.stem + ".manifest.json")
    if not mpath.exists():
        raise FileNotFoundError(f"manifest 不存在：{mpath}（SHA256 校验必须有账）")
    manifest = json.loads(mpath.read_text(encoding="utf-8"))

    actual_sha = _sha256(pkg)
    if actual_sha != manifest.get("sha256"):
        raise ValueError(
            f"SHA256 不匹配：manifest={manifest.get('sha256')} actual={actual_sha}")
    if pkg.stat().st_size != manifest.get("size_bytes"):
        raise ValueError("包大小与 manifest 不一致")

    import duckdb
    conn = duckdb.connect(str(pkg), read_only=True)
    try:
        for t, rows in (manifest.get("tables") or {}).items():
            actual = _table_rows(conn, t)
            if actual != rows:
                raise ValueError(f"行数不匹配：{t} manifest={rows} actual={actual}")
            expect = manifest.get("sampled", {}).get(t)
            if expect and _sample(conn, t) != expect:
                raise ValueError(f"抽样不一致：{t}（数据对不上 manifest）")
    finally:
        conn.close()
    return manifest


def import_package(pkg_path: str | Path, manifest_path: str | Path | None = None,
                   progress: Optional[Callable] = None) -> dict:
    """校验 → 换库（旧库 .bak）→ 重建 schema。updater 进程内执行。"""
    if progress:
        progress(stage="校验数据包")
    manifest = verify_package(pkg_path, manifest_path)
    live = Path(settings.duckdb_path)
    backup = live.with_name(live.name + ".bak")

    # 先释放本线程可能持有的写连接，再动文件（DuckDB 文件替换期间旧连接读旧 inode，无害）
    writer.reset()
    if progress:
        progress(stage="替换库文件")
    if live.exists():
        if backup.exists():
            backup.unlink()
        os.replace(live, backup)
    shutil.copy2(Path(pkg_path).expanduser().resolve(), live)
    writer.ensure_schema()                     # 新文件补 update_log/新表/复权视图
    if progress:
        progress(stage="完成", rows=manifest.get("total_rows", 0),
                 message=f"已导入 {Path(pkg_path).name}（原库备份为 {backup.name}）")
    return {"status": "completed", "rows": int(manifest.get("total_rows", 0)),
            "detail": f"导入成功，SHA256 {manifest['sha256'][:16]}…，"
                      f"原库备份为 {backup.name}"}


# -- 编排器任务函数（registry fn 指向这里；ctx = {package?, out_dir?, ...}) ----

def run_export(progress, ctx: dict) -> dict:
    return export_package(ctx.get("out_dir"), progress=progress,
                          cancel_check=ctx.get("cancel_check"))


def run_import(progress, ctx: dict) -> dict:
    pkg = ctx.get("package")
    if not pkg:
        raise ValueError("缺少 package 参数（POST /data/init mode=import package=…）")
    return import_package(pkg, ctx.get("manifest"), progress=progress)


def run_backfill(progress, ctx: dict) -> dict:
    """历史回补（init mode=backfill）：行情→估值→资金流→K线串行补齐。

    多源降级在各采集器内部（腾讯↔东财车道切换）。单步失败记录后继续，
    不让一个源的故障拖垮整条回补链。
    """
    from .registry import TASKS, resolve_fn

    steps = ("quotes", "valuation", "capital_flow", "kline_update")
    fns = {t["kind"]: resolve_fn(t) for t in TASKS if t["kind"] in steps}
    results: dict[str, dict] = {}
    total_rows = 0
    for i, kind in enumerate(steps):
        if ctx.get("cancel_check") and ctx["cancel_check"]():
            return {"status": "cancelled", "rows": total_rows,
                    "detail": f"回补在第 {i + 1}/{len(steps)} 步被取消"}
        progress(stage=f"回补 {kind}", done=i, total=len(steps),
                 rows=total_rows, log=f"开始 {kind}")
        try:
            sub_ctx = dict(ctx)
            sub_ctx["bus"] = ctx.get("bus")
            res = fns[kind](progress, sub_ctx) or {}
            results[kind] = {"status": res.get("status", "completed"),
                             "rows": int(res.get("rows", 0) or 0)}
        except Exception as e:                 # 单步失败不拖垮整链
            results[kind] = {"status": "failed", "rows": 0, "error": f"{type(e).__name__}: {e}"}
        total_rows += results[kind].get("rows", 0)
        progress(stage=f"回补 {kind} 完成", done=i + 1, total=len(steps),
                 rows=total_rows)
    failed = [k for k, v in results.items() if v["status"] == "failed"]
    skipped = [k for k, v in results.items() if v["status"] == "skipped"]
    detail = "；".join(f"{k}={v['status']}" for k, v in results.items())
    return {"status": "failed" if len(failed) == len(steps) else "completed",
            "rows": total_rows,
            "error": f"回补失败步骤: {', '.join(failed)}" if failed else "",
            "detail": detail + (f"（skipped: {', '.join(skipped)}）" if skipped else "")}
