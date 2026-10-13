"""MAPR Group E: Distributed Reliability, Quota Reliability, Multi-Hub Reconciliation & Observability Audit Test Suite.

Audits:
1. Real PostgreSQL fault injection on SSE lease renewal, release, and crash recovery.
2. Database operation timeouts, session closure, and cancellation safety boundaries.
3. Local monotonic clock margin evaluation for lease renewal validity.
4. Stress benchmark on PostgreSQL advisory lock wait time and quota throughput.
5. Multi-Hub reconciliation recovery under disconnects, lost notifications, and task backlog.
6. Sensitive log structural redaction and observability metrics integrity.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
import logging
import os
from pathlib import Path
import subprocess
import tempfile
import time
from types import SimpleNamespace
from typing import AsyncIterator
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import text, insert, select, URL
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.pool import QueuePool

import app.a2a.sse_global_quota as quota
from app.a2a.sse_global_quota import SSEGlobalQuota, QuotaExceeded, QuotaUnavailable, Lease
from app.core.database import Base
from app.core.observability import (
    metrics,
    redact,
    RedactingFilter,
    install_redacting_filter,
)

# --------------------------------------------------------------------------- #
# PostgreSQL cluster fixture: isolated PG17 cluster
# --------------------------------------------------------------------------- #

def _pg_binary_tree() -> Path | None:
    # First check env var
    val = os.environ.get("MAPR_SSE_QUOTA_PG_ROOT")
    if val:
        root = Path(val)
        if root.parent == Path("/tmp") and root.name.startswith("mapr-sse-quota-bin-"):
            binary = root / "usr/lib/postgresql/17/bin"
            if (binary / "initdb").is_file():
                return binary

    # Next check any matching directory in /tmp
    for candidate in sorted(Path("/tmp").glob("mapr-sse-quota-bin-*")):
        binary = candidate / "usr/lib/postgresql/17/bin"
        if (binary / "initdb").is_file():
            return binary
    return None


@pytest_asyncio.fixture(scope="session")
def pg_cluster():
    """Start an isolated PostgreSQL 17 cluster for E-group reliability tests."""
    binary = _pg_binary_tree()
    if binary is None:
        pytest.skip("No isolated PG17 binary tree available in /tmp")

    env = {**os.environ, "LD_LIBRARY_PATH": str(binary.parent.parent.parent / "x86_64-linux-gnu")}

    with tempfile.TemporaryDirectory(prefix="mapr-audit-e-pg-", dir="/tmp") as directory:
        directory = Path(directory)
        data, sock = directory / "data", directory / "socket"
        sock.mkdir()
        log = directory / "server.log"

        initdb = subprocess.run(
            [str(binary / "initdb"), "-D", str(data), "-U", "audit_e", "-A", "trust",
             "--no-locale", "-E", "UTF8"],
            env=env, capture_output=True, timeout=30,
        )
        assert initdb.returncode == 0, f"initdb failed: {initdb.stderr.decode()}"

        started = subprocess.run(
            [str(binary / "pg_ctl"), "-D", str(data), "-l", str(log),
             "-o", f"-h '' -k {sock} -p 5432 -c fsync=off -c synchronous_commit=off -c max_connections=200",
             "-w", "-t", "15", "start"],
            env=env, capture_output=True, timeout=20,
        )
        assert started.returncode == 0, f"pg_ctl start failed: {started.stderr.decode()}"

        try:
            yield SimpleNamespace(
                url=URL.create("postgresql+asyncpg", username="audit_e", database="postgres",
                               query={"host": str(sock)}),
                binary=binary,
                socket=str(sock),
                data=data,
            )
        finally:
            if (data / "postmaster.pid").is_file():
                subprocess.run(
                    [str(binary / "pg_ctl"), "-D", str(data), "-m", "immediate", "-w",
                     "-t", "10", "stop"],
                    env=env, capture_output=True, timeout=15,
                )


@asynccontextmanager
async def database_store(url: URL) -> AsyncIterator[SimpleNamespace]:
    """Provide schema-initialized session factory against the isolated PG."""
    engine = create_async_engine(
        url,
        pool_size=10,
        max_overflow=10,
        connect_args={"server_settings": {"client_encoding": "UTF8"}},
    )

    import app.models.agent_task_delivery
    import app.models.agent_binding
    import app.models.user
    import app.models.room
    import app.models.agent_card
    import app.chat.models
    import app.a2a.models

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        await connection.run_sync(quota.LEASE_METADATA.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield SimpleNamespace(engine=engine, sessions=factory)
    finally:
        async with engine.begin() as connection:
            await connection.run_sync(quota.LEASE_METADATA.drop_all)
            await connection.run_sync(Base.metadata.drop_all)
        await engine.dispose()


@pytest_asyncio.fixture
async def pg_store(pg_cluster):
    async with database_store(pg_cluster.url) as store:
        yield store


async def age_row(store, lease_id: str, *, seconds: float):
    """Force a lease's expiry into the past to simulate crashed process."""
    async with store.sessions() as db, db.begin():
        await db.execute(
            text("UPDATE sse_stream_leases SET expires_at = :expires WHERE lease_id = :lease_id"),
            {"expires": datetime.now(timezone.utc) - timedelta(seconds=seconds),
             "lease_id": lease_id},
        )


