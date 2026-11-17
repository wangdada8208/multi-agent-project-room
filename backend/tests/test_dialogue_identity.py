"""dialogues/send 身份绑定回归：复合身份只能从唯一 username 派生。

审查 PR #8 时发现 display_name 无唯一约束，攻击者注册同名 display_name
即可冒用他人代理的复合身份。本文件锁定修复后的拒绝行为。
"""
import pytest
from httpx import AsyncClient


async def _create_dialogue(client: AsyncClient, auth_headers: dict[str, str], room_id: str) -> str:
    resp = await client.post(
        "/a2a/dialogue-rpc",
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/create",
            "params": {
                "room_id": room_id,
                "initiator_agent": "tester",
                "participants": ["tester", "Claude"],
                "duration_seconds": 30,
                "max_turns": 8,
            },
            "id": "identity-create",
        },
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["result"]["dialogue_id"]


async def _register_and_invite(
    client: AsyncClient, auth_headers: dict[str, str], room_id: str,
    username: str, display_name: str,
) -> dict[str, str]:
    resp = await client.post(
        "/api/v1/auth/register",
        json={"username": username, "password": "pw-identity-123", "display_name": display_name},
    )
    assert resp.status_code == 200, resp.text
    headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}
    resp = await client.post(
        f"/api/v1/rooms/{room_id}/invite",
        json={"username": username, "role": "member"},
        headers=auth_headers,
    )
    assert resp.status_code == 200, resp.text
    return headers


async def _send(client: AsyncClient, headers: dict[str, str], dialogue_id: str,
                room_id: str, sender_id: str, sender_name: str):
    return await client.post(
        "/a2a/dialogue-rpc",
        json={
            "jsonrpc": "2.0",
            "method": "dialogues/send",
            "params": {
                "dialogue_id": dialogue_id,
                "room_id": room_id,
                "sender_id": sender_id,
                "sender_name": sender_name,
                "target_agent": "Claude",
                "content": "identity probe",
            },
            "id": "identity-send",
        },
        headers=headers,
    )


@pytest.mark.asyncio
async def test_display_name_collision_cannot_impersonate(client: AsyncClient, auth_headers: dict[str, str]):
    room_id = "identity-collision-room"
    dialogue_id = await _create_dialogue(client, auth_headers, room_id)
    # 攻击者的 display_name 与受害者 username 相同，但 username 不同
    mallory = await _register_and_invite(client, auth_headers, room_id, "mallory", "tester")

    resp = await _send(client, mallory, dialogue_id, room_id, "agent_tester", "tester")
    assert resp.status_code == 403, resp.text


@pytest.mark.asyncio
async def test_sender_name_must_match_username(client: AsyncClient, auth_headers: dict[str, str]):
    room_id = "identity-name-room"
    dialogue_id = await _create_dialogue(client, auth_headers, room_id)
    mallory = await _register_and_invite(client, auth_headers, room_id, "mallory2", "Mallory")

    # 用自己的复合 ID 但冒用他人名字作为 sender_name
    resp = await _send(client, mallory, dialogue_id, room_id, "agent_mallory2", "tester")
    assert resp.status_code == 403, resp.text


@pytest.mark.asyncio
async def test_own_username_composite_still_allowed(client: AsyncClient, auth_headers: dict[str, str]):
    room_id = "identity-positive-room"
    dialogue_id = await _create_dialogue(client, auth_headers, room_id)

    resp = await _send(client, auth_headers, dialogue_id, room_id, "agent_tester", "tester")
    assert resp.status_code == 200, resp.text