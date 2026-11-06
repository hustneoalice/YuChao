"""Public NEO contracts contain no private indicator implementations."""

import re
from datetime import date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, field_validator


class EvaluationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capability: Literal["neo.trend_histogram"]
    instrument_id: str = Field(pattern=r"^CN:(SH|SZ):stock:[0-9]{6}$")
    period: Literal["day"] = "day"
    adjust: Literal["raw", "qfq", "hfq"] = "qfq"
    end: date
    limit: int = Field(default=100, ge=1, le=500)

    @field_validator("end", mode="before")
    @classmethod
    def strict_date(cls, value: Any) -> Any:
        if type(value) is date:
            return value
        if not isinstance(value, str) or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None:
            raise ValueError("日期格式必须为YYYY-MM-DD")
        return value

    @field_validator("end")
    @classmethod
    def closed_date(cls, value: date) -> date:
        if value >= datetime.now(ZoneInfo("Asia/Shanghai")).date():
            raise ValueError("仅接受已结束日期")
        return value


class Point(BaseModel):
    date: date
    value: FiniteFloat | None


class Summary(BaseModel):
    trend_value: FiniteFloat | None
    trend_cross_date: date | None
    trend_cross_ago: int | None
    trend_above_days: int
    neg_run: int
    neg_abs: FiniteFloat | None
    trend_data_date: date


class Coverage(BaseModel):
    bars: int = Field(ge=0, le=2000)
    warmup_limit: Literal[2000]


class EvaluationResult(BaseModel):
    schema_version: Literal[1]
    status: Literal["ok", "empty"]
    capability: Literal["neo.trend_histogram"]
    instrument_id: str = Field(pattern=r"^CN:(SH|SZ):stock:[0-9]{6}$")
    period: Literal["day"]
    adjust: Literal["raw", "qfq", "hfq"]
    as_of: date | None
    generated_at: datetime
    bar_state: Literal["closed"]
    rule_version: str
    origin: str
    verification_status: str
    snapshot_id: str
    points: list[Point] = Field(max_length=500)
    latest: Summary | None
    warnings: list[str]
    coverage: Coverage
