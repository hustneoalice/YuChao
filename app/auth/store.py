"""用户态存储：SQLite（设计文档 4.2，按账户隔离，可平滑迁 PG）。

与 DuckDB 行情底座分库：行情全用户共享只读，用户态按账户写。
表全家桶一次建齐——license/自选/卡片/偏好/推送/LLM 配置的存储层在 M3
落位；除 auth/license 外的路由属产品里程碑，按需开放。
"""
import sqlite3
import threading
from pathlib import Path

from ..config import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'free',       -- free | pro（是否有效看 pro_expires_at）
    pro_expires_at TEXT,                     -- NULL = 永久 VIP（内置管理员即此形态）
    role TEXT NOT NULL DEFAULT 'user',       -- user | admin
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_prefs (
    user_id TEXT PRIMARY KEY,
    prefs_json TEXT NOT NULL DEFAULT '{}'    -- 主题/accent/涨跌方向偏好
);
-- 激活码即 license（一码一用，原子兑换）；orders 留给支付核销回调
-- （虎皮椒/爱发电，接入期），此处先建表。
CREATE TABLE IF NOT EXISTS licenses (
    code TEXT PRIMARY KEY,
    plan TEXT NOT NULL DEFAULT 'pro_year',
    duration_days INTEGER NOT NULL DEFAULT 365,
    status TEXT NOT NULL DEFAULT 'unused',   -- unused | redeemed
    redeemed_by TEXT,
    redeemed_at TEXT
);
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    provider TEXT,                           -- hupijiao | afdian
    out_trade_no TEXT UNIQUE,
    user_id TEXT,
    plan TEXT,
    amount REAL,
    status TEXT NOT NULL DEFAULT 'created',  -- created | paid | redeemed | failed
    created_at TEXT NOT NULL,
    paid_at TEXT
);
CREATE TABLE IF NOT EXISTS watchlists (
    user_id TEXT NOT NULL,
    symbol TEXT NOT NULL,                    -- 自选 ≤500（服务层校验）
    group_id TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, symbol)
);
CREATE TABLE IF NOT EXISTS watchlist_groups (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS card_config (
    user_id TEXT NOT NULL,
    card_id TEXT NOT NULL,                   -- 卡片启停排序；停用保留配置
    enabled INTEGER NOT NULL DEFAULT 1,
    sort INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, card_id)
);
CREATE TABLE IF NOT EXISTS feishu_config (
    user_id TEXT PRIMARY KEY,
    webhook TEXT,
    secret TEXT
);
CREATE TABLE IF NOT EXISTS llm_config (
    user_id TEXT PRIMARY KEY,
    provider TEXT,
    base_url TEXT,
    api_key TEXT,                            -- BYOK，返回一律脱敏
    model TEXT
);
"""

_init_lock = threading.Lock()
_init_for: Path | None = None


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def get_conn() -> sqlite3.Connection:
    """每次调用独立连接（FastAPI 线程池下不共享 sqlite3 连接）；
    首次/换路径时先建表（幂等，测试 monkeypatch userdb_path 友好）。"""
    global _init_for
    path = Path(settings.userdb_path)
    if _init_for != path:
        with _init_lock:
            if _init_for != path:
                c = _connect(path)
                c.executescript(SCHEMA)
                c.commit()
                c.close()
                _init_for = path
    return _connect(path)
