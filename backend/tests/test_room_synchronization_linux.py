"""DB-owned room synchronization gates, on isolated SQLite or PostgreSQL."""
import asyncio
import time
from datetime import timedelta, datetime, timezone

import pytest
from sqlalchemy import select, update, delete, func
from conftest import test_session as sessions
from test_a2a_protocol_v1_linux import actors
from app.chat.models import Message
from app.chat.service import save_message
from app.chat.plaintext_guard import PlaintextStorageForbidden
from app.chat.room_synchronizer import RoomSynchronizer
from app.chat.delivery_service import aware
from app.models.room import Room
from app.models.room_presence import RoomPresence as Presence
from app.models.room_permission import RoomPermission
from app.models.room_share import RoomShareToken  # register table for isolated fixtures
from app.ws.connection_manager import ConnectionManager
from app.chat.task_reconciler import TaskReconciler
from app.chat.pg_wakeup import WakeupHint

pytestmark = pytest.mark.asyncio


class Socket:
    def __init__(self):
        self.frames, self.closed = [], False
    async def send_json(self, frame):
        self.frames.append(frame)
    async def close(self, code=1000, reason=""):
        self.closed = True


def worker(actors, user='owner', batch=50, ttl=30, manager=None, room_id=None, cid=None):
    manager = manager or ConnectionManager()
    ws = Socket()
    uid = actors.users[user].id
    channel = room_id or actors.room.id
    async def authorized():
        async with sessions() as db:
            room = await db.get(Room, channel)
            permission = (await db.execute(select(RoomPermission).where(
                RoomPermission.room_id == channel, RoomPermission.user_id == uid))).scalar_one_or_none()
            return bool(room and room.is_active and permission and permission.role in {'viewer','member','owner'})
    manager.set_authorization_check(ws, authorized)
    manager.register(ws, channel, uid, cid or str(__import__('uuid').uuid4()))
    sync = RoomSynchronizer(sessions, manager, batch=batch, ttl=ttl)
    return sync, manager, ws


async def insert(db, actors, count=1, **kw):
    rows = [Message(room_id=actors.room.id, sender_id=actors.users['owner'].id,
        sender_type='human', content=f'm-{i}', **kw) for i in range(count)]
    db.add_all(rows)
    await db.commit()
    return rows


def messages(ws):
    return [frame['message'] for frame in ws.frames if frame['type'] == 'message']


async def test_counter_is_scoped_monotonic_and_rollback_safe(db, actors):
    first = (await insert(db, actors))[0]
    assert first.room_seq == 1
    rolled = Message(room_id=actors.room.id, sender_id=first.sender_id, content='rollback')
    db.add(rolled); await db.flush(); assert rolled.room_seq == 2
    await db.rollback()
    await db.refresh(actors.room)
    await db.refresh(actors.users["owner"])
    await db.refresh(first)
    assert (await insert(db, actors))[0].room_seq == 2
    other = Room(name='other', transport='hub')
    db.add(other); await db.flush()
    msg = Message(room_id=other.id, sender_id=first.sender_id, content='independent')
    db.add(msg); await db.commit(); assert msg.room_seq == 1


async def test_pending_room_and_messages_share_one_transaction(db, actors):
    room = Room(id='new-transaction-room', name='new', transport='hub')
    db.add(room)
    rows = [Message(room_id=room.id, sender_id=actors.users['owner'].id, content=str(i)) for i in range(3)]
    db.add_all(rows); await db.commit()
    assert [r.room_seq for r in rows] == [1,2,3]
    assert room.message_seq == 3


async def test_cross_page_over_50_random_uuid_old_times_and_no_duplicate(db, actors):
    rows = await insert(db, actors, 73, created_at=datetime.now(timezone.utc)-timedelta(days=1))
    sync, manager, ws = worker(actors, batch=7)
    for _ in range(20):
        await sync.run_once()
    assert [m['id'] for m in messages(ws)] == [row.id for row in rows]
    assert [m['room_seq'] for m in messages(ws)] == list(range(1,74))
    for _ in range(20):
        sync.wake()
        await sync.run_once()
    assert len(messages(ws)) == 73
    await sync.stop()


