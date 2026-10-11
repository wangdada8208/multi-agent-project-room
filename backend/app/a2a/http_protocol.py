"""Authenticated SDK transports over the unified SQL task service.

The route guard runs before SDK parsing/logging; streaming emits only approved
control fields, never arbitrary audit payloads or encrypted room plaintext.
"""
from __future__ import annotations
import asyncio
import inspect
import base64
import hashlib
import hmac
import math
import json
import time
import uuid
import anyio
from contextlib import asynccontextmanager
from google.protobuf.json_format import MessageToDict, ParseDict, ParseError
from fastapi import HTTPException
from starlette.responses import JSONResponse
from starlette.routing import Route
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from functools import wraps
from a2a.auth.user import User as SDKUser
from a2a.server.context import ServerCallContext
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes.jsonrpc_routes import create_jsonrpc_routes
from a2a.server.routes.rest_routes import create_rest_routes
from a2a.types import a2a_pb2 as pb
from a2a.utils.errors import (A2AError, InvalidParamsError, InvalidRequestError, JSONParseError,
    MethodNotFoundError, UnsupportedOperationError, PushNotificationNotSupportedError,
    VersionNotSupportedError, ContentTypeNotSupportedError, InternalError)
from a2a.utils.errors import JSON_RPC_ERROR_CODE_MAP
from a2a.server.jsonrpc_models import JSONRPCError
from a2a.server.request_handlers.response_helpers import build_error_response
from a2a.utils.error_handlers import build_rest_error_payload
from app.core.security import decode_access_token
from app.models.user import User
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.chat.models import Message
from app.a2a.models import A2ATask
from app.a2a.task_service import TaskService, TERMINAL_STATUSES, sanitize_payload
from app.a2a.sse_global_quota import SSEGlobalQuota, QuotaExceeded, QuotaUnavailable

quota_policy = SSEGlobalQuota()
HUB_ID = str(uuid.uuid4())

PAGE_SIZE = 100
STREAM_SECONDS = 60.0
POLL_SECONDS = 0.25
HEARTBEAT_SECONDS = 10.0
MAX_STREAMS = 64
MAX_USER_STREAMS = 4
BLOCKING_SECONDS = 60.0
SSE_DB_SECONDS = 3.0
INTERRUPTED_STATUSES = ('input_required',)
_streams: dict[str, int] = {}


def sessions():
    # Same injectable SQL factory as the existing SDK TaskStore.
    from app.a2a import server
    return server.async_session()


class Identity(SDKUser):
    def __init__(self, user_id):
        self.id = user_id
    @property
    def is_authenticated(self):
        return True
    @property
    def user_name(self):
        return self.id


class ContextBuilder:
    def build(self, request):
        return ServerCallContext(user=Identity(request.state.principal.id), state={
            'principal_id': request.state.principal.id,
            'request': request,
            'headers': {'a2a-version': request.headers.get('a2a-version', '')},
        })


def decode_http_token(token):
    """Accept HS256 JWT plus the existing MAPR bearer format during migration.

    Pin the algorithm and key locally; never follow jwks/jku or trust token URLs.
    Both formats expire and identify an existing DB account.
    """
    if token.count('.') != 2:
        return decode_access_token(token)
    try:
        from app.config import get_settings
        header, payload, signature = token.split('.')
        def decode(segment):
            return base64.urlsafe_b64decode(segment + '=' * (-len(segment) % 4))
        info = json.loads(decode(header))
        if info.get('alg') != 'HS256' or info.get('crit'):
            raise ValueError
        expected = hmac.new(get_settings().auth_secret_key.encode(), (header + '.' + payload).encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, decode(signature)):
            raise ValueError
        claims = json.loads(decode(payload))
        expiration = claims.get('exp')
        if type(expiration) not in (int, float) or not math.isfinite(expiration) or expiration <= time.time():
            raise ValueError
        if 'nbf' in claims:
            nbf = claims['nbf']
            if type(nbf) not in (int, float) or not math.isfinite(nbf) or nbf > time.time():
                raise ValueError
        if not isinstance(claims.get('sub'), str) or not claims['sub']:
            raise ValueError
        return claims
    except Exception:
        raise HTTPException(401, 'Invalid token') from None


