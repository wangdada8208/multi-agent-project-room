"""Standard HTTP authentication regression gates; no external network."""
import pytest

@pytest.mark.asyncio
@pytest.mark.parametrize('path,method', [('/a2a/tasks/known:subscribe','GET'),('/a2a/tasks/known:cancel','POST'),('/a2a/tasks/known','GET'),('/a2a/rpc','POST')])
async def test_anonymous_standard_routes_rejected(client,path,method):
    response = await client.request(method,path,json={'jsonrpc':'2.0','method':'CancelTask','params':{'id':'known'},'id':1} if method=='POST' else None)
    assert response.status_code == 401

import asyncio
import json
import socket
import uuid
from types import SimpleNamespace
import pytest_asyncio
import httpx
from google.protobuf.json_format import ParseDict
from a2a.types import a2a_pb2 as pb
from app.models.user import User
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.a2a.models import A2ATask
from app.a2a.task_service import TaskService
from app.a2a import http_protocol as protocol
from app.core.security import create_access_token
from app.a2a.client import A2AClient
from app.a2a import url_policy

@pytest_asyncio.fixture
async def actors(db):
    users = {}
    for name,kind in [('owner','human'),('member','human'),('viewer','human'),('outsider','human'),('agent','agent'),('otheragent','agent')]:
        u=User(username=name,display_name=name,user_type=kind)
        db.add(u); await db.flush(); users[name]=u
    users['agent'].owner_user_id=users['owner'].id
    users['otheragent'].owner_user_id=users['owner'].id
    room=Room(name='internal',created_by=users['owner'].id,transport='hub')
    db.add(room);await db.flush()
    for name,role in [('owner','owner'),('member','member'),('viewer','viewer'),('agent','member'),('otheragent','member')]:
        db.add(RoomPermission(room_id=room.id,user_id=users[name].id,role=role))
    await db.commit()
    headers={k:{'Authorization':'Bearer '+create_access_token(v.id,v.user_type), 'A2A-Version':'1.0'} for k,v in users.items()}
    return SimpleNamespace(users=users,room=room,headers=headers)

def message(actors):
    return {'configuration':{'returnImmediately':True}, 'message':{'messageId':f'm-{uuid.uuid4().hex[:8]}','role':'ROLE_USER','parts':[{'text':'public task'}],
        'metadata':{'roomId':actors.room.id,'targetAgent':actors.users['agent'].id}}}

async def send(client,actors,rest=False):
    data=message(actors)
    r=await client.post('/a2a/message:send' if rest else '/a2a/rpc',headers=actors.headers['owner'],
        json=data if rest else {'jsonrpc':'2.0','method':'SendMessage','id':1,'params':data})
    assert r.status_code == 200, r.text
    value=r.json() if rest else r.json()['result']
    ParseDict(value,pb.SendMessageResponse())
    return value['task']['id']

@pytest.mark.asyncio
@pytest.mark.parametrize('rest',[False,True])
async def test_standard_send_get_cancel_cas(client,db,actors,rest):
    tid=await send(client,actors,rest)
    if rest:
        r=await client.get('/a2a/tasks/'+tid,headers=actors.headers['owner'])
    else:
        r=await client.post('/a2a/rpc',headers=actors.headers['owner'],json={'jsonrpc':'2.0','method':'GetTask','params':{'id':tid},'id':2})
    value=r.json() if rest else r.json()['result']
    ParseDict(value,pb.Task())
    assert value['status']['state']=='TASK_STATE_SUBMITTED'
    r=await client.post('/a2a/tasks/'+tid+':cancel',headers=actors.headers['owner'])
    assert r.status_code==200,r.text
    assert r.json()['status']['state']=='TASK_STATE_CANCELED'
    task,_,code=await TaskService.complete_task(db,tid,{'text':'late'})
    await db.commit()
    assert code=='canceled_overridden_rejected'
    assert task.result is None
    r=await client.post('/a2a/rpc',headers=actors.headers['owner'],json={'jsonrpc':'2.0','method':'CancelTask','params':{'id':tid},'id':3})
    assert r.json()['result']['status']['state']=='TASK_STATE_CANCELED'