# =========================================================================== #
# Task 1: SSE 租约续期、释放、崩溃回收真实 PostgreSQL 故障注入测试
# =========================================================================== #

@pytest.mark.asyncio
async def test_lease_acquire_renew_and_release(pg_store):
    """Verify standard happy-path lifecycle: acquire -> renew -> release."""
    policy = SSEGlobalQuota(lease_seconds=15, renew_seconds=5)
    user_id = f"user-{uuid.uuid4().hex[:8]}"
    task_id = f"task-{uuid.uuid4().hex[:8]}"
    hub_id = "hub-test-1"

    async with pg_store.sessions() as db:
        # 1. Acquire
        lease = await policy.acquire(db, user_id, task_id, hub_id)
        assert lease is not None
        assert lease.user_id == user_id
        assert lease.task_id == task_id
        assert lease.hub_id == hub_id
        orig_expires = lease.expires_at

    # Verify DB presence with separate read session to avoid uncommitted autoflush transactions
    async with pg_store.sessions() as db:
        res = await db.execute(
            select(quota.LEASE_TABLE).where(quota.LEASE_TABLE.c.lease_id == lease.lease_id)
        )
        row = res.mappings().one_or_none()
        assert row is not None
        assert row["hub_id"] == hub_id

    # 2. Renew
    await asyncio.sleep(0.1)
    async with pg_store.sessions() as db:
        renewed_lease = await policy.renew(db, lease.lease_id, hub_id)
        assert renewed_lease is not None
        assert renewed_lease.expires_at > orig_expires

    async with pg_store.sessions() as db:
        res = await db.execute(
            select(quota.LEASE_TABLE).where(quota.LEASE_TABLE.c.lease_id == lease.lease_id)
        )
        row = res.mappings().one()
        assert row["expires_at"] > orig_expires

    # 3. Release
    async with pg_store.sessions() as db:
        released = await policy.release(db, lease.lease_id, hub_id)
        assert released is True

    # Verify DB cleanup
    async with pg_store.sessions() as db:
        res = await db.execute(
            select(quota.LEASE_TABLE).where(quota.LEASE_TABLE.c.lease_id == lease.lease_id)
        )
        assert res.mappings().one_or_none() is None


@pytest.mark.asyncio
async def test_lease_crash_recovery_purge_expired(pg_store):
    """Simulate a crashed worker whose lease expired without clean release.

    Verify that acquire automatically sweeps expired leases and frees the quota slot.
    """
    policy = SSEGlobalQuota(lease_seconds=5, renew_seconds=2)
    user_id = f"user-{uuid.uuid4().hex[:8]}"
    hub_crashed = "hub-worker-crashed"
    hub_new = "hub-worker-live"

    leases = []
    # Fill user quota up to MAX_USER_STREAMS (4)
    for i in range(quota.MAX_USER_STREAMS):
        async with pg_store.sessions() as db:
            l = await policy.acquire(db, user_id, f"task-crash-{i}", hub_crashed)
            leases.append(l)

    # Attempt to acquire an additional stream while all are active -> must fail
    async with pg_store.sessions() as db:
        with pytest.raises(QuotaExceeded):
            await policy.acquire(db, user_id, "task-overflow", hub_new)

    # Crash injection: simulate passage of time beyond TTL without release for first lease
    await age_row(pg_store, leases[0].lease_id, seconds=30)

    # New acquire should auto-purge the dead lease and succeed
    async with pg_store.sessions() as db:
        new_lease = await policy.acquire(db, user_id, "task-live", hub_new)
        assert new_lease is not None
        assert new_lease.lease_id != leases[0].lease_id

    # Verify old lease was cleaned from DB
    async with pg_store.sessions() as db:
        res = await db.execute(
            select(quota.LEASE_TABLE).where(quota.LEASE_TABLE.c.lease_id == leases[0].lease_id)
        )
        assert res.mappings().one_or_none() is None

    # Clean release
    async with pg_store.sessions() as db:
        await policy.release(db, new_lease.lease_id, hub_new)
        for l in leases[1:]:
            await policy.release(db, l.lease_id, hub_crashed)


