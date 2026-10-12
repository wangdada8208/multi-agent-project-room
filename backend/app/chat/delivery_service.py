"""Transactional delivery controls. Caller owns commit and sends only after commit."""
import re
import uuid
import base64
import json
from datetime import datetime, timedelta, timezone
from sqlalchemy import select, update, func
from app.models.agent_task_delivery import AgentTaskDelivery as Delivery
from app.models.user import User
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.chat.models import Message
from app.a2a.models import A2ATask
from app.a2a.task_service import TaskService, ACTIVE_STATUSES, _append_event, notify_task

LEASE_SECONDS = 60
PAGE_SIZE = 50

class DeliveryDenied(ValueError):
    pass

def slug(value):
    return re.sub(r"\s+", "_", value.strip().casefold())

def now():
    return datetime.now(timezone.utc)

def aware(value):
    return value.replace(tzinfo=timezone.utc) if value and value.tzinfo is None else value

async def validate_task(db, task, agent_id):
    agent = await db.get(User, agent_id, populate_existing=True)
    source = await db.get(Message, task.source_message_id) if task and task.source_message_id else None
    room = await db.get(Room, task.room_id) if task and task.room_id else None
    owner = await db.get(User, source.sender_id, populate_existing=True) if source else None
    if agent:
        target_slug = slug(agent.username)
        target_clean = agent.username.strip().lower()
        stmt = select(User).where(
            (func.lower(User.username) == target_clean)
            | (func.lower(func.replace(User.username, " ", "_")) == target_slug)
            | (User.id == agent_id)
        )
        identities = list((await db.execute(stmt)).scalars())
        matches = [identity for identity in identities if slug(identity.username) == target_slug]
    else:
        identities = []
        matches = []
    bound_owner = await db.get(User, agent.owner_user_id, populate_existing=True) if agent and agent.owner_user_id else None
    binding_permission = (await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == task.room_id, RoomPermission.user_id == bound_owner.id
    ))).scalar_one_or_none() if task and bound_owner else None
    unambiguous = len(matches) == 1 and matches[0].id == agent_id
    valid_binding = not agent or not agent.owner_user_id or (bound_owner and bound_owner.user_type == "human"
        and binding_permission and binding_permission.role in {"owner", "member"})
    permission = (await db.execute(select(RoomPermission).where(
        RoomPermission.room_id == task.room_id, RoomPermission.user_id == source.sender_id
    ))).scalar_one_or_none() if task and source else None
    if not (agent and agent.user_type == "agent" and unambiguous and valid_binding and task and task.target_agent
            and slug(task.target_agent) == slug(agent.username)
            and source and source.room_id == task.room_id and source.sender_type == "human"
            and owner and owner.user_type == "human" and permission and permission.role in {"owner", "member"}
            and room and room.is_active and room.transport == "hub"):
        raise DeliveryDenied()
    return agent, source

async def create_delivery(db, task, agent_id):
    await validate_task(db, task, agent_id)
    delivery = Delivery(task_id=task.id, message_id=task.source_message_id,
                        agent_user_id=agent_id, target_room=task.room_id)
    db.add(delivery)
    await db.flush()
    await _append_event(db, task.id, "delivery_created", {"delivery_id": delivery.delivery_id})
    return delivery

async def offer(db, delivery):
    task = await db.get(A2ATask, delivery.task_id, populate_existing=True)
    agent, source = await validate_task(db, task, delivery.agent_user_id)
    # Serialize dispatch with ACK/cancel/finish, then discard pre-lock snapshots.
    await db.execute(update(A2ATask).where(A2ATask.id == task.id).values(event_seq=A2ATask.event_seq))
    await db.refresh(task)
    await db.refresh(delivery)
    if task.status not in ACTIVE_STATUSES:
        return None
    stamp = now()
    changed = await db.execute(update(Delivery).execution_options(synchronize_session=False).where(
        Delivery.delivery_id == delivery.delivery_id, Delivery.state == "pending",
        Delivery.attempt == delivery.attempt,
    ).values(attempt=Delivery.attempt + 1, delivered_at=stamp, updated_at=stamp))
    if changed.rowcount != 1:
        return None
    await db.refresh(delivery)
    await notify_task(db, task.id)
    return {"v": 1, "type": "agent_task", "task_id": task.id,
            "delivery_id": delivery.delivery_id, "attempt": delivery.attempt,
            "deadline": (stamp + timedelta(seconds=LEASE_SECONDS)).isoformat(),
            "message_id": source.id, "content": source.content,
            "sender_id": source.sender_id, "sender_name": source.sender_name,
            "origin_room": task.room_id}

