"""SQLAlchemy async engine, session factory, and base model.

Usage:
    from app.core.database import async_session

    async with async_session() as session:
        result = await session.execute(select(User))
"""

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings  # type: ignore[import-unconf]

settings = get_settings()

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
    except Exception as e:
        return {"status": "error", "reason": str(e)}
