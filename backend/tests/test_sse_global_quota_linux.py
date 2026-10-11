"""SQLite + optional REAL, separately initialized Unix-socket PG17 cluster.

Never consume an external DSN or the coordinator's PG cluster. PG binary root
must be an explicitly copied /tmp/mapr-sse-quota-bin-* package tree. This file
creates/stops only its own /tmp/mapr-sse-quota-pg-* data directory and socket.
"""
import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import subprocess
import tempfile
import sys
from types import SimpleNamespace
import uuid

import pytest
import pytest_asyncio
from sqlalchemy import insert, select, text
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from app.a2a import sse_global_quota as quota


@pytest.fixture(scope="session")
def isolated_pg():
    root = Path(os.environ.get("MAPR_SSE_QUOTA_PG_ROOT", "/nonexistent"))
    if root.parent != Path("/tmp") or not root.name.startswith("mapr-sse-quota-bin-"):
        pytest.skip("Requires copied, independently owned /tmp PG17 binaries")
    binary = root / "usr/lib/postgresql/17/bin"
    if not (binary / "initdb").is_file():
        pytest.skip("No isolated PG17 initdb")
    env = {**os.environ, "LD_LIBRARY_PATH": str(root / "usr/lib/x86_64-linux-gnu")}
    with tempfile.TemporaryDirectory(prefix="mapr-sse-quota-pg-", dir="/tmp") as directory:
        directory = Path(directory)
        data, sock = directory / "data", directory / "socket"
        sock.mkdir()
        log = directory / "server.log"
        result = subprocess.run([str(binary / "initdb"), "-D", str(data), "-U", "quota_test",
                                 "-A", "trust", "--no-locale", "-E", "UTF8"],
                                env=env, capture_output=True, timeout=30)
        assert result.returncode == 0, result.stderr.decode()
        try:
            result = subprocess.run([str(binary / "pg_ctl"), "-D", str(data), "-l", str(log),
                                     "-o", f"-h '' -k {sock} -p 5432 -c fsync=off -c synchronous_commit=off -c max_connections=30",
                                     "-w", "-t", "15", "start"], env=env, capture_output=True, timeout=20)
            assert result.returncode == 0, result.stderr.decode()
            yield URL.create("postgresql+asyncpg", username="quota_test", database="postgres",
                             query={"host": str(sock)})
        finally:
            if (data / "postmaster.pid").is_file():
                result = subprocess.run([str(binary / "pg_ctl"), "-D", str(data), "-m", "immediate",
                                         "-w", "-t", "10", "stop"], env=env, capture_output=True, timeout=15)
                assert result.returncode == 0, result.stderr.decode()


@pytest_asyncio.fixture(params=["sqlite", "postgresql"])
async def store(request, tmp_path):
    url = (URL.create("sqlite+aiosqlite", database=str(tmp_path / "quota.sqlite"))
           if request.param == "sqlite" else request.getfixturevalue("isolated_pg"))
    async with database_store(url, request.param) as store:
        yield store


@pytest_asyncio.fixture
async def pg_store(isolated_pg):
    async with database_store(isolated_pg, "postgresql") as store:
        yield store


@asynccontextmanager
async def database_store(url, dialect):
    engine = create_async_engine(url)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.run_sync(quota.LEASE_METADATA.create_all)
    try:
        yield SimpleNamespace(engine=engine, sessions=factory, dialect=dialect, url=url)
    finally:
        async with engine.begin() as connection:
            await connection.run_sync(quota.LEASE_METADATA.drop_all)
        await engine.dispose()


async def take(store, policy, user="user-1", hub="hub-1", task="task-1"):
    async with store.sessions() as db:
        result = await policy.acquire(db, user, task, hub)
        assert not db.in_transaction()
        return result


async def rows(store):
    async with store.sessions() as db:
        return (await db.execute(select(quota.LEASE_TABLE))).mappings().all()


