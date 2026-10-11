"""Deterministic fake PG protocol/transaction tests, never a real DB endpoint.

The fake models PG COMMIT delivery; it cannot prove server behavior. SQLite
tests use independent temporary SQLite databases even when other gates use PG.
"""
import asyncio
import json
from types import SimpleNamespace

import pytest

from app.chat.pg_wakeup import CHANNEL, PgWakeup, WakeupHint, signal_in_transaction


async def eventually(predicate, timeout=1):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(.002)


def payload(id="agent-1", kind="agent"):
    return json.dumps({"v": 1, "kind": kind, "id": id})


class FakeConnection:
    def __init__(self):
        self.closed = False
        self.listeners = {}
        self.terminations = []
        self.statements = []
        self.close_calls = 0
        self.terminate_calls = 0
        self.fail_ping = False
        self.hang_close = False
        self.after_listen = None
        self.transaction_active = False

    def add_termination_listener(self, callback):
        self.terminations.append(callback)

    async def add_listener(self, channel, callback):
        self.statements.append("LISTEN")
        self.listeners[channel] = callback
        if self.after_listen:
            self.after_listen(self)

    def notify(self, value, channel=CHANNEL):
        if not self.closed and channel in self.listeners:
            self.listeners[channel](self, 123, channel, value)

    def drop(self):
        self.closed = True
        for callback in self.terminations:
            callback(self)

    def is_closed(self):
        return self.closed

    def is_in_transaction(self):
        return self.transaction_active

    async def fetchval(self, sql):
        self.statements.append(sql)
        if self.fail_ping:
            raise ConnectionError("synthetic credential-bearing DSN must not be logged")
        return 1

    async def close(self):
        self.close_calls += 1
        if self.hang_close:
            await asyncio.Future()
        self.drop()

    def terminate(self):
        self.terminate_calls += 1
        self.drop()


class FakePG:
    def __init__(self):
        self.connections = []
        self.attempts = []
        self.failures = 0

    async def connect(self):
        self.attempts.append(asyncio.get_running_loop().time())
        if self.failures:
            self.failures -= 1
            raise ConnectionError("secret-dsn")
        connection = FakeConnection()
        self.connections.append(connection)
        return connection

    def notify(self, value):
        for connection in self.connections:
            connection.notify(value)


def worker(pg, **kwargs):
    return PgWakeup("postgresql+asyncpg://synthetic:synthetic@unused/synthetic_test",
                    connect_factory=pg.connect, reconcile_interval=.025,
                    retry_min=.01, retry_max=.04, io_timeout=.03,
                    connect_timeout=.03, callback_timeout=.03, close_timeout=.03, **kwargs)


async def noop(*args):
    pass


@pytest.mark.asyncio
async def test_two_hubs_each_one_private_connection_duplicate_hints_and_no_body():
    pg = FakePG()
    workers = [worker(pg), worker(pg)]
    received = [[], []]
    async def receive(index, hint):
        assert isinstance(hint, WakeupHint)
        received[index].append(hint)
    try:
        for index, item in enumerate(workers):
            await item.start(lambda hint, index=index: receive(index, hint), noop)
            await item.start(noop, noop)  # Idempotent; must not replace callback.
        await eventually(lambda: all(item.listening for item in workers))
        assert len(pg.connections) == 2
        for _ in range(20):
            pg.notify(payload())
        await eventually(lambda: all(received))
        assert received == [[WakeupHint("agent", "agent-1")]] * 2
        assert all(connection.statements == ["LISTEN"] for connection in pg.connections)
        # Separate commits can redeliver the same hint; handlers must be idempotent.
        pg.notify(payload())
        await eventually(lambda: all(len(values) == 2 for values in received))
    finally:
        await asyncio.gather(*(item.stop() for item in workers))
    assert all(connection.closed and connection.close_calls == 1 for connection in pg.connections)


@pytest.mark.asyncio
async def test_listen_catchup_precedes_hint_callback_and_failed_catchup_is_retried():
    pg = FakePG()
    item = worker(pg)
    order = []
    failures = 1
    async def connect():
        connection = await pg.connect()
        connection.after_listen = lambda conn: conn.notify(payload())
        return connection
    item._connect_factory = connect
    async def reconcile():
        nonlocal failures
        if pg.connections and pg.connections[-1].listeners:
            order.append("catchup")
            if failures:
                failures -= 1
                raise ValueError("synthetic catchup failure")
            order.append("catchup-success")
    async def receive(hint):
        order.append("hint")
    try:
        await item.start(receive, reconcile)
        await eventually(lambda: "hint" in order)
        assert order.index("catchup-success") < order.index("hint")
        assert order.count("catchup") >= 2
    finally:
        await item.stop()