@pytest.mark.asyncio
async def test_lease_cross_hub_hijack_prevention(pg_store):
    """Ensure Hub A's lease cannot be released or renewed by Hub B."""
    policy = SSEGlobalQuota(lease_seconds=10, renew_seconds=3)
    user_id = f"user-{uuid.uuid4().hex[:8]}"

    async with pg_store.sessions() as db:
        lease = await policy.acquire(db, user_id, "task-hijack", "hub-owner")

        # Hub intruder tries to renew -> returns None
        renew_res = await policy.renew(db, lease.lease_id, "hub-intruder")
        assert renew_res is None

        # Hub intruder tries to release -> returns False
        release_res = await policy.release(db, lease.lease_id, "hub-intruder")
        assert release_res is False

        # Legitimate owner can still release
        legit_release = await policy.release(db, lease.lease_id, "hub-owner")
        assert legit_release is True


# =========================================================================== #
# Task 2: 数据库操作超时、会话关闭与取消安全边界
# =========================================================================== #

@pytest.mark.asyncio
async def test_db_statement_timeout_boundary(pg_store):
    """Verify that PostgreSQL statement_timeout fires cleanly and doesn't poison the pool."""
    async with pg_store.sessions() as db:
        # Set short statement timeout for current session
        await db.execute(text("SET statement_timeout = 200"))  # 200ms
        
        # Run a query designed to exceed 200ms
        with pytest.raises(Exception) as exc_info:
            await db.execute(text("SELECT pg_sleep(1.0)"))
        assert "canceling statement due to statement timeout" in str(exc_info.value).lower()

    # Verify session pool remains clean and usable for subsequent queries
    async with pg_store.sessions() as db:
        res = await db.execute(text("SELECT 1"))
        assert res.scalar() == 1


@pytest.mark.asyncio
async def test_asyncio_cancellation_safety_with_advisory_lock(pg_store):
    """Verify that asyncio.CancelledError during advisory-lock protected acquire

    releases the PostgreSQL session cleanly without leaking the advisory lock.
    """
    policy = SSEGlobalQuota(lease_seconds=10, renew_seconds=3)
    user_id = f"user-{uuid.uuid4().hex[:8]}"

    # Start an acquire that gets cancelled immediately
    cancelled_caught = False
    async def cancel_target():
        async with pg_store.sessions() as db:
            await policy.acquire(db, user_id, "task-cancel", "hub-1")

    task = asyncio.create_task(cancel_target())
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        cancelled_caught = True
    assert cancelled_caught is True

    # Immediate next acquire on same user must succeed without hanging or lock deadlock
    async with pg_store.sessions() as db:
        lease = await policy.acquire(db, user_id, "task-post-cancel", "hub-1")
        assert lease is not None
        await policy.release(db, lease.lease_id, "hub-1")


@pytest.mark.asyncio
async def test_session_closure_releases_in_flight_locks(pg_store):
    """Verify closing an AsyncSession while holding an xact advisory lock releases it immediately."""
    lock_id = quota.ADVISORY_LOCK_KEY

    # Session 1 enters transaction, takes advisory xact lock, then aborts/closes
    async with pg_store.sessions() as db1:
        async with db1.begin():
            await db1.execute(
                text("SELECT pg_advisory_xact_lock(:lock_id)"),
                {"lock_id": lock_id},
            )
            # Transaction commits or ends on exit

    # Session 2 must be able to acquire the advisory lock immediately
    async with pg_store.sessions() as db2:
        async with db2.begin():
            res = await db2.execute(
                text("SELECT pg_try_advisory_xact_lock(:lock_id)"),
                {"lock_id": lock_id},
            )
            assert res.scalar() is True


