"""SSE resource regression gates, including isolated real uvicorn processes.

All process modules, logs and databases live in pytest's temporary directory.
No production database, migrations, agents or model calls are used.
"""
import asyncio
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import anyio
import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from starlette.requests import Request

from app.a2a import http_protocol as protocol
from app.config import get_settings
from app.core.database import Base
from app.core.security import create_access_token
from app.models.user import User
from app.models.room import Room
from app.models.room_permission import RoomPermission
from test_a2a_protocol_v1_linux import actors, send, isolated_sse_lifecycle


@pytest.mark.asyncio
async def test_no_session_retained_at_snapshot_or_event_yield(client, actors, monkeypatch):
    tid = await send(client, actors)
    original = protocol.sessions
    opened = []

    @asynccontextmanager
    async def tracked():
        async with original() as db:
            opened.append(db)
            try:
                yield db
            finally:
                opened.remove(db)

    monkeypatch.setattr(protocol, 'sessions', tracked)
    request = Request({'type': 'http', 'method': 'GET', 'path': '/', 'headers': [
        (b'authorization', actors.headers['owner']['Authorization'].encode())]},
        receive=lambda: asyncio.sleep(0, result={'type': 'http.request'}))
    generator = protocol.persisted_events(request, tid, 0)
    try:
        for _ in range(3):  # snapshot, task_created, delivery_created
            assert 'data' in await anext(generator)
            assert opened == []
    finally:
        await generator.aclose()
    assert opened == []


@pytest.mark.asyncio
async def test_disconnect_during_sql_read_allows_rollback_and_close(monkeypatch):
    entered = anyio.Event()
    closed = []

    @asynccontextmanager
    async def session():
        try:
            yield object()
        finally:
            # Multiple awaits expose AnyIO level cancellation during close.
            await anyio.sleep(.01)
            await anyio.sleep(.01)
            closed.append(True)

    monkeypatch.setattr(protocol, 'sessions', session)
    async def producer():
        async with protocol.sse_session():
            entered.set()
            await anyio.sleep(.03)

    async with anyio.create_task_group() as group:
        group.start_soon(producer)
        await entered.wait()
        group.cancel_scope.cancel()
    assert closed == [True]


@pytest.mark.asyncio
async def test_sql_read_timeout_closes_session_and_emits_safe_error(monkeypatch):
    closed = []

    @asynccontextmanager
    async def session():
        try:
            yield object()
        finally:
            await asyncio.sleep(.01)
            closed.append(True)

    async def stall(*args):
        await asyncio.Future()

    monkeypatch.setattr(protocol, 'sessions', session)
    monkeypatch.setattr(protocol, 'authenticate', stall)
    monkeypatch.setattr(protocol, 'SSE_DB_SECONDS', .01)
    frames = [frame async for frame in protocol.persisted_events(object(), 'task', 0)]
    assert len(frames) == 1 and frames[0]['event'] == 'error'
    assert closed == [True]


@pytest.mark.asyncio
async def test_read_deadline_does_not_interrupt_session_exit(monkeypatch):
    closed = []

    @asynccontextmanager
    async def session():
        try:
            yield object()
        finally:
            await asyncio.sleep(.03)
            closed.append(True)

    monkeypatch.setattr(protocol, 'sessions', session)
    monkeypatch.setattr(protocol, 'SSE_DB_SECONDS', .01)
    async with protocol.sse_session():
        await asyncio.sleep(.005)
    assert closed == [True]


