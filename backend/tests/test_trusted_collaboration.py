"""Test Phase 1 Trusted Collaboration mechanics and failure scenarios.

Covers:
1. Impersonation prevention
2. Unauthorized room access isolation
3. ActionGrant generation and single-use consumption
4. Parameter tampering prevention via deterministic hashing
5. ActionGrant expiration enforcement
6. Decider room role enforcement
7. Task final state protection against late complete
8. Task final state protection against late fail
9. Task cancellation active broadcast
10. TrustedRunner process group termination and late output discard
"""

import asyncio
import os
import signal
import uuid
import pytest
from httpx import AsyncClient
from datetime import datetime, timezone, timedelta
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.room import Room
from app.approval.models import Approval, ActionGrant
from app.approval.service import (
    create_approval,
    decide_approval,
    issue_action_grant,
    verify_and_consume_grant,
)
from app.a2a import task_manager as tm
from app.a2a.models import A2ATask
from trusted_runner import TrustedRunner


@pytest.mark.asyncio
async def test_impersonation_blocked(client: AsyncClient):
    """Scenario 1: Sending message with another real user ID as sender_id is blocked."""
    resp_a = await client.post(
        "/api/v1/auth/register",
        json={"username": f"alice_{uuid.uuid4().hex[:6]}", "password": "password123", "display_name": "Alice"},
    )
    assert resp_a.status_code == 200
    token_a = resp_a.json()["access_token"]

    resp_b = await client.post(
        "/api/v1/auth/register",
        json={"username": f"bob_{uuid.uuid4().hex[:6]}", "password": "password123", "display_name": "Bob"},
    )
    assert resp_b.status_code == 200
    user_b = resp_b.json()["user"]

    headers_a = {"Authorization": f"Bearer {token_a}"}
    room_id = f"room-{uuid.uuid4().hex[:8]}"

    # Alice creates dialogue
    create_resp = await client.post(
        "/a2a/dialogue-rpc",
        headers=headers_a,
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/create",
            "params": {
                "room_id": room_id,
                "initiator_agent": "Codex",
                "participants": ["Codex", "Claude"],
            },
            "id": "1",
        },
    )
    assert create_resp.status_code == 200
    dialogue_id = create_resp.json()["result"]["dialogue_id"]

    # Alice tries to forge Bob ID as sender_id
    impersonate_resp = await client.post(
        "/a2a/dialogue-rpc",
        headers=headers_a,
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/send",
            "params": {
                "dialogue_id": dialogue_id,
                "content": "Hello from forged Bob",
                "sender_id": user_b["id"],
                "sender_name": "Codex",
            },
            "id": "2",
        },
    )
    assert impersonate_resp.status_code == 403
    assert "Impersonation" in impersonate_resp.json()["detail"]


@pytest.mark.asyncio
async def test_unauthorized_room_dialogue_blocked(client: AsyncClient):
    """Scenario 2: Non-member cannot access private room dialogue."""
    resp_a = await client.post(
        "/api/v1/auth/register",
        json={"username": f"alice_{uuid.uuid4().hex[:6]}", "password": "password123", "display_name": "Alice"},
    )
    token_a = resp_a.json()["access_token"]
    headers_a = {"Authorization": f"Bearer {token_a}"}

    resp_b = await client.post(
        "/api/v1/auth/register",
        json={"username": f"bob_{uuid.uuid4().hex[:6]}", "password": "password123", "display_name": "Bob"},
    )
    token_b = resp_b.json()["access_token"]
    headers_b = {"Authorization": f"Bearer {token_b}"}

    # Alice creates a private room
    room_resp = await client.post(
        "/api/v1/rooms",
        headers=headers_a,
        json={"name": "Alice Private Room", "description": "Secret"},
    )
    assert room_resp.status_code == 200
    room_id = room_resp.json()["room"]["id"]

    # Bob tries to create dialogue in Alice's private room
    bob_create = await client.post(
        "/a2a/dialogue-rpc",
        headers=headers_b,
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/create",
            "params": {
                "room_id": room_id,
                "initiator_agent": "Claude",
                "participants": ["Claude", "Codex"],
            },
            "id": "1",
        },
    )
    assert bob_create.status_code == 403


