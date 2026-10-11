"""Crash recovery uses synthetic SQL state and no production services."""
import asyncio
from datetime import timedelta
import pytest
from sqlalchemy import select, update
from conftest import test_session as session_factory
from app.chat import delivery_service as ds
from app.chat.delivery_sweeper import DeliverySweeper
from app.a2a.models import A2ATask
from app.a2a.task_service import TaskService
from app.models.agent_task_delivery import AgentTaskDelivery as Delivery
from app.models.room_permission import RoomPermission
from app.ws.connection_manager import connection_manager
from test_ws_reliable_delivery_linux import setup_delivery, rollback_restore

async def expired(db):
    values = await setup_delivery(db)
    agent, delivery, raw = values[2], values[6], values[7]
    await ds.control(db, agent.id, 'dead-runner', raw)
    await db.execute(update(Delivery).where(Delivery.delivery_id == delivery.delivery_id).values(
        lease_until=ds.now()-timedelta(seconds=2)))
    await db.commit()
    return values

@pytest.mark.asyncio
async def test_sweeper_fences_killed_runner_without_resume_or_current_permission(db, monkeypatch):
    owner, _, agent, _, _, task, delivery, raw = await expired(db)
    await db.execute(update(RoomPermission).where(RoomPermission.user_id == owner.id).values(role='viewer'))
    await db.commit()
    sent=[]
    async def broadcast(channel, frame):
        async with session_factory() as observer:
            assert (await observer.get(Delivery, delivery.delivery_id)).state == 'uncertain'
            assert (await observer.get(A2ATask, task.id)).status == 'input_required'
        sent.append((channel,frame))
    monkeypatch.setattr(connection_manager,'broadcast',broadcast)
    sweeper=DeliverySweeper(session_factory)
    assert await sweeper.run_once() == 1
    assert await sweeper.run_once() == 0
    assert sent[0][0] == '_agent_delivery_bot' and sent[0][1]['type']=='task_uncertain'
    events=await TaskService.get_task_events(db,task.id)
    assert sum(e.event_type=='delivery_uncertain' for e in events)==1
    assert [e.event_seq for e in events]==list(range(1,len(events)+1))

@pytest.mark.asyncio
async def test_two_sweepers_single_durable_winner(db):
    _, _, _, _, _, task, delivery, _ = await expired(db)
    workers=[DeliverySweeper(session_factory),DeliverySweeper(session_factory)]
    results=await asyncio.wait_for(asyncio.gather(*(worker.run_once() for worker in workers)),10)
    assert sum(results)==1
    assert (await db.get(Delivery,delivery.delivery_id,populate_existing=True)).state=='uncertain'
    assert (await db.get(A2ATask,task.id,populate_existing=True)).status=='input_required'
    assert sum(e.event_type=='delivery_uncertain' for e in await TaskService.get_task_events(db,task.id))==1

@pytest.mark.asyncio
@pytest.mark.parametrize('winner',['renewal','cancel','completion'])
async def test_sweeper_rechecks_current_state_after_candidate_selection(db, winner):
    _, _, _, _, _, task, delivery, _ = await expired(db)
    did,tid=delivery.delivery_id,task.id
    async with session_factory() as concurrent:
        if winner=='renewal':
            await concurrent.execute(update(Delivery).where(Delivery.delivery_id==did).values(lease_until=ds.now()+timedelta(seconds=60)))
        elif winner=='cancel':
            await TaskService.cancel_task(concurrent,tid)
            await ds.cancel_deliveries(concurrent,tid)
        else:
            await TaskService.complete_task(concurrent,tid,[{'text':'already done'}])
            await concurrent.execute(update(Delivery).where(Delivery.delivery_id==did).values(state='completed'))
        await concurrent.commit()
    assert await ds.expire_delivery(db,did) is None
    await db.commit()
    assert not any(e.event_type=='delivery_uncertain' for e in await TaskService.get_task_events(db,tid))

@pytest.mark.asyncio
async def test_sweeper_bounded_batch_and_eventual_drain(db):
    _, _, agent, _, room, first, _, _ = await expired(db)
    for _ in range(51):
        task,_=await TaskService.create_task(db,query='synthetic',target_agent=agent.username,
            room_id=room.id,source_message_id=first.source_message_id,initial_status='working')
        db.add(Delivery(task_id=task.id,message_id=first.source_message_id,agent_user_id=agent.id,
            target_room=room.id,state='acked',attempt=1,lease_owner='dead',ack_at=ds.now(),
            lease_until=ds.now()-timedelta(seconds=1)))
    await db.commit()
    worker=DeliverySweeper(session_factory)
    assert await worker.run_once()==50
    assert await worker.run_once()==2
    assert await worker.run_once()==0
    with pytest.raises(ValueError): await worker.run_once(51)

@pytest.mark.asyncio
async def test_expiry_event_failure_rolls_back_state_and_no_notification(db,monkeypatch):
    _, _, _, _, _, task, delivery, _ = await expired(db)
    async def fail(*args,**kwargs): raise RuntimeError('synthetic audit failure')
    monkeypatch.setattr(ds,'_append_event',fail)
    with pytest.raises(RuntimeError): await DeliverySweeper(session_factory).run_once()
    assert (await db.get(Delivery,delivery.delivery_id,populate_existing=True)).state=='acked'
    assert (await db.get(A2ATask,task.id,populate_existing=True)).status=='working'

@pytest.mark.asyncio
async def test_background_timeout_retry_start_idempotence_and_shutdown(monkeypatch):
    worker=DeliverySweeper(session_factory,interval=.005,pass_timeout=.01)
    attempts=[];cancelled=asyncio.Event();retried=asyncio.Event()
    async def scan():
        attempts.append(1)
        if len(attempts)==1:
            try: await asyncio.Future()
            finally: cancelled.set()
        retried.set()
    monkeypatch.setattr(worker,'run_once',scan)
    first=worker.start()
    assert worker.start() is first
    await asyncio.wait_for(retried.wait(),1)
    await asyncio.wait_for(worker.stop(),1)
    assert cancelled.is_set() and first.done() and worker.task is None
    await worker.stop()

@pytest.mark.asyncio
async def test_application_lifespan_starts_and_stops_sweeper(monkeypatch):
    from app import main
    initialized=[]
    async def init(): initialized.append(True)
    monkeypatch.setattr(main,'init_db',init)
    monkeypatch.setattr(main,'async_session',session_factory)
    async with main.lifespan(main.app):
        worker=main.app.state.delivery_sweeper
        running=worker.task
        assert initialized==[True] and running is not None
        await asyncio.sleep(0)
    assert running.done() and worker.task is None

@pytest.mark.asyncio
async def test_expired_execution_cannot_renew_or_finish_after_sweep(db):
    _, _, agent, _, _, task, delivery, raw = await expired(db)
    assert await DeliverySweeper(session_factory).run_once()==1
    for operation in ['renew','finish']:
        with pytest.raises(ds.DeliveryDenied):
            if operation=='renew':
                await ds.control(db,agent.id,'dead-runner',{**raw,'type':'task_lease'})
            else:
                await ds.finish(db,agent.id,'dead-runner',raw,'late forbidden output','report')
        await rollback_restore(db)
    assert (await db.get(A2ATask,task.id,populate_existing=True)).result is None
