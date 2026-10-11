"""Task lifecycle, CAS concurrency, monotonic audit events, and SDK Store tests."""
import asyncio
import importlib.util
from io import StringIO
from pathlib import Path

import pytest
import pytest_asyncio
from alembic.migration import MigrationContext
from alembic.operations import Operations
from httpx import AsyncClient
from sqlalchemy.exc import IntegrityError

from a2a.types import Task, TaskState
from app.a2a import task_manager as tm
from app.a2a.models import A2ATask, TaskEvent
from app.a2a.server import TaskServiceTaskStore
from app.a2a.task_service import TaskService, sanitize_payload
from app.core.security import create_access_token
from app.models.room import Room
from app.models.room_permission import RoomPermission
from app.models.user import User


@pytest_asyncio.fixture
async def test_user(db):
    user = User(
        username="task_tester",
        display_name="Task Tester",
        user_type="human",
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@pytest_asyncio.fixture
async def test_room(db, test_user):
    room = Room(name="Lifecycle Room", created_by=test_user.id)
    db.add(room)
    await db.commit()
    await db.refresh(room)
    perm = RoomPermission(
        room_id=room.id,
        user_id=test_user.id,
        role="owner",
    )
    db.add(perm)
    await db.commit()
    return room


def user_auth_headers(user: User) -> dict[str, str]:
    token = create_access_token(user.id, user.user_type)
    return {"Authorization": f"Bearer {token}"}


# ── 1. CAS Concurrency: Cancel vs Complete ───────────────────────


@pytest.mark.asyncio
async def test_cas_cancel_strictly_blocks_late_complete(db):
    """When a task is canceled, a late completion must NOT overwrite canceled state."""
    task, event = await TaskService.create_task(
        db,
        query="Analyze architecture",
        target_agent="Codex",
    )
    await db.commit()
    task_id = task.id
    assert task.status == "submitted"
    assert event.event_seq == 1
    assert event.event_type == "task_created"

    # Start the task
    task, event, status = await TaskService.start_task(db, task_id)
    await db.commit()
    assert status == "working"
    assert task.status == "working"
    assert event.event_seq == 2

    # Cancel the task
    task, event, res_code = await TaskService.cancel_task(
        db, task_id, reason="User clicked cancel"
    )
    await db.commit()
    assert res_code == "canceled"
    assert task.status == "canceled"
    assert event.event_seq == 3
    assert event.event_type == "task_canceled"

    # Late completion arrives from remote agent
    late_task, late_event, res_code = await TaskService.complete_task(
        db, task_id, result_data={"solution": "42"}
    )
    await db.commit()
    assert res_code == "canceled_overridden_rejected"
    assert late_task.status == "canceled"
    assert late_task.result is None  # late result was discarded!

    assert late_event is not None
    assert late_event.event_type == "late_result_discarded"
    assert late_event.event_seq == 4
    assert late_event.payload["attempted_status"] == "completed"
    assert late_event.payload["current_status"] == "canceled"


@pytest.mark.asyncio
async def test_cas_complete_blocks_subsequent_cancel(db):
    """When a task is completed, cancel must NOT overwrite completed state."""
    task, _ = await TaskService.create_task(db, query="Calculate sum")
    await db.commit()
    task_id = task.id

    await TaskService.start_task(db, task_id)
    await db.commit()

    task, event, res_code = await TaskService.complete_task(
        db, task_id, result_data={"sum": 100}
    )
    await db.commit()
    assert res_code == "completed"
    assert task.status == "completed"
    assert task.result == {"sum": 100}

    # Attempt cancel on completed task
    task, cancel_event, res_code = await TaskService.cancel_task(db, task_id)
    await db.commit()
    assert res_code == "already_completed"
    assert task.status == "completed"
    assert cancel_event is None  # no cancel event written


# ── 2. Illegal State Transitions ──────────────────────────────────


@pytest.mark.asyncio
async def test_illegal_state_transitions(db):
    """Tasks cannot be started from terminal states."""
    task, _ = await TaskService.create_task(db, query="Test illegal")
    await db.commit()
    task_id = task.id

    await TaskService.cancel_task(db, task_id)
    await db.commit()

    # Attempt start on canceled task
    t, ev, code = await TaskService.start_task(db, task_id)
    assert code == "terminal_canceled"
    assert ev is None
    assert t.status == "canceled"


# ── 3. Monotonic Event Sequences & Uniqueness ────────────────────


@pytest.mark.asyncio
async def test_monotonic_event_seq_and_uniqueness(db):
    """Events for a task must have strictly increasing sequential numbers."""
    task, ev1 = await TaskService.create_task(db, query="Sequential events test")
    await db.commit()
    task_id = task.id
    assert ev1.event_seq == 1

    _, ev2, _ = await TaskService.start_task(db, task_id)
    await db.commit()
    assert ev2.event_seq == 2

    # Link approval (moves to input_required)
    from app.approval.models import Approval
    from app.models.user import User
    from app.models.room import Room
    owner = User(username="sequence_owner", display_name="Sequence owner", user_type="human")
    db.add(owner)
    await db.flush()
    room = Room(name="Sequence approval room", transport="hub", created_by=owner.id)
    db.add(room)
    await db.flush()
    db.add(Approval(id="appr-123", room_id=room.id, requestor_id=owner.id, title="Sequence approval"))
    await db.commit()
    t, ev3 = await TaskService.link_approval(db, task_id, "appr-123")
    await db.commit()
    assert ev3.event_seq == 3
    assert t.status == "input_required"

    # Resume to working
    _, ev4, _ = await TaskService.start_task(db, task_id)
    await db.commit()
    assert ev4.event_seq == 4

    # Complete
    _, ev5, _ = await TaskService.complete_task(db, task_id, {"done": True})
    await db.commit()
    assert ev5.event_seq == 5

    # Retrieve all events in order
    events = await TaskService.get_task_events(db, task_id)
    assert len(events) == 5
    assert [e.event_seq for e in events] == [1, 2, 3, 4, 5]
    assert [e.event_type for e in events] == [
        "task_created",
        "status_changed",
        "approval_linked",
        "status_changed",
        "task_completed",
    ]

    # Verify unique constraint: inserting an event with duplicate (task_id, event_seq) fails
    dup_event = TaskEvent(
        task_id=task_id,
        event_seq=2,  # duplicate!
        event_type="bogus_duplicate",
        payload={},
    )
    db.add(dup_event)
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


# ── 4. Sensitive Redaction in Event Payloads ──────────────────────


@pytest.mark.asyncio
async def test_sensitive_token_redaction(db):
    """Payloads must scrub tokens, passwords, authorization headers, and secrets."""
    dirty_payload = {
        "user_query": "Please deploy",
        "api_key": "sk-secret-123456",
        "auth_token": "bearer-abc-987",
        "password": "mypassword123",
        "authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        "nested": {
            "token": "tok_xyz",
            "safe_field": "public_data",
        },
    }
    clean = sanitize_payload(dirty_payload)
    assert clean["api_key"] == "[REDACTED]"
    assert clean["auth_token"] == "[REDACTED]"
    assert clean["password"] == "[REDACTED]"
    assert clean["authorization"] == "[REDACTED]"
    assert clean["nested"]["token"] == "[REDACTED]"
    assert clean["nested"]["safe_field"] == "public_data"
    assert clean["user_query"] == "Please deploy"

    # Also test audit event creation with sensitive metadata
    task, event = await TaskService.create_task(
        db,
        query="Deploy container",
        metadata={"token": "should-be-hidden", "env": "prod"},
    )
    await db.commit()
    assert event.payload["token"] == "[REDACTED]"
    assert event.payload["env"] == "prod"