@pytest.mark.asyncio
@pytest.mark.parametrize('actor',['viewer','outsider','agent'])
async def test_send_permission_and_spoofed_identity(client,actors,actor):
    data=message(actors);data['message']['metadata']['userId']=actors.users['owner'].id
    r=await client.post('/a2a/message:send',headers=actors.headers[actor],json=data)
    assert r.status_code==403

@pytest.mark.asyncio
@pytest.mark.parametrize('actor',['viewer','outsider','otheragent','member'])
async def test_cancel_scope(client,actors,actor):
    tid=await send(client,actors)
    r=await client.post('/a2a/tasks/'+tid+':cancel',headers=actors.headers[actor])
    assert r.status_code==403

@pytest.mark.asyncio
@pytest.mark.parametrize('actor',['outsider','otheragent'])
async def test_get_subscribe_scope(client,actors,actor):
    tid=await send(client,actors)
    for suffix in ['',':subscribe']:
        r=await client.get('/a2a/tasks/'+tid+suffix,headers=actors.headers[actor])
        assert r.status_code==403
        assert actors.room.id not in r.text

@pytest.mark.asyncio
async def test_viewer_read_assigned_agent_read_and_filtered_list(client,actors):
    tid=await send(client,actors)
    for actor in ['viewer','agent']:
        r=await client.get('/a2a/tasks/'+tid,headers=actors.headers[actor]);assert r.status_code==200
    r=await client.get('/a2a/tasks',headers=actors.headers['outsider']);assert r.status_code==200
    assert not r.json().get('tasks')
    r=await client.post('/a2a/rpc',headers=actors.headers['owner'],json={'jsonrpc':'2.0','method':'ListTasks','params':{'pageSize':1},'id':2})
    ParseDict(r.json()['result'],pb.ListTasksResponse())
    assert r.json()['result']['tasks'][0]['id']==tid

@pytest.mark.asyncio
async def test_old_nonstandard_request_rejected(client,actors):
    r=await client.post('/a2a/rpc',headers=actors.headers['owner'],json={'jsonrpc':'2.0','method':'tasks/send','params':{'id':'old','query':'old'},'id':1})
    assert r.json()['error']['code']==-32601
    r=await client.post('/a2a/rpc',headers=actors.headers['owner'],json={'jsonrpc':'2.0','method':'SendMessage','params':{'id':'old','query':'old'},'id':1})
    assert r.status_code==200 and r.json()['error']['code']==-32602

@pytest.mark.asyncio
@pytest.mark.parametrize('rpc',[False,True])
async def test_sse_persisted_replay_terminal(client,db,actors,rpc):
    tid=await send(client,actors)
    await TaskService.start_task(db,tid);await db.commit()
    await TaskService.cancel_task(db,tid);await db.commit()
    headers={**actors.headers['viewer'],'Last-Event-ID':'2'}
    if rpc:
        r=await client.post('/a2a/rpc',headers=headers,json={'jsonrpc':'2.0','method':'SubscribeToTask','params':{'id':tid},'id':4})
    else:
        r=await client.get('/a2a/tasks/'+tid+':subscribe',headers=headers)
    assert r.status_code==200,r.text
    assert 'text/event-stream' in r.headers['content-type']
    assert [line for line in r.text.splitlines() if line.startswith('id:')]==['id: 3','id: 4']
    data=[json.loads(line[6:]) for line in r.text.splitlines() if line.startswith('data: ')]
    for frame in data:
        ParseDict(frame['result'] if rpc else frame,pb.StreamResponse())
    assert 'TASK_STATE_WORKING' in r.text and 'TASK_STATE_CANCELED' in r.text
    assert 'public task' not in r.text and actors.room.id not in r.text
    assert protocol._streams=={}