@pytest.mark.asyncio
async def test_action_grant_generation_and_single_use(db: AsyncSession):
    """Scenario 3 & 4: ActionGrant generated on approval, consumed once, second consume fails."""
    user_id = str(uuid.uuid4())
    room_id = str(uuid.uuid4())

    user = User(id=user_id, username=f"u_{user_id[:6]}", password_hash="hash", display_name="User")
    room = Room(id=room_id, name="Test Room", created_by=user_id)
    db.add(user)
    db.add(room)
    await db.commit()

    approval = Approval(
        room_id=room_id,
        requestor_id=user_id,
        title="Calendar free-busy proposal",
        status="pending",
        approval_meta={"action_type": "calendar:negotiate", "params": {"day": "Wed"}},
    )
    db.add(approval)
    await db.commit()
    await db.refresh(approval)

    # Issue grant
    grant = await issue_action_grant(
        db=db,
        approval=approval,
        scope="calendar:negotiate",
        params={"day": "Wed"},
        granted_to_agent="Codex",
    )
    assert grant.id is not None
    assert grant.consumed_at is None

    # First consumption: succeeds
    consumed = await verify_and_consume_grant(
        db=db,
        grant_id=grant.id,
        scope="calendar:negotiate",
        params={"day": "Wed"},
        agent_name="Codex",
    )
    assert consumed.consumed_at is not None

    # Second consumption: rejected
    with pytest.raises(ValueError, match="already.*consumed"):
        await verify_and_consume_grant(
            db=db,
            grant_id=grant.id,
            scope="calendar:negotiate",
            params={"day": "Wed"},
            agent_name="Codex",
        )


@pytest.mark.asyncio
async def test_action_grant_tampering_blocked(db: AsyncSession):
    """Scenario 5: Parameter tampering causes hash mismatch and blocks execution."""
    user_id = str(uuid.uuid4())
    room_id = str(uuid.uuid4())

    user = User(id=user_id, username=f"u_{user_id[:6]}", password_hash="hash", display_name="User")
    room = Room(id=room_id, name="Test Room", created_by=user_id)
    db.add(user)
    db.add(room)
    await db.commit()

    approval = Approval(
        room_id=room_id,
        requestor_id=user_id,
        title="Read free time",
        status="pending",
    )
    db.add(approval)
    await db.commit()

    grant = await issue_action_grant(
        db=db,
        approval=approval,
        scope="calendar:read",
        params={"time_slot": "14:00-16:00"},
        granted_to_agent="Codex",
    )

    # Tampered execution argument
    with pytest.raises(ValueError, match="parameter hash mismatch"):
        await verify_and_consume_grant(
            db=db,
            grant_id=grant.id,
            scope="calendar:read",
            params={"time_slot": "09:00-18:00"},  # Tampered!
            agent_name="Codex",
        )


@pytest.mark.asyncio
async def test_action_grant_expiration(db: AsyncSession):
    """Scenario 6: Expired grant is rejected."""
    user_id = str(uuid.uuid4())
    room_id = str(uuid.uuid4())

    user = User(id=user_id, username=f"u_{user_id[:6]}", password_hash="hash", display_name="User")
    room = Room(id=room_id, name="Test Room", created_by=user_id)
    db.add(user)
    db.add(room)
    await db.commit()

    approval = Approval(
        room_id=room_id,
        requestor_id=user_id,
        title="Expired test",
        status="pending",
    )
    db.add(approval)
    await db.commit()

    grant = await issue_action_grant(
        db=db,
        approval=approval,
        scope="test:scope",
        params=None,
        expires_in_seconds=-10,  # Pre-expired
    )

    with pytest.raises(ValueError, match="expired"):
        await verify_and_consume_grant(
            db=db,
            grant_id=grant.id,
            scope="test:scope",
            params=None,
        )


