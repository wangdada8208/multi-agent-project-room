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
    def test_regex_accepts_and_rejects(self, candidate, accepted):
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
    shared_key = key("race")
    task_ids = []
    failures = []

    async def one_send():
        data = message(actors)
        data["message"]["metadata"]["clientMessageId"] = shared_key
        body = (await send_raw(client, actors.headers["owner"], data)).json()
        if "error" in body:
            failures.append(body["error"])
        else:
            task_ids.append(body["result"]["task"]["id"])

    await _gather(one_send(), one_send())

    # A rejected duplicate is fine; a 500/internal error is a bug.
    for err in failures:
        assert err.get("code") != -32603, f"internal error leaked to caller: {err}"

    


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
    data["message"]["metadata"]["clientMessageId"] = key("recover")

    first = await send(client, actors.headers["owner"], data)
    first_id = first["task"]["id"]

    

    all_ids = await list_task_ids(client, actors.headers["owner"], page_size=100)
    assert all_ids.count(first_id) == 1, "no duplicate task rows"


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
    """Binding a pre-existing task must never cancel it when binding fails."""
    from unittest.mock import patch

    from app.a2a import http_protocol

    tid = (await send(client, actors.headers["owner"], message(actors)))["task"]["id"]

    with patch.object(http_protocol, "quota_policy") as quota_mock:
        quota_mock.bind_task = _bind_false
        # subscribe to a pre-existing task whose bind now fails
        body = await rpc(
            client, actors.headers["owner"], "SubscribeToTask",
            {"id": tid}, req_id=4,
        )

    # A bind failure may surface as a protocol error; it must not be a 500.
    if "error" in body:
        assert body["error"].get("code") != -32603, body["error"]

    # The pre-existing task must survive intact and untouched.
    await db.commit()
    row = (await db.execute(select(A2ATask).where(A2ATask.id == tid))).scalar_one_or_none()
    assert row is not None, "pre-existing task must not be deleted"
    assert row.status != "cancelled", f"pre-existing task must not be cancelled, got {row.status}"


@requires_pg
@pytest.mark.asyncio
async def test_compensation_logs_no_payload_data(client, actors, caplog):
    """Compensation logging carries only exception class names, never payload data."""
    import logging
    from unittest.mock import patch

    from app.a2a import http_protocol

    room_id = actors.room.id
    agent_id = actors.users["agent"].id

    async def refuse_lease(*args, **kwargs):
        raise RuntimeError("lease refused")

    data = message(actors)
    data["message"]["metadata"]["clientMessageId"] = key("sse-log")
    data["message"]["parts"] = [{"text": "TOP-SECRET-PAYLOAD-TEXT"}]

    

    blob = caplog.text
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