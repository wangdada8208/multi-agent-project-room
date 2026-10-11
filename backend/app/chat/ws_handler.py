"""WebSocket chat handler with PostgreSQL persistence and auth.

Message flow:
  Client sends JSON → server persists to DB → server broadcasts to room

Cross-room @mention flow:
  User sends "@Claude ..." in Room A
    → backend saves + broadcasts to Room A
    → backend detects @Claude
    → backend forwards as agent_task to _agent_claude channel
    → adapter (on _agent_claude) receives, processes
    → adapter responds with target_room=Room A
    → backend routes response to Room A
"""

import json
import logging
import re
import uuid

from app.chat import delivery_service as ds
from app.models.agent_task_delivery import AgentTaskDelivery
from app.a2a.task_service import TaskService

from fastapi import WebSocket, WebSocketDisconnect, Query
from sqlalchemy import select, func

from app.core.database import async_session
from app.core.security import decode_access_token
from app.chat import service as chat_service
from app.a2a import task_manager as tm
from app.ws.connection_manager import connection_manager
from app.models.room import Room
from app.models.agent_card import AgentCardRecord
from app.models.user import User
from app.models.room_permission import RoomPermission
from app.a2a.models import A2ATask
from app.chat.models import Message

logger = logging.getLogger(__name__)


MAX_FRAME_BYTES = 65536

class FrameRejected(ValueError):
    def __init__(self, code):
        self.code = code


def delivery_denied_frame(raw):
    frame = {"type": "error", "code": "delivery_denied", "delivery_id": raw.get("delivery_id")}
    attempt = raw.get("attempt")
    if type(attempt) is int and 0 < attempt <= 2147483647:
        frame["attempt"] = attempt
    return frame


async def _receive_frame(websocket):
    # Read raw ASGI data and enforce bytes before allocating a parsed JSON object.
    # Lightweight legacy test doubles may expose only receive_json().
    if not hasattr(websocket, "receive"):
        return await websocket.receive_json()
    frame = await websocket.receive()
    if frame["type"] == "websocket.disconnect":
        raise WebSocketDisconnect(code=frame.get("code", 1000))
    body = frame.get("text")
    if body is None:
        body = frame.get("bytes") or b""
    size = len(body.encode("utf-8")) if isinstance(body, str) else len(body)
    if size > MAX_FRAME_BYTES:
        raise FrameRejected("frame_too_large")
    try:
        return json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise FrameRejected("invalid_frame") from None


def _agent_slug(value: str) -> str:
    """Normalize an account/Agent name for the private channel convention."""
    return re.sub(r"\s+", "_", value.strip().casefold())


def _find_mentioned_agents(content: str, agent_names: set[str]) -> list[str]:
    """Case-insensitive @mention detection with boundary guard."""
    content_lower = content.lower()
    mentioned = []
    sorted_names = sorted(agent_names, key=len, reverse=True)
    for name in sorted_names:
        escaped = re.escape(name.lower())
        pattern = rf"@{escaped}(?:(?=[^a-zA-Z0-9_-])|$)"
        if re.search(pattern, content_lower):
            mentioned.append(name)
    return mentioned


async def _get_active_agent_names(room_id: str | None = None) -> set[str]:
    """Query active agent names from both AgentCardRecord and WebSocket connections."""
    active_names = connection_manager.get_online_agent_names(room_id)
    async with async_session() as db:
        if connection_manager.room_sync and room_id:
            from app.models.room_presence import RoomPresence
            names = (await db.execute(select(User.username).join(RoomPresence, RoomPresence.user_id == User.id)
                .join(RoomPermission, (RoomPermission.room_id == RoomPresence.room_id)
                      & (RoomPermission.user_id == User.id))
                .where(RoomPresence.room_id == room_id, RoomPresence.lease_until > func.current_timestamp(),
                       User.user_type == "agent", RoomPermission.role.in_(("viewer", "member", "owner"))))).scalars()
            active_names.update(names)
        result = await db.execute(
            select(AgentCardRecord.agent_name).where(
                AgentCardRecord.is_active == True
            )
        )
        for row in result.fetchall():
            if row[0]:
                active_names.add(row[0])
    return active_names