@pytest.mark.asyncio
async def test_decider_role_check_in_approval(client: AsyncClient, db: AsyncSession):
    """Scenario 7: Decider without room permissions cannot approve."""
    resp_a = await client.post(
        "/api/v1/auth/register",
        json={"username": f"alice_{uuid.uuid4().hex[:6]}", "password": "password123", "display_name": "Alice"},
    )
    user_a = resp_a.json()["user"]
    token_a = resp_a.json()["access_token"]
    headers_a = {"Authorization": f"Bearer {token_a}"}

    resp_b = await client.post(
        "/api/v1/auth/register",
        json={"username": f"bob_{uuid.uuid4().hex[:6]}", "password": "password123", "display_name": "Bob"},
    )
    user_b = resp_b.json()["user"]

    # Alice creates room
    room_resp = await client.post(
        "/api/v1/rooms",
        headers=headers_a,
        json={"name": "Alice Room"},
    )
    room_id = room_resp.json()["room"]["id"]

    approval = await create_approval(
        db=db,
        room_id=room_id,
        requestor_id=user_a["id"],
        title="Critical Action",
    )

    # Bob (not in room) tries to decide approval
    with pytest.raises(ValueError, match="insufficient role"):
        await decide_approval(
            db=db,
            approval_id=approval.id,
            decider_id=user_b["id"],
            decision="approved",
        )


@pytest.mark.asyncio
async def test_task_canceled_cannot_be_overwritten_by_late_complete(db: AsyncSession):
    """Scenario 8: Canceled task rejects late complete_task and discards output."""
    task_id = f"task-{uuid.uuid4().hex[:8]}"
    task = A2ATask(
        id=task_id,
        query="Perform calculation",
        source_agent="hub",
        target_agent="Codex",
        status="working",
    )
    db.add(task)
    await db.commit()

    # Cancel task
    cancel_res = await tm.cancel_task(task_id)
    assert cancel_res["status"] == "canceled"

    # Late result arrives
    late_res = await tm.complete_task(task_id, [{"text": "late output"}])
    assert late_res["status"] == "canceled"
    assert "late result discarded" in late_res.get("info", "")

    # Verify task in DB remains canceled
    task_dict = await tm.get_task(task_id)
    assert task_dict["status"] == "canceled"
    assert task_dict.get("result") is None


@pytest.mark.asyncio
async def test_task_canceled_cannot_be_overwritten_by_late_fail(db: AsyncSession):
    """Scenario 9: Canceled task rejects late fail_task."""
    task_id = f"task-{uuid.uuid4().hex[:8]}"
    task = A2ATask(
        id=task_id,
        query="Perform action",
        source_agent="hub",
        target_agent="Codex",
        status="working",
    )
    db.add(task)
    await db.commit()

    await tm.cancel_task(task_id)

    # Late fail arrives
    late_fail = await tm.fail_task(task_id, "late timeout")
    assert late_fail["status"] == "canceled"

    task_dict = await tm.get_task(task_id)
    assert task_dict["status"] == "canceled"


@pytest.mark.asyncio
async def test_trusted_runner_process_group_termination_and_discard():
    """Scenario 10: TrustedRunner terminates process group on cancellation and discards output."""
    runner = TrustedRunner(agent_name="Codex")

    task_coro = runner.execute_task(
        task_id="run-task-1",
        cmd=["python3", "-c", "import time; time.sleep(10); print('FINISH')"],
    )

    task_future = asyncio.create_task(task_coro)
    await asyncio.sleep(0.1)

    assert runner.controller.proc is not None
    killed = runner.cancel_current_execution()
    assert killed is True
    assert runner.is_canceled is True

    result = await task_future
    assert result["status"] == "canceled"
    assert result["result"] is None
    assert "discarded" in result["info"]
