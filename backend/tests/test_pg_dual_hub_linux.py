"""Opt-in real loopback dual-worker gate; only dedicated *_test PostgreSQL DBs."""
import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from contextlib import asynccontextmanager

import httpx
import pytest
import pytest_asyncio
import websockets
from sqlalchemy import select, update
from conftest import engine as isolated_engine, test_session as sessions
from test_a2a_protocol_v1_linux import actors, message
from app.a2a.models import A2ATask
from app.models.agent_task_delivery import AgentTaskDelivery as Delivery
from app.models.room_permission import RoomPermission
from app.chat import delivery_service as ds
from app.chat.task_reconciler import CHANNEL
# Hub init_db registers these too; fixture teardown must know all created tables.
import app.agent.models
import app.knowledge.models
import app.files.models
import app.models.room_template
import app.models.room_permission
import app.models.analytics
import app.models.room_share
import app.models.room_invite

pytestmark = [pytest.mark.asyncio, pytest.mark.skipif(isolated_engine.dialect.name != 'postgresql', reason='isolated PG17 process gate')]
ROOT = Path(__file__).resolve().parents[2]


@pytest_asyncio.fixture
async def hubs(tmp_path, actors, request):
    shim = tmp_path / 'hub_test.py'
    shim.write_text('''import os, asyncio
from app.main import app
from app.ws.connection_manager import connection_manager
from app.a2a.http_protocol import _streams
from app.a2a import http_protocol
from app.a2a.sse_global_quota import SSEGlobalQuota
from app.core.database import engine
if os.environ.get('TEST_SSE_FAST_POLICY'):
    http_protocol.quota_policy = SSEGlobalQuota(lease_seconds=2, renew_seconds=.3)
    from contextlib import asynccontextmanager
    original_lifespan = app.router.lifespan_context
    @asynccontextmanager
    async def fast_lifespan(app):
        async with original_lifespan(app):
            app.state.sse_quota_sweeper.interval = .1
            yield
    app.router.lifespan_context = fast_lifespan
@app.get('/_test/listener')
async def state():
    r=app.state.task_reconciler
    return {'ready':r.listener_ready, 'pid':r.wakeup._connection.get_server_pid() if r.wakeup._connection else None, 'streams':sum(_streams.values()), 'pool':engine.pool.checkedout()}
@app.post('/_test/listener/off')
async def offline():
    await app.state.task_reconciler.wakeup.stop()
    return {'stopped':True}
if os.environ.get('TEST_CRASH_AFTER_COMMIT'):
    original=connection_manager.broadcast
    async def broadcast(channel, payload):
        if payload.get('type') == 'agent_task':
            os._exit(91)
        await original(channel,payload)
    connection_manager.broadcast=broadcast
''')
    processes = []
    async def start(crash=False):
        sock = socket.socket()
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
        env = os.environ.copy()
        env.update(MAPR_DATABASE_URL=isolated_engine.url.render_as_string(hide_password=False),
                   PYTHONPATH=str(tmp_path)+':'+str(ROOT / 'backend')+':'+str(ROOT), PYTHONDONTWRITEBYTECODE='1')
        if getattr(request, 'param', None) == 'fast_sse':
            env['TEST_SSE_FAST_POLICY'] = '1'
        if crash:
            env['TEST_CRASH_AFTER_COMMIT'] = '1'
        log = open(tmp_path / f'hub-{len(processes)}.log', 'wb')
        proc = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'hub_test:app', '--fd', str(sock.fileno()),
            '--no-access-log', '--log-level', 'warning', '--ws', 'websockets-sansio'], env=env, cwd=tmp_path,
            pass_fds=(sock.fileno(),), stdout=log, stderr=log, start_new_session=True)
        sock.close()
        processes.append((proc, log))
        url = f'http://127.0.0.1:{port}'
        async with httpx.AsyncClient(trust_env=False) as client:
            async with asyncio.timeout(10):
                while True:
                    assert proc.poll() is None, (tmp_path / f'hub-{len(processes)-1}.log').read_text()
                    try:
                        if (await client.get(url + '/health')).status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    await asyncio.sleep(.05)
        return SimpleNamespace(url=url, ws=f'ws://127.0.0.1:{port}', proc=proc)
    try:
        yield SimpleNamespace(a=await start(), b=await start(), start=start, actors=actors)
    finally:
        # Only PIDs/groups started by this fixture; never search/kill other services.
        errors = []
        for proc, log in processes:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGTERM)
                try:
                    await asyncio.to_thread(proc.wait, 6)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    await asyncio.to_thread(proc.wait, 3)
                    errors.append(proc.pid)
            log.close()
        (tmp_path / 'cleanup.json').write_text(json.dumps({'pids':[p.pid for p,_ in processes],
            'exit_codes':[p.returncode for p,_ in processes], 'forced': errors}))
        assert not errors, f'Hub shutdown stalled: {errors}'