async def seed(store, count, *, same_user=False, expiry=None):
    expiry = expiry or datetime.now(timezone.utc) + timedelta(minutes=5)
    async with store.sessions() as db, db.begin():
        await db.execute(insert(quota.LEASE_TABLE), [
            {"lease_id": str(uuid.uuid4()), "user_id": "user-1" if same_user else f"user-{index}",
             "task_id": "task-1", "hub_id": "seed-hub", "expires_at": expiry}
            for index in range(count)])


@pytest.mark.asyncio
async def test_two_independent_hubs_race_for_user_fifth_slot_exactly_one_wins(store):
    await seed(store, 3, same_user=True)
    policy = quota.SSEGlobalQuota()
    # Independent engine/pool models another Hub, not one shared session/lock.
    second_engine = create_async_engine(store.url)
    second_sessions = async_sessionmaker(second_engine, expire_on_commit=False)
    second = SimpleNamespace(sessions=second_sessions)
    try:
        results = await asyncio.wait_for(asyncio.gather(
            take(store, policy, hub="hub-a"), take(second, policy, hub="hub-b"),
            return_exceptions=True), 5)
        assert sum(isinstance(item, quota.Lease) for item in results) == 1
        assert sum(isinstance(item, quota.QuotaExceeded) for item in results) == 1
        assert len(await rows(store)) == 4
    finally:
        await second_engine.dispose()


@pytest.mark.asyncio
async def test_two_transactions_race_for_global_65th_across_distinct_users(store):
    await seed(store, 63)
    policy = quota.SSEGlobalQuota()
    results = await asyncio.wait_for(asyncio.gather(
        take(store, policy, user="new-a", hub="hub-a"),
        take(store, policy, user="new-b", hub="hub-b"), return_exceptions=True), 5)
    assert sum(isinstance(item, quota.Lease) for item in results) == 1
    assert sum(isinstance(item, quota.QuotaExceeded) for item in results) == 1
    assert len(await rows(store)) == 64


@pytest.mark.asyncio
async def test_expired_crashed_hub_slots_recover_and_delayed_release_cannot_delete_replacement(store):
    await seed(store, 4, same_user=True, expiry=datetime.now(timezone.utc)-timedelta(seconds=1))
    old = (await rows(store))[0]["lease_id"]
    policy = quota.SSEGlobalQuota()
    fresh = await take(store, policy, hub="new-boot")
    assert len(await rows(store)) == 1
    async with store.sessions() as db:
        assert not await policy.release(db, old, "seed-hub")
        assert await policy.renew(db, old, "seed-hub") is None
        assert not await policy.release(db, fresh.lease_id, "seed-hub")
        assert await policy.renew(db, fresh.lease_id, "seed-hub") is None
    assert (await rows(store))[0]["lease_id"] == fresh.lease_id


@pytest.mark.asyncio
async def test_renew_release_idempotence_owner_fencing_and_no_lease_resurrection(store):
    policy = quota.SSEGlobalQuota(lease_seconds=.25, renew_seconds=.05)
    lease = await take(store, policy)
    async with store.sessions() as db:
        assert await policy.renew(db, lease.lease_id, "wrong-hub") is None
        assert not await policy.release(db, lease.lease_id, "wrong-hub")
        first = await policy.renew(db, lease.lease_id, lease.hub_id)
        second = await policy.renew(db, lease.lease_id, lease.hub_id)
        assert second.expires_at >= first.expires_at >= lease.expires_at
        assert await policy.release(db, lease.lease_id, lease.hub_id)
        assert not await policy.release(db, lease.lease_id, lease.hub_id)
        assert await policy.renew(db, lease.lease_id, lease.hub_id) is None
        assert not db.in_transaction()
    assert await rows(store) == []