@pytest.mark.asyncio
@pytest.mark.parametrize('mode', ['disconnect', 'failure', 'cancel', 'early_end'])
async def test_response_closes_suspended_generator_and_releases_quota(mode):
    entered = asyncio.Event()
    closed, released = [], []
    async def events():
        try:
            if mode == 'early_end':
                return
            yield {'id': '1', 'data': '{}'}
            await asyncio.Future()
        finally:
            await anyio.sleep(.01)
            closed.append(True)
    async def receive():
        await entered.wait()
        if mode == 'disconnect':
            return {'type': 'http.disconnect'}
        await asyncio.Future()
    async def emit(frame):
        if frame['type'] == 'http.response.body':
            entered.set()
            if mode == 'failure':
                raise RuntimeError('synthetic send failure')
            if mode in ('disconnect', 'cancel'):
                await asyncio.Future()
    response = protocol.QuotaEventSourceResponse(events(), release_slot=lambda: released.append(True), ping=10)
    task = asyncio.create_task(response({'type': 'http'}, receive, emit))
    if mode == 'cancel':
        await entered.wait()
        task.cancel()
    if mode in ('cancel', 'failure'):
        with pytest.raises((asyncio.CancelledError, ExceptionGroup)):
            await asyncio.wait_for(task, 1)
    else:
        await asyncio.wait_for(task, 1)
    assert closed == [True] and released == [True]


@pytest_asyncio.fixture
async def live_sse(tmp_path):
    """A production pool/lifespan in a separate, owned loopback process."""
    database_url = 'sqlite+aiosqlite:///' + str(tmp_path / 'live.db')
    seed_engine = create_async_engine(database_url)
    factory = async_sessionmaker(seed_engine, expire_on_commit=False)
    async with seed_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with factory() as db:
        owner = User(username='sseowner', display_name='synthetic owner', user_type='human')
        db.add(owner)
        await db.flush()
        agent = User(username='sseagent', display_name='synthetic agent', user_type='agent', owner_user_id=owner.id)
        db.add(agent)
        await db.flush()
        room = Room(name='synthetic SSE', transport='hub', created_by=owner.id)
        db.add(room)
        await db.flush()
        db.add_all([RoomPermission(room_id=room.id, user_id=owner.id, role='owner'),
                    RoomPermission(room_id=room.id, user_id=agent.id, role='member')])
        await db.commit()
    await seed_engine.dispose()
    # Test-only observability. This route never exists in the repository app.
    (tmp_path / 'sse_process.py').write_text('''from app.main import app
from app.a2a import http_protocol as protocol
from app.a2a.sse_global_quota import SSEGlobalQuota
protocol.quota_policy = SSEGlobalQuota(lease_seconds=.8, renew_seconds=.15)
from app.core.database import engine
from contextlib import asynccontextmanager
from pathlib import Path
import json
original_lifespan = app.router.lifespan_context
@asynccontextmanager
async def lifespan(app):
    async with original_lifespan(app):
        yield
    Path('shutdown.json').write_text(json.dumps({'slots':sum(protocol._streams.values()), 'checked_out':engine.sync_engine.pool.checkedout()}))
app.router.lifespan_context = lifespan
@app.get("/_sse_test/state")
async def state():
    return {"slots":sum(protocol._streams.values()), "checked_out":engine.sync_engine.pool.checkedout()}
''')
    root = Path(__file__).resolve().parents[2]
    env = os.environ.copy()
    env.update(MAPR_DATABASE_URL=database_url, MAPR_AUTH_SECRET_KEY=get_settings().auth_secret_key,
               PYTHONDONTWRITEBYTECODE='1', PYTHONPATH=str(tmp_path)+os.pathsep+str(root/'backend'))
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(16)
    port = listener.getsockname()[1]
    log_path = tmp_path / 'uvicorn.log'
    with log_path.open('wb') as log:
        process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'sse_process:app',
            '--fd', str(listener.fileno()), '--no-access-log', '--log-level', 'warning'],
            cwd=tmp_path, env=env, pass_fds=(listener.fileno(),), start_new_session=True, stdout=log, stderr=log)
    listener.close()
    (tmp_path / 'process.json').write_text(json.dumps({'pid':process.pid, 'pgid':os.getpgid(process.pid), 'port':port}))
    client = httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', trust_env=False, timeout=5)
    headers = {'Authorization': 'Bearer '+create_access_token(owner.id), 'A2A-Version':'1.0'}
    async def create():
        payload = {
            'configuration': {'returnImmediately': True},
            'message': {
                'messageId': secrets.token_hex(8),
                'role': 'ROLE_USER',
                'parts': [{'text': 'synthetic no-model task'}],
                'metadata': {'roomId': room.id, 'targetAgent': agent.id},
            },
        }
        response = await client.post('/a2a/message:send', headers=headers, json=payload)
        assert response.status_code == 200, response.text
        return response.json()['task']['id']
    async def state(slots=0):
        async with asyncio.timeout(1.5):
            while True:
                value = (await client.get('/_sse_test/state')).json()
                if value == {'slots': slots, 'checked_out': 0}:
                    return value
                await asyncio.sleep(.01)
    try:
        for _ in range(100):
            assert process.poll() is None, log_path.read_text()
            try:
                await client.get('/_sse_test/state')
                break
            except httpx.TransportError:
                await asyncio.sleep(.05)
        else:
            raise AssertionError('uvicorn startup timed out')
        yield SimpleNamespace(client=client, headers=headers, create=create, state=state, process=process, log=log_path, sessions=factory)
    finally:
        await client.aclose()
        if process.poll() is None:
            process.terminate()
            try:
                await asyncio.to_thread(process.wait, 5)
            except subprocess.TimeoutExpired:
                process.kill()
                await asyncio.to_thread(process.wait)
                pytest.fail('Owned SSE uvicorn did not shut down within five seconds')
        # uvicorn 0.54 re-raises SIGTERM AFTER graceful shutdown. Verify the
        # lifespan marker, rather than mistaking -15 for a cleanup failure.
        assert process.returncode in (0, -signal.SIGTERM), log_path.read_text()
        assert json.loads((tmp_path / 'shutdown.json').read_text()) == {'slots':0, 'checked_out':0}
        log = log_path.read_text()
        assert all(error not in log for error in ('Connection closed', 'database is locked',
            'Exception terminating connection', 'ASGI callable returned without completing response')), log


