#!/usr/bin/env bash
# 驭潮 启动脚本：后端 uvicorn(8031) + 前端 vite(5178，与 vite.config.ts 一致)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/.logs"
PID_DIR="$LOG_DIR"
mkdir -p "$LOG_DIR"

port_pid() { lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; }

start_one() { # name port start_cmd
  local name="$1" port="$2"; shift 2
  if [ -n "$(port_pid "$port")" ]; then
    echo "[$name] 已在运行 (port $port)，跳过"
    return 0
  fi
  echo "[$name] 启动中 → port $port, 日志 .logs/$name.log"
  # nohup+disown：脱离启动终端，脚本所属 shell 退出后进程不被杀
  nohup bash -c "$@" >"$LOG_DIR/$name.log" 2>&1 &
  echo $! > "$PID_DIR/$name.pid"
  disown 2>/dev/null || true
  # 等端口就绪（最多 30s）
  for _ in $(seq 1 60); do
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

start_one backend 8031 "cd '$ROOT' && .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8031"
start_one frontend 5178 "cd '$ROOT/frontend' && npm run dev"

echo
echo "驭潮已就绪：前端 http://localhost:5178 · 后端 http://127.0.0.1:8031"
echo "停止：./scripts/stop.sh · 日志：.logs/backend.log / .logs/frontend.log"
