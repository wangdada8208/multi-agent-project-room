"""Shared SSE lease quota; HTTP integration and lifespan sweep are separate modules.

Approved design / f60 handoff (2026-10-11):
* LEASE_METADATA is independent of Base; f60 is the explicit PG migration.
  Only local SQLite init_db creates it for development. POSTGRES_DDL defines
  the exact table/index specification; this module never auto-migrates PG.
* One fixed transaction advisory lock serializes all quota mutations across
  Hubs on the SAME PostgreSQL DB. READ COMMITTED and real transactions are
  mandatory. Count AFTER acquiring the lock, using clock_timestamp() AFTER
  the wait. No user-derived lock keys, Python hashing or stale snapshots.
* Each API owns a short, committed transaction on an IDLE AsyncSession. Use a
  new session per call; never reuse an SSE read/business transaction here.
  Limits 64 total / 4 per authenticated user, lease 30s, renew every 10s.
* hub_id must be a server-generated per-process boot identity, never supplied
  by the HTTP client or reused on restart. lease_id is a fresh UUID4 capability.
  Quota is NOT authentication: HTTP must first validate account/task access.
* Only opaque user/task/Hub IDs and expiry are stored: no token, URL, room body
  or artifacts. Errors contain no IDs/SQL/DSN or underlying exception text.
* Integrator acquires BEFORE admitting the stream; renews via independent
  short sessions even while frames flow; stops on renewal failure/expiry;
  releases in response AND generator finally, with bounded cancellation-safe
  cleanup. Release is idempotent; crash recovery is expiry + sweep/acquire.
  A failed/cancelled COMMIT acknowledgement can leave a committed lease until
  expiry; always fail closed and discard/close that call's session. Absolute
  zero orphan slots on ambiguous commits is not promised.
  Check validity before network writes. Slow/paused Hubs and already-buffered
  bytes mean this cannot physically cap every open TCP connection. Failure
  fencing / stopping old streams remains an HTTP integration requirement.
* SQLite BEGIN IMMEDIATE is a tested local fallback only. No cross-machine or
  multi-process deployment guarantee is claimed for SQLite. PG Hubs must use
  the same policy, schema, advisory key and primary (not a read replica).
* Scheduling, HTTP errors/429 mapping and permissions live in http_protocol;
  lifespan sweep lives in sse_sweeper. No Redis or Base model changes.
  Timing bounds: TTL <= 86400s, transaction timeout <= 30s (default 3s).

PG transaction locks: https://www.postgresql.org/docs/17/explicit-locking.html
SQLAlchemy 2.x _is_autocommit_isolation is inspected here to reject virtual
AUTOCOMMIT transactions; recheck this internal API on dependency upgrades.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
import re
import uuid
from collections.abc import Callable

from sqlalchemy import (Column, DateTime, Index, MetaData, String, Table,
                        case, delete, func, insert, select, text, update)
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.schema import CreateIndex, CreateTable

MAX_STREAMS = 64
MAX_USER_STREAMS = 4
LEASE_SECONDS = 30.0
RENEW_SECONDS = 10.0
# Reserved DB-wide namespace for this module; every writer must use this key.
ADVISORY_LOCK_KEY = 0x4D415052535345

LEASE_METADATA = MetaData()
LEASE_TABLE = Table(
    "sse_stream_leases", LEASE_METADATA,
    Column("lease_id", String(36), primary_key=True),
    Column("user_id", String(128), nullable=False),
    Column("task_id", String(128), nullable=False),
    Column("hub_id", String(128), nullable=False),
    Column("expires_at", DateTime(timezone=True), nullable=False),
)
Index("ix_sse_stream_leases_expires_at", LEASE_TABLE.c.expires_at)
Index("ix_sse_stream_leases_user_expiry", LEASE_TABLE.c.user_id, LEASE_TABLE.c.expires_at)
POSTGRES_DDL = (
    str(CreateTable(LEASE_TABLE).compile(dialect=postgresql.dialect())),
    *(str(CreateIndex(index).compile(dialect=postgresql.dialect()))
      for index in sorted(LEASE_TABLE.indexes, key=lambda index: index.name)),
)
_ID = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}\Z", re.ASCII)


class QuotaExceeded(Exception):
    def __init__(self):
        super().__init__("SSE stream limit reached")


class QuotaUnavailable(Exception):
    def __init__(self):
        super().__init__("SSE quota unavailable")


@dataclass(frozen=True)
class Lease:
    lease_id: str
    user_id: str
    task_id: str
    hub_id: str
    expires_at: datetime


def _id(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("Invalid quota metadata")
    return value


def _lease_id(value):
    try:
        parsed = uuid.UUID(value)
        if parsed.version != 4 or str(parsed) != value:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise ValueError("Invalid quota metadata") from None
    return value


def _lease(row) -> Lease:
    values = dict(row)
    if values["expires_at"].tzinfo is None:
        values["expires_at"] = values["expires_at"].replace(tzinfo=timezone.utc)
    return Lease(**values)


class SSEGlobalQuota:
    """Policy instance; configured TTL must be the same on every PG Hub."""
    def __init__(self, *, lease_seconds=LEASE_SECONDS, renew_seconds=RENEW_SECONDS,
                 db_timeout=3.0, sqlite_clock: Callable[[], datetime] | None = None):
        if any(not math.isfinite(value) or value <= 0 for value in
               (lease_seconds, renew_seconds, db_timeout)) or renew_seconds >= lease_seconds or lease_seconds > 86400 or db_timeout > 30:
            raise ValueError("Invalid quota timing")
        self.lease_seconds = lease_seconds
        self.renew_seconds = renew_seconds  # Integration scheduler's recommended interval.
        self.db_timeout = db_timeout
        self._sqlite_clock = sqlite_clock or (lambda: datetime.now(timezone.utc))

    @asynccontextmanager
    async def _transaction(self, db: AsyncSession):
        # Fail closed without committing/rolling back someone else's work.
        if db.in_transaction():
            raise QuotaUnavailable()
        try:
            async with asyncio.timeout(self.db_timeout):
                async with db.begin():
                    connection = await db.connection()
                    if connection.sync_connection._is_autocommit_isolation():
                        raise QuotaUnavailable()
                    dialect = connection.dialect.name
                    if dialect == "postgresql":
                        if await connection.get_isolation_level() != "READ COMMITTED":
                            raise QuotaUnavailable()
                        await db.execute(text("SELECT set_config('lock_timeout', :timeout, true), "
                                              "set_config('statement_timeout', :timeout, true)"),
                                         {"timeout": str(max(1, int(self.db_timeout * 1000)))})
                        await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ADVISORY_LOCK_KEY})
                        now = (await db.execute(text("SELECT clock_timestamp()"))).scalar_one()
                    elif dialect == "sqlite":
                        # Bound the worker-thread's busy wait too: asyncio
                        # cancellation cannot interrupt sqlite3's busy handler.
                        milliseconds = max(1, int(self.db_timeout * 1000))
                        await connection.exec_driver_sql(f"PRAGMA busy_timeout = {milliseconds}")
                        # Before any data read/write in this fresh transaction:
                        # serialize the entire check + insert, not just writes.
                        await db.execute(text("BEGIN IMMEDIATE"))
                        now = self._sqlite_clock()
                        if not isinstance(now, datetime) or now.tzinfo is None:
                            raise QuotaUnavailable()
                        now = now.astimezone(timezone.utc)
                    else:
                        raise QuotaUnavailable()
                    yield now
        except (SQLAlchemyError, TimeoutError):
            raise QuotaUnavailable() from None

    async def acquire(self, db: AsyncSession, user_id: str, task_id: str, hub_id: str) -> Lease:
        _id(user_id), _id(task_id), _id(hub_id)
        async with self._transaction(db) as now:
            await db.execute(delete(LEASE_TABLE).where(LEASE_TABLE.c.expires_at <= now))
            total, personal = (await db.execute(select(
                func.count(), func.count().filter(LEASE_TABLE.c.user_id == user_id)
            ).select_from(LEASE_TABLE).where(LEASE_TABLE.c.expires_at > now))).one()
            if total >= MAX_STREAMS or personal >= MAX_USER_STREAMS:
                raise QuotaExceeded()
            values = {"lease_id": str(uuid.uuid4()), "user_id": user_id,
                      "task_id": task_id, "hub_id": hub_id,
                      "expires_at": now + timedelta(seconds=self.lease_seconds)}
            await db.execute(insert(LEASE_TABLE).values(**values))
            lease = _lease(values)
        return lease  # Returned only AFTER commit, not from inside the transaction.

    async def bind_task(self, db: AsyncSession, lease_id: str, hub_id: str, task_id: str) -> bool:
        """Bind a pre-admission reservation after streaming task creation."""
        _lease_id(lease_id), _id(hub_id), _id(task_id)
        async with self._transaction(db) as now:
            result = await db.execute(update(LEASE_TABLE).where(
                LEASE_TABLE.c.lease_id == lease_id, LEASE_TABLE.c.hub_id == hub_id,
                LEASE_TABLE.c.expires_at > now).values(task_id=task_id))
            changed = result.rowcount == 1
        return changed

    async def renew(self, db: AsyncSession, lease_id: str, hub_id: str) -> Lease | None:
        _lease_id(lease_id), _id(hub_id)
        async with self._transaction(db) as now:
            expiry = now + timedelta(seconds=self.lease_seconds)
            row = (await db.execute(update(LEASE_TABLE).where(
                LEASE_TABLE.c.lease_id == lease_id, LEASE_TABLE.c.hub_id == hub_id,
                LEASE_TABLE.c.expires_at > now,
            ).values(expires_at=case((LEASE_TABLE.c.expires_at > expiry, LEASE_TABLE.c.expires_at),
                                    else_=expiry)).returning(*LEASE_TABLE.c))).mappings().one_or_none()
            lease = _lease(row) if row is not None else None
        return lease  # Expired or wrong-owner lease is never resurrected.

    async def release(self, db: AsyncSession, lease_id: str, hub_id: str) -> bool:
        _lease_id(lease_id), _id(hub_id)
        async with self._transaction(db):
            result = await db.execute(delete(LEASE_TABLE).where(
                LEASE_TABLE.c.lease_id == lease_id, LEASE_TABLE.c.hub_id == hub_id))
            changed = result.rowcount == 1
        return changed

    async def sweep(self, db: AsyncSession, *, limit: int = 256) -> int:
        if type(limit) is not int or not 1 <= limit <= 1024:
            raise ValueError("Invalid quota sweep bound")
        async with self._transaction(db) as now:
            expired = select(LEASE_TABLE.c.lease_id).where(LEASE_TABLE.c.expires_at <= now).order_by(
                LEASE_TABLE.c.expires_at, LEASE_TABLE.c.lease_id).limit(limit)
            result = await db.execute(delete(LEASE_TABLE).where(LEASE_TABLE.c.lease_id.in_(expired)))
            changed = result.rowcount
        return changed


_default = SSEGlobalQuota()


async def acquire(db: AsyncSession, user_id: str, task_id: str, hub_id: str) -> Lease:
    return await _default.acquire(db, user_id, task_id, hub_id)


async def renew(db: AsyncSession, lease_id: str, hub_id: str) -> Lease | None:
    return await _default.renew(db, lease_id, hub_id)


async def release(db: AsyncSession, lease_id: str, hub_id: str) -> bool:
    return await _default.release(db, lease_id, hub_id)


async def sweep(db: AsyncSession, *, limit: int = 256) -> int:
    return await _default.sweep(db, limit=limit)
