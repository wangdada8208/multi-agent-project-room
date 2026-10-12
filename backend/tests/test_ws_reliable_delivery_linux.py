"""Reliable WS controls must fail closed on the original implementation."""
import pytest
from test_ws_authz_linux import FakeWebSocket, _create_test_user
from app.chat.ws_handler import handle_chat

@pytest.mark.asyncio
async def test_unknown_ack_is_explicitly_rejected(db):
    agent, token = await _create_test_user(db, "reliable_bot", "agent")
    ws = FakeWebSocket([{"v": 1, "type": "task_ack", "task_id": "unknown",
                         "delivery_id": "unknown", "target_room": "unknown", "attempt": 1}])
    await handle_chat(ws, "_agent_reliable_bot", token=token)
    assert any(m.get("type") == "error" and m.get("code") == "delivery_denied"
               for m in ws.sent_messages)

import importlib.util
from pathlib import Path
from datetime import timedelta
from sqlalchemy import select, update, create_engine, inspect
from alembic.migration import MigrationContext
from alembic.operations import Operations
from app.chat import delivery_service as ds
from app.models.agent_task_delivery import AgentTaskDelivery as Delivery
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.chat.service import save_message
from app.chat.models import Message
from app.a2a.models import A2ATask, TaskEvent
from app.a2a.task_service import TaskService
from app.a2a import task_manager as tm
from app.ws.connection_manager import connection_manager

async def rollback_restore(db):
    await db.rollback()
    for item in list(db.identity_map.values()):
        await db.refresh(item)

async def setup_delivery(db):
    owner, owner_token = await _create_test_user(db, "delivery_owner")
    agent, token = await _create_test_user(db, "delivery_bot", "agent")
    room = Room(name="Delivery room", transport="hub", created_by=owner.id)
    db.add(room)
    await db.flush()
    db.add(RoomPermission(room_id=room.id, user_id=owner.id, role="owner"))
    await db.commit()
    source = await save_message(db, room.id, owner.id, "human", content="@delivery_bot run", msg_type="text")
    task, _ = await TaskService.create_task(db, query=source.content, target_agent=agent.username,
                                           room_id=room.id, source_message_id=source.id)
    delivery = await ds.create_delivery(db, task, agent.id)
    frame = await ds.offer(db, delivery)
    await db.commit()
    raw = {"v": 1, "type": "task_ack", "delivery_id": delivery.delivery_id,
           "task_id": task.id, "attempt": frame["attempt"], "target_room": room.id}
    return owner, owner_token, agent, token, room, task, delivery, raw

@pytest.mark.asyncio
async def test_lost_ack_replay_persists_and_fences_old_attempt(db):
    _, _, agent, _, _, task, delivery, raw = await setup_delivery(db)
    frames, cursor = await ds.resume(db, agent.id)
    await db.commit()
    assert cursor is None and len(frames) == 1
    assert frames[0]["task_id"] == task.id and frames[0]["attempt"] == 2
    with pytest.raises(ds.DeliveryDenied):
        await ds.control(db, agent.id, "first-connection", raw)
    await rollback_restore(db)
    raw["attempt"] = 2
    result = await ds.control(db, agent.id, "second-connection", raw)
    await db.commit()
    assert result["accepted"]
    assert (await ds.resume(db, agent.id))[0] == []

@pytest.mark.asyncio
async def test_duplicate_ack_same_connection_only(db):
    _, _, agent, _, _, task, _, raw = await setup_delivery(db)
    await ds.control(db, agent.id, "conn", raw)
    await db.commit()
    await ds.control(db, agent.id, "conn", raw)
    await db.commit()
    events = await TaskService.get_task_events(db, task.id)
    assert sum(e.event_type == "delivery_acked" for e in events) == 1
    with pytest.raises(ds.DeliveryDenied):
        await ds.control(db, agent.id, "another-connection", raw)
    await rollback_restore(db)