async def test_long_lived_transaction_old_timestamp_is_discovered_after_many_scans(db, actors):
    sync, _, ws = worker(actors, batch=3)
    async with sessions() as delayed:
        # Establish transaction long before later writers. Sequence assigned at
        # flush under row lock, NOT on transaction start/created_at/UUID.
        await delayed.execute(select(Room.id))
        pending = Message(id='00000000-0000-4000-8000-000000000001', room_id=actors.room.id,
            sender_id=actors.users['owner'].id, content='late', created_at=datetime.now(timezone.utc)-timedelta(days=2))
        await insert(db, actors, 8)
        for _ in range(12):
            await sync.run_once()
        delayed.add(pending); await delayed.commit()
    await sync.run_once()
    assert [m['room_seq'] for m in messages(ws)] == list(range(1,10))
    assert messages(ws)[-1]['content'] == 'late'
    await sync.stop()


async def test_local_message_broadcast_uses_same_ordered_pipeline(db, actors):
    rows = await insert(db, actors, 3)
    sync, manager, ws = worker(actors)
    manager.room_sync = sync
    await manager.broadcast(actors.room.id, {'type':'message', 'message':rows[-1].to_dict()})
    assert messages(ws) == []
    await sync.run_once()
    assert [m['room_seq'] for m in messages(ws)] == [1,2,3]
    await sync.run_once(); assert len(messages(ws)) == 3
    await sync.stop()


async def test_cursor_reconnect_and_explicit_replay(db, actors):
    await insert(db, actors, 5)
    sync, _, ws = worker(actors)
    sync.set_cursor(ws, 3); await sync.run_once()
    assert [m['room_seq'] for m in messages(ws)] == [4,5]
    sync.set_cursor(ws, 0); await sync.run_once()
    assert [m['room_seq'] for m in messages(ws)] == [4,5,1,2,3,4,5]
    await sync.stop()


@pytest.mark.parametrize('change', ['revoke','inactive','delete'])
async def test_idle_revocation_closes_and_leaks_no_body(db, actors, change):
    sync, manager, ws = worker(actors, user='member')
    await sync.run_once()
    if change == 'revoke':
        await db.execute(delete(RoomPermission).where(RoomPermission.room_id==actors.room.id,
            RoomPermission.user_id==actors.users['member'].id))
    else:
        # Historical room FKs prevent physical deletion with messages/roles;
        # deletion API uses inactivity. No-room lookup is separately tested below.
        actors.room.is_active = False
    await db.commit(); await insert(db, actors)
    await sync.run_once()
    assert ws.closed and ws not in manager.online and not messages(ws)
    await sync.run_once()
    assert not (await db.execute(select(Presence).where(Presence.user_id==actors.users['member'].id))).scalars().all()
    await sync.stop()


async def test_every_outbound_frame_rechecks_permission(db, actors):
    await insert(db, actors, 3)
    sync, manager, ws = worker(actors)
    original = ws.send_json
    async def send(frame):
        await original(frame)
        if frame['type'] == 'message':
            async with sessions() as tx:
                await tx.execute(delete(RoomPermission).where(RoomPermission.room_id==actors.room.id,
                    RoomPermission.user_id==actors.users['owner'].id)); await tx.commit()
    ws.send_json = send
    await sync.run_once()
    assert len(messages(ws)) == 1 and ws.closed
    await sync.stop()


async def test_multitab_cross_hub_presence_aggregates_and_disconnect_is_owned(db, actors):
    a, ma, wa = worker(actors)
    b, mb, wb = worker(actors)
    await a.run_once(); await b.run_once(); await a.run_once()
    snapshot = wa.frames[-1]
    assert snapshot['online_count'] == 1
    assert snapshot['participants'][0]['connection_count'] == 2
    ma.disconnect(actors.room.id, wa); await a.run_once(); await b.run_once()
    snapshot = wb.frames[-1]
    assert snapshot['online_count'] == 1 and snapshot['participants'][0]['connection_count'] == 1
    await a.stop(); await b.stop()
    assert (await db.execute(select(func.count()).select_from(Presence))).scalar_one() == 0


async def test_expired_lease_never_resurrects_old_connection(db, actors):
    sync, _, ws = worker(actors, ttl=2)
    await sync.run_once()
    await db.execute(update(Presence).values(lease_until=func.current_timestamp())); await db.commit()
    sync.states[ws]['heartbeat'] = 0
    await sync.run_once()
    assert ws.closed
    assert (await db.execute(select(func.count()).select_from(Presence))).scalar_one() == 0
    await sync.stop()


async def test_other_hub_owner_cannot_renew_or_delete_connection(db, actors):
    a, _, wa = worker(actors)
    b, _, wb = worker(actors)
    await a.run_once(); await b.run_once()
    original = next(iter(a.leases))
    async with sessions() as tx:
        await tx.execute(update(Presence).where(Presence.connection_id==original).values(hub_id=b.hub_id))
        await tx.commit()
    a.states[wa]['heartbeat'] = 0; await a.run_once()
    assert wa.closed
    await a.stop()
    assert (await db.execute(select(Presence).where(Presence.connection_id==original))).scalar_one().hub_id == b.hub_id
    await b.stop()