# ── 5. SDK TaskStore Persistence Across Instances ─────────────────


@pytest.mark.asyncio
async def test_sdk_task_store_persistence_across_instances(db):
    """TaskStore must persist tasks into SQL, surviving new Store instances."""
    store_a = TaskServiceTaskStore()

    sdk_task = Task()
    sdk_task.id = "sdk-task-42"
    sdk_task.context_id = "ctx-lifecycle-1"
    sdk_task.status.state = TaskState.TASK_STATE_SUBMITTED

    # Save via Store A
    await store_a.save(sdk_task)

    # Verify task exists in SQL DB
    task_in_db = await TaskService.get_task(db, "sdk-task-42")
    assert task_in_db is not None
    assert task_in_db.context_id == "ctx-lifecycle-1"
    assert task_in_db.status == "submitted"

    # Instantiate completely NEW Store B (simulating app reload or cluster replica)
    store_b = TaskServiceTaskStore()
    retrieved = await store_b.get("sdk-task-42")
    assert retrieved is not None
    assert retrieved.id == "sdk-task-42"
    assert retrieved.context_id == "ctx-lifecycle-1"
    assert retrieved.status.state == TaskState.TASK_STATE_SUBMITTED

    # Transition to completed with artifacts via Store B
    retrieved.status.state = TaskState.TASK_STATE_COMPLETED
    art = retrieved.artifacts.add()
    p = art.parts.add()
    p.text = "Result from store B"
    await store_b.save(retrieved)

    # Store A checks the status
    final_task = await store_a.get("sdk-task-42")
    assert final_task.status.state == TaskState.TASK_STATE_COMPLETED
    assert len(final_task.artifacts) == 1
    assert final_task.artifacts[0].parts[0].text == "Result from store B"