@asynccontextmanager
async def agent_socket(hub, actors):
    token = actors.headers['agent']['Authorization'].split()[1]
    async with websockets.connect(hub.ws + '/ws/chat/_agent_agent?token=' + token) as ws:
        yield ws


async def receive(ws, kind, task_id=None, timeout=5):
    async with asyncio.timeout(timeout):
        while True:
            frame = json.loads(await ws.recv())
            if frame.get('type') == kind and (not task_id or frame.get('task_id') == task_id or frame.get('task',{}).get('id') == task_id):
                return frame


async def send_task(hub, actors, rpc=False):
    params = message(actors)
    async with httpx.AsyncClient(trust_env=False) as client:
        result = await client.post(hub.url + ('/a2a/rpc' if rpc else '/a2a/message:send'),
            headers=actors.headers['owner'], json={'jsonrpc':'2.0','method':'SendMessage','params':params,'id':1} if rpc else params)
    assert result.status_code == 200, result.text
    return (result.json()['result'] if rpc else result.json())['task']['id']


def control(frame, kind):
    return {'v':1,'type':kind,'task_id':frame['task_id'],'delivery_id':frame['delivery_id'],
            'attempt':frame['attempt'],'target_room':frame['origin_room']}


@pytest.mark.parametrize('rpc', [False, True])
async def test_remote_hub_send_ack_repeated_wake_no_execution_duplication(hubs, rpc):
    async with agent_socket(hubs.a, hubs.actors) as ws:
        tid = await send_task(hubs.b, hubs.actors, rpc)
        frame = await receive(ws, 'agent_task', tid)
        await ws.send(json.dumps(control(frame, 'task_ack')))
        assert (await receive(ws, 'task_ack_result', tid))['accepted']
        async with sessions() as db:
            row = (await db.execute(select(Delivery).where(Delivery.task_id == tid))).scalar_one()
            assert row.attempt == 1 and row.state == 'acked'
        # A replayed ACK is idempotent and cannot acquire another execution.
        await ws.send(json.dumps(control(frame, 'task_ack')))
        assert (await receive(ws, 'task_ack_result', tid))['attempt'] == 1


async def test_cross_hub_cancel_and_room_progress_terminal_reconciliation(hubs):
    token = hubs.actors.headers['owner']['Authorization'].split()[1]
    async with agent_socket(hubs.b, hubs.actors) as agent, websockets.connect(
        hubs.a.ws + '/ws/chat/' + hubs.actors.room.id + '?token=' + token) as room:
        tid = await send_task(hubs.a, hubs.actors)
        frame = await receive(agent, 'agent_task', tid)
        await agent.send(json.dumps(control(frame, 'task_ack')))
        await receive(agent, 'task_ack_result', tid)
        await agent.send(json.dumps({**control(frame, 'task_progress'), 'phase':'running','percent':31}))
        await receive(agent, 'task_progress_result', tid)
        assert (await receive(room, 'task_progress', tid))['percent'] == 31
        async with httpx.AsyncClient(trust_env=False) as client:
            result = await client.post(hubs.a.url+'/a2a/tasks/'+tid+':cancel', headers=hubs.actors.headers['owner'], json={})
        assert result.status_code == 200, result.text
        assert (await receive(agent, 'task_cancel', tid))['attempt'] == 1
        # Task snapshots can arrive in any wake order: wait for the terminal snapshot.
        async with asyncio.timeout(5):
            while (await receive(room, 'task_update', tid))['task']['status'] != 'canceled':
                pass
        await agent.send(json.dumps(control(frame, 'task_cancel_ack')))
        assert (await receive(agent, 'task_cancel_ack_result'))['accepted']


