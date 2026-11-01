#!/usr/bin/env bash
# 驭潮 启动脚本：后端 uvicorn(8031) 同时托管前端 dist —— 只开一个口。
#   ./scripts/start.sh        日常使用（前端由 8031 托管，无 vite）
#   ./scripts/start.sh -d     开发模式：额外启动 vite(5178) 热更
#   ./scripts/start.sh -n     启动后不跟随日志
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/.logs"
PID_DIR="$LOG_DIR"
mkdir -p "$LOG_DIR"

DEV=0
for a in "$@"; do [ "$a" = "-d" ] && DEV=1; done

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

# dist 缺失则先构建（8031 托管的前提）
if [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  echo "[frontend] dist 缺失，构建中…"
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
  echo "驭潮已就绪：开发前端 http://localhost:5178 · 生产前端/后端 http://127.0.0.1:8031"
else
  echo "驭潮已就绪：http://localhost:8031 （前端+后端同一端口）"
fi
echo "停止：./scripts/stop.sh · 日志：.logs/backend.log"

# 默认实时显示日志（Ctrl+C 退出查看，服务继续后台运行）；-n 跳过
if ! printf '%s\n' "$@" | grep -q '^-*n$'; then
  echo
  echo "──── 实时日志（Ctrl+C 退出，服务继续运行）────"
  if [ "$DEV" = "1" ]; then
    tail -n 15 -f "$LOG_DIR/backend.log" "$LOG_DIR/frontend.log"
  else
    tail -n 15 -f "$LOG_DIR/backend.log"
  fi
fi
