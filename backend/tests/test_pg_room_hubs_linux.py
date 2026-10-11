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
from app.chat.models import Message
from app.models.room import Room
from app.models.room_presence import RoomPresence
from app.chat.pg_wakeup import PgWakeup, signal_in_transaction
from datetime import datetime, timezone, timedelta
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
async def chat_hubs(tmp_path, actors):
    shim = tmp_path / 'chat_hub_test.py'
    shim.write_text('''import os, asyncio
from app.main import app
from app.ws.connection_manager import connection_manager
from app.a2a.http_protocol import _streams
from app.core.database import engine
from contextlib import asynccontextmanager
original_lifespan=app.router.lifespan_context
@asynccontextmanager
async def chat_lifespan(app):
    async with original_lifespan(app):
        app.state.room_synchronizer.ttl=3
        yield
app.router.lifespan_context=chat_lifespan
@app.post('/_test/listener/restart')
async def restart():
    r=app.state.task_reconciler
    await r.wakeup.start(r._on_hint,r._on_reconcile)
    return {'started':True}
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
        if payload.get('type') == 'message':
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
        if crash:
            env['TEST_CRASH_AFTER_COMMIT'] = '1'
        log = open(tmp_path / f'hub-{len(processes)}.log', 'wb')
        proc = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'chat_hub_test:app', '--fd', str(sock.fileno()),
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
async def room_socket(hub, actors, actor='owner', cursor=None, room_id=None):
    token=actors.headers[actor]['Authorization'].split()[1]
    query='?token='+token+(f'&message_cursor={cursor}' if cursor is not None else '')
    async with websockets.connect(hub.ws+'/ws/chat/'+(room_id or actors.room.id)+query) as ws:
        yield ws


async def read(ws, kind, predicate=lambda f:True, timeout=7):
    async with asyncio.timeout(timeout):
        while True:
            frame=json.loads(await ws.recv())
            if frame['type']==kind and predicate(frame):
                return frame


async def send_chat(ws, text):
    await ws.send(json.dumps({'type':'message','content':text}))


async def insert_messages(actors, n=1, text='db-message', **kwargs):
    async with sessions() as db:
        rows=[Message(room_id=actors.room.id,sender_id=actors.users['owner'].id,
                      sender_type='human',content=f'{text}-{i}', **kwargs) for i in range(n)]
        db.add_all(rows); await db.commit()
    return rows


@pytest.mark.parametrize('actor', ['member','agent'])
async def test_ordinary_user_and_agent_commit_cross_hub_no_duplicates(chat_hubs, actors, actor):
    async with room_socket(chat_hubs.a, actors, 'owner') as wa, room_socket(chat_hubs.b, actors, actor) as wb:
        await send_chat(wb,'cross-hub')
        fa=await read(wa,'message'); fb=await read(wb,'message')
        assert fa['message']['id']==fb['message']['id']
        assert fa['message']['sender_id']==actors.users[actor].id
        assert fa['message']['sender_type']==actors.users[actor].user_type
        assert fa['message']['room_seq']==1
        for _ in range(10):
            async with sessions() as db:
                await db.execute(select(Room.id))
                await signal_in_transaction(db,'room',actors.room.id)
                await db.commit()
        await send_chat(wb,'second')
        assert (await read(wa,'message'))['message']['content']=='second'
        assert (await read(wb,'message'))['message']['content']=='second'


async def test_pg_notify_only_on_commit_and_rollback_no_body(chat_hubs, actors):
    seen=[]
    listener=PgWakeup(isolated_engine.url, reconcile_interval=10)
    async def on_hint(hint): seen.append(hint)
    async def on_reconcile(): pass
    await listener.start(on_hint,on_reconcile)
    try:
        async with asyncio.timeout(3):
            while not listener.listening: await asyncio.sleep(.01)
        async with room_socket(chat_hubs.a, actors) as ws:
            async with sessions() as db:
                pending=Message(room_id=actors.room.id,sender_id=actors.users['owner'].id,content='uncommitted-secret')
                db.add(pending); await db.flush()
                # Presence hints may arrive; distinguish our room after settling,
                # and do not confuse them with a message delivery guarantee.
                await asyncio.sleep(.15); seen.clear()
                await asyncio.sleep(.2)
                assert not seen
                await db.rollback()
            await insert_messages(actors,text='committed')
            frame=await read(ws,'message')
            assert frame['message']['content']=='committed-0' and frame['message']['room_seq']==1
            async with asyncio.timeout(2):
                while not seen: await asyncio.sleep(.01)
            assert all(h.kind=='room' and h.id==actors.room.id for h in seen)
    finally: await listener.stop()


async def test_long_transaction_many_cycles_then_commit_never_skipped(chat_hubs, actors):
    async with room_socket(chat_hubs.a,actors) as ws:
        async with sessions() as tx:
            await tx.execute(select(Room.id))
            pending=Message(id='00000000-0000-4000-8000-000000000001',room_id=actors.room.id,
                sender_id=actors.users['owner'].id,content='late',created_at=datetime.now(timezone.utc)-timedelta(days=2))
            await insert_messages(actors,n=63)
            frames=[(await read(ws,'message'))['message'] for _ in range(63)]
            assert [f['room_seq'] for f in frames]==list(range(1,64))
            # >5 second lookback and several polling/heartbeat cycles.
            await asyncio.sleep(6.2)
            tx.add(pending); await tx.commit()
        last=(await read(ws,'message'))['message']
        assert last['id']==pending.id and last['room_seq']==64
        await insert_messages(actors,text='after-late')
        assert (await read(ws,'message'))['message']['room_seq']==65


async def test_counter_lock_prevents_reverse_commit_and_rollback_reuses_sequence(chat_hubs, actors):
    async with sessions() as first:
        one=Message(room_id=actors.room.id,sender_id=actors.users['owner'].id,content='first')
        first.add(one); await first.flush()
        started=asyncio.Event()
        async def later():
            async with sessions() as second:
                started.set()
                two=Message(room_id=actors.room.id,sender_id=actors.users['owner'].id,content='second')
                second.add(two); await second.commit(); return two
        task=asyncio.create_task(later())
        try:
            await started.wait(); await asyncio.sleep(.2)
            assert not task.done(), 'second transaction must wait for room row lock'
            await first.rollback()
            two=await asyncio.wait_for(task,3)
            assert two.room_seq==1
        finally:
            if not task.done(): task.cancel()
            await asyncio.gather(task,return_exceptions=True)
    async with room_socket(chat_hubs.a,actors) as ws:
        frame=await read(ws,'message')
        assert frame['message']['content']=='second' and frame['message']['room_seq']==1


async def test_lost_listener_and_recovery_polling_compensates_online_client(chat_hubs, actors):
    async with room_socket(chat_hubs.a, actors) as ws:
        async with httpx.AsyncClient(trust_env=False) as client:
            assert (await client.post(chat_hubs.a.url+'/_test/listener/off')).status_code==200
            assert not (await client.get(chat_hubs.a.url+'/_test/listener')).json()['ready']
            await insert_messages(actors,text='missed-notify')
            assert (await read(ws,'message',timeout=4))['message']['content']=='missed-notify-0'
            assert (await client.post(chat_hubs.a.url+'/_test/listener/restart')).status_code==200
            async with asyncio.timeout(3):
                while not (await client.get(chat_hubs.a.url+'/_test/listener')).json()['ready']:
                    await asyncio.sleep(.05)
            await insert_messages(actors,text='restored')
            assert (await read(ws,'message'))['message']['room_seq']==2


async def test_commit_then_writer_crash_still_delivered(chat_hubs, actors):
    crashing=await chat_hubs.start(crash=True)
    async with room_socket(chat_hubs.a, actors) as receiver, room_socket(crashing, actors,'member') as writer:
        await send_chat(writer,'committed-before-crash')
        frame=await read(receiver,'message')
        assert frame['message']['content']=='committed-before-crash'
        async with asyncio.timeout(3):
            while crashing.proc.poll() is None: await asyncio.sleep(.05)
        assert crashing.proc.returncode==91


async def test_hub_sigkill_presence_ttl_multitab_and_restart_replay(chat_hubs, actors):
    async with room_socket(chat_hubs.a,actors) as wa, room_socket(chat_hubs.b,actors) as wb:
        frame=await read(wa,'presence_snapshot',lambda f:f['online_count']==1 and f['participants'][0]['connection_count']==2)
        await insert_messages(actors,n=3)
        got=[(await read(wa,'message'))['message'] for _ in range(3)]
        assert [f['room_seq'] for f in got]==[1,2,3]
        os.killpg(chat_hubs.b.proc.pid,signal.SIGKILL)
        await asyncio.to_thread(chat_hubs.b.proc.wait,3)
        frame=await read(wa,'presence_snapshot',lambda f:f['online_count']==1 and f['participants'][0]['connection_count']==1,timeout=7)
        replacement=await chat_hubs.start()
        async with room_socket(replacement,actors,cursor=2) as restored:
            assert (await read(restored,'message'))['message']['room_seq']==3
            await insert_messages(actors,text='post-restart')
            assert (await read(restored,'message'))['message']['room_seq']==4


@pytest.mark.parametrize('change', ['revoke','inactive','viewer'])
async def test_cross_hub_permission_changes_no_data_leak(chat_hubs, actors, change):
    async with room_socket(chat_hubs.a,actors,'member') as wa:
        await read(wa,'presence_snapshot')
        async with httpx.AsyncClient(trust_env=False) as client:
            if change=='inactive':
                r=await client.delete(chat_hubs.b.url+'/api/v1/rooms/'+actors.room.id, headers=actors.headers['owner'])
            elif change=='viewer':
                r=await client.put(chat_hubs.b.url+'/api/v1/rooms/'+actors.room.id+'/role',
                    headers=actors.headers['owner'],json={'user_id':actors.users['member'].id,'role':'viewer'})
            else:
                r=await client.delete(chat_hubs.b.url+'/api/v1/rooms/'+actors.room.id+'/members/'+actors.users['member'].id,
                    headers=actors.headers['owner'])
            if r is not None: assert r.status_code==200,r.text
        if change=='viewer':
            await send_chat(wa,'forbidden-write')
            error=await read(wa,'error')
            assert error['code']=='read_only'
            await insert_messages(actors,text='still-viewable')
            assert (await read(wa,'message'))['message']['content']=='still-viewable-0'
        else:
            await insert_messages(actors,text='must-not-leak')
            with pytest.raises(websockets.ConnectionClosed):
                async with asyncio.timeout(4):
                    while True:
                        f=json.loads(await wa.recv())
                        assert f['type']!='message'


async def test_two_rooms_isolated_and_reconnect_default_legacy_full_replay(chat_hubs, actors):
    async with sessions() as db:
        room=Room(name='separate',transport='hub'); db.add(room); await db.flush()
        db.add(RoomPermission(room_id=room.id,user_id=actors.users['member'].id,role='owner')); await db.commit()
    async with room_socket(chat_hubs.a,actors) as wa, room_socket(chat_hubs.b,actors,'member',room_id=room.id) as wb:
        await send_chat(wb,'other-room-private')
        assert (await read(wb,'message'))['message']['room_id']==room.id
        await insert_messages(actors,n=101)
        own=[(await read(wa,'message'))['message'] for _ in range(101)]
        assert len({f['id'] for f in own})==101 and all(f['room_id']==actors.room.id for f in own)
    async with room_socket(chat_hubs.b,actors) as legacy:
        replay=[(await read(legacy,'message'))['message'] for _ in range(101)]
        assert [f['id'] for f in replay]==[f['id'] for f in own]


async def test_listener_backend_termination_reconnect_one_bus(chat_hubs, actors):
    async with httpx.AsyncClient(trust_env=False) as client:
        async with asyncio.timeout(3):
            while True:
                before=(await client.get(chat_hubs.a.url+'/_test/listener')).json()
                if before['ready']: break
                await asyncio.sleep(.02)
        async with room_socket(chat_hubs.a,actors) as ws:
            async with sessions() as db:
                from sqlalchemy import text
                assert (await db.execute(text('SELECT pg_terminate_backend(:pid)'),{'pid':before['pid']})).scalar_one()
                await db.commit()
            await insert_messages(actors,text='listener-gap')
            assert (await read(ws,'message'))['message']['content']=='listener-gap-0'
            async with asyncio.timeout(4):
                while True:
                    after=(await client.get(chat_hubs.a.url+'/_test/listener')).json()
                    if after['ready'] and after['pid']!=before['pid']: break
                    await asyncio.sleep(.05)
            assert after['pid']!=before['pid']

async def test_concurrent_same_client_key_only_one_message_and_ack(chat_hubs, actors):
    async with room_socket(chat_hubs.a,actors) as wa, room_socket(chat_hubs.b,actors) as wb:
        frame=json.dumps({'type':'message','content':'same write','client_message_id':'retry-key'})
        await asyncio.gather(wa.send(frame),wb.send(frame))
        a=await read(wa,'message_ack'); b=await read(wb,'message_ack')
        assert a['id']==b['id'] and a['room_seq']==b['room_seq']==1
        async with sessions() as db:
            from sqlalchemy import func
            assert (await db.execute(select(func.count()).select_from(Message))).scalar_one()==1
        await wb.send(json.dumps({'type':'message','content':'changed','client_message_id':'retry-key'}))
        assert (await read(wb,'error'))['code']=='message_key_conflict'
        await send_chat(wb,'after-retry')
        assert (await read(wa,'message',lambda f:f['message']['content']=='after-retry'))['message']['room_seq']==2


async def test_join_kick_presence_changes_are_global_and_authorized(chat_hubs, actors):
    async with room_socket(chat_hubs.a,actors) as wa:
        async with httpx.AsyncClient(trust_env=False) as client:
            response=await client.post(chat_hubs.b.url+'/api/v1/rooms/'+actors.room.id+'/invite',
                headers=actors.headers['owner'],json={'username':'outsider','role':'member'})
            assert response.status_code==200,response.text
            async with room_socket(chat_hubs.b,actors,'outsider') as wb:
                presence=await read(wa,'presence_snapshot',lambda f:f['online_count']==2)
                assert {p['sender_id'] for p in presence['participants']}=={actors.users['owner'].id,actors.users['outsider'].id}
                response=await client.delete(chat_hubs.a.url+'/api/v1/rooms/'+actors.room.id+'/members/'+actors.users['outsider'].id,
                    headers=actors.headers['owner'])
                assert response.status_code==200
                await insert_messages(actors,text='private-after-kick')
                with pytest.raises(websockets.ConnectionClosed):
                    async with asyncio.timeout(4):
                        while True:
                            frame=json.loads(await wb.recv())
                            assert frame['type']!='message'
                presence=await read(wa,'presence_snapshot',lambda f:f['online_count']==1)
                assert presence['participants'][0]['sender_id']==actors.users['owner'].id


async def test_real_access_token_expiry_and_invalid_room_cursor_close_safely(chat_hubs, actors):
    from app.core.security import create_access_token
    import base64, hmac, hashlib
    from app.config import get_settings
    settings=get_settings()
    claims={'sub':actors.users['member'].id,'typ':'human','exp':int(__import__('time').time())+2}
    encode=lambda data:base64.urlsafe_b64encode(data).decode().rstrip('=')
    body=encode(json.dumps(claims,separators=(',',':')).encode())
    token=body+'.'+encode(hmac.new(settings.auth_secret_key.encode(),body.encode(),hashlib.sha256).digest())
    async with websockets.connect(chat_hubs.a.ws+'/ws/chat/'+actors.room.id+'?token='+token) as ws:
        with pytest.raises(websockets.ConnectionClosed):
            async with asyncio.timeout(5):
                while True:
                    frame=json.loads(await ws.recv())
                    assert frame['type']!='message'
    with pytest.raises(websockets.InvalidStatus):
        async with room_socket(chat_hubs.b,actors,cursor=99): pass

async def test_bounded_two_writer_burst_sixty_messages_polling_no_duplicates(chat_hubs, actors, tmp_path):
    import time
    async with room_socket(chat_hubs.a,actors) as reader, room_socket(chat_hubs.b,actors,'member') as member, room_socket(chat_hubs.b,actors,'agent') as agent:
        async with httpx.AsyncClient(trust_env=False) as client:
            assert (await client.post(chat_hubs.a.url+'/_test/listener/off')).status_code==200
        async def consume(ws):
            return [(await read(ws,'message',timeout=12))['message'] for _ in range(60)]
        readers=[asyncio.create_task(consume(ws)) for ws in [reader,member,agent]]
        start= time.monotonic()
        try:
            async def write(ws,prefix):
                for i in range(30): await send_chat(ws,prefix+str(i))
            await asyncio.gather(write(member,'human-'),write(agent,'agent-'))
            received=await asyncio.wait_for(asyncio.gather(*readers),15)
            elapsed=time.monotonic()-start
            for frames in received:
                assert [f['room_seq'] for f in frames]==list(range(1,61))
                assert len({f['id'] for f in frames})==60
                assert sum(f['sender_type']=='agent' for f in frames)==30
            assert [f['id'] for f in received[0]]==[f['id'] for f in received[1]]==[f['id'] for f in received[2]]
            (tmp_path/'bounded-load.json').write_text(json.dumps({'messages':60,'writers':2,'readers':3,
                'listener_on_receiver':False,'seconds':elapsed,'messages_per_second':60/elapsed}))
        finally:
            for task in readers:
                if not task.done(): task.cancel()
            await asyncio.gather(*readers,return_exceptions=True)