async def authorize(db, agent_id, raw):
    delivery = await db.get(Delivery, str(raw.get("delivery_id", "")), populate_existing=True)
    if not (delivery and delivery.agent_user_id == agent_id
            and delivery.task_id == raw.get("task_id")
            and delivery.target_room == raw.get("target_room")
            and type(raw.get("attempt")) is int and delivery.attempt == raw["attempt"]):
        raise DeliveryDenied()
    task = await db.get(A2ATask, delivery.task_id, populate_existing=True)
    if raw.get("type") == "task_cancel_ack" and task and task.status == "canceled":
        # Cleanup attestation contains no output and grants no new execution.
        # Room revocation must not prevent the original executor proving it stopped.
        agent = await db.get(User, agent_id, populate_existing=True)
        if not agent or agent.user_type != "agent":
            raise DeliveryDenied()
    else:
        await validate_task(db, task, agent_id)
    return delivery, task

async def control(db, agent_id, connection_id, raw):
    delivery, task = await authorize(db, agent_id, raw)
    await db.execute(update(A2ATask).where(A2ATask.id == task.id).values(event_seq=A2ATask.event_seq))
    await db.refresh(task)
    kind = raw["type"]
    if kind not in {"task_ack", "task_lease", "task_progress", "task_cancel_ack"}:
        raise DeliveryDenied()
    progress_event = None
    stamp = now()
    base = (Delivery.delivery_id == delivery.delivery_id, Delivery.attempt == delivery.attempt)
    if kind == "task_cancel_ack":
        # Only the connection that acquired execution can attest its cleanup.
        # A fresh socket cannot prove that a disconnected executor stopped.
        if delivery.ack_at is not None and delivery.lease_owner != connection_id:
            raise DeliveryDenied()
        if task.status != "canceled" or delivery.state not in {"canceled", "cancel_ack"}:
            raise DeliveryDenied()
        if delivery.state != "cancel_ack":
            changed = await db.execute(update(Delivery).execution_options(synchronize_session=False).where(*base, Delivery.state == "canceled").values(state="cancel_ack", updated_at=stamp))
            if changed.rowcount != 1:
                raise DeliveryDenied()
            await _append_event(db, task.id, "delivery_cancel_ack", {"delivery_id": delivery.delivery_id})
        return {"v": 1, "type": "task_cancel_ack_result", "accepted": True, "delivery_id": delivery.delivery_id}
    if task.status not in ACTIVE_STATUSES:
        raise DeliveryDenied()
    if kind == "task_ack" and delivery.state == "pending":
        if not delivery.delivered_at or aware(delivery.delivered_at) + timedelta(seconds=LEASE_SECONDS) <= stamp:
            raise DeliveryDenied()
        changed = await db.execute(update(Delivery).execution_options(synchronize_session=False).where(*base, Delivery.state == "pending").values(
            state="acked", ack_at=stamp, lease_until=stamp + timedelta(seconds=LEASE_SECONDS),
            lease_owner=connection_id, updated_at=stamp))
        if changed.rowcount != 1:
            raise DeliveryDenied()
        await TaskService.start_task(db, task.id)
        await _append_event(db, task.id, "delivery_acked", {"delivery_id": delivery.delivery_id})
    else:
        if not (delivery.state == "acked" and delivery.lease_owner == connection_id
                and aware(delivery.lease_until) and aware(delivery.lease_until) > stamp):
            raise DeliveryDenied()
        # Conditional write also serializes with cancellation and result transactions.
        changed = await db.execute(update(Delivery).execution_options(synchronize_session=False).where(*base, Delivery.state == "acked",
            Delivery.lease_owner == connection_id, Delivery.lease_until > stamp).values(
            updated_at=stamp, lease_until=stamp + timedelta(seconds=LEASE_SECONDS)))
        if changed.rowcount != 1:
            raise DeliveryDenied()
        if kind == "task_progress":
            phase = raw.get("phase")
            percent = raw.get("percent")
            if phase not in {"queued", "running", "waiting", "finishing"} or type(percent) is not int or not 0 <= percent <= 100:
                raise DeliveryDenied()
            # Cap audit frequency, independently of client behavior.
            from app.a2a.models import TaskEvent
            recent = (await db.execute(select(TaskEvent.created_at).where(
                TaskEvent.task_id == task.id, TaskEvent.event_type == "task_progress"
            ).order_by(TaskEvent.event_seq.desc()).limit(1))).scalar_one_or_none()
            if not recent or stamp - aware(recent) >= timedelta(seconds=5):
                event = await _append_event(db, task.id, "task_progress", {"phase": phase, "percent": percent})
                progress_event = {"task_id": task.id, "event_seq": event.event_seq,
                                  "phase": phase, "percent": percent}
    await db.refresh(delivery)
    await notify_task(db, task.id)
    response = {"v": 1, "type": kind + "_result", "accepted": True,
            "delivery_id": delivery.delivery_id, "task_id": task.id,
            "attempt": delivery.attempt, "deadline": aware(delivery.lease_until).isoformat()}
    if progress_event:
        response["event_seq"] = progress_event["event_seq"]
        response["progress"] = progress_event
    return response