@pytest.mark.asyncio
async def test_sse_heartbeat_bound_and_new_events(client,db,actors,monkeypatch):
    tid=await send(client,actors)
    monkeypatch.setattr(protocol,'STREAM_SECONDS',.15)
    monkeypatch.setattr(protocol,'POLL_SECONDS',.005)
    monkeypatch.setattr(protocol,'HEARTBEAT_SECONDS',.01)
    r=await asyncio.wait_for(client.get('/a2a/tasks/'+tid+':subscribe?after_seq=1',headers=actors.headers['owner']),1)
    assert 'heartbeat' in r.text and protocol._streams=={}
    async def finish():
        await asyncio.sleep(.01)
        await TaskService.complete_task(db,tid,[{'text':'approved result'}]);await db.commit()
    finisher=asyncio.create_task(finish())
    r=await client.get('/a2a/tasks/'+tid+':subscribe?after_seq=1',headers=actors.headers['owner'])
    await finisher
    assert 'id: 3' in r.text and 'approved result' in r.text

@pytest.mark.asyncio
async def test_encrypted_plaintext_rejected_and_artifacts_hidden(client,db,actors):
    actors.room.transport='xmtp';await db.commit()
    r=await client.post('/a2a/message:send',headers=actors.headers['owner'],json=message(actors))
    assert r.status_code==400
    task,_=await TaskService.create_task(db,query='private',room_id=actors.room.id,source_agent=actors.users['owner'].id,target_agent=actors.users['agent'].id)
    await TaskService.complete_task(db,task.id,[{'text':'private encrypted result'}]);await db.commit()
    r=await client.get('/a2a/tasks/'+task.id,headers=actors.headers['owner'])
    assert 'private' not in r.text
    r=await client.get('/a2a/tasks/'+task.id+':subscribe?after_seq=0',headers=actors.headers['owner'])
    assert 'private' not in r.text

@pytest.mark.asyncio
async def test_card_supported_interfaces(client):
    r=await client.get('/.well-known/agent-card.json');assert r.status_code==200
    card=ParseDict(r.json(),pb.AgentCard())
    assert card.capabilities.streaming and not card.capabilities.push_notifications
    assert {i.protocol_binding for i in card.supported_interfaces}=={'JSONRPC','HTTP+JSON'}
    assert all(i.protocol_version=='1.0' for i in card.supported_interfaces)

@pytest.mark.asyncio
async def test_client_legacy_signatures_standard_requests(monkeypatch):
    requests=[]
    async def fake(base,suffix,**kw):
        requests.append((base,suffix,kw))
        return httpx.Response(200,json={'result':{'task':{'id':'remote'}} if kw['json_body']['method']=='SendMessage' else {'id':'remote'}},request=httpx.Request('POST','https://public.example'))
    monkeypatch.setattr('app.a2a.client.safe_agent_http_request',fake)
    c=A2AClient('https://public.example',token='synthetic',room_id='room',target_agent='agent')
    assert (await c.send_task('hello','legacy-id'))['id']=='remote'
    await c.get_task('remote');await c.cancel_task('remote')
    assert [x[2]['json_body']['method'] for x in requests]==['SendMessage','GetTask','CancelTask']
    ParseDict(requests[0][2]['json_body']['params'],pb.SendMessageRequest())
    assert requests[0][2]['json_body']['params']['message']['messageId']=='legacy-id'
    assert all(x[1]=='/a2a/rpc' and x[2]['connect_timeout']==5 for x in requests)

@pytest.mark.asyncio
async def test_safe_outbound_sse_pinned_and_private_fail_closed(monkeypatch):
    requests=[]
    monkeypatch.setattr(socket,'getaddrinfo',lambda *a,**kw:[(socket.AF_INET,socket.SOCK_STREAM,6,'',('93.184.215.14',443))])
    def handle(request):
        requests.append(request)
        return httpx.Response(200,headers={'content-type':'text/event-stream'},content=b'id: 2\ndata: {"statusUpdate":{}}\n\n')
    monkeypatch.setattr(url_policy,'create_pinned_transport',lambda *a:httpx.MockTransport(handle))
    c=A2AClient('https://agent.example',token='synthetic')
    frames=[f async for f in c.subscribe_task('task',1)]
    assert frames[0]['id']=='2'
    assert requests[0].url.host=='93.184.215.14'
    assert requests[0].headers['Host']=='agent.example'
    assert requests[0].extensions['sni_hostname']=='agent.example'
    assert requests[0].headers['Last-Event-ID']=='1'
    assert requests[0].extensions['timeout']['connect']==5
    with pytest.raises(ValueError,match='disallowed'):
        async for _ in A2AClient('http://127.0.0.1').subscribe_task('x'):
            pass
    assert len(requests)==1