async def first_frame(iterator, persisted=False):
    async with asyncio.timeout(2):
        has_id = False
        async for line in iterator:
            has_id = has_id or line.startswith('id:')
            if line.startswith('data:') and (has_id or not persisted):
                return
    raise AssertionError('SSE ended without expected frame')


@pytest.mark.asyncio
@pytest.mark.parametrize('rpc,gap', [(False, 0), (True, .06), (False, .5)])
async def test_25_fast_disconnects_release_pool_and_allow_subsequent_send(live_sse, rpc, gap):
    live = live_sse
    tid = await live.create()
    for index in range(25):
        kwargs = {'headers': live.headers}
        if rpc:
            kwargs['json'] = {'jsonrpc':'2.0', 'id': index, 'method':'SubscribeToTask', 'params':{'id':tid}}
        async with live.client.stream('POST' if rpc else 'GET', '/a2a/rpc' if rpc else '/a2a/tasks/'+tid+':subscribe', **kwargs) as response:
            assert response.status_code == 200
            iterator = response.aiter_lines()
            await first_frame(iterator, persisted=bool(index % 2))
        await live.state()  # bounded cleanup, checks both quota AND real DB pool
        await asyncio.sleep(gap)
    assert await live.create() != tid
    await live.state()


@pytest.mark.asyncio
async def test_real_four_five_limit_close_and_resubscribe_without_db_sessions(live_sse):
    live = live_sse
    tid = await live.create()
    streams, iterators = [], []
    try:
        for _ in range(4):
            context = live.client.stream('GET', '/a2a/tasks/'+tid+':subscribe', headers=live.headers)
            response = await context.__aenter__()
            streams.append(context)
            assert response.status_code == 200
            iterator = response.aiter_lines()
            iterators.append(iterator)
            await first_frame(iterator)
        await live.state(slots=4)  # open network streams hold zero SQL sessions
        response = await live.client.get('/a2a/tasks/'+tid+':subscribe', headers=live.headers)
        assert response.status_code == 429
        await streams.pop().__aexit__(None, None, None)
        await live.state(slots=3)
        context = live.client.stream('GET', '/a2a/tasks/'+tid+':subscribe', headers=live.headers)
        response = await context.__aenter__()
        streams.append(context)
        assert response.status_code == 200
        iterator = response.aiter_lines()
        iterators.append(iterator)
        await first_frame(iterator)
        await live.state(slots=4)
    finally:
        for context in streams:
            await context.__aexit__(None, None, None)
    await live.state()
    assert await live.create() != tid


