"""Database wiring placeholder for the demo.

Phase 1 will replace this with SQLAlchemy async engine/session setup once
PostgreSQL is introduced.
"""


async def check_database_connection() -> dict:
    return {
        "status": "skipped",
        "reason": "The demo uses an in-memory room store. PostgreSQL is not wired yet.",
    }
