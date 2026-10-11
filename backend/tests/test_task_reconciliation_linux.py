"""Cyclic discovery has no global commit cursor; active attempts never change."""
import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import select, update
from conftest import test_session as sessions
from test_ws_reliable_delivery_linux import setup_delivery
from app.chat import delivery_service as ds
from app.chat.task_reconciler import TaskReconciler
from app.chat.pg_wakeup import PgWakeup
from app.ws.connection_manager import ConnectionManager
from app.models.agent_task_delivery import AgentTaskDelivery as Delivery
from app.a2a.models import A2ATask
from app.a2a.task_service import TaskService, _append_event
from app.models.room_permission import RoomPermission


class Socket:
    def __init__(self):
        self.frames = []
        self.closed = False
    async def send_json(self, frame):
        self.frames.append(frame)
    async def close(self, code):
        self.closed = True


def worker(agent, channel=None, authorize=True, batch=50):
    manager = ConnectionManager()
    ws = Socket()
    async def check():
        return authorize
    manager.set_authorization_check(ws, check)
    manager.register(ws, channel or '_agent_delivery_bot', agent.id, 'connection')
    recon = TaskReconciler(sessions, manager, 'sqlite+aiosqlite:///unused', batch=batch)
    return recon, manager, ws


@pytest.mark.asyncio
async def test_repeated_wakes_keep_attempt_and_accept_original_ack(db):
    _, _, agent, _, _, _, delivery, raw = await setup_delivery(db)
    recon, _, ws = worker(agent)
    for _ in range(25):
        await recon.run_once()
    await db.refresh(delivery)
    assert delivery.attempt == 1
    assert len(ws.frames) == 1
    assert (await ds.control(db, agent.id, 'connection', raw))['accepted']
    await db.commit()
    assert await recon.run_once() == 0


@pytest.mark.asyncio
async def test_expired_pending_offer_repaired_once(db):
    _, _, agent, _, _, _, delivery, _ = await setup_delivery(db)
    delivery.delivered_at = ds.now() - timedelta(seconds=61)
    await db.commit()
    a, _, wa = worker(agent)
    b, _, wb = worker(agent)
    await a.run_once()
    await b.run_once()
    await db.refresh(delivery)
    assert delivery.attempt == 2
    assert wa.frames[0]['attempt'] == wb.frames[0]['attempt'] == 2


@pytest.mark.asyncio
async def test_pagination_over_50_and_late_lower_uuid(db):
    _, _, agent, _, room, initial, delivery, _ = await setup_delivery(db)
    delivery.delivery_id = 'f0000000-0000-4000-8000-000000000000'
    await db.commit()
    recon, _, ws = worker(agent, batch=10)
    await recon.run_once()
    # Insert below the already consumed UUID. Every pass resets to empty.
    for n in range(55):
        task, _ = await TaskService.create_task(db, query='bounded', target_agent=agent.username,
            room_id=room.id, source_message_id=initial.source_message_id)
        row = await ds.create_delivery(db, task, agent.id)
        row.delivery_id = f'10000000-0000-4000-8000-{n:012d}'
        await ds.offer(db, row)
    await db.commit()
    for _ in range(10):
        await recon.run_once()
    assert len({f['delivery_id'] for f in ws.frames}) == 56
    assert all(f['attempt'] == 1 for f in ws.frames)
    assert all(r.attempt == 1 for r in (await db.execute(select(Delivery))).scalars())


@pytest.mark.parametrize('cursor', ['garbage', 'a'*36, '../etc/passwd', '0'*37, 1, [], {}, None])
@pytest.mark.asyncio
async def test_invalid_legacy_cursor_denied(db, cursor):
    _, _, agent, *_ = await setup_delivery(db)
    with pytest.raises(ds.DeliveryDenied):
        await ds.resume(db, agent.id, cursor)


@pytest.mark.asyncio
async def test_valid_legacy_uuid_cursor_remains_accepted(db):
    _, _, agent, *_ = await setup_delivery(db)
    frames, cursor = await ds.resume(db, agent.id, '00000000-0000-0000-0000-000000000000')
    assert frames and cursor is None


@pytest.mark.asyncio
async def test_cancel_compensation_without_local_broadcast(db):
    _, _, agent, _, _, task, _, _ = await setup_delivery(db)
    await TaskService.cancel_task(db, task.id)
    await ds.cancel_deliveries(db, task.id)
    await db.commit()
    recon, _, ws = worker(agent)
    await recon.run_once()
    assert ws.frames[0]['type'] == 'task_cancel'


@pytest.mark.asyncio
async def test_room_state_and_persisted_progress_compensation(db):
    owner, _, _, _, room, task, _, _ = await setup_delivery(db)
    await _append_event(db, task.id, 'task_progress', {'phase': 'running', 'percent': 42})
    await db.commit()
    recon, _, ws = worker(owner, channel=room.id)
    await recon.run_once()
    assert [f['type'] for f in ws.frames] == ['task_update', 'task_progress']
    assert ws.frames[1]['percent'] == 42
    assert 'query' not in ws.frames[0]['task']
    await TaskService.cancel_task(db, task.id)
    await db.commit()
    await recon.run_once()
    assert ws.frames[-1]['task']['status'] == 'canceled'