async def test_committed_task_survives_creator_process_crash(hubs):
    crashing = await hubs.start(crash=True)
    async with agent_socket(hubs.a, hubs.actors) as ws:
        async with httpx.AsyncClient(trust_env=False) as client:
            with pytest.raises(httpx.RemoteProtocolError):
                await client.post(crashing.url+'/a2a/message:send', headers=hubs.actors.headers['owner'], json=message(hubs.actors))
        frame = await receive(ws, 'agent_task')
        assert await asyncio.to_thread(crashing.proc.wait, 3) == 91
        async with sessions() as db:
            assert await db.get(A2ATask, frame['task_id']) is not None
        replacement = await hubs.start()
        assert replacement.proc.poll() is None


async def test_listener_disconnect_online_agent_still_receives_and_recovers(hubs):
    async with httpx.AsyncClient(trust_env=False) as client:
        async with asyncio.timeout(5):
            while not (state := (await client.get(hubs.a.url+'/_test/listener')).json())['ready']:
                await asyncio.sleep(.05)
        import asyncpg
        connection = await asyncpg.connect(isolated_engine.url.set(drivername='postgresql').render_as_string(hide_password=False))
        try:
            await connection.execute('SELECT pg_terminate_backend($1)', state['pid'])
        finally:
            await connection.close()
        async with agent_socket(hubs.a, hubs.actors) as ws:
            tid = await send_task(hubs.b, hubs.actors)
            assert (await receive(ws, 'agent_task', tid))['attempt'] == 1
        async with asyncio.timeout(6):
            while True:
                new = (await client.get(hubs.a.url+'/_test/listener')).json()
                if new['ready'] and new['pid'] != state['pid']:
                    break
                await asyncio.sleep(.05)


async def test_cross_hub_owner_permission_revocation_blocks_delivery(hubs):
    async with agent_socket(hubs.a, hubs.actors) as ws:
        async with sessions() as db:
            await db.execute(update(RoomPermission).where(RoomPermission.room_id == hubs.actors.room.id,
                RoomPermission.user_id == hubs.actors.users['owner'].id).values(role='viewer'))
            await db.commit()
        async with httpx.AsyncClient(trust_env=False) as client:
            response = await client.post(hubs.b.url+'/a2a/message:send', headers=hubs.actors.headers['owner'], json=message(hubs.actors))
        assert response.status_code == 403
        with pytest.raises(asyncio.TimeoutError):
            await receive(ws, 'agent_task', timeout=.3)

async def test_pg_sse_snapshot_last_event_id_and_owner_isolation(hubs):
    tid = await send_task(hubs.b, hubs.actors)
    async with httpx.AsyncClient(trust_env=False) as client:
        response = await client.post(hubs.b.url+'/a2a/tasks/'+tid+':cancel', headers=hubs.actors.headers['owner'], json={})
        assert response.status_code == 200
        initial = await client.get(hubs.a.url+'/a2a/tasks/'+tid+':subscribe?after_seq=0', headers=hubs.actors.headers['owner'])
        assert initial.status_code == 200
        ids = [int(line[4:]) for line in initial.text.splitlines() if line.startswith('id: ')]
        assert ids and ids == sorted(set(ids))
        replay = await client.get(hubs.b.url+'/a2a/tasks/'+tid+':subscribe',
            headers={**hubs.actors.headers['owner'], 'Last-Event-ID':str(ids[0])})
        replay_ids = [int(line[4:]) for line in replay.text.splitlines() if line.startswith('id: ')]
        assert replay_ids == ids[1:]
        assert initial.text.split('id: ', 1)[0].startswith('data:')  # snapshot has NO event id
        denied = await client.get(hubs.a.url+'/a2a/tasks/'+tid+':subscribe', headers=hubs.actors.headers['outsider'])
        assert denied.status_code == 403