async def authenticate(request, db):
    header = request.headers.get('authorization', '')
    if not header.startswith('Bearer '):
        raise HTTPException(401, 'Authentication required')
    payload = decode_http_token(header[7:])
    user = await db.get(User, payload['sub'])
    if user is None or user.user_type not in ('human', 'agent') or payload.get('typ', user.user_type) != user.user_type:
        raise HTTPException(401, 'Invalid account')
    # The current model has no disabled flag. If added, fail closed here.
    if getattr(user, 'is_active', True) is False:
        raise HTTPException(401, 'Invalid account')
    return user


async def room_role(db, room_id, user):
    room = await db.get(Room, room_id) if room_id else None
    perm = (await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == room_id, RoomPermission.user_id == user.id))).scalar_one_or_none()
    if not room or not room.is_active or not perm or perm.role not in ('owner', 'member', 'viewer'):
        raise HTTPException(403, 'Access denied')
    return room, perm.role


async def check_task(db, task_id, user, cancel=False):
    task = await db.get(A2ATask, task_id)
    if not task:
        # Do not distinguish unknown IDs from inaccessible IDs.
        raise HTTPException(403, 'Access denied')
    room, role = await room_role(db, task.room_id, user)
    if user.user_type == 'agent':
        from app.chat.delivery_service import slug
        targets = (await db.execute(select(User))).scalars().all()
        matches = [u for u in targets if task.target_agent == u.id or (task.target_agent and slug(task.target_agent) == slug(u.username))]
        if len(matches) != 1 or matches[0].id != user.id or not user.owner_user_id or role == 'viewer':
            raise HTTPException(403, 'Access denied')
        owner = await db.get(User, user.owner_user_id)
        if not owner or owner.user_type != 'human':
            raise HTTPException(403, 'Access denied')
        _, owner_role = await room_role(db, room.id, owner)
        if owner_role == 'viewer':
            raise HTTPException(403, 'Access denied')
    elif cancel:
        initiator = task.source_agent == user.id
        if task.source_message_id:
            message = await db.get(Message, task.source_message_id)
            initiator = initiator or bool(message and message.sender_id == user.id)
        if role != 'owner' and (role != 'member' or not initiator):
            raise HTTPException(403, 'Access denied')
    return task, room


async def check_send(db, params, user):
    msg = params.message
    metadata = MessageToDict(msg.metadata)
    room_id = metadata.get('roomId') or metadata.get('room_id')
    room, role = await room_role(db, room_id, user)
    if user.user_type != 'human' or role not in ('owner', 'member'):
        raise HTTPException(403, 'Access denied')
    if msg.task_id:
        # Continuation semantics are not yet supported: do not create a second task.
        raise UnsupportedOperationError('Task continuation is unsupported')
    if not msg.message_id or len(msg.message_id) > 256 or len(msg.context_id) > 36 or msg.role != pb.ROLE_USER or not msg.parts:
        raise HTTPException(400, 'Invalid message')
    if any(p.WhichOneof('content') != 'text' for p in msg.parts):
        raise ContentTypeNotSupportedError('Only text parts are supported')
    if params.configuration.HasField('task_push_notification_config'):
        raise PushNotificationNotSupportedError()
    if any(mode not in ('text/plain', 'application/json') for mode in params.configuration.accepted_output_modes):
        raise ContentTypeNotSupportedError()
    if room.transport == 'xmtp':
        raise HTTPException(400, 'Encrypted room plaintext is not accepted')
    target_id = metadata.get('targetAgent') or metadata.get('target_agent')
    target = await db.get(User, target_id) if target_id else None
    if not target or target.user_type != 'agent' or not target.owner_user_id:
        raise HTTPException(403, 'Access denied')
    owner = await db.get(User, target.owner_user_id)
    if not owner or owner.user_type != 'human':
        raise HTTPException(403, 'Access denied')
    _, target_role = await room_role(db, room.id, target)
    _, owner_role = await room_role(db, room.id, owner)
    if target_role == 'viewer' or owner_role == 'viewer':
        raise HTTPException(403, 'Access denied')
    return room, target


