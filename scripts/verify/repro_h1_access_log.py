"""H1 复现脚本：访问日志是否把邀请密钥原样打进去。

用法（在仓库根目录）：
    python scripts/verify/repro_h1_access_log.py
退出码 0 = 密钥未泄露；1 = 密钥泄露（缺陷存在）。
"""
import io
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "backend"))

from app.core.observability import install_redacting_filter

TOKEN = "inv_REPRO_SECRET_abc123"


def main() -> int:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger = logging.getLogger("uvicorn.access")
    logger.setLevel(logging.INFO)
    logger.handlers = [handler]
    install_redacting_filter(logger)

    # uvicorn 访问日志的真实形状：'%s - "%s %s HTTP/%s" %d'
    logger.info(
        '%s - "%s %s HTTP/%s" %d',
        "127.0.0.1:5000", "GET", f"/api/v1/invites/{TOKEN}", "1.1", 200,
    )

    output = stream.getvalue()
    print("日志输出:", repr(output))
    leaked = TOKEN in output
    print("密钥是否泄露:", leaked)
    # 同时检查排查信息是否还在：方法、路径、状态码都要能看到。
    keeps_context = all(part in output for part in ("GET", "/api/v1/invites/", "200"))
    print("是否保留排查信息:", keeps_context)
    if leaked:
        return 1
    return 0 if keeps_context else 2


if __name__ == "__main__":
    sys.exit(main())