@pytest.mark.asyncio
async def test_hub_crash_no_release_then_real_time_expiry_sweep_and_reacquire(store):
    policy = quota.SSEGlobalQuota(lease_seconds=.08, renew_seconds=.02)
    lease = await take(store, policy, hub="killed-boot")
    # Abrupt Hub loss: session/connection gone, no release or renew.
    await asyncio.sleep(.12)
    async with store.sessions() as db:
        assert await policy.renew(db, lease.lease_id, lease.hub_id) is None
        assert await policy.sweep(db) == 1
        assert await policy.sweep(db) == 0
    fresh = await take(store, policy, hub="replacement-boot")
    assert fresh.lease_id != lease.lease_id


@pytest.mark.asyncio
async def test_sweep_bounded_and_only_deletes_expired_leases(store):
    await seed(store, 5, expiry=datetime.now(timezone.utc)-timedelta(seconds=1))
    policy = quota.SSEGlobalQuota()
    async with store.sessions() as db:
        assert await policy.sweep(db, limit=2) == 2
        assert await policy.sweep(db, limit=2) == 2
        assert await policy.sweep(db, limit=2) == 1
    await take(store, policy)
    async with store.sessions() as db:
        assert await policy.sweep(db) == 0
    assert len(await rows(store)) == 1


@pytest.mark.asyncio
async def test_insert_failure_rolls_back_cleanup_and_leaks_no_sql_identifiers(store, monkeypatch):
    from sqlalchemy.exc import OperationalError
    await seed(store, 1, expiry=datetime.now(timezone.utc)-timedelta(seconds=1))
    async with store.sessions() as db:
        original = db.execute
        async def execute(statement, *args, **kwargs):
            if getattr(statement, "is_insert", False):
                raise OperationalError("secret-dsn private-body", {}, RuntimeError("synthetic-token"))
            return await original(statement, *args, **kwargs)
        monkeypatch.setattr(db, "execute", execute)
        with pytest.raises(quota.QuotaUnavailable) as failure:
            await quota.acquire(db, "sensitive-user-id", "task", "hub")
        assert str(failure.value) == "SSE quota unavailable" and failure.value.__suppress_context__
        assert not db.in_transaction()
    assert len(await rows(store)) == 1  # Expiry DELETE also rolled back.
    assert isinstance(await take(store, quota.SSEGlobalQuota()), quota.Lease)


@pytest.mark.asyncio
async def test_cancellation_after_insert_rolls_back_and_releases_transaction_lock(store, monkeypatch):
    entered = asyncio.Event()
    policy = quota.SSEGlobalQuota()
    async with store.sessions() as db:
        original = db.execute
        async def execute(statement, *args, **kwargs):
            result = await original(statement, *args, **kwargs)
            if getattr(statement, "is_insert", False):
                entered.set()
                await asyncio.Future()
            return result
        monkeypatch.setattr(db, "execute", execute)
        pending = asyncio.create_task(policy.acquire(db, "cancelled", "task", "hub"))
        await asyncio.wait_for(entered.wait(), 2)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert not db.in_transaction()
    assert await rows(store) == []
    assert isinstance(await take(store, policy), quota.Lease)


@pytest.mark.asyncio
async def test_refuses_to_commit_or_rollback_callers_existing_transaction(store):
    async with store.sessions() as db, db.begin():
        with pytest.raises(quota.QuotaUnavailable):
            await quota.acquire(db, "user", "task", "hub")
        assert db.in_transaction()
        assert (await db.execute(text("SELECT 1"))).scalar_one() == 1
    assert await rows(store) == []


@pytest.mark.asyncio
async def test_api_defaults_schema_metadata_and_committed_return(store):
    lease = await take(store, quota.SSEGlobalQuota())
    assert lease.expires_at.tzinfo is not None
    assert 25 < (lease.expires_at-datetime.now(timezone.utc)).total_seconds() <= 30.1
    assert quota.RENEW_SECONDS == 10 and quota.MAX_STREAMS == 64 and quota.MAX_USER_STREAMS == 4
    async with store.sessions() as db:
        assert isinstance(await quota.renew(db, lease.lease_id, lease.hub_id), quota.Lease)
        assert await quota.release(db, lease.lease_id, lease.hub_id)
        assert await quota.sweep(db) == 0
    assert set(quota.LEASE_TABLE.c.keys()) == {"lease_id", "user_id", "task_id", "hub_id", "expires_at"}
    from app.core.database import Base
    assert quota.LEASE_TABLE.name not in Base.metadata.tables
    assert "TIMESTAMP WITH TIME ZONE" in quota.POSTGRES_DDL[0]


