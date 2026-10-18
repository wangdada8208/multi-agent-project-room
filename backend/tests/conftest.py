"""Pytest fixtures: test database + test client.

Compatible with pytest-asyncio >= 0.23 and Python 3.13.
"""

import ipaddress
import os
import socket
import sys
from pathlib import Path
from typing import AsyncGenerator
from urllib.parse import urlsplit

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

from app.a2a.sse_global_quota import LEASE_METADATA
from app.models import room_share as _room_share_models
from app.main import app
from app.core import database as core_database
from app.core.database import Base, get_db
from app.a2a import task_manager as a2a_task_manager
from app.a2a import server as a2a_server
from app.a2a import discovery as a2a_discovery
from app.chat import ws_handler as chat_ws_handler
from app.ws.connection_manager import connection_manager
from app.auth.rate_limit import _attempts, _blocked_until, _flush_redis_state

# ---------------------------------------------------------------------------
# Safe DNS faking for the SSRF suites
# ---------------------------------------------------------------------------
# The SSRF gates replace the *process-global* ``socket.getaddrinfo`` so that an
# outbound agent endpoint can be simulated with zero real network access.  Such
# a patch also captures every other name lookup performed while it is installed,
# including the test database and the test Redis connection.  CI addresses both
# as ``localhost`` (.github/workflows/deploy.yml), so the fake resolver answered
# for PostgreSQL too: asyncpg then tried to reach the synthetic agent IP and
# died with a 60s ``TimeoutError`` after ``asyncpg.connect``.  That is why the
# SSRF gates were green locally (127.0.0.1 is an IP literal, so no lookup
# happens) and red in CI.  Redis degraded the same way, tripping the rate-limiter
# circuit breaker into its in-process fallback for the next 60s.
#
# The helpers below keep the simulation honest: loopback names, IP literals and
# whatever host the test database / Redis are configured with always resolve
# through the *real* resolver; only the synthetic agent hostnames are faked.

REAL_GETADDRINFO = socket.getaddrinfo

_LOOPBACK_HOSTNAMES = frozenset(
    {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"}
)


def _configured_infrastructure_hostnames() -> frozenset[str]:
    """Loopback names plus the hosts the test database / Redis point at."""
    hosts = set(_LOOPBACK_HOSTNAMES)
    for env_name in (
        "MAPR_TEST_DATABASE_URL",
        "MAPR_DATABASE_URL",
        "MAPR_TEST_REDIS_URL",
        "MAPR_REDIS_URL",
    ):
        raw = (os.environ.get(env_name) or "").strip()
        if not raw:
            continue
        try:
            host = urlsplit(raw).hostname
        except ValueError:
            host = None
        if host:
            hosts.add(host.strip("[]").lower())
    return frozenset(hosts)


INFRASTRUCTURE_HOSTNAMES = _configured_infrastructure_hostnames()


def is_infrastructure_host(host: object) -> bool:
    """True when ``host`` belongs to the test infrastructure, not to the fake agent.

    IP literals are treated as infrastructure as well: resolving them never needs
    DNS, and faking them would silently redirect a database connection.
    """
    if not isinstance(host, str) or not host:
        return True
    candidate = host.strip("[]").lower()
    if candidate in INFRASTRUCTURE_HOSTNAMES:
        return True
    try:
        ipaddress.ip_address(candidate)
    except ValueError:
        return False
    return True


def fake_agent_dns(fake_ips, *, default_port: int | None = None, record=None):
    """Build a ``socket.getaddrinfo`` stand-in for an SSRF test.

    ``fake_ips`` is one address, a sequence of addresses, or a callable returning
    either (so a test can flip the simulated answer mid-test).  A sequence entry
    may be ``"1.2.3.4"`` or ``(address_family, "address")``.  ``record`` is called
    with each hostname that actually got faked, so tests can still assert on the
    simulated lookups without counting the database resolving ``localhost``.
    """
    def resolve(host, port, *args, **kwargs):
        if is_infrastructure_host(host):
            return REAL_GETADDRINFO(host, port, *args, **kwargs)
        if record is not None:
            record(host)
        answers = fake_ips() if callable(fake_ips) else fake_ips
        if isinstance(answers, str):
            answers = [answers]
        resolved_port = port or default_port
        records = []
        for answer in answers:
            if isinstance(answer, str):
                family, address = socket.AF_INET, answer
            else:
                family, address = answer
            records.append(
                (family, socket.SOCK_STREAM, 6, "", (address, resolved_port))
            )
        return records
    return resolve


def protect_infrastructure_hosts(fake_getaddrinfo):
    """Wrap an existing ``getaddrinfo`` stand-in so infrastructure hosts stay real.

    Use this when a test already has its own fake resolver and only needs to stop
    it from answering for the test database / Redis::

        with patch("socket.getaddrinfo",
                   side_effect=protect_infrastructure_hosts(fake_getaddrinfo)):
            ...

    The wrapped resolver's answers are unchanged for every other host, so the
    simulated SSRF behaviour under test is not weakened.
    """
    def resolve(host, port, *args, **kwargs):
        if is_infrastructure_host(host):
            return REAL_GETADDRINFO(host, port, *args, **kwargs)
        return fake_getaddrinfo(host, port, *args, **kwargs)
    return resolve



# Use SQLite for tests (fast, no external deps)
TEST_DATABASE_URL = os.environ.get("MAPR_TEST_DATABASE_URL", "sqlite+aiosqlite:///./test.db")
# This fixture drops tables: never use the application/production database URL.
if not make_url(TEST_DATABASE_URL).drivername.startswith("sqlite"):
    database_name = make_url(TEST_DATABASE_URL).database or ""
    if not database_name.endswith("_test"):
        raise RuntimeError("MAPR_TEST_DATABASE_URL must point to a dedicated *_test database")

engine = create_async_engine(TEST_DATABASE_URL, echo=False, poolclass=NullPool)
test_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

core_database.async_session = test_session
a2a_task_manager.async_session = test_session
a2a_server.async_session = test_session
a2a_discovery.async_session = test_session
chat_ws_handler.async_session = test_session


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    """Create tables before each test, drop after."""
    connection_manager.reset()
    _attempts.clear()
    _blocked_until.clear()
    _flush_redis_state()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(LEASE_METADATA.create_all)
    yield
    connection_manager.reset()
    _attempts.clear()
    _blocked_until.clear()
    _flush_redis_state()
    async with engine.begin() as conn:
        await conn.run_sync(LEASE_METADATA.drop_all)
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
