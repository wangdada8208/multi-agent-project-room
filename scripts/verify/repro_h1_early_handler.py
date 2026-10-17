"""复现测试同事报的时序：日志 handler 在 import app.main 之前就挂上。

测试同事的探针在这个时序下打出 6 行 _repr_params(...) 泄露。
本脚本用来判定这是不是真缺口。

用法（仓库根目录）：
    python scripts/verify/repro_h1_early_handler.py
退出码 0 = 未泄露；1 = 泄露。
"""
import asyncio
import io
import logging
import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / ".tmpverify"
WORK.mkdir(exist_ok=True)
DB = WORK / "early_handler.db"
if DB.exists():
    DB.unlink()
os.environ["MAPR_DATABASE_URL"] = f"sqlite+aiosqlite:///{DB}"
sys.path.insert(0, str(ROOT / "backend"))

# ── 关键时序：在 import app.main 之前就挂 handler ──
stream = io.StringIO()
handler = logging.StreamHandler(stream)
handler.setFormatter(logging.Formatter("%(name)s %(message)s"))
root = logging.getLogger()
root.addHandler(handler)
root.setLevel(logging.DEBUG)
logging.getLogger("sqlalchemy.engine").setLevel(logging.DEBUG)
logging.getLogger("aiosqlite").setLevel(logging.DEBUG)

print("导入前 handler 的过滤器:", [type(f).__name__ for f in handler.filters])

import app.main  # noqa: E402,F401  触发 install_redacting_filter

print("导入后 handler 的过滤器:", [type(f).__name__ for f in handler.filters])

from sqlalchemy import text  # noqa: E402
from app.core.database import engine  # noqa: E402

TOKEN = secrets.token_urlsafe(32)


async def run() -> None:
    async with engine.begin() as conn:
        await conn.execute(text("select 1 where :t = :t"), {"t": TOKEN})
    await engine.dispose()


asyncio.run(run())

output = stream.getvalue()
leaks = [ln for ln in output.splitlines() if TOKEN in ln]
engine_lines = [ln for ln in output.splitlines() if ln.startswith("sqlalchemy.engine")]
print(f"日志行: {len(output.splitlines())}   sqlalchemy.engine 行: {len(engine_lines)}   泄露行: {len(leaks)}")
for ln in leaks[:6]:
    print(" LEAK:", ln[:150])
# 额外：如果某人只装了自己那一份过滤、没调 install_redacting_filter()，
# 早期挂的 handler 就不会被补上。这是唯一能复现泄露的写法。
print("总结：" + ("存在泄露" if leaks else "未泄露"))
sys.exit(1 if leaks else 0)