# ── 6. REST API Task Events Endpoint ─────────────────────────────


@pytest.mark.asyncio
async def test_rest_api_task_events(client: AsyncClient, test_user, test_room):
    """REST endpoint /api/v1/tasks/{task_id}/events returns ordered audit stream."""
    headers = user_auth_headers(test_user)

    # Submit task associated with the room
    result = await tm.submit_task(
        query="Run test suite",
        room_id=test_room.id,
        route_remote=False,
    )
    task_id = result["id"]

    await tm.complete_task(task_id, {"passed": 42})

    # Fetch events via REST
    resp = await client.get(f"/api/v1/tasks/{task_id}/events", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["task_id"] == task_id
    events = data["events"]
    assert len(events) >= 2
    assert events[0]["event_seq"] == 1
    assert events[0]["event_type"] == "task_created"
    assert events[-1]["event_type"] == "task_completed"

    # Test after_seq filtering
    resp_filtered = await client.get(
        f"/api/v1/tasks/{task_id}/events?after_seq=1", headers=headers
    )
    assert resp_filtered.status_code == 200
    filtered_events = resp_filtered.json()["events"]
    assert all(e["event_seq"] > 1 for e in filtered_events)


# ── 7. Alembic Offline DDL Validation ────────────────────────────


def test_phase2_postgresql_offline_ddl_and_revision_chain():
    """Verify Phase 2 revision b20c20261010 chains from a10c20261010 and generates valid additive DDL."""
    versions = Path(__file__).resolve().parents[1] / "alembic/versions"
    spec = importlib.util.spec_from_file_location(
        "phase2_migration",
        versions / "b20c20261010_task_events_audit_log.py",
    )
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    assert migration.revision == "b20c20261010"
    assert migration.down_revision == "a10c20261010"

    output = StringIO()
    context = MigrationContext.configure(
        dialect_name="postgresql",
        opts={"as_sql": True, "output_buffer": output},
    )
    with Operations.context(context):
        migration.upgrade()
    sql = output.getvalue()

    assert "ALTER TABLE a2a_tasks ADD COLUMN context_id" in sql
    assert "ALTER TABLE a2a_tasks ADD COLUMN event_seq" in sql
    assert "CREATE TABLE task_events" in sql
    assert "CONSTRAINT uq_task_event_seq UNIQUE (task_id, event_seq)" in sql or "uq_task_event_seq" in sql
    assert "DROP TABLE" not in sql
