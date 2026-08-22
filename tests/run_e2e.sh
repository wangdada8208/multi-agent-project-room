#!/bin/bash
set -e
cd "$(dirname "$0")/.."
source .venv/bin/activate

DB_PATH="$(pwd)/e2e_test.db"
export MAPR_DATABASE_URL="sqlite+aiosqlite:///${DB_PATH}"

# 建表
python -c "
import asyncio, sys; sys.path.insert(0, 'backend')
from app.core.database import Base, engine
async def init():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print('DB tables created at', '${DB_PATH}')
asyncio.run(init())
"

# 启动服务器（--env-file 覆盖 .env）
uvicorn app.main:app --app-dir backend --port 8000 --env-file /dev/null &
SERVER_PID=$!
sleep 2

# 运行测试
python tests/e2e_gateway_test.py
EXIT_CODE=$?

kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true
exit $EXIT_CODE
