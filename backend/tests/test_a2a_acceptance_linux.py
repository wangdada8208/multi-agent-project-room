"""Stage-four acceptance of standard binding and real loopback interoperability."""
import asyncio
import json
import socket
import uuid
from unittest.mock import AsyncMock
import httpx
import pytest
from google.protobuf.json_format import ParseDict
from sqlalchemy import select, update
from starlette.applications import Starlette
from a2a.server.routes.jsonrpc_routes import create_jsonrpc_routes
from a2a.types import a2a_pb2 as pb
from app.a2a import http_protocol as protocol, server
from app.a2a.task_service import TaskService
from app.chat import delivery_service as ds
from app.chat.models import Message
from app.models.agent_task_delivery import AgentTaskDelivery as Delivery
from app.models.room_permission import RoomPermission
from app.ws.connection_manager import connection_manager
from conftest import test_session as session_factory
from test_a2a_protocol_v1_linux import actors, isolated_sse_lifecycle, message, send

@pytest.mark.asyncio
@pytest.mark.parametrize('rest',[False,True])
@pytest.mark.parametrize('outcome',['completed','canceled','input_required'])
async def test_default_blocking_send_waits_for_actual_terminal_or_interrupted(client,db,actors,monkeypatch,rest,outcome):
    dispatched=asyncio.Event();frames=[]
    async def broadcast(channel,frame):
        frames.append(frame)
        dispatched.set()
    monkeypatch.setattr(connection_manager,'broadcast',broadcast)
    monkeypatch.setattr(protocol,'POLL_SECONDS',.005)
    params=message(actors);params.pop('configuration')
    request=asyncio.create_task(client.post('/a2a/message:send' if rest else '/a2a/rpc',headers=actors.headers['owner'],
        json=params if rest else {'jsonrpc':'2.0','method':'SendMessage','params':params,'id':'blocking'}))
    await asyncio.wait_for(dispatched.wait(),2)
    assert not request.done()
    tid=frames[0]['task_id']
    if outcome=='completed': await TaskService.complete_task(db,tid,[{'text':'verified final reply'}])
    elif outcome=='canceled': await TaskService.cancel_task(db,tid)
    else: await TaskService.pause_task(db,tid,'owner review')
    await db.commit()
    reply=await asyncio.wait_for(request,2)
    value=reply.json() if rest else reply.json()['result']
    task=ParseDict(value,pb.SendMessageResponse()).task
    assert task.status.state=={'completed':pb.TASK_STATE_COMPLETED,'canceled':pb.TASK_STATE_CANCELED,
                              'input_required':pb.TASK_STATE_INPUT_REQUIRED}[outcome]
    if outcome=='completed': assert task.artifacts[0].parts[0].text=='verified final reply'

@pytest.mark.asyncio
async def test_blocking_deadline_reports_persisted_task_without_false_success(client,actors,monkeypatch):
    monkeypatch.setattr(protocol,'BLOCKING_SECONDS',.01)
    monkeypatch.setattr(protocol,'POLL_SECONDS',.005)
    params=message(actors);params.pop('configuration')
    reply=await client.post('/a2a/rpc',headers=actors.headers['owner'],json={'jsonrpc':'2.0','method':'SendMessage','params':params,'id':1})
    assert reply.json()['error']['code']==-32603 and 'result' not in reply.json()
    # Task stays inspectable; timeout never rolls back a committed dispatch.
    tasks=(await client.get('/a2a/tasks',headers=actors.headers['owner'])).json()['tasks']
    assert len(tasks)==1 and tasks[0]['status']['state']=='TASK_STATE_SUBMITTED'

@pytest.mark.asyncio
@pytest.mark.parametrize('body,code',[
    ('{',-32700),('[]',-32600),
    ({'jsonrpc':'1.0','id':7,'method':'ListTasks'},-32600),
    ({'jsonrpc':'2.0','id':7,'method':'Unknown'},-32601),
    ({'jsonrpc':'2.0','id':7,'method':'GetTask','params':[]},-32602),
    ({'jsonrpc':'2.0','id':7,'method':'GetTask','params':{}},-32602),
    ({'jsonrpc':'2.0','id':7,'method':'SendMessage','params':{'badField':'private-sentinel'}},-32602),
])
async def test_jsonrpc_error_envelope_does_not_expose_untrusted_input(client,actors,body,code):
    kwargs={'content':body} if isinstance(body,str) else {'json':body}
    reply=await client.post('/a2a/rpc',headers=actors.headers['owner'],**kwargs)
    assert reply.status_code==200 and reply.json()['error']['code']==code
    assert reply.json()['jsonrpc']=='2.0' and 'private-sentinel' not in reply.text