@pytest.mark.asyncio
async def test_live_authorization_denial_closes_and_never_sends(db):
    _, _, agent, *_ = await setup_delivery(db)
    recon, manager, ws = worker(agent, authorize=False)
    await recon.run_once()
    assert not ws.frames and ws.closed and not manager.online


@pytest.mark.asyncio
async def test_source_permission_revocation_blocks_agent_replay(db):
    owner, _, agent, _, room, *_ = await setup_delivery(db)
    await db.execute(update(RoomPermission).where(RoomPermission.room_id == room.id,
        RoomPermission.user_id == owner.id).values(role='viewer'))
    await db.commit()
    recon, _, ws = worker(agent)
    assert await recon.run_once() == 0 and not ws.frames


@pytest.mark.asyncio
async def test_ack_expiry_is_uncertain_never_reoffered(db):
    _, _, agent, _, _, task, delivery, raw = await setup_delivery(db)
    await ds.control(db, agent.id, 'connection', raw)
    await db.commit()
    delivery.lease_until = ds.now() - timedelta(seconds=1)
    await db.commit()
    await ds.expire_delivery(db, delivery.delivery_id)
    await db.commit()
    recon, _, ws = worker(agent)
    await recon.run_once()
    await db.refresh(delivery)
    assert ws.frames[0]['type'] == 'task_uncertain' and delivery.attempt == 1


@pytest.mark.asyncio
async def test_sqlite_lifecycle_disconnect_cleans_state(db):
    _, _, agent, *_ = await setup_delivery(db)
    recon, manager, ws = worker(agent)
    recon.start()
    await asyncio.sleep(.1)
    assert len(recon.wakeup._tasks) == 1 and not recon.listener_ready
    manager.disconnect('_agent_delivery_bot', ws)
    await recon.run_once()
    assert not recon.cursors and not recon.sent
    await recon.stop()
    assert not recon.tasks and manager.on_change is None


@pytest.mark.parametrize('batch', [0, 51, -1])
def test_batch_bounds(batch):
    with pytest.raises(ValueError):
        TaskReconciler(None, ConnectionManager(), 'sqlite:///unused', batch=batch)

from conftest import engine as test_engine
import asyncpg

pg_only = pytest.mark.skipif(test_engine.dialect.name != 'postgresql', reason='isolated PG17 gate')

async def pg_connection():
    url = test_engine.url.set(drivername='postgresql').render_as_string(hide_password=False)
    return await asyncpg.connect(url)


@pg_only
@pytest.mark.asyncio
async def test_pg_notify_commit_only_and_identifier_payload(db):
    _, _, _, _, _, task, *_ = await setup_delivery(db)
    listener = await pg_connection()
    notices = []
    await listener.add_listener('mapr_wakeup_v1', lambda _, pid, channel, payload: notices.append(payload))
    try:
        await _append_event(db, task.id, 'probe', {'secret': 'must never notify'})
        await asyncio.sleep(.05)
        assert notices == []
        await db.rollback()
        await asyncio.sleep(.05)
        assert notices == []
        tid = (await db.execute(select(A2ATask.id))).scalar_one()
        await _append_event(db, tid, 'probe', {'private_body': 'not in payload'})
        await _append_event(db, tid, 'probe2')
        await db.commit()
        await asyncio.sleep(.1)
        assert len(notices) == 1
        import json
        assert json.loads(notices[0]) == {"v": 1, "kind": "room", "id": (await db.get(A2ATask, tid)).room_id}  # PostgreSQL folds duplicate hints in one transaction.
    finally:
        await listener.close()


@pg_only
@pytest.mark.asyncio
async def test_pg_reverse_transaction_commit_discovered_next_full_pass(db):
    _, _, agent, _, room, initial, *_ = await setup_delivery(db)
    agent_id, username, room_id, source_id = agent.id, agent.username, room.id, initial.source_message_id
    recon, _, ws = worker(agent, batch=1)
    async with sessions() as first, sessions() as second:
        t1, _ = await TaskService.create_task(first, query='first transaction', target_agent=username,
            room_id=room_id, source_message_id=source_id)
        d1 = await ds.create_delivery(first, t1, agent_id)
        d1.delivery_id = '00000000-0000-4000-8000-000000000001'
        await ds.offer(first, d1)
        t2, _ = await TaskService.create_task(second, query='commits first', target_agent=username,
            room_id=room_id, source_message_id=source_id)
        d2 = await ds.create_delivery(second, t2, agent_id)
        d2.delivery_id = 'eeeeeeee-0000-4000-8000-000000000002'
        await ds.offer(second, d2)
        await second.commit()
        for _ in range(4):
            await recon.run_once()
        assert d1.delivery_id not in {f['delivery_id'] for f in ws.frames}
        await first.commit()  # Late COMMIT behind every currently consumed UUID.
    for _ in range(6):
        await recon.run_once()
    assert {d1.delivery_id, d2.delivery_id} <= {f['delivery_id'] for f in ws.frames}
    assert all(f['attempt'] == 1 for f in ws.frames)


