"""Pytest fixtures: test database + test client.

Compatible with pytest-asyncio >= 0.23 and Python 3.13.
"""

import os
import sys
from pathlib import Path
from typing import AsyncGenerator

import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.engine import make_url
from sqlalchemy.pool import NullPool
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from app.main import app
from app.core.database import Base, get_db
from app.a2a import task_manager as a2a_task_manager
from app.a2a import server as a2a_server
from app.a2a import discovery as a2a_discovery
from app.chat import ws_handler as chat_ws_handler

# Use SQLite for tests (fast, no external deps)
TEST_DATABASE_URL = os.environ.get("MAPR_TEST_DATABASE_URL", "sqlite+aiosqlite:///./test.db")
# This fixture drops tables: never use the application/production database URL.
if not make_url(TEST_DATABASE_URL).drivername.startswith("sqlite"):
    database_name = make_url(TEST_DATABASE_URL).database or ""
    if not database_name.endswith("_test"):
        raise RuntimeError("MAPR_TEST_DATABASE_URL must point to a dedicated *_test database")

engine = create_async_engine(TEST_DATABASE_URL, echo=False, poolclass=NullPool)
test_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

a2a_task_manager.async_session = test_session
a2a_server.async_session = test_session
a2a_discovery.async_session = test_session
chat_ws_handler.async_session = test_session


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    """Create tables before each test, drop after."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


async def override_get_db() -> AsyncGenerator[AsyncSession, None]:
    """Override FastAPI dependency with test database."""
    async with test_session() as session:
        try:
            yield session
        finally:
            await session.close()


app.dependency_overrides[get_db] = override_get_db


@pytest_asyncio.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    """FastAPI test client."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def auth_headers(client: AsyncClient) -> dict[str, str]:
    """Register a human test user and return auth headers."""
    username = "tester"
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": "secret123",
            "display_name": "Test User",
        },
    )
    if resp.status_code == 409:
        resp = await client.post(
            "/api/v1/auth/login",
            json={"username": username, "password": "secret123"},
        )
    token = resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest_asyncio.fixture
async def db() -> AsyncGenerator[AsyncSession, None]:
    """Get a test database session."""
    async with test_session() as session:
        yield session