@pytest.fixture(autouse=True)
def isolated_sse_lifecycle():
    # sse-starlette 2.x caches a process-wide asyncio Event; pytest uses a new
    # event loop per test. Reset only the test lifecycle, never production state.
    from sse_starlette.sse import AppStatus
    AppStatus.should_exit_event = None
    yield
    AppStatus.should_exit_event = None

@pytest.mark.asyncio
@pytest.mark.parametrize('rest',[False,True])
async def test_stream_send_delivery_and_cancel_controls(client,db,actors,monkeypatch,rest):
    from app.models.agent_task_delivery import AgentTaskDelivery
    from sqlalchemy import select
    frames=[]
    async def broadcast(channel,frame):
        frames.append((channel,frame))
    monkeypatch.setattr('app.ws.connection_manager.connection_manager.broadcast',broadcast)
    # Allow the initial snapshot and persisted replay their real PG round trips;
    # 20ms can expire before replay even starts on a busy CI machine.
    monkeypatch.setattr(protocol,'STREAM_SECONDS',.2)
    monkeypatch.setattr(protocol,'POLL_SECONDS',.005)
    params=message(actors)
    r=await client.post('/a2a/message:stream' if rest else '/a2a/rpc',headers=actors.headers['owner'],
        json=params if rest else {'jsonrpc':'2.0','method':'SendStreamingMessage','params':params,'id':1})
    assert r.status_code==200 and 'id: 1' in r.text and 'id: 2' in r.text
    data=[json.loads(line[6:]) for line in r.text.splitlines() if line.startswith('data: ')]
    for frame in data:
        ParseDict(frame if rest else frame['result'],pb.StreamResponse())
    delivery=(await db.execute(select(AgentTaskDelivery))).scalar_one()
    assert delivery.agent_user_id==actors.users['agent'].id
    assert frames[0][1]['task_id']==delivery.task_id
    assert frames[0][1]['content']=='public task'
    assert frames[0][0]=='_agent_agent'
    r=await client.post('/a2a/tasks/'+delivery.task_id+':cancel',headers=actors.headers['owner'])
    assert r.status_code==200
    assert frames[-1][1]['type']=='task_cancel'
    assert protocol._streams=={}

@pytest.mark.asyncio
async def test_sse_reconnect_reauth_and_connection_limit(client,db,actors,monkeypatch):
    tid=await send(client,actors)
    leases = []
    for _ in range(protocol.MAX_USER_STREAMS):
        async with protocol.sessions() as quota_db:
            leases.append(await protocol.quota_policy.acquire(quota_db, actors.users['owner'].id, tid, protocol.HUB_ID))
    r=await client.get('/a2a/tasks/'+tid+':subscribe',headers=actors.headers['owner'])
    assert r.status_code==429
    assert r.json()['error']['status'] == 'RESOURCE_EXHAUSTED'
    assert r.headers['Retry-After'] == '10'
    for lease in leases:
        async with protocol.sessions() as quota_db:
            await protocol.quota_policy.release(quota_db, lease.lease_id, protocol.HUB_ID)
    r=await client.get('/a2a/tasks/'+tid+':subscribe',headers={**actors.headers['owner'],'Last-Event-ID':'-1'})
    assert r.status_code==400
    perm=(await db.execute(__import__('sqlalchemy').select(RoomPermission).where(RoomPermission.room_id==actors.room.id,RoomPermission.user_id==actors.users['viewer'].id))).scalar_one()
    await db.delete(perm);await db.commit()
    r=await client.get('/a2a/tasks/'+tid+':subscribe',headers={**actors.headers['viewer'],'Last-Event-ID':'1'})
    assert r.status_code==403

@pytest.mark.asyncio
async def test_removed_account_and_wrong_type_rejected(client,db,actors):
    headers={'Authorization':'Bearer '+create_access_token(actors.users['owner'].id,'agent'), 'A2A-Version':'1.0'}
    r=await client.get('/a2a/tasks',headers=headers);assert r.status_code==401
    await db.delete(actors.users['outsider']);await db.commit()
    r=await client.get('/a2a/tasks',headers=actors.headers['outsider']);assert r.status_code==401

