"""H1 全链路验证：真实服务 + 数据库参数日志。

比只断言 scrub_text 更强：真的起进程、真的写日志文件、真的发请求。

场景：
  1. 真实 uvicorn 服务，访问日志开，请求带令牌的邀请地址与分享地址
  2. 真实 uvicorn 服务，DEBUG 级别，触发带参数的数据库写入
  3. echo=True 的引擎（SQLAlchemy 自己打 SQL 参数）
  4. echo=False 的引擎 + sqlalchemy.engine 的 DEBUG（同样的日志，另一条路径）

用法（仓库根目录）：
    python scripts/verify/verify_h1_full.py
退出码 0 = 全绿；1 = 有泄露。
"""
import asyncio
import logging
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

failures: list[str] = []


def _report(name: str, token: str, log_file: Path, extra: tuple[str, ...] = ()) -> None:
    text = log_file.read_text(encoding="utf-8", errors="replace")
    leaks = [ln for ln in text.splitlines() if token in ln]
    for other in extra:
        leaks += [ln for ln in text.splitlines() if other in ln]
    status = "OK" if not leaks else "LEAK"
    print(f"[{name}] 日志 {len(text.splitlines())} 行, 泄露 {len(leaks)} 行 -> {status}")
    for line in leaks[:4]:
        print("   LEAK:", line[:160])
    if leaks:
        failures.append(name)


def scenario_real_server() -> None:
    """真实 uvicorn：访问日志 + DEBUG，请求带令牌的地址。"""
    db = WORK / "srv.db"
    if db.exists():
        db.unlink()
    log_file = WORK / "srv.log"
    log_file.write_text("", encoding="utf-8")

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    env = os.environ.copy()
    env["MAPR_DATABASE_URL"] = f"sqlite+aiosqlite:///{db}"
    env["MAPR_ENVIRONMENT"] = "test"
    env["PYTHONPATH"] = str(ROOT / "backend")

    invite = secrets.token_urlsafe(32)
    share = secrets.token_urlsafe(32)
    with log_file.open("w", encoding="utf-8") as sink:
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app",
             "--host", "127.0.0.1", "--port", str(port),
             "--log-level", "debug", "--access-log"],
            cwd=ROOT, env=env, stdout=sink, stderr=sink,
        )
        try:
            base = f"http://127.0.0.1:{port}"
            for _ in range(100):
                try:
                    urllib.request.urlopen(base + "/health", timeout=1)
                    break
                except Exception:
                    time.sleep(0.1)
            for path in (
                f"/api/v1/invites/{invite}",
                f"/api/v1/rooms/shared/{share}/messages",
                f"/api/v1/rooms/rooms-abc/messages/search?q={invite}",
            ):
                try:
                    urllib.request.urlopen(base + path, timeout=3)
                except Exception:
                    pass
            time.sleep(0.6)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=6)
            except Exception:
                proc.kill()
    _report("真实服务(访问日志 + DEBUG)", invite, log_file, extra=(share,))


def scenario_engine(echo: bool) -> None:
    """SQLAlchemy 自己的参数日志：echo=True 与 echo=False + DEBUG 两种。"""
    db = WORK / f"echo_{int(echo)}.db"
    if db.exists():
        db.unlink()
    log_file = WORK / f"echo_{int(echo)}.log"
    log_file.write_text("", encoding="utf-8")

    os.environ["MAPR_DATABASE_URL"] = f"sqlite+aiosqlite:///{db}"
    for mod in [m for m in list(sys.modules) if m.startswith("app")]:
        del sys.modules[mod]
    sys.path.insert(0, str(ROOT / "backend"))

    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy import text

    import app.core.observability as obs
    obs.install_redacting_filter()

    handler = logging.FileHandler(log_file, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(name)s %(message)s"))
    root = logging.getLogger()
    for old in list(root.handlers):
        root.removeHandler(old)
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.DEBUG)
    logging.getLogger("aiosqlite").setLevel(logging.DEBUG)

    token = secrets.token_urlsafe(32)
    engine = create_async_engine(f"sqlite+aiosqlite:///{db}", echo=echo)

    async def run() -> None:
        import app.core.database as dbmod
        # 一次性导入全部模型，避免外键指向未注册的表
        for mod in (
            "app.models.user", "app.models.room", "app.models.agent_card",
            "app.chat.models", "app.a2a.models", "app.approval.models",
            "app.models.room_invite", "app.models.room_share",
            "app.models.room_permission", "app.models.agent_task_delivery",
        ):
            __import__(mod)
        Base = dbmod.Base
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            await conn.execute(
                text("select * from room_invites where token = :t"), {"t": token}
            )
        await engine.dispose()

    asyncio.run(run())
    for h in list(root.handlers):
        h.flush()
        h.close()
        root.removeHandler(h)
    _report(f"引擎 echo={echo}", token, log_file)


def main() -> int:
    scenario_real_server()
    scenario_engine(echo=True)
    scenario_engine(echo=False)
    print("总结：" + ("存在泄露 " + str(failures) if failures else "全部拦住"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
