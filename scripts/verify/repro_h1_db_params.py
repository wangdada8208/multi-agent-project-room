"""H1 复现（组长版）：数据库参数日志里的令牌泄露。

与 lead_sa_probe.py 同一思路，但用真实格式的令牌：
邀请令牌是 secrets.token_urlsafe(32)，约 43 位无分隔符的 URL-safe 串。

用法（仓库根目录）：
    python scripts/verify/repro_h1_db_params.py
退出码 0 = 未泄露；1 = 泄露。
"""
import asyncio
import logging
import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / ".tmpverify"
WORK.mkdir(exist_ok=True)
DB = WORK / "h1db.db"
LOG = WORK / "h1db.log"

os.environ.setdefault("MAPR_DATABASE_URL", f"sqlite+aiosqlite:///{DB}")
sys.path.insert(0, str(ROOT / "backend"))

if DB.exists():
    DB.unlink()
LOG.write_text("", encoding="utf-8")

handler = logging.FileHandler(LOG, encoding="utf-8")
handler.setFormatter(logging.Formatter("%(name)s %(message)s"))
root = logging.getLogger()
root.addHandler(handler)
root.setLevel(logging.DEBUG)
logging.getLogger("sqlalchemy.engine").setLevel(logging.DEBUG)
logging.getLogger("aiosqlite").setLevel(logging.DEBUG)

import app.main  # noqa: F401  触发 install_redacting_filter
from app.core.database import Base, engine
from sqlalchemy import text

TOKEN = secrets.token_urlsafe(32)


async def main() -> None:
    from app.models.room_invite import RoomInvite  # noqa: F401  注册表
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(
            text("select * from room_invites where token = :t"), {"t": TOKEN}
        )


asyncio.run(main())

text_log = LOG.read_text(encoding="utf-8", errors="replace")
leaks = [line for line in text_log.splitlines() if TOKEN in line]
print(f"令牌长度: {len(TOKEN)}   日志总行: {len(text_log.splitlines())}   泄露行: {len(leaks)}")
for line in leaks[:6]:
    print(" LEAK:", line[:170])
print("总结：" + ("存在泄露" if leaks else "未泄露"))
sys.exit(1 if leaks else 0)