@pytest.mark.asyncio
async def test_real_sigterm_with_open_sse_exits_cleanly(live_sse):
    live = live_sse
    tid = await live.create()
    async with live.client.stream('GET', '/a2a/tasks/'+tid+':subscribe', headers=live.headers) as response:
        iterator = response.aiter_lines()
        await first_frame(iterator, persisted=True)
        live.process.terminate()
        await asyncio.to_thread(live.process.wait, 5)
        assert live.process.returncode in (0, -signal.SIGTERM)
        assert json.loads((live.log.parent / 'shutdown.json').read_text()) == {'slots':0, 'checked_out':0}

@pytest.mark.asyncio
async def test_live_heartbeat_renews_then_lost_lease_stops_stream(live_sse):
    from sqlalchemy import delete, select
    from app.a2a.sse_global_quota import LEASE_TABLE
    live = live_sse
    tid = await live.create()
    async with live.client.stream('GET', '/a2a/tasks/'+tid+':subscribe', headers=live.headers) as response:
        assert response.status_code == 200
        iterator = response.aiter_lines()
        await first_frame(iterator)
        async with live.sessions() as db:
            before = (await db.execute(select(LEASE_TABLE.c.expires_at))).scalar_one()
        await asyncio.sleep(1.1)  # Beyond the test lease TTL, without event production.
        async with live.sessions() as db:
            after = (await db.execute(select(LEASE_TABLE.c.expires_at))).scalar_one()
            assert after > before
            await db.execute(delete(LEASE_TABLE))
            await db.commit()
        # Heartbeat fences a stream whose DB lease disappeared.
        async with asyncio.timeout(2):
            async for _ in iterator:
                pass
    await live.state()
    assert await live.create() != tid


@pytest.mark.asyncio
async def test_quota_failure_does_not_admit_or_create_stream_task(client, actors, monkeypatch):
    from app.a2a.sse_global_quota import QuotaUnavailable
    from app.a2a.models import A2ATask
    from sqlalchemy import select, func
    from test_a2a_protocol_v1_linux import message
    async def unavailable(*args):
        raise QuotaUnavailable()
    monkeypatch.setattr(protocol.quota_policy, 'acquire', unavailable)
    response = await client.post('/a2a/message:stream', headers=actors.headers['owner'], json=message(actors))
    assert response.status_code == 503
    assert protocol._streams == {}
    async with protocol.sessions() as db:
        assert (await db.execute(select(func.count()).select_from(A2ATask))).scalar_one() == 0


@pytest.mark.asyncio
async def test_sweeper_expiry_and_start_stop_are_idempotent(client, actors):
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import update
    from app.a2a.sse_global_quota import LEASE_TABLE
    from app.a2a.sse_sweeper import SSEQuotaSweeper
    async with protocol.sessions() as db:
        lease = await protocol.quota_policy.acquire(db, actors.users['owner'].id, 'task', protocol.HUB_ID)
    async with protocol.sessions() as db:
        await db.execute(update(LEASE_TABLE).values(expires_at=datetime.now(timezone.utc)-timedelta(seconds=1)))
        await db.commit()
    sweeper = SSEQuotaSweeper(protocol.sessions, interval=.01)
    assert await sweeper.run_once() == 1
    assert await sweeper.run_once() == 0
    sweeper.start()
    task = sweeper.task
    sweeper.start()
    assert sweeper.task is task
    await sweeper.stop()
    await sweeper.stop()
    assert task.done()
