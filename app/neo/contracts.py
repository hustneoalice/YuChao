"""Public NEO contracts contain no private indicator implementations."""

import hashlib
import json
import re
from datetime import date, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, field_validator, model_validator


CAPABILITIES = ('neo.trend_histogram', 'neo.six_segment', 'neo.money_bag')
Capability = Literal['neo.trend_histogram', 'neo.six_segment', 'neo.money_bag']


class InputBar(BaseModel):
    model_config = ConfigDict(extra="forbid")
    date: date
    open: FiniteFloat = Field(gt=0)
    high: FiniteFloat = Field(gt=0)
    low: FiniteFloat = Field(gt=0)
    close: FiniteFloat = Field(gt=0)
    volume: FiniteFloat | None = Field(default=None, ge=0)
    amount: FiniteFloat | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def valid_prices(self) -> "InputBar":
        if self.low > min(self.open, self.close) or self.high < max(self.open, self.close):
            raise ValueError("invalid OHLC range")
        return self


class EvaluationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    capability: Capability
    instrument_id: str = Field(pattern=r"^CN:(SH|SZ):stock:[0-9]{6}$")
    period: Literal["day"] = "day"
    adjust: Literal["raw", "qfq", "hfq"] = "qfq"
    end: date
    limit: int = Field(default=100, ge=1, le=500)
    bars: list[InputBar] = Field(max_length=2000)
    input_snapshot_id: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def ordered_snapshot(self) -> "EvaluationRequest":
        previous = date.min
        for bar in self.bars or []:
            if not previous < bar.date <= self.end:
                raise ValueError("snapshot dates must increase and not exceed end")
            previous = bar.date
        payload = self.model_dump(mode="json", exclude={"input_snapshot_id"})
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        if self.input_snapshot_id != digest:
            raise ValueError("input snapshot mismatch")
        return self

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


class SixSegmentSummary(BaseModel):
    segment: int = Field(ge=0, le=6)
    segment_name: str
    data_date: date | None


class MoneyBagSummary(BaseModel):
    money_date: date | None
    money_ago: int | None
    money_cnt: int
    data_date: date | None


class Coverage(BaseModel):
    bars: int = Field(ge=0, le=2000)
    warmup_limit: Literal[2000]


class EvaluationResult(BaseModel):
    schema_version: Literal[2]
    status: Literal["ok", "empty"]
    capability: Capability
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
    input_snapshot_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    points: list[Point] = Field(max_length=500)
    latest: Summary | SixSegmentSummary | MoneyBagSummary | None
    warnings: list[str]
    coverage: Coverage
