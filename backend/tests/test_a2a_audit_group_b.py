"""MAPR audit group B — A2A idempotency, concurrency recovery and SSE lifecycle.

The concurrency tests here need a real PostgreSQL: SQLite serialises writers, so
the unique-key race never happens and the "rollback then re-read" path stays
untested. Run them with:

    MAPR_TEST_DATABASE_URL=postgresql+asyncpg://mapr:mapr@127.0.0.1:5432/mapr_test \
        python -m pytest tests/test_a2a_audit_group_b.py -v

Seven audit items covered:
  1. Unique-key conflict: safe rollback + re-read; the idempotency key is never
     truncated or silently rewritten.
  2. New vs. existing task strictly separated, and a bind failure never cancels
     an older existing task.
  3. SSE lease acquisition then bind: compensating a failed bind.
  4. Persisted-then-failed paths remain idempotently recoverable.
  5. JWT `typ` must be present and match the stored account type.
  6. ListTasks permission filtering combined with consistent pagination.
  7. Compensation logging must not carry payload data.
"""

import uuid

import pytest
from sqlalchemy import select

from conftest import engine as test_engine
from test_a2a_protocol_v1_linux import actors, message

from app.a2a.http_protocol import IDEMPOTENCY_KEY_RE
from app.a2a.models import A2ATask
from app.chat.models import Message
from app.core.security import create_access_token

REAL_PG = test_engine.dialect.name == "postgresql"

requires_pg = pytest.mark.skipif(
    not REAL_PG, reason="concurrent unique-key races require real PostgreSQL"
)

# The suite runs under pytest-asyncio STRICT mode, so every async test here is
# marked centrally instead of repeating the decorator on each function.
pytestmark = pytest.mark.asyncio





# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

async def rpc(client, headers, method, params, req_id=1):
    """POST one JSON-RPC call and return the parsed body."""
    r = await client.post(
        "/a2a/rpc", headers=headers,
        json={"jsonrpc": "2.0", "method": method, "params": params, "id": req_id},
    )
    assert r.status_code == 200, r.text
    return r.json()


async def send(client, headers, params):
    body = await rpc(client, headers, "SendMessage", params, req_id=1)
    assert "error" not in body, body.get("error")
    return body["result"]


async def send_raw(client, headers, params):
    """SendMessage returning the raw HTTP response for error-path assertions."""
    return await client.post(
        "/a2a/rpc", headers=headers,
        json={"jsonrpc": "2.0", "method": "SendMessage", "params": params, "id": 1},
    )


async def list_tasks_raw(client, headers, page_size=None, page_token=None, context_id=None):
    params = {}
    if page_size is not None:
        params["pageSize"] = page_size
    if page_token is not None:
        params["pageToken"] = page_token
    if context_id is not None:
        params["contextId"] = context_id
    return await rpc(client, headers, "ListTasks", params, req_id=2)


async def list_task_ids(client, headers, **kw):
    body = await list_tasks_raw(client, headers, **kw)
    assert "error" not in body, body.get("error")
    return [t["id"] for t in body["result"].get("tasks", [])]


def key(prefix):
    return f"{prefix}-{uuid.uuid4().hex}"


# ---------------------------------------------------------------------------
# item 1: idempotency key grammar — reject, never truncate
# ---------------------------------------------------------------------------

class TestIdempotencyKeyGrammar:

    @pytest.mark.parametrize(
        "candidate,accepted",
        [
            ("abc-123", True),
            ("a.b_c:d-e", True),
            ("K" * 128, True),
            ("K" * 129, False),       # must be rejected, NOT truncated to 128
            ("", False),
            ("has space", False),
            ("sla/sh", False),
            ("line\nbreak", False),
            ("percent%20", False),
            ("semi;colon", False),
            ("quote'd", False),
            ("<script>", False),
            ("../../etc/passwd", False),
        ],
    )
    async def test_regex_accepts_and_rejects(self, candidate, accepted):
        assert bool(IDEMPOTENCY_KEY_RE.match(candidate)) is accepted