async def test_pg_sse_25_fast_disconnects_four_five_boundary_send_still_works(hubs):
    tid = await send_task(hubs.b, hubs.actors)
    url = hubs.a.url+'/a2a/tasks/'+tid+':subscribe'
    headers = hubs.actors.headers['owner']
    async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
        for _ in range(25):
            async with client.stream('GET', url, headers=headers) as response:
                assert response.status_code == 200
                async for line in response.aiter_lines():
                    if line.startswith('data:'):
                        break
        async with asyncio.timeout(5):
            while (await client.get(hubs.a.url+'/_test/listener')).json()['streams']:
                await asyncio.sleep(.02)
        streams = [client.stream('GET', hub.url+'/a2a/tasks/'+tid+':subscribe', headers=headers)
                   for hub in (hubs.a, hubs.b, hubs.a, hubs.b)]
        try:
            for stream in streams:
                assert (await stream.__aenter__()).status_code == 200
            fifth = await client.get(url, headers=headers)
            assert fifth.status_code == 429  # quota, NOT storage contention/503
        finally:
            for stream in streams:
                await stream.__aexit__(None, None, None)
        async with asyncio.timeout(5):
            while (state := (await client.get(hubs.a.url+'/_test/listener')).json())['streams'] or state['pool']:
                await asyncio.sleep(.02)
        async with client.stream('GET', url, headers=headers) as response:
            assert response.status_code == 200
        assert await send_task(hubs.a, hubs.actors)


async def test_dual_hub_bounded_burst_60_tasks_unique_ack_execution(hubs):
    async with agent_socket(hubs.a, hubs.actors) as ws:
        tids = set()
        # Bounded write concurrency of four, without invoking a model.
        for _ in range(15):
            tids.update(await asyncio.gather(*(send_task(hubs.b, hubs.actors) for _ in range(4))))
        executed, requested = set(), set()
        async with asyncio.timeout(30):
            while executed != tids:
                frame = json.loads(await ws.recv())
                if frame.get('type') == 'agent_task':
                    assert frame['task_id'] in tids
                    if frame['task_id'] not in requested:
                        requested.add(frame['task_id'])
                        await ws.send(json.dumps(control(frame, 'task_ack')))
                elif frame.get('type') == 'task_ack_result' and frame.get('accepted'):
                    executed.add(frame['task_id'])
        assert len(executed) == 60
        async with sessions() as db:
            rows = list((await db.execute(select(Delivery).where(Delivery.task_id.in_(tids)))).scalars())
            assert len(rows) == 60 and all(row.state == 'acked' and row.attempt == 1 for row in rows)

async def test_no_listener_continuously_online_agent_polling_recovers(hubs):
    async with agent_socket(hubs.a, hubs.actors) as ws:
        async with httpx.AsyncClient(trust_env=False) as client:
            assert (await client.post(hubs.a.url+'/_test/listener/off')).status_code == 200
        tid = await send_task(hubs.b, hubs.actors)
        frame = await receive(ws, 'agent_task', tid)
        assert frame['attempt'] == 1
        async with httpx.AsyncClient(trust_env=False) as client:
            assert not (await client.get(hubs.a.url+'/_test/listener')).json()['ready']


