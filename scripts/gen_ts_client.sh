#!/bin/bash
# 生成 TS 客户端类型：openapi.json → clients/ts/yuchao.d.ts
# 依赖 node/npx（openapi-typescript 经 npx 拉取，无全局安装）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="${PYTHON:-$ROOT/.venv/bin/python}"
[ -x "$PYTHON" ] || PYTHON=python3
"$PYTHON" scripts/export_openapi.py "$ROOT/openapi.json"
mkdir -p "$ROOT/clients/ts"
npx -y openapi-typescript "$ROOT/openapi.json" -o "$ROOT/clients/ts/yuchao.d.ts"
echo "TS 契约已生成：clients/ts/yuchao.d.ts"