async def test_stale_hub_reap_is_bounded_and_filters_revoked_users(db, actors):
    stamp = aware((await db.execute(select(func.current_timestamp()))).scalar_one())
    for i in range(125):
        db.add(Presence(connection_id=f'stale-{i}',hub_id='dead',room_id=actors.room.id,
            user_id=actors.users['member'].id,joined_at=stamp,last_seen_at=stamp,
            lease_until=stamp-timedelta(seconds=1)))
    await db.commit()
    sync, _, ws = worker(actors)
    await sync.run_once()
    assert (await db.execute(select(func.count()).select_from(Presence).where(Presence.hub_id=='dead'))).scalar_one() == 25
    assert ws.frames[-1]['online_count'] == 1
    await sync.run_once()
    assert (await db.execute(select(func.count()).select_from(Presence).where(Presence.hub_id=='dead'))).scalar_one() == 0
    await sync.stop()


async def test_xmtp_body_neither_written_nor_replayed(db, actors):
    actors.room.transport = 'xmtp'; await db.commit()
    with pytest.raises(PlaintextStorageForbidden):
        await save_message(db, actors.room.id, actors.users['owner'].id, content='forbidden')
    await db.rollback()
    # Simulated historical invalid data must never be replayed to XMTP sockets.
    await db.execute(Message.__table__.insert().values(id='historical-invalid',room_id=actors.room.id,
        room_seq=1,sender_id=actors.users['owner'].id,content='historical-invalid'))
    await db.commit()
    sync, _, ws = worker(actors); await sync.run_once()
    assert not messages(ws) and ws.frames[-1]['type']=='presence_snapshot'
    await sync.stop()


async def test_rest_stable_pagination_and_legacy_iso_no_late_skip(client, db, actors):
    rows = await insert(db, actors, 61, created_at=datetime.now(timezone.utc)-timedelta(days=2))
    cursor, found = 0, []
    while True:
        r = await client.get(f'/api/v1/rooms/{actors.room.id}/messages',
            params={'after_seq':cursor,'limit':7},headers=actors.headers['member'])
        assert r.status_code == 200, r.text
        value=r.json(); found.extend(value['messages']); cursor=value['next_cursor']
        if not value['has_more']: break
    assert [m['id'] for m in found] == [r.id for r in rows]
    r = await client.get(f'/api/v1/rooms/{actors.room.id}/messages',
        params={'after':datetime.now(timezone.utc).isoformat(),'limit':100}, headers=actors.headers['member'])
    assert len(r.json()['messages']) == 61 and r.json()['replay_mode']=='legacy_snapshot'


@pytest.mark.parametrize('params', [{'after':'garbage'}, {'after':'2026-01-01'}, {'after_seq':99}])
async def test_rest_invalid_cursors_rejected(client, actors, params):
    r=await client.get(f'/api/v1/rooms/{actors.room.id}/messages',params=params,headers=actors.headers['owner'])
    assert r.status_code==400


@pytest.mark.parametrize('actor', ['outsider','otheragent'])
async def test_rest_replay_authorization(client, db, actors, actor):
    if actor == 'otheragent':
        await db.execute(delete(RoomPermission).where(RoomPermission.room_id==actors.room.id,
            RoomPermission.user_id==actors.users[actor].id)); await db.commit()
    r=await client.get(f'/api/v1/rooms/{actors.room.id}/messages?after_seq=0',headers=actors.headers[actor])
    assert r.status_code==403 and 'content' not in r.text


async def test_shared_bus_hint_and_recovery_wake_both_workers(actors):
    sync, manager, _ = worker(actors)
    tasks=TaskReconciler(sessions,manager,'sqlite+aiosqlite:///unused',room_sync=sync)
    await tasks._on_hint(WakeupHint('room',actors.room.id))
    assert sync.event.is_set() and tasks.event.is_set()
    sync.event.clear(); await tasks._on_reconcile()
    assert sync.event.is_set() and len(sync.leases)==1
    assert not hasattr(sync,'wakeup')
    await tasks.stop(); await sync.stop()


async def test_lifecycle_stops_worker_and_releases_all_leases(actors):
    sync, manager, ws=worker(actors)
    sync.start()
    async with asyncio.timeout(2):
        while not sync.leases:
            await asyncio.sleep(.01)
    task=sync.task
    await sync.stop(); await sync.stop()
    assert task.done() and manager.room_sync is None
    async with sessions() as db:
        assert not (await db.execute(select(Presence).where(Presence.hub_id==sync.hub_id))).scalars().all()
        assert (await db.execute(select(func.count()).select_from(Presence))).scalar_one()==0

