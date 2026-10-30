"""F10 · 飞书推送采集器：交易日盘前把最新核心标名单推给已启用的用户。

为什么是 updater 任务：读核心标必须拿 DuckDB 连接——updater 进程内
writer.conn() 已持有写连接（读写同连接，不碰跨进程锁）；API 进程只读
连接也能读，但没有调度器。配置在 SQLite（app.auth.service），跨进程
读无锁问题。

设计口径（PRD F10「核心标定时 + 测试」）：
- cron 交易日 08:35（盘前看名单）；selfheal 链位补偿覆盖停机错过，
  账本按日去重 → 一天最多推一次；
- 名单为空（引擎未出结果）→ status=skipped，不发空消息打扰用户；
- 逐用户隔离失败：一个 webhook 挂了不影响其他用户。
"""
from __future__ import annotations

import logging

from ..writer import writer
from ... import integrations

logger = logging.getLogger("yuchao.updater")


def push_corepicks(progress=None, ctx=None) -> dict:
    result = {"rows": 0, "detail": ""}
    conn = writer.conn()
    payload = integrations.corepicks_message(conn)
    if payload is None:
        result["status"] = "skipped"
        result["message"] = "核心标名单为空（引擎未生成结果），跳过推送"
        return result
    writer.reset()                         # 发网络请求期间让出写锁（三段式纪律）

    # 遍历启用推送的用户（SQLite 读，跨进程安全）
    from ...auth import service
    users = service.list_users()
    sent = failed = 0
    for u in users:
        cfg = integrations.get_feishu(u["id"])
        if not cfg.get("enabled") or not cfg.get("webhook_url"):
            continue
        ok, msg = integrations.feishu_send(
            cfg["webhook_url"], cfg.get("secret") or "", payload)
        if ok:
            sent += 1
        else:
            failed += 1
            logger.warning("[FeishuPush] 用户 %s 推送失败：%s", u["id"], msg)

    result["rows"] = sent
    result["detail"] = f"推送 {sent} 人成功" + (f"，{failed} 人失败" if failed else "")
    if sent == 0 and failed == 0:
        result["status"] = "skipped"
        result["message"] = "无启用飞书推送的用户，跳过"
    return result