@requires_pg
class TestIdempotencyKeyRejection:
    async def test_overlong_key_is_rejected_not_truncated(self, client, actors):
        """A 500-char key must be rejected, not truncated into a 128-char key."""
        data = message(actors)
        data["message"]["metadata"]["clientMessageId"] = "K" * 500
        body = (await send_raw(client, actors.headers["owner"], data)).json()
        assert "error" in body, f"expected rejection, got {body.get('result')}"

    async def test_whitespace_key_is_rejected(self, client, actors):
        data = message(actors)
        data["message"]["metadata"]["clientMessageId"] = "bad key with spaces"
        body = (await send_raw(client, actors.headers["owner"], data)).json()
        assert "error" in body, f"expected rejection, got {body.get('result')}"

    async def test_valid_key_is_accepted(self, client, actors):
        data = message(actors)
        data["message"]["metadata"]["clientMessageId"] = key("audit-b")
        result = await send(client, actors.headers["owner"], data)
        assert result["task"]["id"]


# ---------------------------------------------------------------------------
# item 2: concurrent send with the same idempotency key -> exactly one task
# ---------------------------------------------------------------------------

@requires_pg
@pytest.mark.asyncio
async def test_concurrent_send_same_key_creates_one_task(client, db, actors):
    """Two simultaneous sends with the same key must produce exactly one task.

    Real PostgreSQL is required: SQLite serialises writers, so the unique-key
    conflict is never raised and the rollback-then-reread path stays untested.
    """
    from app.models.agent_task_delivery import AgentTaskDelivery as Delivery

    shared_key = key("race")
    task_ids = []
    failures = []

    async def one_send():
        data = message(actors)
        data["message"]["metadata"]["clientMessageId"] = shared_key
        resp = await send_raw(client, actors.headers["owner"], data)
        assert resp.status_code == 200, f"send failed with {resp.status_code}: {resp.text}"
        body = resp.json()
        if "error" in body:
            failures.append(body["error"])
        else:
            task_ids.append(body["result"]["task"]["id"])

    await _gather(one_send(), one_send())

    assert len(failures) == 0, f"unexpected errors: {failures}"
    assert len(task_ids) == 2, f"expected 2 responses with task id, got {len(task_ids)}"
    assert task_ids[0] == task_ids[1], f"task IDs must match: {task_ids[0]} vs {task_ids[1]}"

    await db.commit()
    msgs = (await db.execute(select(Message).where(Message.client_message_id == shared_key))).scalars().all()
    assert len(msgs) == 1, f"expected 1 Message row, got {len(msgs)}"

    tasks = (await db.execute(select(A2ATask).where(A2ATask.source_message_id == msgs[0].id))).scalars().all()
    assert len(tasks) == 1, f"expected 1 A2ATask row, got {len(tasks)}"
    assert tasks[0].id == task_ids[0]

    deliveries = (await db.execute(select(Delivery).where(Delivery.task_id == tasks[0].id))).scalars().all()
    assert len(deliveries) == 1, f"expected 1 Delivery row, got {len(deliveries)}"


async def _gather(*coros):
    import asyncio

    return await asyncio.gather(*coros)


# ---------------------------------------------------------------------------
# item 5: JWT typ enforcement
# ---------------------------------------------------------------------------

class TestJWTTypeClaim:
    @pytest.mark.asyncio
    async def test_typ_mismatch_is_rejected(self, client, actors):
        """A token claiming the human typ must not authenticate as an agent account."""
        token = create_access_token(actors.users["agent"].id, user_type="human")
        r = await client.post(
            "/a2a/rpc",
            headers={"Authorization": f"Bearer {token}", "A2A-Version": "1.0"},
            json={"jsonrpc": "2.0", "method": "SendMessage", "params": message(actors), "id": 1},
        )
        assert r.status_code in (401, 403), r.text

    @pytest.mark.asyncio
    async def test_matching_typ_is_accepted(self, client, actors):
        result = await send(client, actors.headers["owner"], message(actors))
        assert result["task"]["id"]


# ---------------------------------------------------------------------------
# item 6: ListTasks permission filter + consistent pagination
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_list_tasks_excludes_other_rooms(client, actors):
    """An outsider with no role in the room must not see the room's tasks."""
    result = await send(client, actors.headers["owner"], message(actors))
    tid = result["task"]["id"]
    visible = await list_task_ids(client, actors.headers["outsider"], page_size=100)
    assert tid not in visible, "outsider must not see a task from a room they cannot access"