async def cancel_deliveries(db, task_id):
    rows = list((await db.execute(select(Delivery).where(Delivery.task_id == task_id))).scalars())
    frames = []
    if not rows:
        task = await db.get(A2ATask, task_id)
        if task and task.status == "canceled" and task.target_agent:
            target = task.target_agent
            target_slug = slug(target)
            target_clean = target.strip().lower()
            stmt = select(User).where(
                User.user_type == "agent",
                (
                    (func.lower(User.username) == target_clean)
                    | (func.lower(func.replace(User.username, " ", "_")) == target_slug)
                    | (User.id == target)
                ),
            )
            agents = list((await db.execute(stmt)).scalars())
            matches = [agent for agent in agents if slug(agent.username) == target_slug]
            if len(matches) == 1:
                frames.append(("_agent_" + slug(matches[0].username), {
                    "type": "task_cancel", "task_id": task_id, "origin_room": task.room_id}))
    for delivery in rows:
        if delivery.state == "cancel_ack":
            continue
        await db.execute(update(Delivery).execution_options(synchronize_session=False).where(Delivery.delivery_id == delivery.delivery_id).values(
            state="canceled", canceled_at=now(), updated_at=now()))
        agent = await db.get(User, delivery.agent_user_id)
        if agent and agent.user_type == "agent":
            frames.append(("_agent_" + slug(agent.username), {
                "v": 1, "type": "task_cancel", "task_id": task_id,
                "delivery_id": delivery.delivery_id, "attempt": delivery.attempt,
                "origin_room": delivery.target_room}))
    if rows:
        await notify_task(db, task_id)
    return frames

async def resume(db, agent_id, cursor=""):
    """One pagination pass only; periodic discovery must restart from empty.

    UUID order is not insertion or commit order. Hub reconciliation never calls this
    method: explicit client resume may deliberately replace a pending offer attempt.
    """
    if not isinstance(cursor, str) or len(cursor) > 512:
        raise DeliveryDenied()
    upper = None
    after = cursor
    if cursor:
        try:
            if cursor.startswith("snap1:"):
                data = json.loads(base64.urlsafe_b64decode(cursor[6:]))
                if set(data) != {"agent", "after", "upper"} or data["agent"] != agent_id:
                    raise ValueError()
                after, upper = data["after"], data["upper"]
                if str(uuid.UUID(upper)) != upper or after > upper:
                    raise ValueError()
            if str(uuid.UUID(after)) != after:
                raise ValueError()
        except (ValueError, TypeError, AttributeError, KeyError):
            raise DeliveryDenied()
    agent = await db.get(User, agent_id, populate_existing=True)
    if not agent or agent.user_type != "agent":
        raise DeliveryDenied()
    if upper is None:
        upper = (await db.execute(select(func.max(Delivery.delivery_id)).where(
            Delivery.agent_user_id == agent_id))).scalar() or ""
    rows = list((await db.execute(select(Delivery).where(
        Delivery.agent_user_id == agent_id, Delivery.delivery_id > after,
        Delivery.delivery_id <= upper
    ).order_by(Delivery.delivery_id).limit(PAGE_SIZE + 1).execution_options(populate_existing=True))).scalars())
    frames = []
    for delivery in rows[:PAGE_SIZE]:
        task = await db.get(A2ATask, delivery.task_id, populate_existing=True)
        try:
            await validate_task(db, task, agent_id)
        except DeliveryDenied:
            continue
        await db.execute(update(A2ATask).where(A2ATask.id == task.id).values(event_seq=A2ATask.event_seq))
        await db.refresh(task)
        await db.refresh(delivery)
        if task.status == "canceled" and delivery.state != "cancel_ack":
            frames.extend(frame for _, frame in await cancel_deliveries(db, task.id))
        elif delivery.state == "pending":
            frame = await offer(db, delivery)
            if frame:
                frames.append(frame)
        elif (task.status in ACTIVE_STATUSES and delivery.state == "acked"
              and aware(delivery.lease_until) <= now()):
            frame = await expire_delivery(db, delivery.delivery_id)
            if frame:
                frames.append(frame)
    next_cursor = None
    if len(rows) > PAGE_SIZE:
        data = {"agent": agent_id, "after": rows[PAGE_SIZE - 1].delivery_id, "upper": upper}
        next_cursor = "snap1:" + base64.urlsafe_b64encode(json.dumps(data, separators=(",", ":")).encode()).decode()
    return frames, next_cursor