@pytest.mark.asyncio
@pytest.mark.parametrize('rest',[False,True])
async def test_version_push_continuation_errors_and_no_orphan_tasks(client,db,actors,rest):
    async def request(params,headers=None):
        return await client.post('/a2a/message:send' if rest else '/a2a/rpc',headers=headers or actors.headers['owner'],
            json=params if rest else {'jsonrpc':'2.0','method':'SendMessage','params':params,'id':5})
    params=message(actors)
    reply=await request(params,{**actors.headers['owner'],'A2A-Version':'0.3'})
    assert (reply.status_code==400 and reply.json()['error']['status']=='FAILED_PRECONDITION') if rest else reply.json()['error']['code']==-32009
    params['configuration']['taskPushNotificationConfig']={'url':'http://127.0.0.1/private'}
    reply=await request(params)
    assert (reply.status_code==400) if rest else reply.json()['error']['code']==-32003
    params=message(actors);params['message']['taskId']='existing-task'
    reply=await request(params)
    assert (reply.status_code==400) if rest else reply.json()['error']['code']==-32004
    assert not list((await db.execute(select(Delivery))).scalars())

@pytest.mark.asyncio
@pytest.mark.parametrize('rest',[False,True])
async def test_stream_first_snapshot_cursor_terminal_rules_and_slot_release(client,db,actors,rest):
    tid=await send(client,actors)
    await TaskService.cancel_task(db,tid);await db.commit()
    async def request(cursor=False):
        headers={**actors.headers['viewer'],**({'Last-Event-ID':'2'} if cursor else {})}
        return await client.get('/a2a/tasks/'+tid+':subscribe',headers=headers) if rest else await client.post('/a2a/rpc',headers=headers,
            json={'jsonrpc':'2.0','method':'SubscribeToTask','params':{'id':tid},'id':3})
    refused=await request()
    assert refused.status_code==400 if rest else refused.json()['error']['code']==-32004
    replay=await request(True)
    frames=[json.loads(line[6:]) for line in replay.text.splitlines() if line.startswith('data: ')]
    first=ParseDict(frames[0] if rest else frames[0]['result'],pb.StreamResponse())
    assert first.WhichOneof('payload')=='task' and first.task.status.state==pb.TASK_STATE_CANCELED
    assert [line for line in replay.text.splitlines() if line.startswith('id: ')]==['id: 3']
    assert protocol._streams=={}

@pytest.mark.asyncio
async def test_stream_interrupt_and_permission_revoke_release_slots(client,db,actors,monkeypatch):
    monkeypatch.setattr(protocol,'POLL_SECONDS',.005)
    monkeypatch.setattr(protocol,'STREAM_SECONDS',1)
    tid=await send(client,actors)
    async def revoke():
        await asyncio.sleep(.02)
        await db.execute(update(RoomPermission).where(RoomPermission.user_id==actors.users['viewer'].id).values(role='none'))
        await db.commit()
    revoker=asyncio.create_task(revoke())
    reply=await asyncio.wait_for(client.get('/a2a/tasks/'+tid+':subscribe',headers=actors.headers['viewer']),2)
    await revoker
    assert 'event: error' in reply.text and 'public task' not in reply.text and protocol._streams=={}
    await TaskService.pause_task(db,tid,'review');await db.commit()
    reply=await asyncio.wait_for(client.get('/a2a/tasks/'+tid+':subscribe',headers=actors.headers['owner']),2)
    assert 'TASK_STATE_INPUT_REQUIRED' in reply.text and protocol._streams=={}

@pytest.mark.asyncio
async def test_global_stream_quota_and_failed_send_release_slot(client,actors,monkeypatch):
    tid=await send(client,actors)
    leases = []
    for i in range(protocol.MAX_STREAMS):
        async with protocol.sessions() as quota_db:
            leases.append(await protocol.quota_policy.acquire(quota_db, 'other-account-'+str(i), tid, protocol.HUB_ID))
    reply=await client.get('/a2a/tasks/'+tid+':subscribe',headers=actors.headers['owner'])
    assert reply.status_code==429
    for lease in leases:
        async with protocol.sessions() as quota_db:
            await protocol.quota_policy.release(quota_db, lease.lease_id, protocol.HUB_ID)
    async def fail(*args,**kwargs): raise RuntimeError('synthetic safe failure')
    # Streaming guard must release an acquired slot even before generator startup.
    from app.a2a.http_protocol import SQLRequestHandler
    monkeypatch.setattr(SQLRequestHandler,'on_message_send',fail)
    reply = await client.post('/a2a/message:stream',headers=actors.headers['owner'],json=message(actors))
    assert reply.status_code == 500
    assert 'synthetic safe failure' not in reply.text
    assert protocol._streams=={}