@pytest.mark.asyncio
async def test_pagination_is_consistent_across_pages(client, actors):
    """Walking every page returns each task exactly once and terminates."""
    for i in range(7):
        data = message(actors)
        data["message"]["parts"] = [{"text": f"paged task {i}"}]
        await send(client, actors.headers["owner"], data)

    seen, token = [], None
    for _ in range(20):  # hard stop so a broken token can never loop forever
        body = await list_tasks_raw(client, actors.headers["owner"], page_size=2, page_token=token)
        assert "error" not in body, body.get("error")
        for item in body["result"].get("tasks", []):
            assert item["id"] not in seen, f"task {item['id']} repeated across pages"
            seen.append(item["id"])
        token = body["result"].get("nextPageToken") or None
        if not token:
            break
    else:
        pytest.fail("pagination did not terminate")

    assert len(seen) == len(set(seen)), "no task may appear twice"
    assert len(seen) >= 7, f"expected at least 7 tasks, got {len(seen)}"


@pytest.mark.asyncio
async def test_page_token_round_trip_is_stable(client, actors):
    """Replaying the server's own nextPageToken must not be rejected."""
    # Ensure there is more than one page of results, otherwise no token is issued.
    for i in range(3):
        await send(client, actors.headers["owner"], message(actors))

    body = await list_tasks_raw(client, actors.headers["owner"], page_size=2)
    token = body["result"].get("nextPageToken")
    assert token not in ("", "[REDACTED]", None), f"unusable page token: {token!r}"
    replayed = await list_tasks_raw(client, actors.headers["owner"], page_size=2, page_token=token)
    assert "error" not in replayed, replayed.get("error")


# ---------------------------------------------------------------------------
# items 2 + 4: retry an existing task -> same task, no duplicate, no cancel
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_same_key_retry_returns_existing_task(client, db, actors):
    """A repeated key must recover the same task instead of creating a second one."""
    data = message(actors)
    rec_key = key("recover")
    data["message"]["metadata"]["clientMessageId"] = rec_key

    first = await send(client, actors.headers["owner"], data)
    first_id = first["task"]["id"]

    # Second identical request must return same task ID without duplicate task
    second = await send(client, actors.headers["owner"], data)
    second_id = second["task"]["id"]
    assert second_id == first_id, f"retry must return same task ID: {second_id} vs {first_id}"

    all_ids = await list_task_ids(client, actors.headers["owner"], page_size=100)
    assert all_ids.count(first_id) == 1, "no duplicate task rows"

    # Same key but different payload text must return 409 conflict
    data_diff_text = message(actors)
    data_diff_text["message"]["metadata"]["clientMessageId"] = rec_key
    data_diff_text["message"]["parts"] = [{"text": "completely different payload text"}]
    r_text_conflict = await send_raw(client, actors.headers["owner"], data_diff_text)
    assert r_text_conflict.status_code == 409, f"expected 409 conflict, got {r_text_conflict.status_code}"
    assert "conflict" in r_text_conflict.text.lower() or "mismatch" in r_text_conflict.text.lower()

    # Same key but different target agent must return 409 conflict
    data_diff_target = message(actors)
    data_diff_target["message"]["metadata"]["clientMessageId"] = rec_key
    data_diff_target["message"]["parts"] = data["message"]["parts"]
    data_diff_target["message"]["metadata"]["targetAgent"] = actors.users["otheragent"].id
    r_target_conflict = await send_raw(client, actors.headers["owner"], data_diff_target)
    assert r_target_conflict.status_code == 409, f"expected 409 conflict, got {r_target_conflict.status_code}"
    assert "conflict" in r_target_conflict.text.lower() or "mismatch" in r_target_conflict.text.lower()


@pytest.mark.asyncio
async def test_distinct_messages_create_distinct_tasks(client, actors):
    ids = []
    for _ in range(2):
        result = await send(client, actors.headers["owner"], message(actors))
        ids.append(result["task"]["id"])
    assert ids[0] != ids[1]


# ---------------------------------------------------------------------------
# item 3 + 7: SSE lifecycle and sanitised compensation logging
# ---------------------------------------------------------------------------

async def _bind_false(*args, **kwargs):
    return False


