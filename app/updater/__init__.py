"""updater 进程：DuckDB 唯一写者（编排/采集/调度）。

进程模型（设计文档 03/05 节）：DuckDB 多进程只允许全 read_only，
因此写全部收敛进本进程——API 进程一律只读挂载。入口 `python -m app.updater`。
"""
