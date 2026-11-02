#!/usr/bin/env bash
# 一键推送到云服务器：本地构建前端 → rsync 代码 → 远程装依赖/重启 → 健康检查。
#
#   ./scripts/deploy.sh              日常发布：只推代码与 dist，数据由服务器自己更新
#   ./scripts/deploy.sh --data       首次/重置：把本地 DuckDB 一并推上去（需先停本地写者）
#   ./scripts/deploy.sh --first      首次部署：= --data + 服务器 bootstrap（venv/systemd/Caddy）
#
# 环境变量：YUCHAO_HOST（默认 ubuntu@120.53.7.176）、YUCHAO_REMOTE_DIR（默认 /home/ubuntu/yuchao）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${YUCHAO_HOST:-ubuntu@120.53.7.176}"
REMOTE_DIR="${YUCHAO_REMOTE_DIR:-/home/ubuntu/yuchao}"
# ControlMaster 复用一条 SSH 连接：云主机对短时间大量新建连接会限流（表现就是
# 第 0 步通了、紧接着 rsync 却 connect timeout）。脚本结束统一关闭主连接。
CTL="$HOME/.ssh/yuchao-deploy-%r@%h-%p"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10
          -o ControlMaster=auto -o "ControlPath=$CTL" -o ControlPersist=120)
ssh_cleanup() { ssh -o "ControlPath=$CTL" -O exit "$HOST" >/dev/null 2>&1 || true; }
trap ssh_cleanup EXIT

WITH_DATA=0
FIRST=0
for a in "$@"; do
  case "$a" in
    --data) WITH_DATA=1 ;;
    --first) WITH_DATA=1; FIRST=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数：$a" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "[0/4] 检查 SSH 连通"
# 公网首连偶发超时（服务器侧限流/跨境抖动），建立 master 前重试几次
CONNECTED=0
for i in 1 2 3 4 5; do
  if ssh "${SSH_OPTS[@]}" "$HOST" 'true'; then CONNECTED=1; break; fi
  echo "连接失败，重试 $i/5…" >&2; sleep 3
done
if [ "$CONNECTED" != "1" ]; then
  echo "免密登录失败：先执行 ssh-copy-id ${HOST}（或设 YUCHAO_HOST）" >&2; exit 1
fi

say "[1/4] 本地构建前端（tsc --noEmit && vite build）"
(cd "$ROOT/frontend" && npm run build >/tmp/yuchao_build.log 2>&1) || {
  echo "前端构建失败：" >&2; tail -30 /tmp/yuchao_build.log >&2; exit 1
}
echo "构建通过"

say "[2/4] 同步代码 → $REMOTE_DIR"
ssh "${SSH_OPTS[@]}" "$HOST" "mkdir -p '$REMOTE_DIR/data' '$REMOTE_DIR/.logs'"
# macOS 自带的 /usr/bin/rsync 2.6.9 最稳（homebrew 的 openrsync 不支持 --info=progress2）
RSYNC="${RSYNC:-/usr/bin/rsync}"
"$RSYNC" -az --delete \
  --exclude '.git' --exclude '.venv' --exclude 'node_modules' \
  --exclude '.logs' --exclude '.playwright-cli' --exclude '.workbuddy' \
  --exclude '.trae' --exclude '.artifacts' --exclude 'docs/investigations' \
  --exclude 'data' --exclude '__pycache__' --exclude '.pytest_cache' \
  -e "ssh ${SSH_OPTS[*]}" \
  "$ROOT/" "$HOST:$REMOTE_DIR/"
echo "代码已同步"

# 依赖/数据只在必要时动，日常发布保持不变
if [ "$WITH_DATA" = "1" ]; then
  say "[3/4] 同步数据底座（先停远端服务，压缩上传后解压）"
  if pgrep -f "uvicorn app.main" >/dev/null 2>&1; then
    echo "本地服务正在运行（内置更新内核持有写锁），先停再传数据：./scripts/stop.sh" >&2; exit 1
  fi
  ssh "${SSH_OPTS[@]}" "$HOST" 'sudo systemctl stop yuchao-api 2>/dev/null || true'
  TMP="$ROOT/data/scratch_deploy"
  mkdir -p "$TMP"
  echo "压缩中（zstd -1，约 1.16GB → 0.57GB）…"
  zstd -q -1 -T0 -f "$ROOT/data/stock_research.duckdb" -o "$TMP/db.zst"
  "$RSYNC" -a --progress -e "ssh ${SSH_OPTS[*]}" \
    "$TMP/db.zst" "$HOST:$REMOTE_DIR/data/db.zst"
  ssh "${SSH_OPTS[@]}" "$HOST" "zstd -q -d -f '$REMOTE_DIR/data/db.zst' -o '$REMOTE_DIR/data/stock_research.duckdb' && rm -f '$REMOTE_DIR/data/db.zst' '$REMOTE_DIR/data/stock_research.duckdb.wal'"
  rm -rf "$TMP"
  echo "数据已替换（$(ssh "${SSH_OPTS[@]}" "$HOST" "du -h '$REMOTE_DIR/data/stock_research.duckdb' | cut -f1")）"
fi

if [ "$FIRST" = "1" ]; then
  say "[4/4] 服务器初始化（venv / systemd / Caddy）"
  ssh "${SSH_OPTS[@]}" "$HOST" "cd '$REMOTE_DIR' && bash scripts/server-bootstrap.sh '$REMOTE_DIR'"
else
  say "[4/4] 远程装依赖并重启"
  if ! ssh "${SSH_OPTS[@]}" "$HOST" "[ -d '$REMOTE_DIR/.venv' ]"; then
    echo "服务器尚未初始化，请先跑：./scripts/deploy.sh --first" >&2; exit 1
  fi
  # pyproject 变了才重装依赖（内容哈希存远端，日常发布几乎零耗时）
  LOCAL_HASH=$(shasum "$ROOT/pyproject.toml" | cut -d' ' -f1)
  REMOTE_HASH=$(ssh "${SSH_OPTS[@]}" "$HOST" "cat '$REMOTE_DIR/.deploy-stamp' 2>/dev/null || true")
  if [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
    echo "依赖声明有变化，安装中…"
    ssh "${SSH_OPTS[@]}" "$HOST" "cd '$REMOTE_DIR' && .venv/bin/pip install -q -e . && echo '$LOCAL_HASH' > .deploy-stamp"
  else
    echo "依赖未变化，跳过安装"
  fi
  ssh "${SSH_OPTS[@]}" "$HOST" 'sudo systemctl restart yuchao-api'
fi

PORT="${YUCHAO_API_PORT:-8031}"
say "健康检查"
OK=0
for _ in $(seq 1 30); do
  if ssh "${SSH_OPTS[@]}" "$HOST" "curl -fsS -m 3 http://127.0.0.1:$PORT/healthz >/dev/null"; then
    OK=1; break
  fi
  sleep 1
done
if [ "$OK" = "1" ]; then
  echo "✓ 部署完成：http://${HOST#*@}/"
else
  echo "✗ API 未就绪，查看日志：" >&2
  ssh "${SSH_OPTS[@]}" "$HOST" 'sudo journalctl -u yuchao-api -n 30 --no-pager' >&2
  exit 1
fi