@requires_pg
@pytest.mark.asyncio
async def test_sse_bind_failure_does_not_cancel_existing_task(client, db, actors):
    """Binding a pre-existing task in SendStreamingMessage must never cancel it when binding fails."""
    from unittest.mock import patch
    from app.a2a import http_protocol

    data = message(actors)
    client_key = key("sse-exist")
    data["message"]["metadata"]["clientMessageId"] = client_key

    first = await send(client, actors.headers["owner"], data)
    tid = first["task"]["id"]

    row_before = (await db.execute(select(A2ATask).where(A2ATask.id == tid))).scalar_one()
    assert row_before.status == "submitted"

    # Real SendStreamingMessage with bind_task failure for pre-existing task
    with patch.object(http_protocol.quota_policy, "bind_task", _bind_false):
        r = await client.post(
            "/a2a/rpc",
            headers=actors.headers["owner"],
            json={"jsonrpc": "2.0", "method": "SendStreamingMessage", "params": data, "id": 5},
        )
    assert r.status_code == 503, f"expected 503 QuotaUnavailable, got {r.status_code}: {r.text}"

    # The pre-existing task must survive intact and untouched.
    await db.commit()
    row = (await db.execute(select(A2ATask).where(A2ATask.id == tid))).scalar_one_or_none()
    assert row is not None, "pre-existing task must not be deleted"
    assert row.status != "canceled", f"pre-existing task must not be canceled, got {row.status}"
    assert row.status == "submitted"


@requires_pg
@pytest.mark.asyncio
async def test_sse_bind_failure_compensates_new_task_and_releases_lease(client, db, actors):
    """New task created during SendStreamingMessage must be compensated and lease released on bind failure."""
    from unittest.mock import patch
    from app.a2a import http_protocol

    data = message(actors)
    client_key = key("sse-new-comp")
    data["message"]["metadata"]["clientMessageId"] = client_key

    released_leases = []
    orig_release = http_protocol.quota_policy.release

    async def mock_release(s_db, lease_id, hub_id):
        released_leases.append(lease_id)
        return await orig_release(s_db, lease_id, hub_id)

    with patch.object(http_protocol.quota_policy, "bind_task", _bind_false),          patch.object(http_protocol.quota_policy, "release", side_effect=mock_release):
        r = await client.post(
            "/a2a/rpc",
            headers=actors.headers["owner"],
            json={"jsonrpc": "2.0", "method": "SendStreamingMessage", "params": data, "id": 6},
        )
    assert r.status_code == 503

    assert len(released_leases) >= 1, "quota lease must be released"

    await db.commit()
    msg = (await db.execute(select(Message).where(Message.client_message_id == client_key))).scalar_one()
    task = (await db.execute(select(A2ATask).where(A2ATask.source_message_id == msg.id))).scalar_one()
    assert task.status == "canceled", f"new task must be canceled, got {task.status}"

    # Recovery query
    body = await rpc(client, actors.headers["owner"], "GetTask", {"id": task.id}, req_id=7)
    assert body["result"]["status"]["state"] == "TASK_STATE_CANCELED"


@requires_pg
@pytest.mark.asyncio
async def test_sse_bind_failure_compensation_failure_marks_task_failed(client, db, actors):
    """When cancel_task fails during compensation, task must be marked failed."""
    from unittest.mock import patch
    from app.a2a import http_protocol
    from app.a2a.task_service import TaskService

    data = message(actors)
    client_key = key("sse-comp-fail")
    data["message"]["metadata"]["clientMessageId"] = client_key

    async def _fail_cancel(*args, **kwargs):
        raise RuntimeError("simulated cancel failure")

    with patch.object(http_protocol.quota_policy, "bind_task", _bind_false),          patch.object(TaskService, "cancel_task", side_effect=_fail_cancel):
        r = await client.post(
            "/a2a/rpc",
            headers=actors.headers["owner"],
            json={"jsonrpc": "2.0", "method": "SendStreamingMessage", "params": data, "id": 8},
        )
    assert r.status_code == 503

    await db.commit()
    msg = (await db.execute(select(Message).where(Message.client_message_id == client_key))).scalar_one()
    task = (await db.execute(select(A2ATask).where(A2ATask.source_message_id == msg.id))).scalar_one()
    assert task.status == "failed", f"task must be marked failed, got {task.status}"

    # Recovery query
    body = await rpc(client, actors.headers["owner"], "GetTask", {"id": task.id}, req_id=9)
    assert body["result"]["status"]["state"] == "TASK_STATE_FAILED"