async def expire_delivery(db, delivery_id, stamp=None):
    """Caller owns transaction. Parent lock and CAS make concurrent sweepers idempotent.

    Housekeeping intentionally does not require a live runner or current room permissions.
    No output is persisted, no unknown external action is restarted.
    """
    stamp = stamp or now()
    delivery = await db.get(Delivery, delivery_id, populate_existing=True)
    if not delivery:
        return None
    locked = await db.execute(update(A2ATask).where(A2ATask.id == delivery.task_id).values(
        event_seq=A2ATask.event_seq))
    if locked.rowcount != 1:
        return None
    task = await db.get(A2ATask, delivery.task_id, populate_existing=True)
    if task.status not in ACTIVE_STATUSES:
        return None
    changed = await db.execute(update(Delivery).execution_options(synchronize_session=False).where(
        Delivery.delivery_id == delivery_id, Delivery.state == "acked",
        Delivery.lease_until <= stamp,
    ).values(state="uncertain", updated_at=stamp))
    if changed.rowcount != 1:
        return None
    await TaskService.pause_task(db, task.id, "lease_expired")
    await _append_event(db, task.id, "delivery_uncertain", {"reason": "lease_expired"})
    return {"v": 1, "type": "task_uncertain", "task_id": task.id,
            "delivery_id": delivery_id, "attempt": delivery.attempt}

async def finish(db, agent_id, connection_id, raw, content, message_kind):
    """Serialize result with cancellation before persisting or broadcasting any body."""
    delivery, task = await authorize(db, agent_id, raw)
    await db.execute(update(A2ATask).where(A2ATask.id == task.id).values(event_seq=A2ATask.event_seq))
    stamp = now()
    changed = await db.execute(update(Delivery).execution_options(synchronize_session=False).where(
        Delivery.delivery_id == delivery.delivery_id, Delivery.state == "acked",
        Delivery.lease_owner == connection_id, Delivery.lease_until > stamp,
        Delivery.attempt == raw["attempt"],
    ).values(state="completed", updated_at=stamp))
    if changed.rowcount != 1:
        raise DeliveryDenied()
    # TaskService obtains the task row write lock in this same transaction.
    _, _, result = await TaskService.complete_task(db, task.id, [{"type": message_kind, "content": content}])
    if result != "completed":
        raise DeliveryDenied()
    message = Message(room_id=task.room_id, sender_id=agent_id, sender_type="agent",
                      sender_name=(await db.get(User, agent_id)).username, content=content,
                      msg_type=message_kind, parent_id=delivery.message_id)
    db.add(message)
    await db.flush()
    return message

async def finish_legacy(db, agent_id, task_id, target_room, content, message_kind):
    """Unversioned existing tasks retain permissions, but result/body commit is atomic."""
    task = await db.get(A2ATask, task_id, populate_existing=True)
    await validate_task(db, task, agent_id)
    if task.room_id != target_room:
        raise DeliveryDenied()
    _, _, result = await TaskService.complete_task(db, task_id, [{"type": message_kind, "content": content}])
    if result != "completed":
        raise DeliveryDenied()
    message = Message(room_id=task.room_id, sender_id=agent_id, sender_type="agent",
                      sender_name=(await db.get(User, agent_id)).username,
                      content=content, msg_type=message_kind, parent_id=task.source_message_id)
    db.add(message)
    await db.flush()
    return message