@pytest.mark.asyncio
async def test_outbound_stream_redirect_and_oversize_fail_closed(monkeypatch):
    monkeypatch.setattr(socket,'getaddrinfo',lambda *a,**kw:[(socket.AF_INET,socket.SOCK_STREAM,6,'',('93.184.215.14',443))])
    mode=['redirect']; requests=[]
    def handle(request):
        requests.append(request)
        if mode[0]=='redirect':
            return httpx.Response(302,headers={'location':'http://127.0.0.1/private'})
        return httpx.Response(200,headers={'content-type':'text/event-stream'},content=b'data: '+b'x'*70000)
    monkeypatch.setattr(url_policy,'create_pinned_transport',lambda *a:httpx.MockTransport(handle))
    for setting in ['redirect','large']:
        mode[0]=setting
        with pytest.raises(ValueError,match='disallowed'):
            async for _ in A2AClient('https://agent.example').subscribe_task('x'):
                pass
    assert len(requests)==2

@pytest.mark.asyncio
async def test_sse_pagination_and_token_audit_redaction(client,db,actors):
    from app.a2a.task_service import _append_event
    tid=await send(client,actors)
    for n in range(103):
        await _append_event(db,tid,'task_progress',{'phase':'running','percent':n % 100,'token':'private-synthetic','body':'private unapproved text'})
    await TaskService.cancel_task(db,tid);await db.commit()
    r=await client.post('/a2a/tasks/'+tid+':subscribe?after_seq=2',headers=actors.headers['viewer'])
    ids=[int(line[4:]) for line in r.text.splitlines() if line.startswith('id: ')]
    assert ids==list(range(3,107))
    assert 'private-synthetic' not in r.text and 'unapproved text' not in r.text

@pytest.mark.asyncio
async def test_standard_version_and_client_result_compatibility(client,actors):
    r=await client.post('/a2a/message:send',headers={'Authorization':actors.headers['owner']['Authorization']},json=message(actors))
    assert r.status_code==400
    assert A2AClient._legacy_task({'task':{'id':'t','status':{'state':'TASK_STATE_CANCELED'}}})=={'id':'t','status':'canceled'}
    assert A2AClient._legacy_task({'message':{'parts':[{'text':'ok'}]}},'t')['artifacts']==[{'parts':[{'text':'ok'}]}]

@pytest.mark.asyncio
async def test_standard_jwt_algorithm_expiry_signature_and_db_identity(client,actors):
    import base64,hashlib,hmac,time
    from app.config import get_settings
    def jwt(alg='HS256',exp=None,key=None,sub=None):
        def encode(obj):
            return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip('=')
        body=encode({'alg':alg,'typ':'JWT'})+'.'+encode({'sub':sub or actors.users['owner'].id,'exp':exp if exp is not None else time.time()+60})
        sig=hmac.new((key or get_settings().auth_secret_key).encode(),body.encode(),hashlib.sha256).digest()
        return body+'.'+base64.urlsafe_b64encode(sig).decode().rstrip('=')
    for token,code in [(jwt(),200),(jwt(alg='none'),401),(jwt(exp=time.time()-1),401),(jwt(key='synthetic-wrong'),401),(jwt(sub='missing'),401)]:
        r=await client.get('/a2a/tasks',headers={'Authorization':'Bearer '+token,'A2A-Version':'1.0'})
        assert r.status_code==code
        assert token not in r.text