@pytest.mark.asyncio
async def test_pg_rejects_stale_snapshot_isolation_and_autocommit(pg_store):
    store = pg_store
    for level in ("REPEATABLE READ", "SERIALIZABLE", "AUTOCOMMIT"):
        engine = create_async_engine(store.url, isolation_level=level)
        try:
            async with async_sessionmaker(engine)() as db:
                with pytest.raises(quota.QuotaUnavailable):
                    await quota.acquire(db, "user", "task", "hub")
                assert not db.in_transaction()
        finally:
            await engine.dispose()
    assert await rows(store) == []


@pytest.mark.asyncio
async def test_pg_wait_timeout_sanitized_and_no_lock_survives_rollback(pg_store):
    store = pg_store
    async with store.sessions() as holder, holder.begin():
        await holder.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": quota.ADVISORY_LOCK_KEY})
        async with store.sessions() as db:
            with pytest.raises(quota.QuotaUnavailable):
                await quota.SSEGlobalQuota(db_timeout=.06).acquire(db, "user", "task", "hub")
            assert not db.in_transaction()
    assert isinstance(await take(store, quota.SSEGlobalQuota()), quota.Lease)


@pytest.mark.asyncio
@pytest.mark.parametrize("method,args", [
    ("acquire", ("Bearer synthetic-token", "task", "hub")),
    ("acquire", ("user", "https://private", "hub")),
    ("acquire", ("user", "task", "x"*129)),
    ("renew", ("not-a-uuid", "hub")),
    ("release", (str(uuid.uuid4()), "hub\nprivate")),
])
async def test_invalid_input_cannot_access_db_or_leak_metadata(method, args):
    with pytest.raises(ValueError, match="^Invalid quota metadata$"):
        await getattr(quota, method)(None, *args)


@pytest.mark.parametrize("options", [dict(lease_seconds=0), dict(renew_seconds=30),
                                    dict(db_timeout=float("nan")), dict(lease_seconds=float("inf")),
                                    dict(lease_seconds=86401), dict(db_timeout=31)])
def test_invalid_policy_timing(options):
    with pytest.raises(ValueError, match="Invalid quota timing"):
        quota.SSEGlobalQuota(**options)


@pytest.mark.asyncio
async def test_pg_clock_ignores_hub_clock_and_starts_ttl_after_lock_wait(pg_store):
    store = pg_store
    policy = quota.SSEGlobalQuota(lease_seconds=.25, renew_seconds=.05,
        sqlite_clock=lambda: datetime(2099, 1, 1, tzinfo=timezone.utc))
    async with store.sessions() as holder:
        async with holder.begin():
            await holder.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": quota.ADVISORY_LOCK_KEY})
            pending = asyncio.create_task(take(store, policy))
            await asyncio.sleep(.15)
            assert not pending.done()
        lease = await asyncio.wait_for(pending, 1)
        now = (await holder.execute(text("SELECT clock_timestamp()"))).scalar_one()
        assert .18 < (lease.expires_at-now).total_seconds() <= .25
        assert lease.expires_at.year != 2099