async def test_message_client_key_retry_deduplicates_and_conflict_rejected(db, actors):
    kwargs=dict(db=db,room_id=actors.room.id,sender_id=actors.users['owner'].id,
                content='one',client_message_id='stable-key')
    first=await save_message(**kwargs)
    second=await save_message(**kwargs)
    assert first.id==second.id and second.room_seq==1 and second.replayed
    with pytest.raises(ValueError,match='conflict'):
        await save_message(**{**kwargs,'content':'different'})
    await db.rollback()
    async with sessions() as tx:
        assert (await tx.execute(select(func.count()).select_from(Message))).scalar_one()==1


async def test_idempotency_key_is_room_and_sender_scoped(db, actors):
    first=await save_message(db,actors.room.id,actors.users['owner'].id,content='one',client_message_id='key')
    second=await save_message(db,actors.room.id,actors.users['member'].id,content='two',client_message_id='key')
    assert first.id!=second.id and second.room_seq==2


async def test_all_connections_are_rotated_in_bounded_batches(db, actors):
    sync, manager, first=worker(actors)
    sockets=[first]
    for _ in range(34):
        _, _, ws=worker(actors,manager=manager)
        sockets.append(ws)
    await insert(db,actors)
    await sync.run_once()
    assert sum(bool(messages(ws)) for ws in sockets)==16
    for _ in range(3): await sync.run_once()
    assert all(len(messages(ws))==1 for ws in sockets)
    assert len(sync.leases)==35
    await sync.stop()

async def test_absent_room_closes_idle_socket(db, actors):
    sync, _, ws=worker(actors)
    await sync.run_once()
    await db.execute(delete(Presence).where(Presence.room_id==actors.room.id))
    await db.execute(delete(RoomPermission).where(RoomPermission.room_id==actors.room.id))
    await db.execute(delete(Room).where(Room.id==actors.room.id)); await db.commit()
    await sync.run_once()
    assert ws.closed and not messages(ws)
    await sync.stop()


async def test_role_none_does_not_fall_back_to_viewer(client, db, actors):
    await db.execute(update(RoomPermission).where(RoomPermission.room_id==actors.room.id,
        RoomPermission.user_id==actors.users['member'].id).values(role='none')); await db.commit()
    r=await client.get(f'/api/v1/rooms/{actors.room.id}/messages?after_seq=0',headers=actors.headers['member'])
    assert r.status_code==403
    rooms=await client.get('/api/v1/rooms',headers=actors.headers['member'])
    assert rooms.json()['rooms']==[]


async def test_owner_delete_revokes_history_and_share_but_cannot_be_spoofed(client, db, actors):
    await insert(db,actors)
    share=await client.post(f'/api/v1/rooms/{actors.room.id}/share',json={},headers=actors.headers['owner'])
    assert share.status_code==200
    denied=await client.delete(f'/api/v1/rooms/{actors.room.id}',headers=actors.headers['member'])
    assert denied.status_code==403
    deleted=await client.delete(f'/api/v1/rooms/{actors.room.id}',headers=actors.headers['owner'])
    assert deleted.status_code==200
    assert (await client.get(f'/api/v1/rooms/{actors.room.id}/messages?after_seq=0',headers=actors.headers['member'])).status_code==403
    assert (await client.get('/api/v1/rooms/shared/'+share.json()['token']+'/messages')).status_code==404
    assert (await db.execute(select(func.count()).select_from(Message))).scalar_one()==1


async def test_cursor_reset_during_send_is_not_overwritten(db, actors):
    await insert(db,actors,3)
    sync, _, ws=worker(actors)
    original=ws.send_json
    changed=False
    async def send(frame):
        nonlocal changed
        await original(frame)
        if frame['type']=='message' and not changed:
            changed=True; sync.set_cursor(ws,0)
    ws.send_json=send
    await sync.run_once()
    assert sync.states[ws]['cursor']==0 and len(messages(ws))==1
    await sync.run_once()
    assert [m['room_seq'] for m in messages(ws)]==[1,1,2,3]
    await sync.stop()

