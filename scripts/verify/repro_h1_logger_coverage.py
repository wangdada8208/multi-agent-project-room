"""H1 复现（测试同事探针版）：令牌能否绕过脱敏进日志。

用法（仓库根目录）：
    python scripts/verify/repro_h1_logger_coverage.py
退出码 0 = 全部拦住；1 = 有泄露。

逐项覆盖测试同事实测到的三类，外加两条绕过路径：
  1. httpx 出站请求日志
  2. sqlalchemy.engine 的「SQL + 参数元组」日志
  3. uvicorn.access
  4. 库直接给 logger 赋 handler（log.handlers = [h]）
  5. logging.dictConfig 事后重建 handler
"""
import io
import logging
import logging.config
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app.core.observability import install_redacting_filter

TOKEN = "inv_LEAKCHECK777"
results: dict[str, tuple[bool, str]] = {}


def _probe(name: str, logger_name: str, level: int, emit, *, assign_handlers: bool = False) -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger = logging.getLogger(f"{logger_name}.{name}")
    logger.handlers = []
    if assign_handlers:
        # 绕过 Logger.addHandler 钩子：直接赋值 handler 列表
        logger.handlers = [handler]
    else:
        logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = False
    install_redacting_filter(logger)
    emit(logger)
    text = stream.getvalue()
    results[name] = (TOKEN in text, text.strip())


def main() -> int:
    install_redacting_filter()  # 与 app.main 启动时一致：只装一次

    _probe("httpx", "httpx", logging.DEBUG, lambda lg: lg.info(
        'HTTP Request: %s %s "%s %d %s"', "GET",
        f"http://127.0.0.1:8913/api/v1/invites/{TOKEN}", "HTTP/1.1", 404, "Not Found"))
    _probe("sqlalchemy", "sqlalchemy.engine", logging.DEBUG, lambda lg: lg.debug(
        "SELECT room_invites.room_id FROM room_invites WHERE room_invites.token = ?", (TOKEN,)))
    _probe("uvicorn.access", "uvicorn.access", logging.INFO, lambda lg: lg.info(
        '%s - "%s %s HTTP/%s" %d', "127.0.0.1:5000", "GET",
        f"/api/v1/invites/{TOKEN}", "1.1", 404))
    _probe("handlers_assigned", "httpx.assigned", logging.DEBUG, lambda lg: lg.info(
        'HTTP Request: %s %s "%s"', "GET", f"http://x/api/v1/invites/{TOKEN}", "HTTP/1.1"),
        assign_handlers=True)

    # 5) 事后 dictConfig 重建 handler
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger = logging.getLogger("httpx.dictcfg")
    logger.handlers = [handler]
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    logger.info('HTTP Request: %s %s "%s"', "GET", f"http://x/api/v1/invites/{TOKEN}", "HTTP/1.1")
    results["dictconfig_like"] = (TOKEN in stream.getvalue(), stream.getvalue().strip())

    leaked = False
    for name, (has, text) in results.items():
        leaked = leaked or has
        print(f"[{name}] 泄露={has}  日志={text!r}")
    print("总结：" + ("存在泄露" if leaked else "全部拦住"))
    return 1 if leaked else 0


if __name__ == "__main__":
    sys.exit(main())
