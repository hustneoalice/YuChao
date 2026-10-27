"""M3 数据包：导出 → manifest 校验 → 篡改拒绝 → 换库导入。"""
import json
import shutil

import duckdb
import pytest

from app.config import settings
from app.updater import packaging, registry
from app.updater.writer import Writer


@pytest.fixture()
def pack_env(duckdb_file, tmp_path, monkeypatch):
    """live 库（拷自夹具）+ 导出目录 + packaging 模块内 writer 重定向。"""
    live = tmp_path / "live.duckdb"
    shutil.copy2(duckdb_file, live)
    monkeypatch.setattr(settings, "duckdb_path", live)
    monkeypatch.setattr(settings, "export_dir", tmp_path / "exports")
    w = Writer(live)
    monkeypatch.setattr(packaging, "writer", w)
    return live


def test_registry_resolves_packaging_fns():
    for kind in ("package_export", "package_import", "backfill"):
        spec = next(t for t in registry.TASKS if t["kind"] == kind)
        assert callable(registry.resolve_fn(spec))


def test_export_manifest_and_verify(pack_env, tmp_path):
    out = packaging.export_package()
    pkg, manifest_path = out["package"], out["manifest"]
    manifest = json.loads(open(manifest_path).read())
    assert manifest["format"] == "yuchao-data-package"
    assert manifest["tables"]["daily_ohlcv"] == 180        # 3 symbols × 60 bars
    assert manifest["tables"]["corepicks_result"] == 1
    assert manifest["sha256"] == packaging._sha256(__import__("pathlib").Path(pkg))
    # 校验通过
    assert packaging.verify_package(pkg)["sha256"] == manifest["sha256"]
    # manifest 行数被改 → 拒绝
    tampered = dict(manifest)
    tampered["tables"] = dict(manifest["tables"], daily_ohlcv=1)
    bad = tmp_path / "bad.manifest.json"
    bad.write_text(json.dumps(tampered))
    with pytest.raises(ValueError, match="行数不匹配"):
        packaging.verify_package(pkg, bad)
    # 包体篡改 → SHA256 拒绝
    data = bytearray(open(pkg, "rb").read())
    data[-8] ^= 0xFF
    open(pkg, "wb").write(bytes(data))
    with pytest.raises(ValueError, match="SHA256"):
        packaging.verify_package(pkg)
    # 缺 manifest → 拒绝
    with pytest.raises(FileNotFoundError, match="manifest"):
        packaging.verify_package(tmp_path / "nope.duckdb")


def test_import_swaps_database(pack_env, tmp_path):
    out = packaging.export_package()
    live = pack_env
    # 破坏 live 库（模拟「导入前」的坏状态）：清空 daily_ohlcv
    c = duckdb.connect(str(live))
    c.execute("DELETE FROM daily_ohlcv")
    c.commit()
    c.close()

    res = packaging.import_package(out["package"], out["manifest"])
    assert res["status"] == "completed"
    packaging.writer.reset()                               # 释放写连接再开只读
    bak = live.with_name("live.duckdb.bak")
    assert bak.exists()                                    # 原库备份
    conn = duckdb.connect(str(live), read_only=True)       # 新库数据回来
    assert conn.execute("SELECT COUNT(*) FROM daily_ohlcv").fetchone()[0] == 180
    tables = {r[0] for r in conn.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='main'").fetchall()}
    conn.close()
    assert "update_log" in tables                          # ensure_schema 重建账本
    assert "v_daily_ohlcv_qfq" in {r[0] for r in duckdb.connect(
        str(live), read_only=True).execute(
        "SELECT view_name FROM duckdb_views() WHERE NOT internal").fetchall()}
