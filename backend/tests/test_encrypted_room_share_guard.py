"""Encrypted rooms must not be able to create a read-only share link (H1 sibling).

The share *view* already returns an empty list for ``transport == "xmtp"``. The
gap was the generator: anyone could mint a share token for an encrypted room,
leaving an entry point that should not exist. An entry point that must never
work should not be creatable in the first place.
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models.room import Room
from app.models.room_share import RoomShareToken


@pytest.mark.asyncio
async def test_encrypted_room_cannot_create_share_link(client, auth_headers):
    created = await client.post(
        "/api/v1/rooms",
        json={"name": "encrypted room", "transport": "xmtp"},
        headers=auth_headers,
    )
    assert created.status_code in (200, 201), created.text
    room_id = created.json()["room"]["id"] if "room" in created.json() else created.json()["id"]

    share = await client.post(f"/api/v1/rooms/{room_id}/share", json={}, headers=auth_headers)
    assert share.status_code == 409, share.text
    assert "token" not in share.json()


@pytest.mark.asyncio
async def test_encrypted_room_share_is_not_persisted(client, db, auth_headers):
    created = await client.post(
        "/api/v1/rooms",
        json={"name": "encrypted room 2", "transport": "xmtp"},
        headers=auth_headers,
    )
    room_id = created.json()["room"]["id"] if "room" in created.json() else created.json()["id"]

    await client.post(f"/api/v1/rooms/{room_id}/share", json={}, headers=auth_headers)

    rows = (await db.execute(select(RoomShareToken).where(RoomShareToken.room_id == room_id))).scalars().all()
    assert rows == [], "a refused share request must not leave a token behind"


@pytest.mark.asyncio
async def test_plaintext_room_can_still_create_share_link(client, db, auth_headers):
    """The refusal is scoped to encrypted rooms; plaintext rooms keep working."""
    me = (await client.get("/api/v1/auth/me", headers=auth_headers)).json()["user"]

    room = Room(name="plaintext room", created_by=me["id"], transport="hub")
    db.add(room)
    await db.flush()
    from app.models.room_permission import RoomPermission

    db.add(RoomPermission(room_id=room.id, user_id=me["id"], role="owner"))
    await db.commit()

    share = await client.post(f"/api/v1/rooms/{room.id}/share", json={}, headers=auth_headers)
    assert share.status_code == 200, share.text
    assert share.json()["token"]
