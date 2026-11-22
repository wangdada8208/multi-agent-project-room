"""Encrypted (xmtp) rooms keep file and document bodies off the Hub entirely.

The files and knowledge APIs are plaintext-on-Hub features. For rooms with
``transport == "xmtp"`` every one of their endpoints must answer 409 so that
no attachment bytes or document bodies ever reach Hub storage. Plaintext
``_agent_`` channels (``transport == "hub"``) keep the legacy behaviour.
"""

import uuid

import pytest
from sqlalchemy import select

from app.files.models import RoomFile
from app.knowledge.models import KnowledgeDoc
from app.models.room import Room


async def _create_room(client, headers, name="房间") -> str:
    created = await client.post(
        "/api/v1/rooms",
        headers=headers,
        json={"name": name, "description": ""},
    )
    assert created.status_code == 200
    return created.json()["room"]["id"]


async def _flip_to_hub(db, room_id: str) -> None:
    """Test-only transport override: simulate an _agent_-style hub channel."""
    room = await db.get(Room, room_id)
    room.transport = "hub"
    await db.commit()


@pytest.mark.asyncio
async def test_xmtp_room_rejects_file_upload_and_writes_nothing(client, auth_headers, db):
    room_id = await _create_room(client, auth_headers)

    resp = await client.post(
        f"/api/v1/rooms/{room_id}/files/upload",
        headers=auth_headers,
        files={"file": ("note.txt", b"secret bytes that must not reach the Hub")},
    )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "body_not_on_hub"

    rows = (
        await db.execute(select(RoomFile).where(RoomFile.room_id == room_id))
    ).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_xmtp_room_rejects_file_list_and_download(client, auth_headers):
    room_id = await _create_room(client, auth_headers)

    list_resp = await client.get(f"/api/v1/rooms/{room_id}/files", headers=auth_headers)
    assert list_resp.status_code == 409

    download = await client.get(
        f"/api/v1/rooms/{room_id}/files/{uuid.uuid4()}/download",
        headers=auth_headers,
    )
    assert download.status_code == 409


@pytest.mark.asyncio
async def test_xmtp_room_rejects_docs_end_to_end(client, auth_headers, db):
    room_id = await _create_room(client, auth_headers)

    created = await client.post(
        f"/api/v1/rooms/{room_id}/docs",
        headers=auth_headers,
        json={"title": "私密文档", "content": "正文不能进 Hub"},
    )
    assert created.status_code == 409

    for suffix in ("", "/search?q=私密", f"/{uuid.uuid4()}"):
        resp = await client.get(
            f"/api/v1/rooms/{room_id}/docs{suffix}", headers=auth_headers
        )
        assert resp.status_code == 409, suffix

    rows = (
        await db.execute(select(KnowledgeDoc).where(KnowledgeDoc.room_id == room_id))
    ).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_nonmember_still_gets_403_before_transport_guard(client, auth_headers):
    """Authorization is checked before the transport guard."""
    room_id = await _create_room(client, auth_headers)
    outsider = (
        await client.post(
            "/api/v1/auth/register",
            json={
                "username": "outsider",
                "display_name": "Outsider",
                "password": "password123",
            },
        )
    ).json()
    headers = {"Authorization": f"Bearer {outsider['access_token']}"}

    resp = await client.post(
        f"/api/v1/rooms/{room_id}/files/upload",
        headers=headers,
        files={"file": ("injected.txt", b"unapproved")},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_hub_transport_room_keeps_files_and_docs(client, auth_headers, db):
    """Plaintext _agent_-style rooms (transport='hub') keep legacy behaviour."""
    room_id = await _create_room(client, auth_headers)
    await _flip_to_hub(db, room_id)

    uploaded = await client.post(
        f"/api/v1/rooms/{room_id}/files/upload",
        headers=auth_headers,
        files={"file": ("notes.txt", b"hub room bytes")},
    )
    assert uploaded.status_code == 200
    file_id = uploaded.json()["file"]["id"]

    listed = await client.get(f"/api/v1/rooms/{room_id}/files", headers=auth_headers)
    assert listed.status_code == 200
    assert [f["id"] for f in listed.json()["files"]] == [file_id]

    downloaded = await client.get(
        f"/api/v1/rooms/{room_id}/files/{file_id}/download", headers=auth_headers
    )
    assert downloaded.status_code == 200

    created = await client.post(
        f"/api/v1/rooms/{room_id}/docs",
        headers=auth_headers,
        json={"title": "hub 文档", "content": "hub 房间正文照常"},
    )
    assert created.status_code == 200
    doc_id = created.json()["doc"]["id"]

    for suffix in ("", "/search?q=hub", f"/{doc_id}"):
        resp = await client.get(
            f"/api/v1/rooms/{room_id}/docs{suffix}", headers=auth_headers
        )
        assert resp.status_code == 200, suffix