@requires_pg
@pytest.mark.asyncio
async def test_compensation_logs_no_payload_data(client, actors, caplog):
    """Compensation logging carries only exception class names, never payload data."""
    import logging
    from unittest.mock import patch
    from app.a2a import http_protocol
    from app.a2a.task_service import TaskService

    room_id = actors.room.id
    agent_id = actors.users["agent"].id

    async def _cancel_error(*args, **kwargs):
        raise RuntimeError("simulated compensation exception with SECRET_LEAK_TRY")

    data = message(actors)
    data["message"]["metadata"]["clientMessageId"] = key("sse-log")
    data["message"]["parts"] = [{"text": "TOP-SECRET-PAYLOAD-TEXT"}]

    with caplog.at_level(logging.WARNING),          patch.object(http_protocol.quota_policy, "bind_task", _bind_false),          patch.object(TaskService, "cancel_task", side_effect=_cancel_error):
        r = await client.post(
            "/a2a/rpc",
            headers=actors.headers["owner"],
            json={"jsonrpc": "2.0", "method": "SendStreamingMessage", "params": data, "id": 10},
        )
    assert r.status_code == 503

    blob = caplog.text
    assert "Failed to cancel newly created task" in blob, "compensation failure must be logged"
    assert "RuntimeError" in blob, "exception class name must be logged"
    assert "SECRET_LEAK_TRY" not in blob, "exception message must not leak into log"
    assert "TOP-SECRET-PAYLOAD-TEXT" not in blob, "compensation log leaked payload text"
    assert str(room_id) not in blob, "compensation log leaked the room id"
    assert str(agent_id) not in blob, "compensation log leaked the agent id"


@pytest.mark.asyncio
async def test_sse_endpoint_returns_the_task_stream(client, actors):
    """The events endpoint streams the task lifecycle to the task owner."""
    tid = (await send(client, actors.headers["owner"], message(actors)))["task"]["id"]
    r = await client.get(f"/api/v1/tasks/{tid}/events", headers=actors.headers["owner"])
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), dict)

# ---------------------------------------------------------------------------
# item 4 + 5 (round 4 additions): >4096 pagination traversal & PG type safety
# ---------------------------------------------------------------------------

@requires_pg
@pytest.mark.asyncio
async def test_pagination_over_4096_filtered_records(client, db, actors):
    """Traversing tasks when > 4096 invisible tasks are intermingled must not prematurely end."""
    from sqlalchemy import insert

    # 1. Insert 1 visible task for agent
    t_first = (await send(client, actors.headers["owner"], message(actors)))["task"]["id"]

    # 2. Bulk insert 4200 invisible tasks in the same room targeted at another non-matching agent
    room_id = actors.room.id
    bulk_tasks = [
        {
            "id": f"invis-{i}-{uuid.uuid4().hex[:8]}",
            "context_id": str(uuid.uuid4()),
            "source_agent": actors.users["owner"].id,
            "target_agent": "invisible_target_other",
            "query": f"invisible task {i}",
            "status": "submitted",
            "room_id": room_id,
        }
        for i in range(4200)
    ]
    await db.execute(insert(A2ATask), bulk_tasks)
    await db.commit()

    # 3. Insert 1 more visible task for agent
    t_last = (await send(client, actors.headers["owner"], message(actors)))["task"]["id"]

    # 4. Agent user lists tasks: only t_first and t_last should be visible
    # Traverse with pagination (page_size = 50)
    seen, token = [], None
    max_pages = 100
    for _ in range(max_pages):
        body = await list_tasks_raw(client, actors.headers["agent"], page_size=50, page_token=token)
        assert "error" not in body, body.get("error")
        for t in body["result"].get("tasks", []):
            assert t["id"] not in seen, f"task {t['id']} duplicated"
            seen.append(t["id"])
        token = body["result"].get("nextPageToken") or None
        if not token:
            break
    else:
        pytest.fail("pagination did not terminate within max_pages")

    assert t_first in seen, "first task must be retrieved"
    assert t_last in seen, "last task must be retrieved after skipping >4096 invisible records"
    assert len(seen) == 2, f"expected exactly 2 visible tasks, got {len(seen)}"


@requires_pg
@pytest.mark.asyncio
async def test_postgres_agent_without_owner_list_tasks(client, db, actors):
    """An agent user without owner_user_id must not crash with PostgreSQL type error on ListTasks."""
    from app.models.user import User

    unowned_agent = User(username="unowned_" + uuid.uuid4().hex[:6], display_name="Unowned", user_type="agent")
    db.add(unowned_agent)
    await db.commit()

    token = create_access_token(unowned_agent.id, "agent")
    headers = {"Authorization": f"Bearer {token}", "A2A-Version": "1.0"}

    body = await list_tasks_raw(client, headers, page_size=10)
    assert "error" not in body, body.get("error")
    assert body["result"].get("tasks", []) == []