async def _check_mentions_and_forward(
    source_room_id: str,
    message,
    content: str,
) -> None:
    """Detect @mentions and forward agent_task messages to agent channels."""
    agent_names = await _get_active_agent_names(source_room_id)
    mentioned = _find_mentioned_agents(content, agent_names)
    if not mentioned:
        return

    for agent_name in mentioned:
        async with async_session() as db:
            agents = list((await db.execute(select(User).where(User.user_type == "agent"))).scalars())
            matches = [agent for agent in agents if _agent_slug(agent.username) == _agent_slug(agent_name)]
            if len(matches) != 1:
                continue
            agent = matches[0]
            # Do not create a task for an invalid/revoked source or an encrypted room.
            provisional = A2ATask(target_agent=agent.username, room_id=source_room_id,
                                  source_message_id=message.id)
            try:
                await ds.validate_task(db, provisional, agent.id)
            except ds.DeliveryDenied:
                continue
            task, _ = await TaskService.create_task(db, query=content, target_agent=agent.username,
                source_agent=message.sender_id, room_id=source_room_id, source_message_id=message.id)
            delivery = await ds.create_delivery(db, task, agent.id)
            channel = "_agent_" + _agent_slug(agent.username)
            if await db.get(Room, channel) is None:
                db.add(Room(id=channel, name=f"Agent Channel {agent.username}", transport="hub", is_active=False))
                await db.flush()
            # Keep the historical hidden task marker, containing IDs only, in the same transaction.
            db.add(Message(room_id=channel, sender_id=message.sender_id, sender_type="system",
                msg_type="task", parent_id=message.id, content=json.dumps({
                    "task_id": task.id, "delivery_id": delivery.delivery_id,
                    "original_id": message.id, "origin_room": source_room_id})))
            frame = await ds.offer(db, delivery)
            await db.commit()
        if frame:
            await connection_manager.broadcast("_agent_" + _agent_slug(agent.username), frame)


async def persist_incoming_message(
    room_id: str,
    sender_id: str,
    sender_type: str,
    sender_name: str | None,
    content: str,
    msg_type: str,
    parent_id: str | None,
    client_message_id: str | None = None,
):
    from app.chat.plaintext_guard import PlaintextStorageForbidden

    async with async_session() as db:
        room = await db.get(Room, room_id)
        if room is None:
            if not room_id.startswith("_agent_"):
                room = Room(
                    id=room_id,
                    name=f"Room {room_id[:8]}",
                    transport="xmtp",
                )
                db.add(room)
                await db.commit()
                return None
            room = await chat_service.get_or_create_room(
                db, room_id, name=f"Room {room_id[:8]}"
            )
        if room.transport == "xmtp":
            return None
        return await chat_service.save_message(
            db=db,
            room_id=room_id,
            sender_id=sender_id,
            sender_type=sender_type,
            sender_name=sender_name,
            content=content,
            msg_type=msg_type,
            parent_id=parent_id,
            client_message_id=client_message_id,
        )


