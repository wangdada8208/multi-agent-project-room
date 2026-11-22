"""Shared EIP-191 test helper: request a server nonce and sign it.

Tests that hit /redeem, /agent-register or members/me/xmtp-address must prove
address ownership exactly like a real wallet: POST /api/v1/invites/nonce, then
personal_sign the returned message. Each call mints a fresh single-use nonce.
"""
from __future__ import annotations

from eth_account import Account
from eth_account.messages import encode_defunct


def new_wallet() -> Account:
    return Account.create()


async def signed_proof(client, action: str, resource: str, account: Account) -> dict:
    resp = await client.post(
        "/api/v1/invites/nonce",
        json={"action": action, "resource": resource, "address": account.address},
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    sig = account.sign_message(encode_defunct(text=data["message"]))
    return {"nonce": data["nonce"], "signature": "0x" + sig.signature.hex().removeprefix("0x")}


async def redeem_signed(client, token: str, account: Account, headers: dict | None = None):
    proof = await signed_proof(client, "invite-redeem", token, account)
    body = {"xmtp_address": account.address, **proof}
    return await client.post(f"/api/v1/invites/{token}/redeem", json=body, headers=headers or {})


async def agent_register_signed(
    client, token: str, account: Account, display_name: str | None = None
):
    proof = await signed_proof(client, "invite-agent-register", token, account)
    body = {"xmtp_address": account.address, **proof}
    if display_name:
        body["display_name"] = display_name
    return await client.post(f"/api/v1/invites/{token}/agent-register", json=body)


async def agent_register_poll(client, token: str, account: Account):
    proof = await signed_proof(client, "invite-agent-register", token, account)
    return await client.get(
        f"/api/v1/invites/{token}/agent-register",
        params={"address": account.address, **proof},
    )


async def bind_address_signed(client, room_id: str, account: Account, headers: dict):
    proof = await signed_proof(client, "bind-address", room_id, account)
    body = {"xmtp_address": account.address, **proof}
    return await client.put(
        f"/api/v1/rooms/{room_id}/members/me/xmtp-address", json=body, headers=headers
    )