@pytest.mark.parametrize("mutation", ["agent", "room", "task", "attempt", "source_role", "encrypted", "user_type", "target"])
@pytest.mark.asyncio
async def test_controls_reject_identity_room_and_state_spoof(db, mutation):
    owner, _, agent, _, room, task, _, raw = await setup_delivery(db)
    agent_id = agent.id
    if mutation == "agent":
        attacker, _ = await _create_test_user(db, "second_bot", "agent")
        agent_id = attacker.id
    elif mutation == "room": raw["target_room"] = "other-room"
    elif mutation == "task": raw["task_id"] = task.source_message_id
    elif mutation == "attempt": raw["attempt"] = 0
    elif mutation == "source_role":
        await db.execute(update(RoomPermission).where(RoomPermission.user_id == owner.id).values(role="viewer"))
    elif mutation == "encrypted": room.transport = "xmtp"
    elif mutation == "user_type": agent.user_type = "human"
    elif mutation == "target": task.target_agent = "another"
    await db.commit()
    with pytest.raises(ds.DeliveryDenied):
        await ds.control(db, agent_id, "conn", raw)
    await rollback_restore(db)

@pytest.mark.asyncio
async def test_expired_lease_cannot_revive_and_no_blind_reexecution(db):
    _, _, agent, _, _, task, delivery, raw = await setup_delivery(db)
    await ds.control(db, agent.id, "conn", raw)
    await db.commit()
    await db.execute(update(Delivery).where(Delivery.delivery_id == delivery.delivery_id).values(lease_until=ds.now()-timedelta(seconds=1)))
    await db.commit()
    raw["type"] = "task_lease"
    with pytest.raises(ds.DeliveryDenied):
        await ds.control(db, agent.id, "conn", raw)
    await rollback_restore(db)
    frames, _ = await ds.resume(db, agent.id)
    await db.commit()
    assert [f["type"] for f in frames] == ["task_uncertain"]
    assert (await db.get(Delivery, raw["delivery_id"], populate_existing=True)).state == "uncertain"
    assert (await ds.resume(db, agent.id))[0] == []
    assert (await db.get(A2ATask, task.id, populate_existing=True)).status == "input_required"

@pytest.mark.asyncio
async def test_cancel_private_channel_replay_and_late_body_discard(db, monkeypatch):
    _, _, agent, _, room, task, delivery, raw = await setup_delivery(db)
    await ds.control(db, agent.id, "conn", raw)
    await db.commit()
    sent = []
    async def broadcast(channel, frame): sent.append((channel, frame))
    monkeypatch.setattr(connection_manager, "broadcast", broadcast)
    await tm.cancel_task(task.id)
    assert sent[0][0] == "_agent_delivery_bot" and sent[0][1]["type"] == "task_cancel"
    frames, _ = await ds.resume(db, agent.id)
    await db.commit()
    assert frames[0]["type"] == "task_cancel"
    with pytest.raises(ds.DeliveryDenied):
        await ds.finish(db, agent.id, "conn", raw, "SECRET-LATE-BODY", "report")
    await rollback_restore(db)
    assert not list((await db.execute(select(Message).where(Message.content == "SECRET-LATE-BODY"))).scalars())
    raw["type"] = "task_cancel_ack"
    await ds.control(db, agent.id, "conn", raw)
    await db.commit()
    assert (await ds.resume(db, agent.id))[0] == []

@pytest.mark.asyncio
async def test_progress_whitelist_rate_limit_and_monotonic_events(db):
    _, _, agent, _, _, task, _, raw = await setup_delivery(db)
    await ds.control(db, agent.id, "conn", raw)
    await db.commit()
    raw.update(type="task_progress", phase="running", percent=20, token="SECRET-TOKEN", content="PRIVATE")
    await ds.control(db, agent.id, "conn", raw)
    await db.commit()
    await ds.control(db, agent.id, "conn", raw)
    await db.commit()
    events = await TaskService.get_task_events(db, task.id)
    assert len([e for e in events if e.event_type == "task_progress"]) == 1
    assert [e.event_seq for e in events] == list(range(1, len(events)+1))
    assert "SECRET-TOKEN" not in str([e.payload for e in events]) and "PRIVATE" not in str([e.payload for e in events])
    raw["phase"] = "Bearer SECRET-TOKEN"
    with pytest.raises(ds.DeliveryDenied): await ds.control(db, agent.id, "conn", raw)
    await rollback_restore(db)

