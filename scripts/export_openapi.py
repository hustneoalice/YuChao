"""导出 OpenAPI 契约：contracts 是唯一出处 → clients/ts 由它生成。

用法：python scripts/export_openapi.py [out.json]
TS 客户端：bash scripts/gen_ts_client.sh（内部先跑本脚本）
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.main import app  # noqa: E402


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else \
        Path(__file__).resolve().parent.parent / "openapi.json"
    spec = app.openapi()
    out.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OpenAPI 契约已导出：{out}（{len(spec['paths'])} paths）")


if __name__ == "__main__":
    main()
