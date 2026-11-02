#!/usr/bin/env bash
# 云服务器首次初始化（幂等，可重复执行）：
#   venv + 依赖 → systemd 双进程（只读 API / 写者 updater）→ Caddy 反代 80。
# 用法（在服务器上，代码已 rsync 到位后）：
#   bash scripts/server-bootstrap.sh [/home/ubuntu/yuchao]
# 环境变量：YUCHAO_API_PORT 默认 8031；YUCHAO_DOMAIN 默认 :80（可填域名走自动 HTTPS）
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
PORT="${YUCHAO_API_PORT:-8031}"
DOMAIN="${YUCHAO_DOMAIN:-:80}"
RUN_USER="$(id -un)"

echo "[1/5] 目录与 venv"
mkdir -p "$ROOT/data" "$ROOT/.logs"
# Ubuntu 最小镜像默认不带 ensurepip，venv 创建会失败
if ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
  echo "安装 python3-venv…"
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv
fi
[ -d "$ROOT/.venv" ] || python3 -m venv "$ROOT/.venv"
"$ROOT/.venv/bin/pip" install -q -U pip
"$ROOT/.venv/bin/pip" install -q -e "$ROOT"

echo "[2/4] systemd: yuchao-api（单进程：只读 API + 内置更新内核）"
# 默认 api_embedded_updater=true：编排器/调度链/写者都并入 uvicorn，
# 不再单独跑 app.updater（双进程会抢 DuckDB 写锁、双调度重复触发）
sudo tee /etc/systemd/system/yuchao-api.service >/dev/null <<UNIT
[Unit]
Description=YuChao API + embedded updater
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$ROOT
Environment=PYTHONUNBUFFERED=1
ExecStart=$ROOT/.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port $PORT --log-level info
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

# 清理早期版本遗留的独立写者进程（回退模式才需要）
if [ -f /etc/systemd/system/yuchao-updater.service ]; then
  sudo systemctl disable --now yuchao-updater >/dev/null 2>&1 || true
  sudo rm -f /etc/systemd/system/yuchao-updater.service
fi

echo "[3/4] Caddy 反代 $DOMAIN → 127.0.0.1:$PORT"
if [ -f /etc/caddy/Caddyfile ] && ! grep -q "yuchao-managed" /etc/caddy/Caddyfile; then
  sudo cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)"
fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
# yuchao-managed：由 scripts/server-bootstrap.sh 生成，手改请同步脚本
$DOMAIN {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT {
		flush_interval -1
	}
}
CADDY

echo "[4/4] 启用服务"
sudo systemctl daemon-reload
sudo systemctl enable yuchao-api >/dev/null 2>&1 || true
sudo systemctl restart yuchao-api
sudo systemctl reload-or-restart caddy

echo "完成：http://$(curl -s -m 3 https://api.ipify.org || echo 127.0.0.1)/"
echo "状态：systemctl status yuchao-api --no-pager"