@pytest.mark.asyncio
async def test_http_cancel_races_ws_finish_single_terminal_and_body(db,client,actors):
    tid=await send(client,actors)
    delivery=(await db.execute(select(Delivery).where(Delivery.task_id==tid))).scalar_one()
    raw={'v':1,'type':'task_ack','delivery_id':delivery.delivery_id,'task_id':tid,
         'attempt':delivery.attempt,'target_room':actors.room.id}
    await ds.control(db,actors.users['agent'].id,'executor',raw);await db.commit()
    async def finish():
        async with session_factory() as session:
            try:
                await ds.finish(session,actors.users['agent'].id,'executor',raw,'race-result','report')
                await session.commit();return True
            except ds.DeliveryDenied:
                await session.rollback();return False
    cancel,completed=await asyncio.wait_for(asyncio.gather(
        client.post('/a2a/tasks/'+tid+':cancel',headers=actors.headers['owner']),finish()),5)
    task=await TaskService.get_task(db,tid);await db.refresh(task)
    bodies=list((await db.execute(select(Message).where(Message.content=='race-result'))).scalars())
    if completed:
        assert task.status=='completed' and len(bodies)==1 and cancel.status_code==400
        assert cancel.json()['error']['details'][0]['reason']=='TASK_NOT_CANCELABLE'
    else:
        assert task.status=='canceled' and not bodies and cancel.status_code==200

@pytest.mark.asyncio
async def test_internal_dialogue_real_standard_remote_and_cancel_inflight(db,actors,monkeypatch):
    import uvicorn
    received=[]; reached=asyncio.Event(); release=asyncio.Event()
    class StandardRemote:
        async def on_message_send(self, params, context):
            assert isinstance(params,pb.SendMessageRequest)
            assert params.message.role==pb.ROLE_USER and not params.configuration.return_immediately
            received.append(params.message.parts[0].text)
            reached.set()
            await release.wait()
            reply=pb.Message(message_id='remote-reply',role=pb.ROLE_AGENT)
            reply.parts.add().text='[CONSENSUS] verified remote reply'
            return reply
    remote=Starlette(routes=create_jsonrpc_routes(StandardRemote(),'/a2a/rpc'))
    listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(16)
    port=listener.getsockname()[1]
    runner=uvicorn.Server(uvicorn.Config(remote,lifespan='off',log_level='error'))
    running=asyncio.create_task(runner.serve(sockets=[listener]))
    url=f'http://127.0.0.1:{port}'
    # Explicit synthetic loopback allowlist; production egress defaults stay unchanged.
    monkeypatch.setenv('MAPR_A2A_ALLOW_LOCALHOST','1')
    monkeypatch.setenv('MAPR_A2A_LOCAL_ALLOWLIST',url)
    monkeypatch.setattr(server.AgentDiscovery,'list_available',AsyncMock(return_value=[{'name':'agent','url':url}]))
    async def started():
        while not runner.started: await asyncio.sleep(.005)
    try:
        await asyncio.wait_for(started(),2)
        direct=asyncio.create_task(server._send_to_agent('agent','direct standard call'))
        await asyncio.wait_for(reached.wait(),2);release.set()
        assert await asyncio.wait_for(direct,2)=='[CONSENSUS] verified remote reply'
        assert received==['direct standard call']
        # Exercise real automatic dialogue path, then owner stop while remote reply is pending.
        reached.clear();release.clear()
        did=str(uuid.uuid4())
        dialogue={'id':did,'room_id':actors.room.id,'status':'active','participants':['agent'],
                  'max_turns':2,'topic':'synthetic negotiation','turns':[],'created_at':server._now()}
        server.DIALOGUES[did]=dialogue
        loop=asyncio.create_task(server._run_dialogue_loop(did))
        await asyncio.wait_for(reached.wait(),2)
        dialogue['status']='ended';release.set()
        await asyncio.wait_for(loop,2)
        assert not dialogue['turns']
        assert not list((await db.execute(select(Message).where(Message.content=='[CONSENSUS] verified remote reply'))).scalars())
        server.DIALOGUES.pop(did,None)
        # Normal automatic path uses the verified account and the persisted message ID.
        from sqlalchemy import text
        if db.bind.dialect.name == 'sqlite':
            await db.execute(text('PRAGMA foreign_keys=ON'))
        await db.commit()
        did=str(uuid.uuid4())
        normal={**dialogue,'dialogue_id':did,'status':'active','turns':[],
                'participants':['hub','agent'], 'created_by_user_id':actors.users['owner'].id}
        server.DIALOGUES[did]=normal
        broadcasted=[]
        async def capture(channel,frame): broadcasted.append((channel,frame))
        monkeypatch.setattr(connection_manager,'broadcast',capture)
        await asyncio.wait_for(server._run_dialogue_loop(did),2)
        assert normal['reason']=='consensus' and len(normal['turns'])==1
        message_frame=next(frame for _,frame in broadcasted if frame.get('type')=='message')
        persisted=await db.get(Message,message_frame['message']['id'])
        assert persisted and persisted.sender_id==actors.users['agent'].id
        assert persisted.content=='[CONSENSUS] verified remote reply' and persisted.parent_id is None
        server.DIALOGUES.pop(did,None)
    finally:
        release.set();runner.should_exit=True
        await asyncio.wait_for(running,5);listener.close()

