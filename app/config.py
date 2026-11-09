"""运行配置：环境变量 YUCHAO_* / .env，默认 data/stock_research.duckdb。"""
from pathlib import Path

from pydantic import Field
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
    # 北交所开关（参考策影）：关闭时全系统不考虑北交所标的（搜索/行情/K线/目标一概过滤）
    bj_enabled: bool = False
    neo_signing_key: str = Field(default="", repr=False)
    neo_issuer: str = ""
    neo_grants_file: str = ""

    # 内置管理员：首次启动自动创建（库中已有 admin 则跳过）；邮箱/用户名/密码可用环境变量覆盖
    admin_seed: bool = True
    admin_email: str = "admin@yuchao.local"
    admin_username: str = "admin"
    admin_password: str = Field(default="admin123", repr=False)

    # 智能助手默认模型（可选兜底）：密钥只从环境变量注入，不入库、不入仓
    llm_base_url: str | None = None
    llm_model: str | None = None
    llm_api_key: str = Field(default="", repr=False)

    # K 线采集并发度：线程只做 HTTP，写库仍在主线程串行（1=回退纯串行）
    kline_workers: int = 8
    # 资金流采集并发度：同上（新浪单只 p50≈90ms，串行全市场要 15 分钟以上）
    capital_flow_workers: int = 8

    model_config = {"env_prefix": "YUCHAO_", "env_file": ".env", "extra": "ignore"}


settings = Settings()