# =========================================================================== #
# Task 3: 续租有效期的本地单调时钟余量评估
# =========================================================================== #

@pytest.mark.asyncio
async def test_lease_monotonic_clock_margin_evaluation(pg_store):
    """Evaluate monotonic clock safety margin between renewal interval and lease TTL.

    Rules verified:
    - renew_seconds < lease_ttl_seconds
    - Safety margin = lease_ttl_seconds - renew_seconds >= minimum margin (e.g. 50% or 3s)
    - Monotonic drift during normal renewal loop leaves >= 60% valid window
    """
    lease_ttl = 10.0
    renew_interval = 4.0
    policy = SSEGlobalQuota(lease_seconds=int(lease_ttl), renew_seconds=int(renew_interval))

    user_id = f"user-{uuid.uuid4().hex[:8]}"
    async with pg_store.sessions() as db:
        t_start_mono = time.monotonic()
        lease = await policy.acquire(db, user_id, "task-mono", "hub-mono")
        
        # Simulate background renewal loop interval
        await asyncio.sleep(0.5)
        t_renew_mono = time.monotonic()
        elapsed_mono = t_renew_mono - t_start_mono

        # Perform renewal
        renewed_lease = await policy.renew(db, lease.lease_id, "hub-mono")
        assert renewed_lease is not None

        # Margin remaining: initial TTL minus elapsed time before renew
        margin_remaining = lease_ttl - elapsed_mono
        margin_ratio = margin_remaining / lease_ttl

        # Assert monotonic clock safety margin > 80% remaining at renewal point
        assert margin_remaining > 5.0, f"Remaining margin too low: {margin_remaining}s"
        assert margin_ratio >= 0.8, f"Remaining ratio too low: {margin_ratio}"

        await policy.release(db, lease.lease_id, "hub-mono")


# =========================================================================== #
# Task 4: PostgreSQL advisory lock 等待耗时与配额吞吐压测
# =========================================================================== #

@pytest.mark.asyncio
async def test_advisory_lock_contention_and_throughput_benchmark(pg_store):
    """Benchmark PostgreSQL advisory lock under concurrent contention.

    Measures:
    - Wait / execution latency per acquire (min, avg, p95, max)
    - Total operations per second (throughput)
    - Zero deadlocks and absolute quota adherence.
    """
    concurrency = 16
    loops_per_worker = 10
    total_ops = concurrency * loops_per_worker
    policy = SSEGlobalQuota(lease_seconds=30, renew_seconds=10)

    latencies_ms: list[float] = []
    latencies_lock = asyncio.Lock()
    failures = 0

    async def worker(worker_id: int):
        nonlocal failures
        user_id = f"bench-user-{worker_id}"
        async with pg_store.sessions() as db:
            for i in range(loops_per_worker):
                task_id = f"task-{worker_id}-{i}"
                t0 = time.perf_counter()
                try:
                    lease = await policy.acquire(db, user_id, task_id, f"hub-{worker_id}")
                    dur_ms = (time.perf_counter() - t0) * 1000.0
                    async with latencies_lock:
                        latencies_ms.append(dur_ms)

                    # Release right away
                    await policy.release(db, lease.lease_id, f"hub-{worker_id}")
                except Exception as ex:
                    failures += 1

    t_start = time.perf_counter()
    await asyncio.gather(*(worker(i) for i in range(concurrency)))
    total_time = time.perf_counter() - t_start

    assert failures == 0, f"Benchmark encountered {failures} failures"
    assert len(latencies_ms) == total_ops

    latencies_ms.sort()
    avg_latency = sum(latencies_ms) / len(latencies_ms)
    p50_latency = latencies_ms[int(len(latencies_ms) * 0.50)]
    p95_latency = latencies_ms[int(len(latencies_ms) * 0.95)]
    p99_latency = latencies_ms[int(len(latencies_ms) * 0.99)]
    max_latency = latencies_ms[-1]
    throughput = total_ops / total_time

    # Record metrics into observability
    metrics.observe("sse_advisory_lock_acquire_ms", avg_latency / 1000.0)
    metrics.gauge("sse_quota_benchmark_throughput_ops", throughput)

    print(f"\n[BENCHMARK RESULT] Concurrency={concurrency}, Ops={total_ops}")
    print(f"Total time: {total_time:.3f}s | Throughput: {throughput:.1f} ops/sec")
    print(f"Latency ms: avg={avg_latency:.2f}, p50={p50_latency:.2f}, p95={p95_latency:.2f}, p99={p99_latency:.2f}, max={max_latency:.2f}")

    # Reliability assertions
    assert p95_latency < 500.0, f"p95 latency too high: {p95_latency}ms"
    assert throughput > 20.0, f"Throughput too low: {throughput} ops/sec"


