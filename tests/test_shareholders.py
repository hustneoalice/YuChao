import pytest

from app.foundation import shareholders


def holder(name, shares, *, code=None, rank=1, ratio=1.0, quarter="2026-09-30"):
    return {"END_DATE": quarter + " 00:00:00", "HOLDER_NAME": name,
            "HOLDER_CODE": code, "HOLDER_RANK": rank, "HOLD_NUM": shares,
            "HOLD_RATIO": ratio, "NOTICE_DATE": "2026-10-30 00:00:00"}


def previous():
    return [holder(f"股东{i}", 100, code=str(i), rank=i, quarter="2026-06-30")
            for i in range(1, 11)]


def test_quantity_comparison_and_social_security_sample():
    rows = previous() + [
        holder("改名股东", 150, code="1", rank=1),
        holder("股东2", 50, code="2", rank=2),
        holder("股东3", 100, code="3", rank=3, ratio=0.9),
        holder("全国社保基金一零九组合", 28249743, code="109", rank=4, ratio=0.3461),
    ]
    out = shareholders.build_report("002600", rows)
    assert [x.change for x in out.items] == ["加仓", "减仓", "不变", "进入"]
    assert out.items[0].share_change == 50
    assert out.items[2].ratio_change == pytest.approx(-0.1)
    assert out.items[3].shares == 28249743
    assert out.items[3].is_social_security
    assert out.items[3].share_change is None  # 新进十大不能把全部持仓算成当季买入
    assert out.total_ratio == pytest.approx(3.2461)
    assert out.notice_date == "2026-10-30"
    assert out.previous_report_date == "2026-06-30"


@pytest.mark.parametrize("older", [[], [holder("旧股东", 100, quarter="2026-03-31")], previous()[:3]])
def test_missing_or_incomplete_previous_quarter_is_not_new_entry(older):
    out = shareholders.build_report("002600", older + [holder("全国社保基金一零九组合", 28249743)])
    assert out.items[0].change == "无法比较"
    assert out.ratio_change is None


def test_name_fallback_missing_values_and_quarter_selection():
    rows = previous()
    rows[0]["HOLDER_CODE"] = None
    rows += [holder("股东1", 100), holder("股东2", None, rank=2, ratio=None)]
    out = shareholders.build_report("002600", rows)
    assert out.items[0].change == "不变"
    assert out.items[1].change == "无法比较"
    assert out.total_ratio is None  # 缺值不能当零
    old = shareholders.build_report("002600", rows, "2026-06-30")
    assert len(old.items) == 10
    assert old.report_dates == ["2026-09-30", "2026-06-30"]
    assert old.previous_report_date is None


def test_unavailable_quarter_and_empty_data():
    assert shareholders.build_report("002600", []).items == []
    with pytest.raises(ValueError, match="报告期"):
        shareholders.build_report("002600", previous(), "2026-09-30")


def test_year_boundary_uses_previous_calendar_quarter():
    rows = [dict(x, END_DATE="2025-12-31") for x in previous()]
    out = shareholders.build_report("002600", rows + [holder("股东1", 200, code="1", quarter="2026-03-31")])
    assert out.items[0].change == "加仓"
    assert out.previous_report_date == "2025-12-31"


def test_non_quarter_shareholder_disclosures_are_excluded():
    rows = previous() + [holder("临时披露", 100, quarter="2026-08-12")]
    out = shareholders.build_report("002600", rows)
    assert out.report_dates == ["2026-06-30"]
    assert out.report_date == "2026-06-30"


def test_source_pagination_cache_and_failed_request_not_cached(monkeypatch):
    import httpx

    calls = []
    fail = True

    def get(url, *, params, **kwargs):
        calls.append(dict(params))
        if fail:
            raise httpx.ReadTimeout("timeout")
        rows = [holder("社保基金样本", 28249743)] if params["pageNumber"] == 1 else previous()
        return httpx.Response(200, request=httpx.Request("GET", url),
                              json={"success": True, "result": {"pages": 2, "data": rows}})

    monkeypatch.setattr(shareholders, "_CACHE", {})
    monkeypatch.setattr(shareholders.client, "get", get)
    with pytest.raises(httpx.ReadTimeout):
        shareholders.stock_shareholders("002600")
    fail = False
    out = shareholders.stock_shareholders("002600")
    assert out.items[0].change == "进入"
    assert len(calls) == 3
    assert all(x["filter"] == '(SECURITY_CODE="002600")(IS_REPORT="1")' for x in calls)
    assert len(shareholders.stock_shareholders("002600", "2026-06-30").items) == 10
    assert len(calls) == 3


def test_api_dates_validation_errors_and_index_guard(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from fastapi.responses import JSONResponse
    from app.errors import ApiError
    from app.routers.v1.market import router

    app = FastAPI()
    app.include_router(router)

    @app.exception_handler(ApiError)
    async def handle(request, exc):
        return JSONResponse(status_code=exc.status, content={"code": exc.code})

    monkeypatch.setattr(shareholders, "stock_shareholders", lambda code, d: shareholders.build_report(code, previous(), d))
    client = TestClient(app)
    assert client.get("/market/shareholders?symbol=002600.SZ").json()["symbol"] == "002600"
    assert client.get("/market/shareholders?symbol=002600&report_date=2026-09-30").status_code == 422
    assert client.get("/market/shareholders?symbol=002600&report_date=garbage").status_code == 422
    assert client.get("/market/shareholders?symbol=bad").status_code == 422
    assert client.get("/market/shareholders?symbol=000001.SH").json()["items"] == []
    assert client.get("/market/shareholders?symbol=usDJI").json()["items"] == []

    def broken(*args):
        raise ValueError("invalid source JSON")

    monkeypatch.setattr(shareholders, "stock_shareholders", broken)
    assert client.get("/market/shareholders?symbol=002600").status_code == 503
