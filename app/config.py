"""运行配置：环境变量 YUCHAO_* / .env，默认 data/stock_research.duckdb。"""
from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    duckdb_path: Path = Path(__file__).resolve().parent.parent / "data" / "stock_research.duckdb"
    api_title: str = "YuChao Data Foundation API"
    api_v1_prefix: str = "/api/v1"

    model_config = {"env_prefix": "YUCHAO_", "env_file": ".env", "extra": "ignore"}


settings = Settings()