@pytest.mark.asyncio
async def test_disconnect_reconnect_catchup_and_stale_connection_ignored():
    pg = FakePG()
    item = worker(pg)
    received = []
    snapshots = []
    async def reconcile():
        snapshots.append(len(pg.connections))
    async def receive(hint):
        received.append(hint.id)
    try:
        await item.start(receive, reconcile)
        await eventually(lambda: item.listening)
        old = pg.connections[0]
        old_callback = old.listeners[CHANNEL]
        old.drop()
        await eventually(lambda: len(pg.connections) == 2 and item.listening)
        assert 2 in snapshots
        old_callback(old, 123, CHANNEL, payload("stale"))
        pg.connections[1].notify(payload("fresh"))
        await eventually(lambda: received)
        assert received == ["fresh"] and old.close_calls == 1
    finally:
        await item.stop()


@pytest.mark.asyncio
async def test_half_open_health_failure_triggers_reconnect():
    pg = FakePG()
    item = worker(pg)
    try:
        await item.start(noop, noop)
        await eventually(lambda: item.listening)
        pg.connections[0].fail_ping = True
        await eventually(lambda: len(pg.connections) == 2 and item.listening)
        assert "SELECT 1" in pg.connections[0].statements
    finally:
        await item.stop()


@pytest.mark.asyncio
async def test_failed_connect_backoff_is_bounded_and_periodic_db_reconcile_continues(caplog):
    pg = FakePG()
    pg.failures = 100
    item = worker(pg)
    reconciled = []
    async def reconcile():
        reconciled.append(1)
    try:
        await item.start(noop, reconcile)
        await eventually(lambda: len(pg.attempts) >= 5)
        gaps = [b-a for a, b in zip(pg.attempts, pg.attempts[1:])]
        assert gaps[0] >= .009 and gaps[1] >= .019
        assert all(.009 <= gap < .1 for gap in gaps)
        assert len(reconciled) >= 3 and not item.listening
    finally:
        await item.stop()
    assert "secret-dsn" not in caplog.text
    assert not pg.connections and not item._tasks


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["error", "timeout", "self_cancel"])
async def test_callback_failures_are_isolated_and_no_private_exception_logged(mode, caplog):
    pg = FakePG()
    item = worker(pg)
    received = []
    reconciled = []
    async def receive(hint):
        received.append(hint.id)
        if hint.id == "bad":
            if mode == "error":
                raise ValueError("Bearer synthetic-secret private-body")
            if mode == "self_cancel":
                raise asyncio.CancelledError()
            await asyncio.Future()
    async def reconcile():
        reconciled.append(1)
    try:
        await item.start(receive, reconcile)
        await eventually(lambda: item.listening)
        pg.notify(payload("bad"))
        pg.notify(payload("good"))
        await eventually(lambda: received == ["bad", "good"])
        await eventually(lambda: len(reconciled) >= 3)
        assert all(not task.done() for task in item._tasks)
    finally:
        await item.stop()
    assert "synthetic-secret" not in caplog.text and "private-body" not in caplog.text


@pytest.mark.asyncio
async def test_bounded_queue_overflow_requests_full_reconcile_and_periodic_loss_recovery():
    pg = FakePG()
    item = worker(pg, queue_size=2)
    db_state = []
    observed = []
    async def reconcile():
        observed[:] = db_state
    try:
        await item.start(noop, reconcile)
        await eventually(lambda: item.listening)
        for index in range(100):
            pg.notify(payload(f"agent-{index}"))
        assert item._queue.qsize() == 2 and len(item._pending) == 2
        assert item._reconcile_requested.is_set()
        db_state.append("persisted-without-notify")
        await eventually(lambda: observed == db_state)
        # No notification emitted: periodic reconciliation is the recovery path.
        await eventually(lambda: not item._reconcile_requested.is_set())
        db_state.append("another-lost-notify")
        await eventually(lambda: observed == db_state)
    finally:
        await item.stop()


