"""组长验收脚本：真起 uvicorn + sqlalchemy.engine DEBUG + 写文件日志 + 请求带密钥地址。

验收标准：对每个密钥 grep 日志文件，必须是 0 行。

关键点：光起服务不够。服务没跑过带参数的数据库查询时，日志里根本不会有
sqlalchemy.engine 的行，那样的「0 行」是假绿。本脚本会先断言引擎确实打了日志，
再断言密钥没出现。

用法（仓库根目录）：
    python scripts/verify/accept_grep_zero.py
退出码 0 = 0 行泄露且日志确有内容；1 = 泄露或有假绿。
"""
import json
import os
import secrets
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / ".tmpverify"
WORK.mkdir(exist_ok=True)


def main() -> int:
    invite = secrets.token_urlsafe(32)
    share = secrets.token_urlsafe(32)
    log_file = WORK / "accept.log"
    db_file = WORK / "accept.db"
    for f in (log_file, db_file):
        if f.exists():
            f.unlink()

    config = WORK / "logcfg.json"
    config.write_text(json.dumps({
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"plain": {"format": "%(name)s %(message)s"}},
        "handlers": {"file": {
            "class": "logging.FileHandler",
            "filename": str(log_file),
            "formatter": "plain",
        }},
        "root": {"handlers": ["file"], "level": "DEBUG"},
        "loggers": {
            "sqlalchemy.engine": {"level": "DEBUG", "handlers": ["file"], "propagate": False},
            "uvicorn.access": {"level": "INFO", "handlers": ["file"], "propagate": False},
            "httpx": {"level": "DEBUG", "handlers": ["file"], "propagate": False},
        },
    }, indent=2), encoding="utf-8")

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    env = os.environ.copy()
    env["MAPR_DATABASE_URL"] = f"sqlite+aiosqlite:///{db_file}"
    env["MAPR_ENVIRONMENT"] = "test"
    env["PYTHONPATH"] = str(ROOT / "backend")

    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app",
         "--host", "127.0.0.1", "--port", str(port),
         "--access-log", "--log-config", str(config)],
        cwd=ROOT, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        base = f"http://127.0.0.1:{port}"
        for _ in range(150):
            try:
                urllib.request.urlopen(base + "/health", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        # 这些请求会各自触发一次带绑定参数的数据库查询
        for path in (
            f"/api/v1/invites/{invite}",
            f"/api/v1/rooms/shared/{share}/messages",
            f"/api/v1/rooms/room-x/messages/search?q={invite}",
        ):
            try:
                urllib.request.urlopen(base + path, timeout=3)
            except Exception:
                pass
        time.sleep(0.8)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()

    text = log_file.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    engine_lines = [ln for ln in lines if ln.startswith("sqlalchemy.engine")]

    print(f"日志总行数: {len(lines)}   sqlalchemy.engine 行数: {len(engine_lines)}")
    ok = True
    if not engine_lines:
        print("假绿警告：日志里没有 sqlalchemy.engine 的行，本次 0 行不算数")
        ok = False
    for name, token in (("invite", invite), ("share", share)):
        hits = [ln for ln in lines if token in ln]
        print(f"grep {name}: {len(hits)} 行")
        for ln in hits[:3]:
            print("   LEAK:", ln[:160])
        if hits:
            ok = False

    print("总结：" + ("通过" if ok else "未通过"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
