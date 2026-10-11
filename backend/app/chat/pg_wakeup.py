"""Lossy transaction-bound PG wakeups; persistent DB reconciliation is authority.

No global instance, settings import, shared session, WebSocket send or Redis.
Create ONE PgWakeup per Hub lifespan, not per socket. See the PG wakeup ADR.
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
import json
import logging
import math
import re
from typing import Any

import asyncpg
from sqlalchemy import text
from sqlalchemy.engine import URL, make_url
from sqlalchemy.dialects.postgresql.asyncpg import PGDialect_asyncpg
from sqlalchemy.ext.asyncio import AsyncSession

CHANNEL = "mapr_wakeup_v1"
_ID = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}\Z", re.ASCII)
_KINDS = frozenset({"agent", "user", "room"})
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class WakeupHint:
    kind: str
    id: str


def _hint(kind: str, id: str) -> WakeupHint:
    if not isinstance(kind, str) or kind not in _KINDS or not isinstance(id, str) or not _ID.fullmatch(id):
        raise ValueError("Invalid wakeup metadata")
    return WakeupHint(kind, id)


def signal_sync_in_transaction(connection, kind: str, id: str) -> bool:
    """ORM flush companion, on the SAME transaction/connection and protocol."""
    hint = _hint(kind, id)
    if not connection.in_transaction() or connection._is_autocommit_isolation():
        raise ValueError("Wakeup requires transactional isolation")
    if connection.dialect.name == "sqlite":
        return False
    if connection.dialect.name != "postgresql":
        raise ValueError("Unsupported wakeup database")
    connection.execute(text("SELECT pg_notify(:channel, :payload)"), {
        "channel": CHANNEL,
        "payload": json.dumps({"v": 1, "kind": hint.kind, "id": hint.id}, separators=(",", ":")),
    })
    return True


async def signal_in_transaction(session: AsyncSession, kind: str, id: str) -> bool:
    """Queue a minimal PG hint in the existing business transaction, never commit.

    Return False for SQLite. Raise on invalid input, absent transaction,
    autocommit, unsupported DB or SQL failure; caller owns rollback/retry.
    """
    hint = _hint(kind, id)
    if not session.in_transaction():
        raise ValueError("Wakeup requires an active business transaction")
    dialect = session.get_bind().dialect.name
    if dialect == "sqlite":
        return False
    if dialect != "postgresql":
        raise ValueError("Unsupported wakeup database")
    connection = await session.connection()
    # SQLAlchemy 2.x's transaction flag also covers AUTOCOMMIT's virtual
    # transaction. Check the actual configured isolation, not that flag alone.
    if connection.sync_connection._is_autocommit_isolation():
        raise ValueError("Wakeup requires transactional isolation")
    await session.execute(text("SELECT pg_notify(:channel, :payload)"), {
        "channel": CHANNEL,
        "payload": json.dumps({"v": 1, "kind": hint.kind, "id": hint.id}, separators=(",", ":")),
    })
    return True


class PgWakeup:
    """One dedicated connection, bounded/coalesced hints, periodic DB fallback.

    Callbacks must be async, cancellation-cooperative and independently open
    short DB transactions. They are serialized and exceptions are isolated.
    start() schedules work; it does not wait for database availability.
    connect_factory() is an optional private-connection factory for tests/custom
    TLS configuration; ownership transfers here, including close/terminate.
    """

    def __init__(self, database_url: str | URL, *, reconcile_interval: float = 10,
                 connect_timeout: float = 5, io_timeout: float = 5,
                 callback_timeout: float = 5, retry_min: float = .25,
                 retry_max: float = 10, close_timeout: float = 1,
                 queue_size: int = 256,
                 connect_factory: Callable[[], Awaitable[Any]] | None = None):
        for value in (reconcile_interval, connect_timeout, io_timeout, callback_timeout,
                      retry_min, retry_max, close_timeout):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Wakeup timing must be finite and positive")
        if retry_min > retry_max or type(queue_size) is not int or not 1 <= queue_size <= 4096:
            raise ValueError("Invalid wakeup bounds")
        url = make_url(database_url)
        backend = url.get_backend_name()
        if backend not in {"sqlite", "postgresql", "postgres"}:
            raise ValueError("Unsupported wakeup database")
        self._postgres = backend != "sqlite"
        self._connect_options = None
        if self._postgres:
            # Preserve credentials/TLS/multihost options without assembling a
            # raw credential-bearing DSN or borrowing the application pool.
            _, options = PGDialect_asyncpg().create_connect_args(url)
            options.pop("prepared_statement_cache_size", None)  # SQLAlchemy adapter-only setting
            options.update(timeout=connect_timeout, command_timeout=io_timeout)
            self._connect_options = options
        self._connect_factory = connect_factory or self._connect
        self.reconcile_interval = reconcile_interval
        self.connect_timeout = connect_timeout
        self.io_timeout = io_timeout
        self.callback_timeout = callback_timeout
        self.retry_min = retry_min
        self.retry_max = retry_max
        self.close_timeout = close_timeout
        self._queue = asyncio.Queue(maxsize=queue_size)
        self._pending: set[WakeupHint] = set()
        self._ready = asyncio.Event()
        self._reconcile_requested = asyncio.Event()
        self._callback_lock = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._tasks: list[asyncio.Task] = []
        self._running = False
        self._connection = None
        self._on_wakeup = None
        self._on_reconcile = None

    @property
    def listening(self) -> bool:
        """Diagnostic only; never an authorization or delivery guarantee."""
        return self._ready.is_set()

    async def _connect(self):
        return await asyncpg.connect(**self._connect_options)

    async def start(self, on_wakeup: Callable[[WakeupHint], Awaitable[None]],
                    on_reconcile: Callable[[], Awaitable[None]]) -> None:
        async with self._lifecycle_lock:
            if self._running:
                return
            if not callable(on_wakeup) or not callable(on_reconcile):
                raise ValueError("Wakeup requires callbacks")
            self._on_wakeup, self._on_reconcile = on_wakeup, on_reconcile
            self._running = True
            self._tasks = [asyncio.create_task(self._reconcile_loop(), name="pg-wakeup-reconcile")]
            if self._postgres:
                self._tasks.extend([
                    asyncio.create_task(self._listen_loop(), name="pg-wakeup-listener"),
                    asyncio.create_task(self._dispatch_loop(), name="pg-wakeup-dispatch"),
                ])

    async def stop(self) -> None:
        async with self._lifecycle_lock:
            self._running = False
            self._ready.clear()
            for task in self._tasks:
                task.cancel()
            await asyncio.gather(*self._tasks, return_exceptions=True)
            self._tasks.clear()
            self._pending.clear()
            while not self._queue.empty():
                self._queue.get_nowait()
                self._queue.task_done()
            self._reconcile_requested.clear()
            self._on_wakeup = self._on_reconcile = None

    async def _call(self, callback, *args) -> bool:
        try:
            await asyncio.wait_for(callback(*args), self.callback_timeout)
            return True
        except asyncio.CancelledError:
            if asyncio.current_task().cancelling():
                raise
            # A callback can cancel itself; do not kill the infrastructure.
        except Exception:
            pass
        logger.warning("PG wakeup callback failed or timed out")
        return False

    async def _reconcile(self) -> bool:
        async with self._callback_lock:
            return await self._call(self._on_reconcile)

    async def _reconcile_loop(self):
        while self._running:
            self._reconcile_requested.clear()
            await self._reconcile()
            try:
                await asyncio.wait_for(self._reconcile_requested.wait(), self.reconcile_interval)
                # Coalesce an overflow storm instead of spinning DB scans.
                await asyncio.sleep(min(.05, self.reconcile_interval))
            except asyncio.TimeoutError:
                pass

    def _notification(self, connection, pid, channel, payload):
        # asyncpg callback does no IO, no DB access and no application callback.
        if not self._running or connection is not self._connection or channel != CHANNEL:
            return
        try:
            if not isinstance(payload, str) or len(payload) > 512:
                return
            value = json.loads(payload)
            if not isinstance(value, dict) or set(value) != {"v", "kind", "id"} or type(value["v"]) is not int or value["v"] != 1:
                return
            hint = _hint(value["kind"], value["id"])
        except (ValueError, TypeError):
            return
        if hint in self._pending:
            return
        if self._queue.full():
            self._reconcile_requested.set()
            return
        self._pending.add(hint)
        self._queue.put_nowait(hint)

    async def _dispatch_loop(self):
        while self._running:
            await self._ready.wait()
            hint = await self._queue.get()
            try:
                async with self._callback_lock:
                    if not self._ready.is_set():
                        self._reconcile_requested.set()
                    elif not await self._call(self._on_wakeup, hint):
                        self._reconcile_requested.set()
            finally:
                self._pending.discard(hint)
                self._queue.task_done()

    async def _close(self, connection):
        try:
            await asyncio.wait_for(connection.close(), self.close_timeout)
        except (Exception, asyncio.CancelledError):
            # Local termination is immediate; never wait indefinitely for PG.
            connection.terminate()

    async def _listen_loop(self):
        delay = self.retry_min
        while self._running:
            connection = None
            disconnected = asyncio.Event()
            try:
                connection = await asyncio.wait_for(self._connect_factory(), self.connect_timeout)
                self._connection = connection
                if connection.is_in_transaction():
                    raise ValueError("Listener requires an idle private connection")
                connection.add_termination_listener(lambda _: disconnected.set())
                # asyncpg add_listener performs its own autocommitted LISTEN.
                # No business DB session or explicit transaction is opened here.
                await asyncio.wait_for(connection.add_listener(CHANNEL, self._notification), self.io_timeout)
                while self._running and not disconnected.is_set():
                    if await self._reconcile():
                        break
                    try:
                        await asyncio.wait_for(disconnected.wait(), self.reconcile_interval)
                    except asyncio.TimeoutError:
                        pass
                if disconnected.is_set() or connection.is_closed():
                    raise ConnectionError()
                self._ready.set()
                while self._running:
                    try:
                        await asyncio.wait_for(disconnected.wait(), min(5, self.reconcile_interval))
                        raise ConnectionError()
                    except asyncio.TimeoutError:
                        await asyncio.wait_for(connection.fetchval("SELECT 1"), self.io_timeout)
                        delay = self.retry_min
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("PG wakeup listener unavailable; DB reconciliation remains active")
                self._reconcile_requested.set()
            finally:
                self._ready.clear()
                self._connection = None
                if connection is not None:
                    await self._close(connection)
            await asyncio.sleep(delay)
            delay = min(self.retry_max, delay * 2)
