"""SQLAlchemy async engine, session factory, and base model.

Usage:
    from app.core.database import async_session

    async with async_session() as session:
        result = await session.execute(select(User))
"""

import asyncio
import logging

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings  # type: ignore[import-unconf]

settings = get_settings()
logger = logging.getLogger(__name__)

engine = create_async_engine(
    settings.database_url,
    echo=False,
    pool_size=5,
    max_overflow=10,
)

async_session = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


class Base(DeclarativeBase):
    pass


async def init_db():
    """Create all tables. Called from FastAPI lifespan startup."""
    # Import all models so Base.metadata is populated
    import app.models.agent_task_delivery  # noqa: F401
    import app.models.agent_binding  # noqa: F401
    import app.models.user  # noqa: F401
    import app.models.room  # noqa: F401
    import app.models.agent_card  # noqa: F401
    import app.chat.models  # noqa: F401
    import app.a2a.models  # noqa: F401
    import app.approval.models  # noqa: F401
    import app.agent.models  # noqa: F401
    import app.knowledge.models  # noqa: F401
    import app.files.models  # noqa: F401
    import app.models.room_template  # noqa: F401
    import app.models.room_presence  # noqa: F401
    import app.models.room_permission  # noqa: F401
    import app.models.analytics  # noqa: F401
    import app.models.room_share  # noqa: F401

    env = (settings.environment or "").strip().lower()
    if env in ("development", "test", "testing", "dev") or engine.dialect.name == "sqlite":
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
            if conn.dialect.name == "sqlite":
                from app.a2a.sse_global_quota import LEASE_METADATA
                await conn.run_sync(LEASE_METADATA.create_all)
    else:
        async with engine.connect() as conn:
            await conn.execute(__import__("sqlalchemy").text("SELECT 1"))


async def get_db() -> AsyncSession:  # type: ignore[misc]
    """FastAPI dependency: yield an async session."""
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()


async def check_database_connection() -> dict:
    """Health-check endpoint: verify DB is reachable."""
    try:
        async with async_session() as session:
            await session.execute(
                __import__("sqlalchemy").text("SELECT 1")
            )
            return {"status": "connected", "reason": None}
    except Exception:
        return {"status": "error", "reason": "Database unavailable"}


EXPECTED_ALEMBIC_HEAD = "i90c20261017"
CRITICAL_TABLES = ("users",)


async def check_database_readiness(session: AsyncSession | None = None) -> dict:
    """Readiness probe: verify DB connectivity, alembic migration head, and critical schema tables."""
    async def _check(sess: AsyncSession) -> dict:
        import asyncio
        from sqlalchemy import text

        await asyncio.wait_for(sess.execute(text("SELECT 1")), timeout=2.0)
        current_rev = None
        try:
            rev_result = await sess.execute(text("SELECT version_num FROM alembic_version LIMIT 1"))
            rev_row = rev_result.first()
            current_rev = rev_row[0] if rev_row else None
        except Exception:
            # A failed statement leaves a real PostgreSQL transaction in the
            # aborted state: every later statement on this session keeps failing
            # with "current transaction is aborted, commands ignored until end
            # of transaction block" until it is rolled back. Without this
            # rollback the probe returned a misleading DATABASE_UNAVAILABLE
            # instead of the intended "Alembic version table not found", and the
            # critical-table check below could never run on the dev/test path.
            # SQLite does not abort the transaction on a failed statement, which
            # is why the default create_all() test path hid this for so long.
            await sess.rollback()
            env = (settings.environment or "").strip().lower()
            if engine.dialect.name == "sqlite" or env in ("development", "test", "testing", "dev"):
                current_rev = EXPECTED_ALEMBIC_HEAD
            else:
                return {"status": "not_ready", "reason": "Alembic version table not found"}

        if current_rev != EXPECTED_ALEMBIC_HEAD:
            return {
                "status": "not_ready",
                "reason": f"Alembic migration revision mismatch: current={current_rev}, expected={EXPECTED_ALEMBIC_HEAD}",
            }

        for table in CRITICAL_TABLES:
            await sess.execute(text(f"SELECT 1 FROM {table} LIMIT 1"))

        return {"status": "ready", "revision": current_rev, "reason": None}

    try:
        if session is not None:
            return await _check(session)
        async with async_session() as sess:
            return await _check(sess)
    except Exception as e:
        from app.core.observability import scrub_text

        # Sanitize exception for internal logging
        diag_msg = scrub_text(f"{type(e).__name__}: {e}")
        logger.warning("Database readiness probe failed: %s", diag_msg)

        # Map to safe, stable error code and description
        if isinstance(e, asyncio.TimeoutError):
            code = "DATABASE_TIMEOUT"
            desc = "Database query timed out"
        elif "OperationalError" in type(e).__name__:
            code = "DATABASE_CONNECTION_ERROR"
            desc = "Database connection failed"
        elif "ProgrammingError" in type(e).__name__:
            code = "DATABASE_QUERY_ERROR"
            desc = "Database query failed"
        else:
            code = "DATABASE_UNAVAILABLE"
            desc = "Database service unavailable"

        return {
            "status": "not_ready",
            "code": code,
            "reason": f"Database readiness check failed: {desc}",
            "diagnostic": diag_msg,
        }