def storage_boundary(fn):
    @wraps(fn)
    async def call(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except SQLAlchemyError:
            raise HTTPException(503, 'Task storage unavailable') from None
    return call


class SQLRequestHandler(DefaultRequestHandler):
    @storage_boundary
    async def on_message_send(self, params, context):
        async with sessions() as db:
            user = await authenticate(context.state['request'], db)
            room, target = await check_send(db, params, user)
            text = sanitize_payload('\n'.join(p.text for p in params.message.parts))
            source = Message(room_id=room.id, sender_id=user.id, sender_type='human', sender_name=user.display_name, content=text, msg_type='task')
            db.add(source)
            await db.flush()
            task, _ = await TaskService.create_task(db,
                query=text,
                source_agent=user.id, target_agent=target.username, room_id=room.id, source_message_id=source.id,
                context_id=params.message.context_id or str(uuid.uuid4()))
            from app.chat.delivery_service import create_delivery, offer, slug
            delivery = await create_delivery(db, task, target.id)
            frame = await offer(db, delivery)
            await db.commit()
            result = self.task_store._to_sdk_task(task)
        from app.ws.connection_manager import connection_manager
        if frame:
            await connection_manager.broadcast('_agent_' + slug(target.username), frame)
        if params.configuration.return_immediately:
            return result
        # A standard send blocks by default, but holds no SQL transaction while waiting.
        deadline = time.monotonic() + BLOCKING_SECONDS
        while time.monotonic() < deadline:
            if await context.state['request'].is_disconnected():
                raise InternalError('Caller disconnected; task remains persisted')
            result = await self.on_get_task(pb.GetTaskRequest(id=task.id), context)
            if result.status.state in (pb.TASK_STATE_COMPLETED, pb.TASK_STATE_FAILED,
                                       pb.TASK_STATE_CANCELED, pb.TASK_STATE_INPUT_REQUIRED):
                return result
            await asyncio.sleep(POLL_SECONDS)
        raise InternalError('Blocking wait limit reached; use GetTask', data={'taskId':task.id})

    @storage_boundary
    async def on_get_task(self, params, context):
        async with sessions() as db:
            user = await authenticate(context.state['request'], db)
            task, room = await check_task(db, params.id, user)
            result = self.task_store._to_sdk_task(task)
            if room.transport == 'xmtp' or task.status == 'failed':
                result.ClearField('artifacts')
            return result

    @storage_boundary
    async def on_cancel_task(self, params, context):
        async with sessions() as db:
            user = await authenticate(context.state['request'], db)
            await check_task(db, params.id, user, cancel=True)
            task, _, code = await TaskService.cancel_task(db, params.id)
            from app.chat.delivery_service import cancel_deliveries
            frames = await cancel_deliveries(db, params.id) if task.status == 'canceled' else []
            await db.commit()
        from app.ws.connection_manager import connection_manager
        for channel, frame in frames:
            await connection_manager.broadcast(channel, frame)
        if code in ('already_completed', 'already_failed'):
            from a2a.utils.errors import TaskNotCancelableError
            raise TaskNotCancelableError()
        return await self.on_get_task(pb.GetTaskRequest(id=params.id), context)

    @storage_boundary
    async def on_list_tasks(self, params, context):
        async with sessions() as db:
            user = await authenticate(context.state['request'], db)
            # Filter in SQL by room membership before bounded pagination.
            stmt = select(A2ATask).join(RoomPermission, RoomPermission.room_id == A2ATask.room_id).where(RoomPermission.user_id == user.id)
            if user.user_type == 'agent':
                stmt = stmt.where(A2ATask.target_agent.in_((user.id, user.username)))
            if params.context_id:
                stmt = stmt.where(A2ATask.context_id == params.context_id)
            if params.status:
                from app.a2a.server import _TASK_STATE_TO_STATUS
                stmt = stmt.where(A2ATask.status == _TASK_STATE_TO_STATUS.get(params.status, 'invalid'))
            try:
                offset = int(params.page_token or '0')
                if offset < 0:
                    raise ValueError
            except ValueError:
                raise InvalidParamsError('Invalid page token') from None
            if params.page_size < 0 or params.page_size > PAGE_SIZE:
                raise InvalidParamsError('Invalid page size')
            size = params.page_size or 50
            rows = (await db.execute(stmt.order_by(A2ATask.id).offset(offset).limit(size + 1))).scalars().all()
            response = pb.ListTasksResponse(page_size=size)
            for row in rows[:size]:
                try:
                    _, room = await check_task(db, row.id, user)
                except HTTPException:
                    continue
                task = self.task_store._to_sdk_task(row)
                if not params.include_artifacts or room.transport == 'xmtp' or row.status == 'failed':
                    task.ClearField('artifacts')
                response.tasks.append(task)
            if len(rows) > size:
                response.next_page_token = str(offset + size)
            return response


@asynccontextmanager
async def sse_session():
    # EventSourceResponse uses AnyIO level cancellation: an unshielded SQL
    # rollback/close can be cancelled at every await after socket disconnect.
    # Shield only a bounded read and its session exit, never network sends or
    # polling. asyncio.timeout supplies a single edge cancellation on timeout,
    # allowing SQLAlchemy's normal rollback/close to finish before it propagates.
    with anyio.CancelScope(shield=True):
        async with sessions() as db:
            # Session exit must be outside the read deadline: timing out during
            # close could leave SQLAlchemy's shielded cleanup task unfinished.
            async with asyncio.timeout(SSE_DB_SECONDS):
                yield db


async def persisted_events(request, task_id, after, rpc_id=None, rpc=False):
    deadline = time.monotonic() + STREAM_SECONDS
    heartbeat = time.monotonic()
    # Snapshot has no SSE id: it must not advance the persisted replay cursor.
    try:
        async with sse_session() as db:
            user = await authenticate(request, db)
            task, room = await check_task(db, task_id, user)
            snapshot = self_task(task)
            if room.transport == 'xmtp' or task.status == 'failed':
                snapshot.ClearField('artifacts')
            data = MessageToDict(pb.StreamResponse(task=snapshot))
    except (HTTPException, SQLAlchemyError, TimeoutError):
        yield subscription_error(rpc_id, rpc)
        return
    if rpc:
        data = {'jsonrpc':'2.0','id':rpc_id,'result':data}
    yield {'data':json.dumps(sanitize_payload(data))}
    while time.monotonic() < deadline:
        if await request.is_disconnected():
            return
        try:
            batch = []
            async with sse_session() as db:
                user = await authenticate(request, db)
                task, room = await check_task(db, task_id, user)
                events = await TaskService.get_task_events(db, task_id, after_seq=after, limit=PAGE_SIZE)
                # A producer may commit between the task read and event query.
                # Refresh its result before serializing a newly observed completion.
                await db.refresh(task)
                terminal = task.status in TERMINAL_STATUSES + INTERRUPTED_STATUSES
                end_seq = task.event_seq
                for event in events:
                    # Historical state derives from that event, not the current row.
                    from app.a2a.server import _STATUS_TO_TASK_STATE
                    payload = event.payload or {}
                    state = payload.get('status') or payload.get('to_status') or payload.get('current_status')
                    if not state:
                        state = {'delivery_created':'submitted', 'delivery_acked':'working', 'task_progress':'working',
                                 'delivery_cancel_ack':'canceled','delivery_uncertain':'input_required'}.get(event.event_type)
                    index = payload.get('artifact_index')
                    artifacts = self_task(task).artifacts if room.transport != 'xmtp' and task.status == 'completed' else []
                    if event.event_type == 'artifact_update' and type(index) is int and 0 <= index < len(artifacts):
                        artifact_update = pb.TaskArtifactUpdateEvent(task_id=task.id, context_id=task.context_id or '', artifact=artifacts[index], last_chunk=True)
                        data = MessageToDict(pb.StreamResponse(artifact_update=artifact_update))
                    elif event.event_type == 'task_completed' and room.transport != 'xmtp':
                        snapshot = self_task(task)
                        snapshot.status.state = pb.TASK_STATE_COMPLETED
                        data = MessageToDict(pb.StreamResponse(task=snapshot))
                    else:
                        update = pb.TaskStatusUpdateEvent(task_id=task.id, context_id=task.context_id or '')
                        update.status.state = _STATUS_TO_TASK_STATE.get(state, pb.TASK_STATE_UNSPECIFIED)
                        update.metadata.update({'eventType': event.event_type, 'eventSeq': event.event_seq})
                        if event.event_type == 'task_progress':
                            update.metadata.update({k:payload[k] for k in ('phase','percent') if k in payload})
                        data = MessageToDict(pb.StreamResponse(status_update=update))
                    if rpc:
                        data = {'jsonrpc':'2.0','id':rpc_id,'result':data}
                    batch.append({'id':str(event.event_seq), 'data':json.dumps(sanitize_payload(data))})
            # No SQL session or ORM reads survive across a network yield.
            for frame in batch:
                yield frame
                after = int(frame['id'])
        except (HTTPException, SQLAlchemyError, TimeoutError):
            yield subscription_error(rpc_id, rpc)
            return
        if terminal and after >= end_seq:
            return
        if not events and time.monotonic() - heartbeat >= HEARTBEAT_SECONDS:
            heartbeat = time.monotonic()
            yield {'comment':'heartbeat'}
        await asyncio.sleep(POLL_SECONDS)


def subscription_error(rpc_id, rpc):
    error = InternalError('Subscription no longer available')
    data = build_error_response(rpc_id, error) if rpc else build_rest_error_payload(error)
    return {'event':'error','data':json.dumps(data)}


def self_task(task):
    from app.a2a.server import TaskServiceTaskStore
    return TaskServiceTaskStore._to_sdk_task(task)


class QuotaEventSourceResponse(EventSourceResponse):
    def __init__(self, *args, release_slot, lease=None, valid_until=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.release_slot = release_slot
        self.lease = lease
        self.valid_until = valid_until

    async def __call__(self, scope, receive, send):
        async def fenced_send(frame):
            if self.lease is not None and time.monotonic() >= self.valid_until:
                raise QuotaUnavailable()
            await send(frame)

        async def heartbeat(group):
            while True:
                await anyio.sleep(quota_policy.renew_seconds)
                started = time.monotonic()
                try:
                    async with sse_session() as db:
                        renewed = await quota_policy.renew(db, self.lease.lease_id, HUB_ID)
                    if renewed is None or time.monotonic() >= self.valid_until:
                        group.cancel_scope.cancel()
                        return
                    self.valid_until = started + quota_policy.lease_seconds
                except (QuotaUnavailable, SQLAlchemyError, TimeoutError):
                    group.cancel_scope.cancel()
                    return

        try:
            async with anyio.create_task_group() as group:
                if self.lease is not None:
                    group.start_soon(heartbeat, group)
                try:
                    await super().__call__(scope, receive, fenced_send)
                finally:
                    group.cancel_scope.cancel()
            if self.active:
                # Renewal failure cancels the producer, then ends the ASGI body
                # without emitting further SSE data (including expired pings).
                self.active = False
                with anyio.move_on_after(self.send_timeout, shield=True):
                    await send({'type':'http.response.body', 'body':b'', 'more_body':False})
        finally:
            # Generator may never have started, or be suspended in a blocked send.
            with anyio.move_on_after(SSE_DB_SECONDS + 1, shield=True):
                close = getattr(self.body_iterator, 'aclose', None)
                try:
                    if close is not None:
                        await close()
                finally:
                    result = self.release_slot()
                    if inspect.isawaitable(result):
                        await result


def guarded(endpoint, handler, operation, rpc=False):
    async def entry(request):
        request_id = None
        try:
            async with sessions() as db:
                user = await authenticate(request, db)
                request.state.principal = user
                chunks = bytearray()
                async for chunk in request.stream():
                    chunks.extend(chunk)
                    if len(chunks) > 65536:
                        raise HTTPException(413, 'Request too large')
                raw = bytes(chunks)
                request._body = raw
                if len(raw) > 65536:
                    raise HTTPException(413, 'Request too large')
                try:
                    body = sanitize_payload(json.loads(raw)) if raw else {}
                except (ValueError, UnicodeDecodeError):
                    raise JSONParseError() from None
                if not isinstance(body, dict):
                    raise InvalidRequestError()
                if rpc:
                    if type(body.get('id')) in (str, int):
                        request_id = body['id']
                    if (body.get('jsonrpc') != '2.0' or 'id' not in body
                            or (body['id'] is not None and type(body['id']) not in (str,int))):
                        raise InvalidRequestError()
                # SDK debug logging sees only sanitized data, never bearer strings.
                request._json = body
                request._body = json.dumps(body).encode()
                method = body.get('method') if rpc else operation
                params_dict = body.get('params', {}) if rpc else body
                allowed = {'SendMessage','SendStreamingMessage','GetTask','CancelTask','SubscribeToTask','ListTasks'}
                if method not in allowed:
                    raise MethodNotFoundError()
                from packaging.version import Version, InvalidVersion
                try:
                    if Version(request.headers.get('a2a-version', '0.3')).major != 1:
                        raise VersionNotSupportedError()
                except InvalidVersion:
                    raise VersionNotSupportedError() from None
                if not isinstance(params_dict, dict):
                    raise InvalidParamsError()
                if params_dict.get('tenant'):
                    raise UnsupportedOperationError('Tenant routing is unsupported')
                if method in ('SendMessage','SendStreamingMessage'):
                    params = ParseDict(params_dict, pb.SendMessageRequest())
                    await check_send(db, params, user)
                elif method != 'ListTasks':
                    task_id = params_dict.get('id') if rpc else request.path_params['id']
                    if not isinstance(task_id, str) or not task_id:
                        raise InvalidParamsError()
                    if rpc:
                        schema = {'GetTask':pb.GetTaskRequest, 'CancelTask':pb.CancelTaskRequest,
                                  'SubscribeToTask':pb.SubscribeToTaskRequest}[method]
                        ParseDict(params_dict, schema())
                    task, _ = await check_task(db, task_id, user, cancel=method=='CancelTask')
                    if method == 'SubscribeToTask' and task.status in TERMINAL_STATUSES:
                        if 'last-event-id' not in request.headers and 'after_seq' not in request.query_params:
                            raise UnsupportedOperationError('Terminal subscription requires a replay cursor')
                elif rpc:
                    ParseDict(params_dict, pb.ListTasksRequest())
            streaming = method in ('SendStreamingMessage','SubscribeToTask')
            if streaming:
                after = int(request.headers.get('last-event-id') or request.query_params.get('after_seq', '0'))
                if after < 0:
                    raise HTTPException(400, 'Invalid event cursor')
                started = time.monotonic()
                reservation = str(uuid.uuid4()) if method == 'SendStreamingMessage' else task_id
                try:
                    async with sse_session() as db:
                        lease = await quota_policy.acquire(db, user.id, reservation, HUB_ID)
                except QuotaExceeded:
                    data = ({'jsonrpc':'2.0', 'id':request_id, 'error':{
                        'code':-32603, 'message':'Stream limit reached',
                        'data':[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',
                                 'reason':'RESOURCE_EXHAUSTED','domain':'a2a-protocol.org'}]}} if rpc else {
                        'error':{'code':429, 'status':'RESOURCE_EXHAUSTED', 'message':'Stream limit reached'}})
                    return JSONResponse(data, status_code=429, headers={'Retry-After':'10'},
                                        media_type='application/json' if rpc else 'application/a2a+json')
                _streams[user.id] = _streams.get(user.id, 0) + 1  # Local observability only.
                released = False
                async def release_slot():
                    nonlocal released
                    if released:
                        return
                    released = True
                    remaining = _streams.get(user.id, 1) - 1
                    if remaining:
                        _streams[user.id] = remaining
                    else:
                        _streams.pop(user.id, None)
                    with anyio.move_on_after(SSE_DB_SECONDS + 1, shield=True):
                        try:
                            async with sse_session() as db:
                                await quota_policy.release(db, lease.lease_id, HUB_ID)
                        except (QuotaUnavailable, SQLAlchemyError, TimeoutError):
                            pass  # Expiry/sweep handles ambiguous or unavailable storage.
                try:
                    if method == 'SendStreamingMessage':
                        params.configuration.return_immediately = True  # Streaming never blocks on execution.
                        task = await handler.on_message_send(params, ContextBuilder().build(request))
                        task_id = task.id
                        async with sse_session() as db:
                            if not await quota_policy.bind_task(db, lease.lease_id, HUB_ID, task_id):
                                raise QuotaUnavailable()
                    async def stream():
                        try:
                            async for event in persisted_events(request, task_id, after, body.get('id'), rpc):
                                yield event
                        finally:
                            await release_slot()
                    return QuotaEventSourceResponse(stream(), release_slot=release_slot, lease=lease, valid_until=started + quota_policy.lease_seconds, ping=HEARTBEAT_SECONDS, send_timeout=5)
                except BaseException:
                    await release_slot()
                    raise
            return await endpoint(request)
        except HTTPException as exc:
            if exc.status_code == 400:
                return protocol_error(InvalidParamsError(), request_id, rpc)
            return JSONResponse({'detail':exc.detail}, status_code=exc.status_code)
        except A2AError as exc:
            return protocol_error(exc, request_id, rpc)
        except (ValueError, TypeError, AttributeError, ParseError):
            return protocol_error(InvalidParamsError(), request_id, rpc)
        except (SQLAlchemyError, QuotaUnavailable, TimeoutError):
            return JSONResponse({'detail':'Task storage unavailable'}, status_code=503)
    return entry


def protocol_error(error, request_id, rpc):
    if rpc:
        # SDK 1.2.2 omits JSONParseError from EXCEPTION_MAP. Use its generic
        # JSONRPCError model and authoritative code map rather than a literal -32603 model.
        model = JSONRPCError(code=JSON_RPC_ERROR_CODE_MAP.get(type(error), -32603),
                             message=error.message)
        return JSONResponse(build_error_response(request_id, model))
    if isinstance(error, JSONParseError):
        error = InvalidRequestError()
    payload = build_rest_error_payload(error)
    return JSONResponse(payload, status_code=payload['error']['code'], media_type='application/a2a+json')


def protocol_routes(handler):
    builder = ContextBuilder()
    routes = []
    for route in create_jsonrpc_routes(handler, '/a2a/rpc', context_builder=builder):
        routes.append(Route(route.path, guarded(route.endpoint, handler, None, rpc=True), methods=['POST']))
    operations = {'on_message_send':'SendMessage','on_message_send_stream':'SendStreamingMessage',
        'on_cancel_task':'CancelTask','on_subscribe_to_task':'SubscribeToTask','on_get_task':'GetTask','list_tasks':'ListTasks'}
    for route in create_rest_routes(handler, context_builder=builder, path_prefix='/a2a'):
        # No tenant mount, push URLs or extended card capabilities are exposed.
        if isinstance(route, Route) and route.endpoint.__name__ in operations:
            routes.append(Route(route.path, guarded(route.endpoint,handler,operations[route.endpoint.__name__]),methods=route.methods))
    return routes