async def test_two_hub_agent_connections_only_one_execution_ack_wins(hubs):
    async with agent_socket(hubs.a, hubs.actors) as a, agent_socket(hubs.b, hubs.actors) as b:
        tid = await send_task(hubs.b, hubs.actors)
        fa = await receive(a, 'agent_task', tid)
        fb = await receive(b, 'agent_task', tid)
        assert fa['delivery_id'] == fb['delivery_id'] and fa['attempt'] == fb['attempt'] == 1
        await a.send(json.dumps(control(fa, 'task_ack')))
        assert (await receive(a, 'task_ack_result', tid))['accepted']
        await b.send(json.dumps(control(fb, 'task_ack')))
        assert (await receive(b, 'error'))['code'] == 'delivery_denied'
        async with sessions() as db:
            row = (await db.execute(select(Delivery).where(Delivery.task_id == tid))).scalar_one()
            assert row.state == 'acked' and row.attempt == 1

async def test_revoked_owner_still_gets_executor_stop_and_fenced_cleanup(hubs):
    from app.a2a.task_service import TaskService
    async with agent_socket(hubs.b, hubs.actors) as ws:
        tid = await send_task(hubs.a, hubs.actors)
        frame = await receive(ws, 'agent_task', tid)
        await ws.send(json.dumps(control(frame, 'task_ack')))
        await receive(ws, 'task_ack_result', tid)
        async with sessions() as db:
            await db.execute(update(RoomPermission).where(RoomPermission.room_id == hubs.actors.room.id,
                RoomPermission.user_id == hubs.actors.users['owner'].id).values(role='viewer'))
            # Trusted service cancellation with NO local WebSocket broadcast.
            await TaskService.cancel_task(db, tid)
            await ds.cancel_deliveries(db, tid)
            await db.commit()
        assert (await receive(ws, 'task_cancel', tid))['delivery_id'] == frame['delivery_id']
        await ws.send(json.dumps(control(frame, 'task_lease')))
        assert (await receive(ws, 'error'))['code'] == 'delivery_denied'
        await ws.send(json.dumps(control(frame, 'task_cancel_ack')))
        assert (await receive(ws, 'task_cancel_ack_result'))['accepted']

@pytest.mark.parametrize('hubs', ['fast_sse'], indirect=True)
async def test_pg_real_http_hub_sigkill_then_other_hub_sweep_reclaims_lease(hubs):
    from app.a2a.sse_global_quota import LEASE_TABLE
    from sqlalchemy import func
    tid = await send_task(hubs.b, hubs.actors)
    headers = hubs.actors.headers['owner']
    async with httpx.AsyncClient(trust_env=False, timeout=5) as client:
        async with client.stream('GET', hubs.a.url+'/a2a/tasks/'+tid+':subscribe', headers=headers) as response:
            assert response.status_code == 200
            iterator = response.aiter_lines()
            async for line in iterator:
                if line.startswith('data:'):
                    break
            async with sessions() as db:
                assert (await db.execute(select(func.count()).select_from(LEASE_TABLE))).scalar_one() == 1
            hubs.a.proc.kill()  # Exact owned Hub process; intentionally no finally/release.
            assert await asyncio.to_thread(hubs.a.proc.wait, 3) == -signal.SIGKILL
            async with sessions() as db:
                assert (await db.execute(select(func.count()).select_from(LEASE_TABLE))).scalar_one() == 1
        async with asyncio.timeout(5):
            while True:
                async with sessions() as db:
                    count = (await db.execute(select(func.count()).select_from(LEASE_TABLE))).scalar_one()
                if count == 0:
                    break
                await asyncio.sleep(.05)
        # Surviving Hub actually admitted a replacement HTTP stream.
        async with client.stream('GET', hubs.b.url+'/a2a/tasks/'+tid+':subscribe', headers=headers) as response:
            assert response.status_code == 200
            iterator = response.aiter_lines()
            async for line in iterator:
                if line.startswith('data:'):
                    break
        assert await send_task(hubs.b, hubs.actors)