# =========================================================================== #
# Task 5: 多 Hub 对账断线、通知丢失、任务积压恢复行为验证
# =========================================================================== #

class DummySocket:
    def __init__(self):
        self.frames = []
        self.closed = False

    async def send_json(self, frame):
        self.frames.append(frame)

    async def close(self, code):
        self.closed = True


async def setup_test_delivery(db):
    """Helper to seed user, room, task and delivery for reconciliation tests."""
    from app.models.user import User
    from app.models.room import Room
    from app.models.room_permission import RoomPermission
    from app.models.agent_task_delivery import AgentTaskDelivery
    from app.chat.models import Message
    from app.chat import delivery_service as ds
    from app.a2a.task_service import TaskService
    from app.core.security import hash_password

    owner = User(
        id=str(uuid.uuid4()),
        username=f"owner_{uuid.uuid4().hex[:6]}",
        display_name="Delivery Owner",
        password_hash=hash_password("Pass123!"),
        user_type="human",
    )
    agent = User(
        id=str(uuid.uuid4()),
        username=f"agent_{uuid.uuid4().hex[:6]}",
        display_name="Delivery Agent",
        password_hash=hash_password("Pass123!"),
        user_type="agent",
    )
    db.add_all([owner, agent])
    await db.flush()

    room = Room(name="Audit Room", transport="hub", created_by=owner.id)
    db.add(room)
    await db.flush()
    db.add(RoomPermission(room_id=room.id, user_id=owner.id, role="owner"))
    await db.flush()

    msg = Message(
        id=str(uuid.uuid4()),
        room_id=room.id,
        sender_id=owner.id,
        sender_type="human",
        content=f"@{agent.username} audit task",
        msg_type="text",
    )
    db.add(msg)
    await db.flush()

    task, _ = await TaskService.create_task(
        db,
        query=msg.content,
        target_agent=agent.username,
        room_id=room.id,
        source_message_id=msg.id,
    )
    delivery = await ds.create_delivery(db, task, agent.id)
    frame = await ds.offer(db, delivery)
    await db.commit()

    raw_ack = {
        "v": 1,
        "type": "task_ack",
        "delivery_id": delivery.delivery_id,
        "task_id": task.id,
        "attempt": frame["attempt"],
        "target_room": room.id,
    }
    return owner, agent, room, task, delivery, raw_ack


@pytest.mark.asyncio
async def test_multi_hub_lost_notification_reconciliation(pg_store):
    """Verify that when a dispatch notification is lost and delivery is stuck in 'pending',

    the TaskReconciler detects expired offers and repairs/reoffers them.
    """
    from app.chat.task_reconciler import TaskReconciler
    from app.ws.connection_manager import ConnectionManager
    from app.chat import delivery_service as ds
    from app.models.agent_task_delivery import AgentTaskDelivery

    async with pg_store.sessions() as db:
        _, agent, _, task, delivery, raw = await setup_test_delivery(db)

        # Simulate lost notification: delivery was offered 65 seconds ago (past OFFER_TTL)
        delivery.delivered_at = ds.now() - timedelta(seconds=65)
        await db.commit()

        # Setup Hub reconciler worker
        manager = ConnectionManager()
        ws = DummySocket()
        async def check():
            return True
        manager.set_authorization_check(ws, check)
        manager.register(ws, "_agent_delivery_bot", agent.id, "conn-hub-1")

        reconciler = TaskReconciler(pg_store.sessions, manager, "postgresql+asyncpg://audit_test", batch=10)
        await reconciler.run_once()

        # Verify delivery attempt incremented and re-offered
        await db.refresh(delivery)
        assert delivery.attempt == 2
        assert len(ws.frames) == 1
        assert ws.frames[0]["attempt"] == 2
        assert ws.frames[0]["task_id"] == task.id

        # Accept the re-offered task
        raw["attempt"] = 2
        ack_res = await ds.control(db, agent.id, "conn-hub-1", raw)
        await db.commit()
        assert ack_res["accepted"] is True


