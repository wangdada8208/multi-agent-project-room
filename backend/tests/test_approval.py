"""Test approval API and service."""

import pytest
import uuid
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.room import Room
from app.models.user import User
from app.approval.service import create_approval, list_approvals, decide_approval


@pytest.mark.asyncio
async def test_approval_flow(client: AsyncClient, auth_headers: dict[str, str]):
    """Full approval lifecycle via API."""
    # Create room first
    resp = await client.post("/api/v1/rooms", json={"name": "Approval Test"}, headers=auth_headers)
    room_id = resp.json()["room"]["id"]

    # Create approval
    resp = await client.post(
        f"/api/v1/rooms/{room_id}/approvals",
        json={"title": "Approve this", "description": "Please approve", "risk_level": "low"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    approval = resp.json()["approval"]
    assert approval["status"] == "pending"
    approval_id = approval["id"]

    # List approvals
    resp = await client.get(f"/api/v1/rooms/{room_id}/approvals", headers=auth_headers)
    assert resp.status_code == 200
    assert len(resp.json()["approvals"]) == 1

    # Approve
    resp = await client.post(
        f"/api/v1/approvals/{approval_id}/approve",
        json={"decision": "approved"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["approval"]["status"] == "approved"

    # Reject another
    resp = await client.post(
        f"/api/v1/rooms/{room_id}/approvals",
        json={"title": "Reject this", "description": "Please reject"},
        headers=auth_headers,
    )
    approval_id2 = resp.json()["approval"]["id"]

    resp = await client.post(
        f"/api/v1/approvals/{approval_id2}/approve",
        json={"decision": "rejected"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    assert resp.json()["approval"]["status"] == "rejected"


@pytest.mark.asyncio
async def test_approval_service(db: AsyncSession):
    """Test approval service functions."""
    room = Room(name="Svc Test")
    db.add(room)
    await db.commit()

    approval = await create_approval(
        db=db, room_id=room.id, requestor_id="test-agent",
        title="Service test", description="Testing",
    )
    assert approval.status == "pending"
    assert approval.title == "Service test"

    approvals = await list_approvals(db=db, room_id=room.id)
    assert len(approvals) == 1

    result = await decide_approval(db=db, approval_id=approval.id, decider_id="admin", decision="approved")
    assert result is not None
    assert result.status == "approved"