async def test_current_db_transport_guard_blocks_xmtp_switch_during_save(db, actors, monkeypatch):
    from app.chat import service
    async def switch_after_initial_guard(session):
        await session.commit()
        async with sessions() as other:
            await other.execute(update(Room).where(Room.id==actors.room.id).values(transport='xmtp'))
            await other.commit()
    monkeypatch.setattr(service,'cleanup_expired_messages',switch_after_initial_guard)
    with pytest.raises(PlaintextStorageForbidden):
        await service.save_message(db,actors.room.id,actors.users['owner'].id,content='must-not-persist')
    await db.rollback()
    async with sessions() as checked:
        assert (await checked.execute(select(func.count()).select_from(Message))).scalar_one()==0
        assert (await checked.execute(select(Room.message_seq))).scalar_one()==0


async def test_room_updated_reports_current_role_and_metadata(db, actors):
    sync, _, ws=worker(actors,user='member')
    await sync.run_once()
    await db.execute(update(RoomPermission).where(RoomPermission.room_id==actors.room.id,
        RoomPermission.user_id==actors.users['member'].id).values(role='viewer'))
    actors.room.name='renamed'; await db.commit()
    await sync.run_once()
    updates=[frame for frame in ws.frames if frame['type']=='room_updated']
    assert updates[-1]['role']=='viewer' and updates[-1]['room']['name']=='renamed'
    await sync.stop()


async def test_remote_presence_agent_discovery_is_room_scoped(db, actors, monkeypatch):
    from app.chat import ws_handler
    sync, manager, ws=worker(actors,user='agent')
    await sync.run_once()
    monkeypatch.setattr(ws_handler.connection_manager,'room_sync',sync)
    assert 'agent' in await ws_handler._get_active_agent_names(actors.room.id)
    assert 'agent' not in await ws_handler._get_active_agent_names('unrelated-room')
    await sync.stop()

async def test_stop_clears_exact_own_hub_connections_and_preserves_live_other_hub(db, actors):
    sync, manager, one=worker(actors)
    _, _, two=worker(actors,manager=manager)
    other, _, foreign=worker(actors,user='member')
    await sync.run_once(); await other.run_once()
    own_ids=set(sync.leases); foreign_ids=set(other.leases)
    assert len(own_ids)==2 and len(foreign_ids)==1
    await sync.stop()
    async with sessions() as checked:
        rows=(await checked.execute(select(Presence))).scalars().all()
        assert not any(row.hub_id==sync.hub_id or row.connection_id in own_ids for row in rows)
        assert {row.connection_id for row in rows}==foreign_ids
        assert all(row.hub_id==other.hub_id for row in rows)
    await other.stop()
    assert (await db.execute(select(func.count()).select_from(Presence))).scalar_one()==0


async def test_cancelled_scan_waits_for_session_close_before_return(actors):
    sync, _, ws=worker(actors)
    leased=sessions()
    original_close=leased.close
    entered, release, closed=asyncio.Event(),asyncio.Event(),asyncio.Event()
    async def slow_close():
        entered.set()
        await release.wait()
        await original_close()
        closed.set()
    leased.close=slow_close
    sync.sessions=lambda:leased
    task=asyncio.create_task(sync.run_once())
    try:
        await asyncio.wait_for(entered.wait(),2)
        task.cancel(); await asyncio.sleep(.01)
        assert not task.done() and not closed.is_set()
        release.set()
        with pytest.raises(asyncio.CancelledError): await task
        assert closed.is_set()
    finally:
        release.set()
        await asyncio.gather(task,return_exceptions=True)
        await original_close()


async def test_repeated_lifespan_stop_has_zero_own_leases_and_no_orphan_tasks(actors):
    for _ in range(20):
        sync, _, ws=worker(actors)
        sync.start()
        async with asyncio.timeout(3):
            while not sync.leases: await asyncio.sleep(.002)
        cid=next(iter(sync.leases)); hub_id=sync.hub_id; task=sync.task
        await sync.stop()
        async with sessions() as checked:
            assert not (await checked.execute(select(Presence).where(
                (Presence.hub_id==hub_id) | (Presence.connection_id==cid)))).scalars().all()
        assert task.done()
    assert not [task for task in asyncio.all_tasks() if task.get_name()=='room-reconciliation' and not task.done()]

async def test_shutdown_cleans_own_lease_if_worker_was_already_cancelled(actors):
    sync, _, ws=worker(actors)
    sync.start()
    async with asyncio.timeout(3):
        while not sync.leases: await asyncio.sleep(.002)
    hub=sync.hub_id
    sync.task.cancel(); await asyncio.gather(sync.task,return_exceptions=True)
    await sync.stop()
    async with sessions() as checked:
        assert not (await checked.execute(select(Presence).where(Presence.hub_id==hub))).scalars().all()