async def handle_chat(websocket: WebSocket, room_id: str, token: str = Query(default=""), message_cursor: str = "0") -> None:
    """WebSocket endpoint for a chat room.

    Requires ?token=<access_token> query parameter for authentication.
    """
    # ── Authenticate before accepting connection ──
    try:
        payload = decode_access_token(token)
    except Exception:
        await websocket.close(code=4001, reason="Authentication required")
        return

    authenticated_user_id = payload.get("sub", "")
    token_user_type = payload.get("typ")

    # Resolve identity and authorization before accepting or announcing presence.
    user = None
    role = None
    is_agent_channel = room_id.startswith("_agent_")
    async with async_session() as db:
        user = await db.get(User, authenticated_user_id)
        if user is None or token_user_type != user.user_type:
            await websocket.close(code=4003, reason="User identity is not authorized")
            return

        if is_agent_channel:
            requested_slug = _agent_slug(room_id[len("_agent_"):])
            matches = (await db.execute(
                select(User)
            )).scalars().all()
            matching_users = [candidate for candidate in matches
                              if _agent_slug(candidate.username) == requested_slug]
            if (user.user_type != "agent" or not requested_slug
                    or len(matching_users) != 1 or matching_users[0].id != user.id):
                await websocket.close(code=4003, reason="Agent channel access denied")
                return
            resolved = await chat_service.resolve_room(db, room_id)
            if resolved:
                room_id = resolved.id
        else:
            resolved = await chat_service.resolve_room(db, room_id)
            if resolved is None or not resolved.is_active:
                await websocket.close(code=4003, reason="Room not found")
                return
            room_id = resolved.id
            permission = await db.execute(
                select(RoomPermission).where(
                    RoomPermission.room_id == room_id,
                    RoomPermission.user_id == user.id,
                )
            )
            permission = permission.scalar_one_or_none()
            if permission is None or permission.role not in {"viewer", "member", "owner"}:
                await websocket.close(code=4003, reason="Room access denied")
                return
            role = permission.role

    authenticated_transport = resolved.transport if not is_agent_channel else "hub"
    authenticated_user_type = user.user_type
    authenticated_sender_id = user.id
    authenticated_sender_name = user.username if user.user_type == "agent" else user.display_name

    async def authorize_outbound():
        # Idle sockets must lose subscriptions too, even without another inbound frame.
        claims = decode_access_token(token)
        async with async_session() as db:
            actor = await db.get(User, authenticated_user_id)
            if not (actor and actor.user_type == authenticated_user_type
                    and claims.get("sub") == actor.id and claims.get("typ") == actor.user_type):
                return False
            if is_agent_channel:
                identities = (await db.execute(select(User))).scalars().all()
                matches = [item for item in identities if _agent_slug(item.username) == _agent_slug(actor.username)]
                return (actor.user_type == "agent" and len(matches) == 1
                        and room_id == "_agent_" + _agent_slug(actor.username))
            room = await db.get(Room, room_id)
            permission = (await db.execute(select(RoomPermission).where(
                RoomPermission.room_id == room_id, RoomPermission.user_id == actor.id))).scalar_one_or_none()
            return bool(room and room.is_active and room.transport == authenticated_transport
                        and permission and permission.role in {"viewer", "member", "owner"})

    # Cursor is scoped to this authorized room, never UUID/time or another room.
    try:
        initial_cursor = int(message_cursor)
        if initial_cursor < 0 or initial_cursor > 2**63 - 1:
            raise ValueError()
        if not is_agent_channel:
            async with async_session() as db:
                cursor_room = await db.get(Room, room_id)
                if not cursor_room or initial_cursor > cursor_room.message_seq:
                    raise ValueError()
    except (ValueError, TypeError):
        await websocket.close(code=4003, reason="Invalid message cursor")
        return
    connection_id = str(uuid.uuid4())
    await connection_manager.connect(room_id, websocket)
    logger.info("ws connected room=%s user=%s", room_id[:8], authenticated_user_id[:8])
    connection_manager.set_authorization_check(websocket, authorize_outbound)
    connection_manager.register(websocket, room_id, authenticated_user_id, connection_id)
    if connection_manager.room_sync and not is_agent_channel:
        connection_manager.room_sync.set_cursor(websocket, initial_cursor)
    else:
        await connection_manager.send_checked(websocket, {
            "type": "presence_snapshot", "participants": connection_manager.presence_snapshot(room_id)})
    await connection_manager.broadcast(room_id, {"type": "system", "content": "A participant joined the room."})

    try:
        while True:
            try:
                raw = await _receive_frame(websocket)
            except FrameRejected as error:
                await connection_manager.send_checked(websocket, {"type": "error", "code": error.code})
                continue
            if not isinstance(raw, dict) or len(json.dumps(raw).encode("utf-8")) > 65536:
                await connection_manager.send_checked(websocket, {"type": "error", "code": "frame_too_large"})
                continue
            msg_type = raw.get("type", "")
            # Apply the same live JWT/account check to control, message and cancel frames.
            try:
                live_claims = decode_access_token(token)
                async with async_session() as db:
                    live_user = await db.get(User, authenticated_user_id, populate_existing=True)
                    valid_identity = bool(live_user and live_user.user_type == authenticated_user_type
                        and live_claims.get("sub") == authenticated_user_id
                        and live_claims.get("typ") == authenticated_user_type)
                if not valid_identity:
                    raise ValueError()
            except Exception:
                await websocket.close(code=4003, reason="Authentication no longer valid")
                raise WebSocketDisconnect(code=4003)
            if msg_type == "messages_resume":
                cursor = raw.get("after_seq", 0)
                valid = type(cursor) is int and 0 <= cursor <= 2**63 - 1
                if valid and not is_agent_channel and connection_manager.room_sync and await authorize_outbound():
                    async with async_session() as db:
                        current_room = await db.get(Room, room_id)
                        valid = bool(current_room and cursor <= current_room.message_seq)
                    if valid:
                        connection_manager.room_sync.set_cursor(websocket, cursor)
                        continue
                await connection_manager.send_checked(websocket, {"type": "error", "code": "invalid_message_cursor"})
                continue
            if msg_type == "task_events":
                try:
                    after_seq, limit = raw.get("after_seq", 0), raw.get("limit", 100)
                    if (is_agent_channel or type(raw.get("v", 1)) is not int or raw.get("v", 1) != 1
                            or type(after_seq) is not int or after_seq < 0
                            or type(limit) is not int or not 1 <= limit <= 100):
                        raise ds.DeliveryDenied()
                    async with async_session() as db:
                        task = await db.get(A2ATask, str(raw.get("task_id", "")))
                        room = await db.get(Room, room_id)
                        permission = (await db.execute(select(RoomPermission).where(
                            RoomPermission.room_id == room_id,
                            RoomPermission.user_id == authenticated_user_id))).scalar_one_or_none()
                        if not (task and task.room_id == room_id and room and room.is_active
                                and permission and permission.role in {"viewer", "member", "owner"}):
                            raise ds.DeliveryDenied()
                        events = await TaskService.get_task_events(db, task.id, after_seq, limit)
                        response = {"v": 1, "type": "task_events_result", "task_id": task.id,
                            "events": [{"event_seq": e.event_seq, "event_type": e.event_type,
                                        "payload": e.payload, "created_at": ds.aware(e.created_at).isoformat()}
                                       for e in events],
                            "next_seq": events[-1].event_seq if events else after_seq}
                    await connection_manager.send_checked(websocket, response)
                except (ds.DeliveryDenied, TypeError, ValueError):
                    await connection_manager.send_checked(websocket, {"type": "error", "code": "delivery_denied"})
                continue
            if msg_type in {"task_ack", "task_lease", "task_progress", "task_cancel_ack", "task_resume"}:
                try:
                    if not is_agent_channel or raw.get("v", 1) != 1:
                        raise ds.DeliveryDenied()
                    try:
                        current_claims = decode_access_token(token)
                    except Exception:
                        raise ds.DeliveryDenied() from None
                    if current_claims.get("sub") != authenticated_user_id or current_claims.get("typ") != "agent":
                        raise ds.DeliveryDenied()
                    async with async_session() as db:
                        current = await db.get(User, authenticated_user_id, populate_existing=True)
                        if not current or current.user_type != "agent" or "_agent_" + _agent_slug(current.username) != room_id:
                            raise ds.DeliveryDenied()
                        if msg_type == "task_resume":
                            frames, cursor = await ds.resume(db, current.id, raw.get("cursor", ""))
                            response = {"v": 1, "type": "task_resume_result", "cursor": cursor, "cursor_mode": "snapshot", "rescan_from": ""}
                        else:
                            response = await ds.control(db, current.id, connection_id, raw)
                            frames = []
                        progress = response.pop("progress", None)
                        progress_room = raw.get("target_room")
                        await db.commit()
                    for frame in frames:
                        await connection_manager.send_checked(websocket, frame)
                    await connection_manager.send_checked(websocket, response)
                    if progress:
                        await connection_manager.broadcast(progress_room, {"v": 1, "type": "task_progress", **progress})
                except (ds.DeliveryDenied, TypeError, ValueError):
                    await connection_manager.send_checked(websocket, delivery_denied_frame(raw))
                continue
            if msg_type == "task_cancel":
                try:
                    if is_agent_channel:
                        raise ds.DeliveryDenied()
                    async with async_session() as db:
                        actor = await db.get(User, authenticated_user_id, populate_existing=True)
                        permission = (await db.execute(select(RoomPermission).where(
                            RoomPermission.room_id == room_id, RoomPermission.user_id == authenticated_user_id
                        ))).scalar_one_or_none()
                        task = await db.get(A2ATask, str(raw.get("task_id", "")))
                        source = await db.get(Message, task.source_message_id) if task and task.source_message_id else None
                        if not (actor and actor.user_type == "human" and permission
                                and (permission.role == "owner" or (permission.role == "member" and source and source.sender_id == actor.id))
                                and task and task.room_id == room_id):
                            raise ds.DeliveryDenied()
                    result = await tm.cancel_task(task.id)
                    await connection_manager.send_checked(websocket, {"v": 1, "type": "task_cancel_result", **result})
                except ds.DeliveryDenied:
                    await connection_manager.send_checked(websocket, {"type": "error", "code": "delivery_denied"})
                continue

            # ── Heartbeat ──
            if msg_type == "ping":
                await connection_manager.send_checked(websocket, {"type": "pong"})
                continue

            # ── Presence identity (must match authenticated user) ──
            if msg_type == "identify":
                participant = await connection_manager.identify(room_id, websocket, {
                    "sender_id": authenticated_sender_id,
                    "sender_type": authenticated_user_type,
                    "sender_name": authenticated_sender_name,
                })
                await connection_manager.broadcast(
                    room_id,
                    {"type": "user_online", "participant": participant},
                )
                await connection_manager.broadcast(
                    room_id,
                    {
                        "type": "presence_snapshot",
                        "participants": connection_manager.presence_snapshot(room_id),
                    },
                )
                continue

            # ── Typing indicator ──
            if msg_type == "typing":
                if role == "viewer":
                    continue
                await connection_manager.broadcast(
                    room_id,
                    {"type": "typing", "sender_id": authenticated_user_id},
                )
                continue

            # ── Chat message ──
            if msg_type == "message":
                if not is_agent_channel:
                    async with async_session() as db:
                        actor = await db.get(User, authenticated_user_id, populate_existing=True)
                        current_permission = (await db.execute(select(RoomPermission).where(
                            RoomPermission.room_id == room_id, RoomPermission.user_id == authenticated_user_id
                        ))).scalar_one_or_none()
                        if not actor or actor.user_type != authenticated_user_type or not current_permission:
                            await connection_manager.send_checked(websocket, {"type": "error", "code": "room_access_denied"})
                            continue
                        role = current_permission.role
                if role not in {"owner", "member"} and not is_agent_channel:
                    await connection_manager.send_checked(websocket, {"type": "error", "code": "read_only", "message": "Viewer access is read-only"})
                    continue
                participant = await connection_manager.identify(room_id, websocket, {
                    "sender_id": authenticated_sender_id,
                    "sender_type": authenticated_user_type,
                    "sender_name": authenticated_sender_name,
                })
                content = str(raw.get("content", "")).strip()
                if not content:
                    await connection_manager.send_checked(websocket,
                        {"type": "error", "message": "content is required"}
                    )
                    continue

                requested_target = raw.get("target_room")
                task_id = raw.get("task_id")
                if is_agent_channel:
                    if not task_id or not requested_target:
                        await connection_manager.send_checked(websocket, {"type": "error", "code": "task_required", "message": "Agent channel replies require a task and target room"})
                        continue
                    target_room = str(requested_target)
                    async with async_session() as db:
                        task = await db.get(A2ATask, str(task_id))
                        target = await chat_service.resolve_room(db, target_room)
                        source_message = await db.get(Message, task.source_message_id) if task and task.source_message_id else None
                        source_permission = None
                        if source_message is not None:
                            perm_result = await db.execute(select(RoomPermission).where(
                                RoomPermission.room_id == source_message.room_id,
                                RoomPermission.user_id == source_message.sender_id,
                            ))
                            source_permission = perm_result.scalar_one_or_none()
                        valid_task = bool(
                            task
                            and task.status in tm.ACTIVE_TASK_STATUSES
                            and task.room_id == target_room
                            and target is not None
                            and target.is_active
                            and task.target_agent
                            and _agent_slug(task.target_agent) == _agent_slug(user.username)
                            and source_message is not None
                            and source_message.room_id == task.room_id
                            and source_message.sender_type == "human"
                            and source_permission is not None
                            and source_permission.role in {"owner", "member"}
                        )
                    if not valid_task:
                        await connection_manager.send_checked(websocket, {"type": "error", "code": "task_not_authorized", "message": "Task or target room is not authorized"})
                        continue
                else:
                    if requested_target is not None and str(requested_target) != room_id:
                        await connection_manager.send_checked(websocket, {"type": "error", "code": "cross_room_denied", "message": "Messages are limited to the connected room"})
                        continue
                    if task_id:
                        await connection_manager.send_checked(websocket, {"type": "error", "code": "task_not_authorized", "message": "Task completion is only accepted from the matching agent channel"})
                        continue
                    target_room = room_id

                message_kind = "text"
                if is_agent_channel:
                    message_kind = raw.get("msg_type")
                    if message_kind not in {"report", "text"}:
                        message_kind = "report"
                if is_agent_channel:
                    async with async_session() as db:
                        delivery = (await db.execute(select(AgentTaskDelivery).where(
                            AgentTaskDelivery.task_id == str(task_id)
                        ))).scalar_one_or_none()
                        try:
                            if delivery is not None:
                                message = await ds.finish(db, authenticated_user_id, connection_id, raw, content, message_kind)
                            else:
                                if raw.get("v") == 1:
                                    raise ds.DeliveryDenied()
                                message = await ds.finish_legacy(db, authenticated_user_id, str(task_id), target_room, content, message_kind)
                            completed_task = await db.get(A2ATask, str(task_id), populate_existing=True)
                            await db.commit()
                        except ds.DeliveryDenied:
                            await db.rollback()
                            await connection_manager.send_checked(websocket, delivery_denied_frame(raw))
                            continue
                        await connection_manager.broadcast(target_room, {"type": "message", "message": message.to_dict()})
                        await tm._broadcast_task_update(completed_task)
                        if delivery:
                            await connection_manager.send_checked(websocket, {"v": 1, "type": "task_result_ack", "delivery_id": delivery.delivery_id})
                        continue
                client_key = raw.get("client_message_id")
                if client_key is not None and (not isinstance(client_key, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", client_key)):
                    await connection_manager.send_checked(websocket, {"type": "error", "code": "invalid_message_key"})
                    continue
                try:
                    message = await persist_incoming_message(
                        room_id=target_room,
                        sender_id=authenticated_sender_id,
                        sender_type=authenticated_user_type,
                        sender_name=authenticated_sender_name,
                        content=content,
                        msg_type=message_kind,
                        parent_id=raw.get("parent_id"),
                        **({"client_message_id": client_key} if client_key is not None else {}),
                    )
                except ValueError:
                    await connection_manager.send_checked(websocket, {"type": "error", "code": "message_key_conflict"})
                    continue
                if message is None:
                    await connection_manager.send_checked(websocket,
                        {"type": "error", "code": "body_not_on_hub", "message": "加密房间的正文不经过 Hub"}
                    )
                    continue

                await connection_manager.broadcast(
                    target_room,
                    {"type": "message", "message": message.to_dict()},
                )

                if client_key is not None:
                    await connection_manager.send_checked(websocket, {"type": "message_ack",
                        "client_message_id": client_key, "id": message.id, "room_seq": message.room_seq})
                if not room_id.startswith("_agent_") and not getattr(message, "replayed", False):
                    await _check_mentions_and_forward(
                        target_room, message, content
                    )

    except WebSocketDisconnect:
        participant = connection_manager.disconnect(room_id, websocket)
        logger.info("ws disconnected room=%s", room_id[:8])
        if participant:
            await connection_manager.broadcast(
                room_id,
                {"type": "user_offline", "participant": participant},
            )
        await connection_manager.broadcast(
            room_id,
            {
                "type": "presence_snapshot",
                "participants": connection_manager.presence_snapshot(room_id),
            },
        )
        await connection_manager.broadcast(
            room_id,
            {"type": "system", "content": "A participant left the room."},
        )
    except Exception as e:
        participant = connection_manager.disconnect(room_id, websocket)
        logger.error("ws error room=%s; details suppressed", room_id[:8])
        if participant:
            await connection_manager.broadcast(
                room_id,
                {"type": "user_offline", "participant": participant},
            )
        await connection_manager.broadcast(
            room_id,
            {
                "type": "presence_snapshot",
                "participants": connection_manager.presence_snapshot(room_id),
            },
        )
        await connection_manager.broadcast(
            room_id,
            {"type": "system", "content": "Connection error"},
        )