@pytest.mark.asyncio
async def test_untrusted_payload_is_not_forwarded_or_logged(caplog):
    pg = FakePG()
    item = worker(pg)
    received = []
    async def receive(hint):
        received.append(hint)
    try:
        await item.start(receive, noop)
        await eventually(lambda: item.listening)
        for value in ("not-json-private", "x"*9000, "[]", "null", payload("https://secret"),
                      json.dumps({"v": True, "kind": "agent", "id": "valid"}),
                      json.dumps({"v": 1, "kind": "agent", "id": "valid", "body": "private"})):
            pg.notify(value)
        pg.connections[0].notify(payload(), channel="other_channel")
        pg.notify(payload("valid"))
        await eventually(lambda: received)
        assert received == [WakeupHint("agent", "valid")]
    finally:
        await item.stop()
    assert "private" not in caplog.text and "secret" not in caplog.text


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["connect", "callback", "backoff"])
async def test_stop_immediately_cancels_pending_work_and_restart_is_supported(phase):
    pg = FakePG()
    item = worker(pg)
    entered = asyncio.Event()
    cancelled = asyncio.Event()
    async def blocked():
        entered.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()
    if phase == "connect":
        item._connect_factory = blocked
    elif phase == "backoff":
        pg.failures = 100
        item.retry_min = item.retry_max = 60
    try:
        await item.start(noop, blocked if phase == "callback" else noop)
        if phase == "backoff":
            await eventually(lambda: pg.attempts)
            await asyncio.sleep(.005)
        else:
            await entered.wait()
        tasks = item._tasks.copy()
        await asyncio.wait_for(item.stop(), .2)
        assert all(task.done() for task in tasks) and not item.listening
        if phase != "backoff":
            assert cancelled.is_set()
        await item.stop()
        item._connect_factory = pg.connect
        pg.failures = 0
        await item.start(noop, noop)
        await eventually(lambda: item.listening)
    finally:
        await item.stop()


@pytest.mark.asyncio
async def test_stop_terminates_connection_when_graceful_close_hangs():
    pg = FakePG()
    item = worker(pg)
    await item.start(noop, noop)
    try:
        await eventually(lambda: item.listening)
        connection = pg.connections[0]
        connection.hang_close = True
        await asyncio.wait_for(item.stop(), .2)
        assert connection.closed and connection.terminate_calls == 1
    finally:
        await item.stop()


class Transaction:
    """Explicit fake PG commit/rollback model, not a live server assertion."""
    def __init__(self, pg, *, autocommit=False):
        self.pg, self.pending, self.calls = pg, [], []
        self.active = True
        self.autocommit = autocommit

    def in_transaction(self):
        return self.active

    def get_bind(self):
        return SimpleNamespace(dialect=SimpleNamespace(name="postgresql"))

    async def connection(self):
        return SimpleNamespace(sync_connection=SimpleNamespace(_is_autocommit_isolation=lambda: self.autocommit))

    async def execute(self, statement, params):
        assert self.active
        self.calls.append((str(statement), params))
        self.pending.append(params["payload"])

    async def commit(self):
        self.active = False
        for value in self.pending:
            self.pg.notify(value)
        self.pending.clear()

    async def rollback(self):
        self.active = False
        self.pending.clear()


@pytest.mark.asyncio
async def test_bound_pg_notify_same_business_transaction_commit_and_rollback_model():
    pg = FakePG()
    item = worker(pg)
    received = []
    async def receive(hint):
        received.append(hint.id)
    try:
        await item.start(receive, noop)
        await eventually(lambda: item.listening)
        transaction = Transaction(pg)
        assert await signal_in_transaction(transaction, "agent", "committed")
        assert received == [] and transaction.active
        statement, params = transaction.calls[0]
        assert statement == "SELECT pg_notify(:channel, :payload)"
        assert "committed" not in statement and params["channel"] == CHANNEL
        assert set(json.loads(params["payload"])) == {"v", "kind", "id"}
        await transaction.commit()
        await eventually(lambda: received)
        rolled_back = Transaction(pg)
        await signal_in_transaction(rolled_back, "room", "rolled-back")
        await rolled_back.rollback()
        await asyncio.sleep(.04)
        assert received == ["committed"]
    finally:
        await item.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,id", [("task", "t"), ("agent", ""), ("room", "a"*129),
                                     ("user", "https://secret"), ("agent", "x'); SELECT 1;--"),
                                     ("room", "private\nbody"), ("agent", None)])
async def test_signal_invalid_metadata_has_no_db_access(kind, id):
    class NoDatabase:
        def in_transaction(self):
            raise AssertionError("No DB access allowed")
    with pytest.raises(ValueError, match="Invalid wakeup metadata"):
        await signal_in_transaction(NoDatabase(), kind, id)


@pytest.mark.asyncio
async def test_signal_rejects_autocommit_or_absent_transaction_and_sql_failure_propagates():
    transaction = Transaction(FakePG(), autocommit=True)
    with pytest.raises(ValueError, match="transactional isolation"):
        await signal_in_transaction(transaction, "agent", "a")
    assert transaction.calls == []
    transaction.active = False
    with pytest.raises(ValueError, match="active business transaction"):
        await signal_in_transaction(transaction, "agent", "a")
    transaction = Transaction(FakePG())
    async def fail(*args):
        raise RuntimeError("synthetic SQL failure")
    transaction.execute = fail
    with pytest.raises(RuntimeError, match="SQL failure"):
        await signal_in_transaction(transaction, "agent", "a")
    assert transaction.active  # No hidden commit or rollback.


