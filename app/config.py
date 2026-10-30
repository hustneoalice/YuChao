"""运行配置：环境变量 YUCHAO_* / .env，默认 data/stock_research.duckdb。"""
from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    duckdb_path: Path = Path(__file__).resolve().parent.parent / "data" / "stock_research.duckdb"
    api_title: str = "YuChao Data Foundation API"
    api_v1_prefix: str = "/api/v1"

    # M2 updater：进度快照 / 事件总线 / 控制通道（均为 data/ 下 JSONL/JSON 文件）
    update_snapshot_path: Path = Path(__file__).resolve().parent.parent / "data" / "update_progress.json"
    stream_events_path: Path = Path(__file__).resolve().parent.parent / "data" / "stream_events.jsonl"
    control_requests_path: Path = Path(__file__).resolve().parent.parent / "data" / "control_requests.jsonl"
    scheduler_enabled: bool = True          # updater CLI 的 APScheduler 开关（api_embedded_updater=true 时 CLI 不启调度）
    api_embedded_updater: bool = True       # 更新内核内置 API 进程（策影模式：编排器+调度+自愈并入 uvicorn）
    control_poll_s: float = 2.0             # 控制请求轮询间隔
    selfheal_ledger_path: Path = Path(__file__).resolve().parent.parent / "data" / "selfheal_ledger.json"

    # M3 用户态 / license（SQLite，按账户隔离，与行情底座分库）
    userdb_path: Path = Path(__file__).resolve().parent.parent / "data" / "users.sqlite3"
    jwt_secret: str = "yuchao-dev-secret-change-me-32bytes-minimum!"  # 生产必须 YUCHAO_JWT_SECRET（多 worker 共享）
    token_ttl_days: int = 30
    # M3 backplane：设置后事件走 Redis pub/sub（多 worker/多机）；缺省文件总线（同机）
    redis_url: str | None = None
    # M3 数据包（PRD F14）：导出目录 / 初始包导入均经 updater 排队执行
    export_dir: Path = Path(__file__).resolve().parent.parent / "data" / "exports"

    model_config = {"env_prefix": "YUCHAO_", "env_file": ".env", "extra": "ignore"}


settings = Settings()