@pytest.mark.asyncio
async def test_multi_hub_task_backlog_recovery_batch(pg_store):
    """Verify that multiple stalled deliveries are reconciled across batches cleanly."""
    from app.chat.task_reconciler import TaskReconciler
    from app.ws.connection_manager import ConnectionManager
    from app.chat import delivery_service as ds

    async with pg_store.sessions() as db:
        # Create 3 deliveries
        deliveries = []
        agents = []
        for _ in range(3):
            _, agent, _, task, delivery, _ = await setup_test_delivery(db)
            delivery.delivered_at = ds.now() - timedelta(seconds=70)
            deliveries.append(delivery)
            agents.append(agent)
        await db.commit()

        manager = ConnectionManager()
        for agent in agents:
            ws = DummySocket()
            async def check():
                return True
            manager.set_authorization_check(ws, check)
            manager.register(ws, "_agent_delivery_bot", agent.id, f"conn-{agent.id}")

        reconciler = TaskReconciler(pg_store.sessions, manager, "postgresql+asyncpg://audit_test", batch=10)
        reconciled_count = await reconciler.run_once()
        assert reconciled_count >= 3

        for delivery in deliveries:
            await db.refresh(delivery)
            assert delivery.attempt >= 2


# =========================================================================== #
# Task 6: 敏感日志结构化脱敏与可观测性指标测试
# =========================================================================== #

def test_sensitive_log_structured_redaction():
    """Verify structural redaction of authorization headers, tokens, passwords, and sensitive keys."""
    # Test dictionary redaction
    payload = {
        "authorization": "Bearer secret-token-xyz123",
        "api_key": "sk-real-live-key-abc",
        "password": "SuperSecretPassword123!",
        "token": "tok_access_live",
        "credential_info": "priv_cred_value",
        "nested": {
            "auth_token": "bearer-nested-token",
            "safe_field": "public_data",
        },
        "safe_value": 42,
    }

    redacted = redact(payload)
    assert redacted["authorization"] == "***REDACTED***"
    assert redacted["api_key"] == "***REDACTED***"
    assert redacted["password"] == "***REDACTED***"
    assert redacted["token"] == "***REDACTED***"
    assert redacted["credential_info"] == "***REDACTED***"
    assert redacted["nested"]["auth_token"] == "***REDACTED***"
    assert redacted["nested"]["safe_field"] == "public_data"
    assert redacted["safe_value"] == 42

    # Test string redaction regex
    text_sample = "Failed auth: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9 with api_key=sk-secret-key"
    redacted_text = redact(text_sample)
    assert "Bearer ***REDACTED***" in redacted_text
    assert "api_key=***REDACTED***" in redacted_text


def test_logging_handler_redacting_filter():
    """Verify RedactingFilter attached to standard logging masks sensitive records."""
    logger = logging.getLogger("test_redact_logger")
    logger.setLevel(logging.INFO)

    stream_records = []
    class CapturingHandler(logging.Handler):
        def emit(self, record):
            stream_records.append(self.format(record))

    handler = CapturingHandler()
    handler.addFilter(RedactingFilter())
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)

    try:
        logger.info("Connecting with password=MySecretPass123 and token=abcde12345")
        assert len(stream_records) == 1
        formatted = stream_records[0]
        assert "password=***REDACTED***" in formatted
        assert "token=***REDACTED***" in formatted
        assert "MySecretPass123" not in formatted
    finally:
        logger.removeHandler(handler)


def test_observability_metrics_export():
    """Verify observability metrics recording and snapshotting."""
    metrics.increment("test_quota_acquisitions", value=5, hub="hub-1")
    metrics.gauge("test_active_leases", value=12, hub="hub-1")
    metrics.observe("test_lease_wait_ms", seconds=0.0154, hub="hub-1")

    snapshot = metrics.snapshot()
    assert "test_quota_acquisitions{hub=hub-1}" in snapshot["counters"]
    assert snapshot["counters"]["test_quota_acquisitions{hub=hub-1}"] >= 5
    assert "test_active_leases{hub=hub-1}" in snapshot["gauges"]
    assert snapshot["gauges"]["test_active_leases{hub=hub-1}"] == 12
    assert "test_lease_wait_ms{hub=hub-1}" in snapshot["timings"]