@pytest.mark.asyncio
async def test_ws_ack_result_and_cancel_owner_flow(db):
    _, owner_token, agent, token, room, task, delivery, raw = await setup_delivery(db)
    ws = FakeWebSocket([raw, {**raw, "type": "task_progress", "phase": "running", "percent": 10}])
    await handle_chat(ws, "_agent_delivery_bot", token=token)
    assert any(m.get("type") == "task_ack_result" and m.get("accepted") for m in ws.sent_messages)
    cancel_ws = FakeWebSocket([{"v": 1, "type": "task_cancel", "task_id": task.id}])
    await handle_chat(cancel_ws, room.id, token=owner_token)
    assert (await tm.get_task(task.id))["status"] == "canceled"
    cancel_ack = {**raw, "type": "task_cancel_ack"}
    second_ws = FakeWebSocket([cancel_ack])
    await handle_chat(second_ws, "_agent_delivery_bot", token=token)
    assert any(m.get("code") == "delivery_denied" and m.get("attempt") == raw["attempt"]
               for m in second_ws.sent_messages)
    assert (await db.get(Delivery, delivery.delivery_id, populate_existing=True)).state == "canceled"

@pytest.mark.asyncio
async def test_external_room_cannot_ack_or_resume_and_oversize_rejected(db):
    _, owner_token, _, _, room, _, _, raw = await setup_delivery(db)
    ws = FakeWebSocket([raw, {"type": "task_resume"}, {"type": "message", "content": "x"*65537}])
    await handle_chat(ws, room.id, token=owner_token)
    codes = [m.get("code") for m in ws.sent_messages if m.get("type") == "error"]
    assert codes == ["delivery_denied", "delivery_denied", "frame_too_large"]

@pytest.mark.asyncio
async def test_agent_replay_only_own_tasks_and_bounded_page(db):
    _, _, agent, _, room, task, _, _ = await setup_delivery(db)
    other, _ = await _create_test_user(db, "unrelated_bot", "agent")
    assert (await ds.resume(db, other.id))[0] == []
    for i in range(51):
        extra, _ = await TaskService.create_task(db, query="test", target_agent=agent.username,
            room_id=room.id, source_message_id=task.source_message_id)
        await ds.create_delivery(db, extra, agent.id)
    await db.commit()
    frames, cursor = await ds.resume(db, agent.id)
    await db.commit()
    assert len(frames) == 50 and cursor
    second, cursor2 = await ds.resume(db, agent.id, cursor)
    await db.commit()
    assert len(second) == 2 and cursor2 is None

@pytest.mark.asyncio
async def test_message_id_is_not_accepted_as_task_id(db):
    _, _, agent, _, _, task, _, _ = await setup_delivery(db)
    with pytest.raises(ds.DeliveryDenied):
        await ds.create_delivery(db, await db.get(A2ATask, task.source_message_id), agent.id)
    await rollback_restore(db)

@pytest.mark.asyncio
async def test_atomic_creation_rollback_removes_both_task_and_delivery(db):
    _, _, agent, _, room, original, _, _ = await setup_delivery(db)
    task, _ = await TaskService.create_task(db, query="test", target_agent=agent.username,
                                          room_id=room.id, source_message_id=original.source_message_id)
    task_id = task.id
    delivery = await ds.create_delivery(db, task, agent.id)
    did = delivery.delivery_id
    await rollback_restore(db)
    assert await db.get(A2ATask, task_id) is None
    assert await db.get(Delivery, did) is None

