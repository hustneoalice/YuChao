"""两点乾坤定时推送：按用户设置的时间点（每天可多个）计算并推送飞书。

调度侧每分钟探测一次到期时段（integrations.due_push_users，只读 SQLite），
命中才提交本任务；任务内只计算一次、发给该时段的所有用户（逐用户隔离）。
推送成功后写 feishu.push_last = "YYYY-MM-DD HH:MM"，同一时段不会重复推。
无命中标的不发空消息（与核心标早报同一口径：不打扰）。
"""
from __future__ import annotations

import logging

from ..util import now_cst
from ..writer import writer
from ... import integrations

logger = logging.getLogger("yuchao.updater")


def has_due_users(now=None) -> bool:
    now = now or now_cst()
    return bool(integrations.due_push_users(now.strftime("%H:%M"),
                                            now.strftime("%Y-%m-%d")))


def push_target_signals(progress=None, ctx=None) -> dict:
    result: dict = {"rows": 0, "detail": ""}
    progress = progress or (lambda **k: None)
    now = now_cst()
    slot = str((ctx or {}).get("slot") or now.strftime("%H:%M"))
    day = str((ctx or {}).get("day") or now.strftime("%Y-%m-%d"))

    users = integrations.due_push_users(slot, day)
    if not users:
        result["status"] = "skipped"
        result["message"] = f"{slot} 无到期的两点乾坤推送用户"
        return result

    progress(stage="计算两点乾坤",
             message=f"时段 {slot} · 目标 {len(users)} 位用户",
             total=len(users), done=0)
    conn = writer.conn()
    payload = integrations.liangdian_message(conn, slot)
    writer.reset()                    # 发网络请求期间让出写锁（三段式纪律）
    if payload is None:
        result["status"] = "skipped"
        result["message"] = f"{slot} 暂无符合两点乾坤的标的，跳过推送"
        logger.info("[TargetPush] %s 无命中", slot)
        return result

    progress(stage="推送飞书", message="发送飞书卡片")
    sent = failed = 0
    for u in users:
        ok, msg = integrations.feishu_send(
            u["webhook_url"], u.get("secret") or "", payload)
        if ok:
            sent += 1
            try:
                integrations.mark_feishu_pushed(u["id"], f"{day} {slot}")
            except Exception:
                logger.warning("[TargetPush] 用户 %s 去重标记写入失败",
                               u["id"], exc_info=True)
        else:
            failed += 1
            logger.warning("[TargetPush] 用户 %s 推送失败：%s", u["id"], msg)

    result["rows"] = sent
    result["detail"] = f"{slot} 推送 {sent} 人成功" + (f"，{failed} 人失败" if failed else "")
    progress(done=len(users), rows=sent, message=result["detail"])
    if failed and not sent:
        result["status"] = "failed"
        result["error"] = f"{failed} 位用户推送失败（webhook 失效或飞书限流）"
    return result