@pytest.mark.asyncio
async def test_ws_result_is_standard_text_artifact_with_status_timestamp(client,db,actors):
    tid=await send(client,actors)
    await TaskService.complete_task(db,tid,[{'type':'report','content':'clean WS result'}]);await db.commit()
    reply=await client.get('/a2a/tasks/'+tid,headers=actors.headers['owner'])
    task=ParseDict(reply.json(),pb.Task())
    assert task.artifacts[0].parts[0].text=='clean WS result'
    assert task.status.HasField('timestamp')

@pytest.mark.asyncio
@pytest.mark.parametrize('mode',['expiry','disconnect','pre_start_revoke'])
async def test_sse_early_disconnect_token_expiry_and_pre_start_denial(db,client,actors,monkeypatch,mode):
    from starlette.requests import Request
    tid=await send(client,actors)
    checks=[False]
    async def receive():
        if mode=='disconnect': return {'type':'http.disconnect'}
        await asyncio.Future()
    request=Request({'type':'http','method':'GET','path':'/a2a/tasks/'+tid+':subscribe','headers':[
        (b'authorization',actors.headers['viewer']['Authorization'].encode()),(b'a2a-version',b'1.0')]},receive)
    if mode=='pre_start_revoke':
        await db.execute(update(RoomPermission).where(RoomPermission.user_id==actors.users['viewer'].id).values(role='none'));await db.commit()
    elif mode=='expiry':
        original=protocol.decode_http_token
        count=[]
        def expire(token):
            count.append(1)
            if len(count)>1:
                from fastapi import HTTPException
                raise HTTPException(401,'expired')
            return original(token)
        monkeypatch.setattr(protocol,'decode_http_token',expire)
    frames=[event async for event in protocol.persisted_events(request,tid,0)]
    if mode=='disconnect':
        assert len(frames)==1 and 'task' in frames[0]['data']
    else:
        assert frames[-1]['event']=='error' and 'public task' not in str(frames)

@pytest.mark.asyncio
async def test_list_tasks_page_bounds_owner_revocation_and_pagination(client,db,actors):
    tids=[await send(client,actors) for _ in range(3)]
    first=await client.get('/a2a/tasks?pageSize=2',headers=actors.headers['viewer'])
    assert len(first.json()['tasks'])==2 and first.json()['nextPageToken']=='2'
    second=await client.get('/a2a/tasks?pageSize=2&pageToken=2',headers=actors.headers['viewer'])
    assert len(second.json()['tasks'])==1
    for params in [{'pageSize':-1},{'pageSize':101},{'pageToken':'-1'},{'pageToken':'invalid'}]:
        reply=await client.post('/a2a/rpc',headers=actors.headers['owner'],json={'jsonrpc':'2.0','method':'ListTasks','params':params,'id':1})
        assert reply.json()['error']['code']==-32602
    await db.execute(update(RoomPermission).where(RoomPermission.user_id==actors.users['owner'].id).values(role='viewer'));await db.commit()
    reply=await client.get('/a2a/tasks/'+tids[0],headers=actors.headers['agent'])
    assert reply.status_code==403
    reply=await client.get('/a2a/tasks',headers=actors.headers['agent'])
    assert not reply.json().get('tasks')