@pytest.mark.asyncio
async def test_real_pg_hub_sigkill_keeps_committed_lease_until_expiry(pg_store, tmp_path):
    script = r'''
import asyncio,os,time
from sqlalchemy.ext.asyncio import create_async_engine,async_sessionmaker
from app.a2a.sse_global_quota import SSEGlobalQuota
async def run():
    engine=create_async_engine(os.environ['MAPR_QUOTA_OWNED_URL'])
    async with async_sessionmaker(engine)() as db:
        lease=await SSEGlobalQuota(lease_seconds=.2,renew_seconds=.05).acquire(db,'crash-user','task','killed-boot')
        print(lease.lease_id,flush=True)
    await asyncio.sleep(60)
asyncio.run(run())
'''
    root = Path(__file__).resolve().parents[2]
    env = {**os.environ, "MAPR_QUOTA_OWNED_URL": pg_store.url.render_as_string(hide_password=False),
           "PYTHONPATH": f"{root}/backend:{root}", "PYTHONDONTWRITEBYTECODE": "1"}
    process = await asyncio.create_subprocess_exec(sys.executable, "-c", script, cwd=tmp_path, env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        lease_id = (await asyncio.wait_for(process.stdout.readline(), 5)).decode().strip()
        assert uuid.UUID(lease_id).version == 4
        assert process.returncode is None
        # Exact, unreaped direct child capability; no process/group scan.
        process.kill()
        await asyncio.wait_for(process.wait(), 3)
        assert process.returncode < 0
        assert (await rows(pg_store))[0]["lease_id"] == lease_id
        await asyncio.sleep(.25)
        async with pg_store.sessions() as db:
            assert await quota.sweep(db) == 1
        assert isinstance(await take(pg_store, quota.SSEGlobalQuota(), hub="replacement-boot"), quota.Lease)
    finally:
        if process.returncode is None:
            process.kill()
        await asyncio.wait_for(process.wait(), 3)


@pytest.mark.asyncio
async def test_sqlite_busy_wait_bounded_locally_without_cross_process_claim(tmp_path):
    url = URL.create("sqlite+aiosqlite", database=str(tmp_path / "busy.sqlite"))
    async with database_store(url, "sqlite") as store:
        async with store.sessions() as holder, holder.begin():
            await holder.execute(text("BEGIN IMMEDIATE"))
            async with store.sessions() as db:
                start = asyncio.get_running_loop().time()
                with pytest.raises(quota.QuotaUnavailable):
                    await quota.SSEGlobalQuota(db_timeout=.06).acquire(db, "user", "task", "hub")
                assert asyncio.get_running_loop().time()-start < .5
                assert not db.in_transaction()
        assert isinstance(await take(store, quota.SSEGlobalQuota()), quota.Lease)


@pytest.mark.asyncio
async def test_concurrent_duplicate_release_has_only_one_winner(store):
    policy = quota.SSEGlobalQuota()
    lease = await take(store, policy)
    async def release():
        async with store.sessions() as db:
            return await policy.release(db, lease.lease_id, lease.hub_id)
    assert sorted(await asyncio.gather(release(), release())) == [False, True]
    assert await rows(store) == []


@pytest.mark.asyncio
async def test_release_and_renew_race_cannot_resurrect_stream(store):
    policy = quota.SSEGlobalQuota()
    lease = await take(store, policy)
    async def renew():
        async with store.sessions() as db:
            return await policy.renew(db, lease.lease_id, lease.hub_id)
    async def release():
        async with store.sessions() as db:
            return await policy.release(db, lease.lease_id, lease.hub_id)
    renewed, released = await asyncio.gather(renew(), release())
    assert released and (renewed is None or renewed.lease_id == lease.lease_id)
    assert await rows(store) == []
    async with store.sessions() as db:
        assert await policy.renew(db, lease.lease_id, lease.hub_id) is None


@pytest.mark.asyncio
async def test_sqlite_clock_regression_cannot_shorten_renewal_and_autocommit_rejected(tmp_path):
    url = URL.create("sqlite+aiosqlite", database=str(tmp_path / "clock.sqlite"))
    clock = [datetime.now(timezone.utc)]
    policy = quota.SSEGlobalQuota(sqlite_clock=lambda: clock[0])
    async with database_store(url, "sqlite") as store:
        lease = await take(store, policy)
        async with store.sessions() as db:
            clock[0] += timedelta(seconds=5)
            renewed = await policy.renew(db, lease.lease_id, lease.hub_id)
            clock[0] -= timedelta(seconds=10)
            repeated = await policy.renew(db, lease.lease_id, lease.hub_id)
            assert repeated.expires_at == renewed.expires_at
        engine = create_async_engine(url, isolation_level="AUTOCOMMIT")
        try:
            async with async_sessionmaker(engine)() as db:
                with pytest.raises(quota.QuotaUnavailable):
                    await policy.acquire(db, "user", "task", "hub")
                assert not db.in_transaction()
        finally:
            await engine.dispose()


@pytest.mark.asyncio
async def test_commit_ack_loss_fails_closed_and_is_recovered_by_expiry(store):
    from sqlalchemy.exc import OperationalError
    policy = quota.SSEGlobalQuota(lease_seconds=.06, renew_seconds=.02)
    async with store.sessions() as db:
        class LostAcknowledgement:
            def in_transaction(self):
                return db.in_transaction()
            async def connection(self):
                return await db.connection()
            async def execute(self, *args, **kwargs):
                return await db.execute(*args, **kwargs)
            @asynccontextmanager
            async def begin(self):
                async with db.begin():
                    yield
                # The DB really committed; model losing the subsequent ACK.
                raise OperationalError("private DSN", {}, RuntimeError("synthetic network loss"))
        with pytest.raises(quota.QuotaUnavailable, match="^SSE quota unavailable$"):
            await policy.acquire(LostAcknowledgement(), "user", "task", "hub")
    assert len(await rows(store)) == 1
    await asyncio.sleep(.1)
    async with store.sessions() as db:
        assert await policy.sweep(db) == 1
    assert await rows(store) == []

@pytest.mark.asyncio
async def test_reservation_binding_requires_live_owner_and_commits(store):
    policy = quota.SSEGlobalQuota()
    lease = await take(store, policy, task='reservation')
    async with store.sessions() as db:
        assert not await policy.bind_task(db, lease.lease_id, 'wrong-hub', 'actual-task')
        assert await policy.bind_task(db, lease.lease_id, lease.hub_id, 'actual-task')
        assert not db.in_transaction()
        assert await policy.release(db, lease.lease_id, lease.hub_id)
        assert not await policy.bind_task(db, lease.lease_id, lease.hub_id, 'late-task')

@pytest.mark.asyncio
async def test_f60_migration_upgrade_downgrade_upgrade_in_isolated_store(store):
    import importlib.util
    from alembic.operations import Operations
    from alembic.migration import MigrationContext
    path = Path(__file__).resolve().parents[1] / 'alembic/versions/f60c20261011_sse_global_quota.py'
    spec = importlib.util.spec_from_file_location('f60_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == 'e50c20261011'
    def exercise(connection):
        quota.LEASE_METADATA.drop_all(connection)
        with Operations.context(MigrationContext.configure(connection)):
            module.upgrade()
            module.downgrade()
            module.upgrade()
    async with store.engine.begin() as connection:
        await connection.run_sync(exercise)
    assert isinstance(await take(store, quota.SSEGlobalQuota()), quota.Lease)


def test_f60_postgres_offline_ddl():
    import importlib.util
    from io import StringIO
    from alembic.operations import Operations
    from alembic.migration import MigrationContext
    path = Path(__file__).resolve().parents[1] / 'alembic/versions/f60c20261011_sse_global_quota.py'
    spec = importlib.util.spec_from_file_location('f60_offline', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    output = StringIO()
    context = MigrationContext.configure(dialect_name='postgresql', opts={'as_sql':True, 'output_buffer':output})
    with Operations.context(context):
        module.upgrade()
    sql = output.getvalue()
    assert 'CREATE TABLE sse_stream_leases' in sql
    assert 'TIMESTAMP WITH TIME ZONE' in sql
    assert 'CREATE INDEX ix_sse_stream_leases_user_expiry' in sql
