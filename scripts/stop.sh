#!/usr/bin/env bash
# 驭潮 停止脚本：按 PID 优雅终止，兜底按端口清理
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_DIR="$ROOT/.logs"

stop_one() { # name port
  local name="$1" port="$2"
  local pid_file="$PID_DIR/$name.pid" pids=""
  [ -f "$pid_file" ] && pids=$(cat "$pid_file")
  # PID 文件中的进程可能已不在监听；最终以端口实际占用者为准
  local port_pids; port_pids=$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$pids$port_pids" ]; then
    echo "[$name] 未在运行"
    rm -f "$pid_file"; return 0
  fi
  for p in $pids $port_pids; do
    kill -TERM "$p" 2>/dev/null || true
  done
  # 最多等 5s：以「进程是否退出」为准——收尾阶段端口可能先释放而进程仍在持库锁
  local alive
  for _ in $(seq 1 10); do
    alive=""
    for p in $pids $port_pids; do
      kill -0 "$p" 2>/dev/null && alive="$alive $p"
    done
    [ -z "$alive" ] && break
    sleep 0.5
  done
  # 兜底 KILL：凡仍存活的（含已释放端口但未退出的）一律强杀
  for p in $pids $port_pids; do
    if kill -0 "$p" 2>/dev/null; then
      kill -KILL "$p" 2>/dev/null || true
    fi
  done
  echo "[$name] 已停止 (port $port)"
  rm -f "$pid_file"
}

stop_one frontend 5178
stop_one backend 8031
echo "完成"