@pytest.mark.asyncio
async def test_stream_real_httpcore_pin_tls_no_proxy(monkeypatch):
    import ssl
    from httpcore._backends.auto import AutoBackend
    from httpcore._backends.base import AsyncNetworkStream
    connects=[]; tls=[]; writes=[]; closed=[]
    body=b'id: 7\ndata: {"statusUpdate":{}}\n\n'
    class Stream(AsyncNetworkStream):
        def __init__(self):
            self.data=b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: '+str(len(body)).encode()+b'\r\n\r\n'+body
        async def read(self,max_bytes,timeout=None):
            data,self.data=self.data[:max_bytes],self.data[max_bytes:];return data
        async def write(self,buffer,timeout=None):
            writes.append(buffer)
        async def aclose(self):
            closed.append(True)
        async def start_tls(self,ssl_context,server_hostname=None,timeout=None):
            tls.append((server_hostname,ssl_context.check_hostname,ssl_context.verify_mode,timeout));return self
    async def connect(backend,host,port,timeout=None,**kw):
        connects.append((host,port,timeout));return Stream()
    for name in ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']:
        monkeypatch.setenv(name,'http://127.0.0.1:8888')
    monkeypatch.setattr(socket,'getaddrinfo',lambda *a,**kw:[(socket.AF_INET,socket.SOCK_STREAM,6,'',('93.184.215.14',8443))])
    monkeypatch.setattr(AutoBackend,'connect_tcp',connect)
    frames=[frame async for frame in A2AClient('https://agent.example:8443').subscribe_task('t')]
    assert frames[0]['id']=='7'
    assert connects==[('93.184.215.14',8443,5.0)]
    assert tls==[('agent.example',True,ssl.CERT_REQUIRED,5.0)]
    assert b'Host: agent.example:8443\r\n' in b''.join(writes)
    assert closed

@pytest.mark.asyncio
async def test_persistent_sdk_artifact_update_and_restart_replay(client,actors):
    from app.a2a.server import TaskServiceTaskStore
    tid=await send(client,actors)
    store=TaskServiceTaskStore()
    task=await store.get(tid)
    task.status.state=pb.TASK_STATE_COMPLETED
    artifact=task.artifacts.add();artifact.artifact_id='test-artifact';artifact.parts.add().text='public result chunk'
    await store.save(task)
    restarted=TaskServiceTaskStore()
    assert (await restarted.get(tid)).artifacts[0].parts[0].text=='public result chunk'
    r=await client.get('/a2a/tasks/'+tid+':subscribe?after_seq=3',headers=actors.headers['viewer'])
    frames=[json.loads(line[6:]) for line in r.text.splitlines() if line.startswith('data: ')]
    assert len(frames)==2 and 'task' in frames[0]
    parsed=ParseDict(frames[1],pb.StreamResponse())
    assert parsed.artifact_update.artifact.parts[0].text=='public result chunk'
    assert parsed.artifact_update.last_chunk
    assert parsed.artifact_update.artifact.artifact_id==tid+':0'
    assert 'id: 4' in r.text

@pytest.mark.asyncio
async def test_client_server_standard_interoperation_without_network(actors,monkeypatch):
    from app.main import app
    monkeypatch.setattr(socket,'getaddrinfo',lambda *a,**kw:[(socket.AF_INET,socket.SOCK_STREAM,6,'',('93.184.215.14',443))])
    monkeypatch.setattr(url_policy,'create_pinned_transport',lambda *a:httpx.ASGITransport(app=app))
    c=A2AClient('https://agent.example',token=actors.headers['owner']['Authorization'][7:],room_id=actors.room.id,target_agent=actors.users['agent'].id)
    task=await c.send_task('contract over pinned helper','legacy-message-id')
    assert task['status']=='submitted'
    assert (await c.get_task(task['id']))['status']=='submitted'
    assert (await c.cancel_task(task['id']))['status']=='canceled'
    frames=[frame async for frame in c.subscribe_task(task['id'],2)]
    assert len(frames)==2 and 'id' not in frames[0] and frames[1]['id']=='3'
    assert frames[1]['data']['statusUpdate']['status']['state']=='TASK_STATE_CANCELED'

@pytest.mark.asyncio
async def test_sse_backpressure_timeout_releases_slot():
    released=[];closed=[]
    async def events():
        try:
            yield {'id':'1','data':'{}'}
        finally:
            closed.append(True)
    async def receive():
        await asyncio.Future()
    async def send(frame):
        if frame['type']=='http.response.body':
            await asyncio.Future()
    response=protocol.QuotaEventSourceResponse(events(),release_slot=lambda:released.append(True),send_timeout=.01,ping=10)
    with pytest.raises(BaseExceptionGroup):
        await asyncio.wait_for(response({'type':'http','asgi':{'version':'3.0'}},receive,send),1)
    assert released==[True] and closed==[True]
