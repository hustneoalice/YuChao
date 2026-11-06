"""APScheduler 调度链（1.0 services/scheduler.py 原样迁移，时区北京时间）。

15:35 板块 → 16:00 行情 → 16:20 估值 → 16:30 资金流 → 16:50 PE分位
→ 17:00 K线 → 17:30 财务；周六 09:00 复权因子；交易日 20:00 核心标。

顺序有讲究：估值(16:20) 必须先于 PE分位(16:50)——分位从当日截面算；
K线(17:00) 在估值后，前端图表与估值同日可见。
"""
from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler

from .. import integrations
from .registry import CRON_CHAIN, WEEKLY
from .trading_calendar import is_trading_day
from .util import now_cst

logger = logging.getLogger("yuchao.updater")


def build_scheduler(orchestrator, control: ControlRequests | None = None):
    """构造并返回未启动的调度器（由入口统一 start / shutdown）。"""
    sched = BackgroundScheduler(timezone="Asia/Shanghai",
                                job_defaults={"coalesce": True, "max_instances": 1})
    for kind, h, m in CRON_CHAIN:
        sched.add_job(_cron_submit, "cron", day_of_week="mon-fri",
                      hour=h, minute=m, args=[orchestrator, kind],
                      id=f"cron:{kind}", replace_existing=True)
    for kind, h, m in WEEKLY:
        # 周任务不走交易日守卫：周六本身非交易日，套用守卫 = 永不触发
        sched.add_job(_cron_submit_weekly, "cron", day_of_week="sat",
                      hour=h, minute=m, args=[orchestrator, kind],
                      id=f"cron:{kind}", replace_existing=True)
    # 两点乾坤：用户可配任意多个 HH:MM，故按分钟探测（到期才提交，平时只读 prefs）
    sched.add_job(_minute_tick, "cron", day_of_week="mon-fri", minute="*",
                  args=[orchestrator], id="cron:target_push",
                  replace_existing=True)
    sched.add_job(_retry_corepicks, "cron", day_of_week="mon-fri", hour="20-23", minute="*/10",
                  args=[orchestrator], id="cron:corepicks_retry", replace_existing=True)
    return sched


def _cron_submit(orchestrator, kind: str):
    if not is_trading_day(now_cst()):
        # 节假日整天休市：不打任务、不留账（板块/行情接口返回的是昨日状态，
        # 采了只会给快照盖幽灵日期——1.0 2026-09-25 中秋实测教训）
        orchestrator.log_event(f"非交易日，跳过 {kind}", "info", kind=kind)
        return
    _submit(orchestrator, kind, params={"rotation_trigger": "auto"} if kind == "corepicks" else None)


def _cron_submit_weekly(orchestrator, kind: str):
    _submit(orchestrator, kind)


def _minute_tick(orchestrator):
    """两点乾坤：每分钟探测用户配置的 HH:MM 是否到期（只读 SQLite，无到期即返回）。"""
    now = now_cst()
    if not is_trading_day(now):
        return
    day, slot = now.strftime("%Y-%m-%d"), now.strftime("%H:%M")
    try:
        due = integrations.due_push_users(slot, day)
    except Exception:
        logger.exception("[Scheduler] 两点乾坤到期探测失败")
        return
    if not due:
        return
    _submit(orchestrator, "target_push", params={"slot": slot, "day": day})


def _submit(orchestrator, kind: str, params: dict | None = None):
    r = orchestrator.submit(kind, trigger="cron", params=params)
    if r.get("ok"):
        logger.info("[Scheduler] 已触发 %s → task=%s", kind, r["task"]["id"])
    elif r.get("deduped"):
        logger.info("[Scheduler] %s 已在队列/执行中，cron 触发去重", kind)
    else:
        logger.warning("[Scheduler] %s 触发失败: %s", kind, r.get("message"))


def _retry_corepicks(orchestrator):
    """20点后等待数据的任务每10分钟重试，成功后不重复。"""
    now = now_cst()
    if not is_trading_day(now):
        return
    from ..foundation.db import open_conn
    from ..foundation.repo.core_rotation import read_rotation
    conn = open_conn()
    try:
        data = read_rotation(conn)
    finally:
        conn.close()
    latest = data['latest_attempt']
    day = now.strftime('%Y-%m-%d')
    if latest and latest['date'] == day and latest['status'] != 'waiting':
        return
    _submit(orchestrator, 'corepicks', params={'rotation_trigger':'auto'})
