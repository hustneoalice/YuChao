#!/usr/bin/env bash
# 驭潮 启动脚本：后端 uvicorn(8031) + 前端 vite(5178)
#   ./scripts/start.sh        默认开发模式：8031 API + 5178 vite 热更（看最新代码用这个）
#   ./scripts/start.sh -d     同默认（兼容旧写法）
#   ./scripts/start.sh -p     生产模式：只启 8031，由后端托管 dist（源码有更新会自动重构建）
#   ./scripts/start.sh -n     启动后不跟随日志
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/.logs"
PID_DIR="$LOG_DIR"
mkdir -p "$LOG_DIR"

DEV=1
FOLLOW=1
for a in "$@"; do
  case "$a" in
    -d|--dev) DEV=1 ;;
    -p|--prod) DEV=0 ;;
    -n|--no-log) FOLLOW=0 ;;
  esac
done

port_pid() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }

start_one() { # name port wait_secs start_cmd
  local name="$1" port="$2" wait="$3"; shift 3
  if [ -n "$(port_pid "$port")" ]; then
    echo "[$name] 已在运行 (port $port)，跳过"
    return 0
  fi
  echo "[$name] 启动中 → port $port, 日志 .logs/$name.log"
  # nohup+disown：脱离启动终端，脚本所属 shell 退出后进程不被杀
  nohup bash -c "$@" >"$LOG_DIR/$name.log" 2>&1 &
  echo $! > "$PID_DIR/$name.pid"
  disown 2>/dev/null || true
  # 等端口就绪（backend 90s：写锁被旧进程只读连接占用时，reaper 最长 90s 才让锁）
  for _ in $(seq 1 $((wait * 2))); do
    [ -n "$(port_pid "$port")" ] && break
    sleep 0.5
  done
  if [ -n "$(port_pid "$port")" ]; then
    echo "[$name] ✓ 就绪"
  else
    echo "[$name] ✗ 启动失败，最近日志：" >&2
    tail -5 "$LOG_DIR/$name.log" >&2
    exit 1
  fi
}

# 生产模式下 dist 必须是最新的：缺失或前端源码比它新都重构建
# （旧逻辑只在缺失时构建，改了代码再 start 会一直看到旧界面）
dist_stale() {
  local dist="$ROOT/frontend/dist/index.html"
  [ -f "$dist" ] || return 0
  [ -n "$(find "$ROOT/frontend/src" "$ROOT/frontend/index.html" "$ROOT/frontend/vite.config.ts" \
      -newer "$dist" -type f 2>/dev/null | head -1)" ]
}

if [ "$DEV" = "0" ] && dist_stale; then
  echo "[frontend] dist 落后于源码，构建中…"
  (cd "$ROOT/frontend" && npm run build >/dev/null)
fi

# 清理残留的 yuchao 后端进程（可能已不在 8031 监听但持有 duckdb 写锁）
if pids=$(pgrep -f "uvicorn app.main:app" 2>/dev/null); then
  echo "[backend] 清理残留进程：$pids"
  kill -TERM $pids 2>/dev/null || true
  sleep 1
fi

start_one backend 8031 90 "cd '$ROOT' && PYTHONUNBUFFERED=1 .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8031 --log-level info"
if [ "$DEV" = "1" ]; then
  start_one frontend 5178 30 "cd '$ROOT/frontend' && npm run dev"
fi

echo
if [ "$DEV" = "1" ]; then
  echo "驭潮已就绪：开发前端 http://localhost:5178 （热更，看最新代码）"
  echo "            API/生产前端 http://127.0.0.1:8031"
else
  echo "驭潮已就绪：http://localhost:8031 （生产模式，前端由后端托管）"
fi
echo "停止：./scripts/stop.sh · 日志：.logs/backend.log$([ "$DEV" = "1" ] && printf ' · .logs/frontend.log' || true)"

# 默认实时显示日志（Ctrl+C 退出查看，服务继续后台运行）；-n 跳过
if [ "$FOLLOW" = "1" ]; then
  echo
  echo "──── 实时日志（Ctrl+C 退出，服务继续运行）────"
  if [ "$DEV" = "1" ]; then
    tail -n 15 -f "$LOG_DIR/backend.log" "$LOG_DIR/frontend.log"
  else
    tail -n 15 -f "$LOG_DIR/backend.log"
  fi
fi
