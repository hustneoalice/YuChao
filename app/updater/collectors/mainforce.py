"""收盘更新链完成后预生成资金排行，API 重启后仍可直接读取。"""
from ..writer import writer
from ...foundation.repo.mainforce_cache import prewarm_mainforce


def update_mainforce(progress=None, ctx=None):
    try:
        return prewarm_mainforce(writer.conn(), progress, (ctx or {}).get('cancel_check'))
    finally:
        writer.reset()