@pg_only
@pytest.mark.asyncio
async def test_pg_listener_reconnect_and_stop(db):
    _, _, agent, *_ = await setup_delivery(db)
    recon, manager, _ = worker(agent)
    recon.database_url = test_engine.url.render_as_string(hide_password=False)
    recon.wakeup = PgWakeup(recon.database_url, reconcile_interval=.1)
    recon.start()
    try:
        async with asyncio.timeout(4):
            while not recon.listener_ready:
                await asyncio.sleep(.02)
        old = recon.wakeup._connection
        old.terminate()
        async with asyncio.timeout(6):
            while recon.wakeup._connection is old or not recon.listener_ready:
                await asyncio.sleep(.05)
        assert recon.wakeup._connection is not old and not recon.wakeup._connection.is_in_transaction()
        current = recon.wakeup._connection
    finally:
        await recon.stop()
    assert current.is_closed() and not recon.tasks and manager.on_change is None


@pg_only
@pytest.mark.asyncio
async def test_pg_two_workers_repair_one_expired_attempt(db):
    _, _, agent, _, _, _, row, _ = await setup_delivery(db)
    row.delivered_at = ds.now() - timedelta(seconds=61)
    await db.commit()
    a, _, _ = worker(agent)
    b, _, _ = worker(agent)
    results = await asyncio.gather(a._repair_offer(row.delivery_id, 1), b._repair_offer(row.delivery_id, 1))
    await db.refresh(row)
    assert sum(result is not None for result in results) == 1 and row.attempt == 2

@pytest.mark.asyncio
async def test_snapshot_upper_bound_excludes_concurrent_higher_insert_until_fresh_scan(db):
    _, _, agent, _, room, original, row, _ = await setup_delivery(db)
    row.delivery_id = '10000000-0000-4000-8000-000000000000'
    await db.commit()
    for n in range(1, 51):
        task, _ = await TaskService.create_task(db, query='snapshot', target_agent=agent.username,
            room_id=room.id, source_message_id=original.source_message_id)
        delivery = await ds.create_delivery(db, task, agent.id)
        delivery.delivery_id = f'10000000-0000-4000-8000-{n:012d}'
    await db.commit()
    first, cursor = await ds.resume(db, agent.id)
    await db.commit()
    assert len(first) == 50 and cursor.startswith('snap1:')
    task, _ = await TaskService.create_task(db, query='new higher id', target_agent=agent.username,
        room_id=room.id, source_message_id=original.source_message_id)
    new = await ds.create_delivery(db, task, agent.id)
    new.delivery_id = 'f0000000-0000-4000-8000-000000000001'
    await db.commit()
    second, end = await ds.resume(db, agent.id, cursor)
    await db.commit()
    assert len(second) == 1 and end is None and second[0]['delivery_id'] != new.delivery_id
    fresh, next_cursor = await ds.resume(db, agent.id, '')
    tail, end = await ds.resume(db, agent.id, next_cursor)
    assert new.delivery_id in {frame['delivery_id'] for frame in fresh + tail}


@pytest.mark.asyncio
async def test_snapshot_cursor_cannot_switch_authenticated_agent(db):
    import base64, json
    _, _, agent, _, _, _, row, _ = await setup_delivery(db)
    forged = 'snap1:' + base64.urlsafe_b64encode(json.dumps({'agent':'other-agent',
        'after':row.delivery_id,'upper':row.delivery_id}).encode()).decode()
    with pytest.raises(ds.DeliveryDenied):
        await ds.resume(db, agent.id, forged)

@pytest.mark.asyncio
async def test_revocation_denies_execution_but_allows_original_executor_cancel_cleanup(db):
    owner, _, agent, _, room, task, row, raw = await setup_delivery(db)
    await ds.control(db, agent.id, 'connection', raw)
    await db.commit()
    await db.execute(update(RoomPermission).where(RoomPermission.room_id == room.id,
        RoomPermission.user_id == owner.id).values(role='viewer'))
    await TaskService.cancel_task(db, task.id)
    await ds.cancel_deliveries(db, task.id)
    await db.commit()
    recon, _, ws = worker(agent)
    await recon.run_once()
    assert ws.frames == [{'v':1,'type':'task_cancel','task_id':task.id,'delivery_id':row.delivery_id,
        'attempt':1,'origin_room':room.id}]
    agent_id = agent.id
    with pytest.raises(ds.DeliveryDenied):
        await ds.control(db, agent_id, 'different-connection', {**raw, 'type':'task_cancel_ack'})
    await db.rollback()
    result = await ds.control(db, agent_id, 'connection', {**raw, 'type':'task_cancel_ack'})
    assert result['accepted']
    await db.commit()
