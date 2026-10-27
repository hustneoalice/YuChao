"""统一错误规约：所有业务错误映射为 {code, message, detail?}。"""
from typing import Any, Optional


class ApiError(Exception):
    """业务异常；由 main.py 的 handler 统一转为 JSON 错误体。"""

    def __init__(self, code: str, message: str, status: int = 400, detail: Any = None):
        self.code = code
        self.message = message
        self.status = status
        self.detail = detail
        super().__init__(message)


def not_found(message: str, detail: Any = None) -> ApiError:
    return ApiError("not_found", message, 404, detail)


def invalid_param(message: str, detail: Any = None) -> ApiError:
    return ApiError("invalid_param", message, 422, detail)


def vip_required(message: str = "VIP 通道未授权，不返回数据", detail: Any = None) -> ApiError:
    return ApiError("vip_required", message, 403, detail)


def unauthorized(message: str = "未登录或令牌无效", detail: Any = None) -> ApiError:
    return ApiError("unauthorized", message, 401, detail)


def forbidden(message: str = "无权限执行该操作", detail: Any = None) -> ApiError:
    return ApiError("forbidden", message, 403, detail)


def not_implemented(message: str, detail: Any = None) -> ApiError:
    return ApiError("not_implemented", message, 501, detail)


def data_not_ready(message: str, detail: Any = None) -> ApiError:
    return ApiError("data_not_ready", message, 503, detail)