@pytest.mark.asyncio
async def test_sqlite_real_session_no_notify_no_pg_connection_periodic_only(tmp_path):
    calls = []
    async def forbidden_connect():
        raise AssertionError("SQLite must not connect to PG")
    async def reconcile():
        calls.append(1)
    item = PgWakeup("sqlite+aiosqlite:///:memory:", reconcile_interval=.01, connect_factory=forbidden_connect)
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    engine = create_async_engine("sqlite+aiosqlite:///" + str(tmp_path / "sqlite-wakeup.db"))
    try:
        async with async_sessionmaker(engine)() as db:
            async with db.begin():
                assert await signal_in_transaction(db, "room", "synthetic-room") is False
    finally:
        await engine.dispose()
    try:
        await item.start(noop, reconcile)
        await eventually(lambda: len(calls) >= 3)
        assert not item.listening and len(item._tasks) == 1
    finally:
        await item.stop()


@pytest.mark.asyncio
async def test_default_connector_uses_private_asyncpg_and_preserves_tls_options(monkeypatch):
    observed = []
    connection = FakeConnection()
    async def connect(**kwargs):
        observed.append(kwargs)
        return connection
    monkeypatch.setattr("app.chat.pg_wakeup.asyncpg.connect", connect)
    item = PgWakeup("postgresql+asyncpg://synthetic:synthetic@unused:5433/synthetic_test?ssl=require&prepared_statement_cache_size=0")
    try:
        await item.start(noop, noop)
        await eventually(lambda: item.listening)
        assert len(observed) == 1
        assert observed[0]["ssl"] == "require" and observed[0]["port"] == 5433
        assert observed[0]["user"] == "synthetic" and observed[0]["timeout"] == 5
        assert "prepared_statement_cache_size" not in observed[0]
    finally:
        await item.stop()


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["connect", "listen"])
async def test_connect_and_listen_timeouts_retry_without_leaking_connections(phase):
    pg = FakePG()
    item = worker(pg)
    cancellations = []
    async def connect():
        if not cancellations and phase == "connect":
            try:
                await asyncio.Future()
            finally:
                cancellations.append(1)
        connection = await pg.connect()
        if not cancellations and phase == "listen":
            async def blocked(*args):
                try:
                    await asyncio.Future()
                finally:
                    cancellations.append(1)
            connection.add_listener = blocked
        return connection
    item._connect_factory = connect
    try:
        await item.start(noop, noop)
        await eventually(lambda: item.listening)
        assert cancellations == [1]
        if phase == "listen":
            assert pg.connections[0].closed and pg.connections[0].close_calls == 1
            assert len(pg.connections) == 2
    finally:
        await item.stop()
    assert all(connection.closed for connection in pg.connections)


@pytest.mark.asyncio
async def test_continuous_notifications_do_not_starve_periodic_reconcile_or_overlap_callbacks():
    pg = FakePG()
    item = worker(pg)
    active = 0
    reconciliations = []
    hints = []
    async def receive(hint):
        nonlocal active
        active += 1
        assert active == 1
        try:
            hints.append(hint)
            await asyncio.sleep(.003)
        finally:
            active -= 1
    async def reconcile():
        nonlocal active
        active += 1
        assert active == 1
        try:
            reconciliations.append(asyncio.get_running_loop().time())
            await asyncio.sleep(.002)
        finally:
            active -= 1
    try:
        await item.start(receive, reconcile)
        await eventually(lambda: item.listening)
        for index in range(150):
            pg.notify(payload(f"agent-{index}"))
        await eventually(lambda: len(hints) >= 25 and len(reconciliations) >= 5)
        assert item._queue.qsize() > 0  # Full scans ran before hints drained.
    finally:
        await item.stop()
    assert active == 0 and item._queue._unfinished_tasks == 0


@pytest.mark.parametrize("options", [dict(reconcile_interval=0), dict(connect_timeout=float("inf")),
                                    dict(callback_timeout=float("nan")), dict(retry_min=2, retry_max=1),
                                    dict(queue_size=0), dict(queue_size=4097)])
def test_invalid_lifecycle_bounds_rejected(options):
    with pytest.raises(ValueError):
        PgWakeup("sqlite+aiosqlite:///:memory:", **options)


@pytest.mark.asyncio
async def test_listener_rejects_preexisting_transaction_and_closes_before_retry():
    pg = FakePG()
    item = worker(pg)
    async def connect():
        connection = await pg.connect()
        connection.transaction_active = len(pg.connections) == 1
        return connection
    item._connect_factory = connect
    try:
        await item.start(noop, noop)
        await eventually(lambda: item.listening)
        assert len(pg.connections) == 2
        assert pg.connections[0].closed and pg.connections[0].statements == []
    finally:
        await item.stop()