def test_incremental_migration_synthetic_sqlite_only():
    path = Path(__file__).resolve().parents[1]/"alembic/versions/c30c20261010_agent_task_deliveries.py"
    spec = importlib.util.spec_from_file_location("delivery_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.down_revision == "b20c20261010"
    engine = create_engine("sqlite:///:memory:")
    with engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE users(id VARCHAR(36) PRIMARY KEY)")
        conn.exec_driver_sql("CREATE TABLE a2a_tasks(id VARCHAR(36) PRIMARY KEY)")
        conn.exec_driver_sql("INSERT INTO users VALUES ('existing-user')")
        module.op = Operations(MigrationContext.configure(conn))
        module.upgrade()
        inspector = inspect(conn)
        assert "agent_task_deliveries" in inspector.get_table_names()
        assert len(inspector.get_foreign_keys("agent_task_deliveries")) == 2
        assert "content" not in {c["name"] for c in inspector.get_columns("agent_task_deliveries")}
        module.downgrade()
        assert conn.exec_driver_sql("SELECT id FROM users").scalar() == "existing-user"
    engine.dispose()

@pytest.mark.asyncio
async def test_concurrent_connections_single_ack_winner(db):
    import asyncio
    from conftest import test_session
    _, _, agent, _, _, task, _, raw = await setup_delivery(db)
    aid, tid = agent.id, task.id
    async def claim(connection):
        async with test_session() as session:
            try:
                await ds.control(session, aid, connection, raw)
                await session.commit()
                return True
            except ds.DeliveryDenied:
                await session.rollback()
                return False
    winners = await asyncio.wait_for(asyncio.gather(claim("one"), claim("two")), 10)
    assert winners.count(True) == 1
    events = await TaskService.get_task_events(db, tid)
    assert sum(e.event_type == "delivery_acked" for e in events) == 1

@pytest.mark.asyncio
async def test_lease_then_atomic_result_and_duplicate_late_result_rejected(db):
    _, _, agent, _, _, task, delivery, raw = await setup_delivery(db)
    await ds.control(db, agent.id, "conn", raw)
    await db.commit()
    result = await ds.control(db, agent.id, "conn", {**raw, "type": "task_lease"})
    await db.commit()
    assert result["accepted"] and result["deadline"].endswith("+00:00")
    message = await ds.finish(db, agent.id, "conn", raw, "result", "report")
    await db.commit()
    assert message.parent_id == task.source_message_id
    assert (await db.get(A2ATask, task.id, populate_existing=True)).status == "completed"
    with pytest.raises(ds.DeliveryDenied):
        await ds.finish(db, agent.id, "conn", raw, "duplicate", "report")
    await rollback_restore(db)
    assert not list((await db.execute(select(Message).where(Message.content == "duplicate"))).scalars())

@pytest.mark.asyncio
async def test_restart_session_replays_persistent_delivery(db):
    from conftest import test_session
    _, _, agent, _, _, _, delivery, _ = await setup_delivery(db)
    aid, did = agent.id, delivery.delivery_id
    async with test_session() as restarted:
        frames, _ = await ds.resume(restarted, aid)
        await restarted.commit()
        assert frames[0]["delivery_id"] == did

@pytest.mark.asyncio
async def test_task_event_endpoint_limits_pages_and_authorizes(client, db):
    _, owner_token, _, agent_token, _, task, _, _ = await setup_delivery(db)
    for i in range(105):
        await ds._append_event(db, task.id, "test_metadata", {"percent": i % 100})
    await db.commit()
    endpoint = f"/api/v1/tasks/{task.id}/events"
    response = await client.get(endpoint, headers={"Authorization": f"Bearer {owner_token}"})
    assert response.status_code == 200 and len(response.json()["events"]) == 100
    second = await client.get(endpoint+"?after_seq=100&limit=10", headers={"Authorization": f"Bearer {owner_token}"})
    assert second.status_code == 200 and len(second.json()["events"]) <= 10
    assert (await client.get(endpoint+"?limit=101", headers={"Authorization": f"Bearer {owner_token}"})).status_code == 422
    assert (await client.get(endpoint, headers={"Authorization": f"Bearer {agent_token}"})).status_code == 403

@pytest.mark.asyncio
async def test_same_agent_other_connection_cannot_attest_executor_stopped(db):
    _, _, agent, _, _, task, _, raw = await setup_delivery(db)
    await ds.control(db, agent.id, "executor", raw)
    await db.commit()
    await tm.cancel_task(task.id)
    with pytest.raises(ds.DeliveryDenied):
        await ds.control(db, agent.id, "same-agent-second-socket", {**raw, "type": "task_cancel_ack"})
    await rollback_restore(db)
    result = await ds.control(db, agent.id, "executor", {**raw, "type": "task_cancel_ack"})
    await db.commit()
    assert result["accepted"]

@pytest.mark.asyncio
async def test_slow_broadcast_client_is_bounded_and_other_client_receives(monkeypatch):
    import asyncio
    from app.ws.connection_manager import ConnectionManager
    manager = ConnectionManager()
    manager.send_timeout = 0.02
    good = FakeWebSocket()
    class Slow(FakeWebSocket):
        async def send_json(self, data): await asyncio.Event().wait()
    slow = Slow()
    await manager.connect("test-room", slow)
    await manager.connect("test-room", good)
    await asyncio.wait_for(manager.broadcast("test-room", {"type": "task_cancel"}), 0.2)
    assert good.sent_messages == [{"type": "task_cancel"}]
    assert slow not in manager._connections["test-room"]

@pytest.mark.asyncio
async def test_casefold_duplicate_agent_identity_is_fail_closed(db):
    from starlette.websockets import WebSocketDisconnect
    _, _, agent, token, _, _, _, raw = await setup_delivery(db)
    await _create_test_user(db, "DELIVERY_BOT", "human")
    with pytest.raises(ds.DeliveryDenied): await ds.control(db, agent.id, "executor", raw)
    await rollback_restore(db)
    ws = FakeWebSocket()
    with pytest.raises(WebSocketDisconnect):
        await handle_chat(ws, "_agent_delivery_bot", token=token)
    assert not ws.accepted

@pytest.mark.asyncio
async def test_frame_limit_before_json_parse_and_invalid_bytes(monkeypatch):
    from app.chat.ws_handler import _receive_frame, FrameRejected
    class RawSocket:
        def __init__(self, body): self.body = body
        async def receive(self): return {"type": "websocket.receive", "bytes": self.body}
    def no_parse(body): raise AssertionError("Oversized frame must never be parsed")
    with monkeypatch.context() as patch:
        patch.setattr("app.chat.ws_handler.json.loads", no_parse)
        with pytest.raises(FrameRejected) as overflow:
            await _receive_frame(RawSocket(b"x" * 65537))
        assert overflow.value.code == "frame_too_large"
    with pytest.raises(FrameRejected) as error:
        await _receive_frame(RawSocket(b"\xff"))
    assert error.value.code == "invalid_frame"

@pytest.mark.parametrize("kind", ["message", "task_cancel", "task_resume"])
@pytest.mark.asyncio
async def test_expired_jwt_rejected_on_every_action_frame(db, monkeypatch, kind):
    from app.chat import ws_handler
    from app.core.security import decode_access_token
    _, token, _, agent_token, room, task, _, _ = await setup_delivery(db)
    checks = []
    def decode(value):
        checks.append(value)
        if len(checks) > 1: raise ValueError("expired")
        return decode_access_token(value)
    monkeypatch.setattr(ws_handler, "decode_access_token", decode)
    ws = FakeWebSocket([{"type": kind, "task_id": task.id, "content": "must-not-save"}])
    channel = "_agent_delivery_bot" if kind == "task_resume" else room.id
    await handle_chat(ws, channel, token=agent_token if kind == "task_resume" else token)
    assert ws.closed_code == 4003
    assert not list((await db.execute(select(Message).where(Message.content == "must-not-save"))).scalars())

def test_launchers_enforce_protocol_wire_limit():
    root = Path(__file__).resolve().parents[2]
    docker = (root/"backend/Dockerfile").read_text()
    start = (root/"scripts/start.sh").read_text()
    assert '"--ws", "websockets", "--ws-max-size", "65536"' in docker
    assert "--ws websockets --ws-max-size 65536" in start

def test_delivery_migration_postgresql_offline_ddl():
    from io import StringIO
    path = Path(__file__).resolve().parents[1]/"alembic/versions/c30c20261010_agent_task_deliveries.py"
    spec = importlib.util.spec_from_file_location("delivery_pg_offline", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    output = StringIO()
    context = MigrationContext.configure(dialect_name="postgresql", opts={"as_sql": True, "output_buffer": output})
    module.op = Operations(context)
    module.upgrade()
    sql = output.getvalue()
    assert "CREATE TABLE agent_task_deliveries" in sql
    assert "REFERENCES a2a_tasks (id) ON DELETE CASCADE" in sql
    assert "REFERENCES users (id)" in sql
    assert "UNIQUE (task_id)" in sql
    assert "TIMESTAMP WITH TIME ZONE" in sql
    assert "DROP " not in sql and "ALTER TABLE users" not in sql
    assert "content" not in sql and "password" not in sql

@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["offer", "expire"])
async def test_cancel_between_validation_and_delivery_write_is_fenced(db, monkeypatch, operation):
    from conftest import test_session
    _, _, agent, _, _, task, delivery, raw = await setup_delivery(db)
    if operation == "expire":
        await ds.control(db, agent.id, "executor", raw)
        await db.execute(update(Delivery).where(Delivery.delivery_id == delivery.delivery_id).values(
            lease_until=ds.now()-timedelta(seconds=1)))
        await db.commit()
    validate = ds.validate_task
    fired = False
    async def cancel_after_validation(session, checked_task, aid):
        nonlocal fired
        identity = await validate(session, checked_task, aid)
        if not fired:
            fired = True
            async with test_session() as other:
                await TaskService.cancel_task(other, task.id)
                await other.commit()
        return identity
    monkeypatch.setattr(ds, "validate_task", cancel_after_validation)
    if operation == "offer":
        assert await ds.offer(db, delivery) is None
    else:
        frames, _ = await ds.resume(db, agent.id)
        assert [frame["type"] for frame in frames] == ["task_cancel"]
    await db.commit()
    events = await TaskService.get_task_events(db, task.id)
    assert not any(event.event_type == "delivery_uncertain" for event in events)

@pytest.mark.asyncio
async def test_ws_live_progress_matches_seq_replay_and_rate_limit(db):
    _, owner_token, _, agent_token, room, task, _, raw = await setup_delivery(db)
    viewer = FakeWebSocket()
    await connection_manager.connect(room.id, viewer)
    try:
        progress = {**raw, "type": "task_progress", "phase": "running", "percent": 25}
        agent_ws = FakeWebSocket([raw, progress, progress])
        await handle_chat(agent_ws, "_agent_delivery_bot", token=agent_token)
        live = [frame for frame in viewer.sent_messages if frame.get("type") == "task_progress"]
        assert len(live) == 1
        seq = live[0]["event_seq"]
        replay_ws = FakeWebSocket([{"v": 1, "type": "task_events", "task_id": task.id,
                                   "after_seq": seq-1, "limit": 1}])
        await handle_chat(replay_ws, room.id, token=owner_token)
        reply = next(frame for frame in replay_ws.sent_messages if frame.get("type") == "task_events_result")
        assert reply["events"][0]["event_seq"] == seq
        assert reply["events"][0]["payload"] == {"phase": "running", "percent": 25}
        assert reply["next_seq"] == seq
    finally:
        connection_manager.disconnect(room.id, viewer)

@pytest.mark.asyncio
@pytest.mark.parametrize("mutation", ["room", "revoked", "negative_seq", "bool_seq", "oversize", "agent_channel"])
async def test_ws_event_replay_checks_scope_permission_and_bounds(db, mutation):
    owner, token, _, agent_token, room, task, _, _ = await setup_delivery(db)
    channel = room.id
    request = {"v": 1, "type": "task_events", "task_id": task.id, "after_seq": 0, "limit": 100}
    if mutation == "room":
        db.add(Room(id="different-room", name="Unrelated room", transport="hub"))
        await db.flush()
        task.room_id = "different-room"
    if mutation == "negative_seq": request["after_seq"] = -1
    if mutation == "bool_seq": request["after_seq"] = True
    if mutation == "oversize": request["limit"] = 101
    if mutation == "agent_channel": channel, token = "_agent_delivery_bot", agent_token
    await db.commit()
    class RevokeSocket(FakeWebSocket):
        async def receive_json(self):
            if mutation == "revoked":
                await db.execute(update(RoomPermission).where(RoomPermission.user_id == owner.id).values(role="none"))
                await db.commit()
            return await super().receive_json()
    ws = RevokeSocket([request])
    await handle_chat(ws, channel, token=token)
    if mutation == "revoked":
        # Every outbound frame now rechecks RBAC: even the denial frame must
        # not be delivered to a revoked room subscription. Close instead.
        assert ws.closed_code == 1011
        assert not any(frame.get("code") == "delivery_denied" for frame in ws.sent_messages)
    else:
        assert any(frame.get("code") == "delivery_denied" for frame in ws.sent_messages)
    assert not any(frame.get("type") == "task_events_result" for frame in ws.sent_messages)

@pytest.mark.asyncio
@pytest.mark.parametrize("first", ["cancel", "finish"])
async def test_delivery_cancel_finish_overlapping_transactions_have_one_terminal_winner(db, first):
    import asyncio
    from conftest import test_session
    _, _, agent, _, _, task, delivery, raw = await setup_delivery(db)
    await ds.control(db, agent.id, "executor", raw)
    await db.commit()
    aid, tid, did = agent.id, task.id, delivery.delivery_id
    acquired, competing, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    async def run(kind):
        async with test_session() as session:
            if kind != first:
                await acquired.wait()
                competing.set()
            try:
                if kind == "cancel":
                    _, _, result = await TaskService.cancel_task(session, tid)
                    if result == "canceled":
                        await ds.cancel_deliveries(session, tid)
                else:
                    await ds.finish(session, aid, "executor", raw, "RACE-RESULT", "report")
                    result = "completed"
                if kind == first:
                    acquired.set()
                    await release.wait()
                await session.commit()
                return result
            except ds.DeliveryDenied:
                await session.rollback()
                return "denied"
    cancel = asyncio.create_task(run("cancel"))
    finish = asyncio.create_task(run("finish"))
    await asyncio.wait_for(competing.wait(), 5)
    release.set()
    outcomes = await asyncio.wait_for(asyncio.gather(cancel, finish), 10)
    persisted = await db.get(A2ATask, tid, populate_existing=True)
    row = await db.get(Delivery, did, populate_existing=True)
    messages = list((await db.execute(select(Message).where(Message.content == "RACE-RESULT"))).scalars())
    events = await TaskService.get_task_events(db, tid)
    assert [event.event_seq for event in events] == list(range(1, len(events)+1))
    if first == "cancel":
        assert outcomes == ["canceled", "denied"]
        assert persisted.status == row.state == "canceled"
        assert persisted.result is None and not messages
    else:
        assert outcomes == ["already_completed", "completed"]
        assert persisted.status == row.state == "completed"
        assert len(messages) == 1

@pytest.mark.asyncio
async def test_ws_idle_subscription_is_removed_when_permission_revoked(db):
    import asyncio
    from starlette.websockets import WebSocketDisconnect
    owner, token, _, _, room, task, _, _ = await setup_delivery(db)
    waiting, release = asyncio.Event(), asyncio.Event()
    class IdleSocket(FakeWebSocket):
        async def receive_json(self):
            waiting.set()
            await release.wait()
            raise WebSocketDisconnect(code=1000)
    ws = IdleSocket()
    handler = asyncio.create_task(handle_chat(ws, room.id, token=token))
    try:
        await asyncio.wait_for(waiting.wait(), 5)
        await db.execute(update(RoomPermission).where(RoomPermission.user_id == owner.id).values(role="none"))
        await db.commit()
        await connection_manager.broadcast(room.id, {"type": "task_progress", "task_id": task.id, "percent": 10})
        assert not any(frame.get("type") == "task_progress" for frame in ws.sent_messages)
        assert ws not in connection_manager._connections.get(room.id, set())
    finally:
        release.set()
        await asyncio.wait_for(handler, 5)

@pytest.mark.asyncio
async def test_ws_member_cannot_cancel_another_owners_task(db):
    _, _, _, _, room, task, _, _ = await setup_delivery(db)
    stranger, token = await _create_test_user(db, "other_owner")
    db.add(RoomPermission(room_id=room.id, user_id=stranger.id, role="member"))
    await db.commit()
    ws = FakeWebSocket([{"v": 1, "type": "task_cancel", "task_id": task.id}])
    await handle_chat(ws, room.id, token=token)
    assert any(frame.get("code") == "delivery_denied" for frame in ws.sent_messages)
    assert (await db.get(A2ATask, task.id, populate_existing=True)).status == "submitted"

@pytest.mark.asyncio
async def test_progress_rollback_does_not_consume_sequence(db):
    _, _, agent, _, _, task, _, raw = await setup_delivery(db)
    await ds.control(db, agent.id, "executor", raw)
    await db.commit()
    before = (await db.get(A2ATask, task.id, populate_existing=True)).event_seq
    progress = {**raw, "type": "task_progress", "phase": "running", "percent": 30}
    uncommitted = await ds.control(db, agent.id, "executor", progress)
    assert uncommitted["event_seq"] == before+1
    await rollback_restore(db)
    assert (await db.get(A2ATask, task.id, populate_existing=True)).event_seq == before
    committed = await ds.control(db, agent.id, "executor", progress)
    await db.commit()
    assert committed["event_seq"] == before+1
    assert len([event for event in await TaskService.get_task_events(db, task.id)
                if event.event_type == "task_progress"]) == 1

@pytest.mark.asyncio
async def test_real_websocket_ack_progress_resume_and_seq_replay(db):
    """Loopback only: exercise actual ASGI framing, handshake and disconnect recovery."""
    import asyncio
    import json
    import socket
    import uvicorn
    import websockets
    from app.main import app
    _, owner_token, _, agent_token, room, task, _, raw = await setup_delivery(db)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(16)
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, lifespan="off", ws="websockets",
                                        ws_max_size=65536, log_level="error"))
    serving = asyncio.create_task(server.serve(sockets=[listener]))
    async def started():
        while not server.started:
            if serving.done():
                await serving
                raise AssertionError("Loopback server did not start")
            await asyncio.sleep(0.01)
    async def receive_kind(ws, kind):
        async def receive():
            while True:
                frame = json.loads(await ws.recv())
                if frame.get("type") == kind:
                    return frame
        return await asyncio.wait_for(receive(), 5)
    base = f"ws://127.0.0.1:{port}/ws/chat/"
    try:
        await asyncio.wait_for(started(), 5)
        async with websockets.connect(base+room.id+"?token="+owner_token) as owner_ws:
            await receive_kind(owner_ws, "presence_snapshot")
            async with websockets.connect(base+"_agent_delivery_bot?token="+agent_token) as agent_ws:
                await receive_kind(agent_ws, "presence_snapshot")
                await agent_ws.send(json.dumps({"v": 1, "type": "task_resume"}))
                dispatch = await receive_kind(agent_ws, "agent_task")
                assert dispatch["task_id"] == task.id and dispatch["attempt"] == 2
                ack = {**raw, "attempt": dispatch["attempt"]}
                await agent_ws.send(json.dumps(ack))
                assert (await receive_kind(agent_ws, "task_ack_result"))["accepted"]
                await agent_ws.send(json.dumps({**ack, "type": "task_progress", "phase": "running", "percent": 40}))
                receipt = await receive_kind(agent_ws, "task_progress_result")
                live = await receive_kind(owner_ws, "task_progress")
                assert receipt["event_seq"] == live["event_seq"]
            # New room connection recovers the committed progress using its seq cursor.
        async with websockets.connect(base+room.id+"?token="+owner_token) as reconnected:
            await reconnected.send(json.dumps({"v": 1, "type": "task_events", "task_id": task.id,
                                              "after_seq": live["event_seq"]-1, "limit": 1}))
            replay = await receive_kind(reconnected, "task_events_result")
            assert replay["events"][0]["event_seq"] == live["event_seq"]
            assert replay["events"][0]["payload"]["percent"] == 40
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, 5)
        listener.close()
        from app.ws.connection_manager import connection_manager
        connection_manager.reset()
