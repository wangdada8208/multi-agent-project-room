"""EIP-191 (personal_sign) proof verification for XMTP/EVM addresses (m1 / WP6).

Flow
----
1. Caller asks ``POST /api/v1/invites/nonce`` for a challenge bound to an
   action, a resource (invite token or room id) and an address. The server
   stores a single-use ``xmtp_auth_nonces`` row and returns the exact message
   to sign plus the nonce.
2. The protected endpoint receives ``nonce`` + ``signature`` and calls
   :func:`require_signed_nonce`, which rebuilds the signed text from the
   *stored* row — so action, resource, address and expiry are bound
   server-side, never from client fields — recovers the EIP-191 signer, then
   atomically consumes the nonce with one conditional UPDATE checked by
   rowcount (replay-safe across restarts and concurrent requests).

No private key material ever touches this module; only signatures travel.
"""
from __future__ import annotations

import re
import secrets
from datetime import datetime, timedelta, timezone

from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import HTTPException
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.xmtp_auth_nonce import NONCE_ACTIONS, XmtpAuthNonce

ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
SIGNATURE_RE = re.compile(r"^0x[0-9a-fA-F]{130}$")

# Domain separator baked into every signed message.
DOMAIN = "MAPR-XP1"
NONCE_TTL_SECONDS = 600
# Bounds table growth without rate-limiting legitimate concurrent sign-ins:
# a single (action, address) may hold at most this many live challenges.
MAX_LIVE_NONCES_PER_ADDRESS = 32

ACTION_INVITE_REDEEM = "invite-redeem"
ACTION_AGENT_REGISTER = "invite-agent-register"
ACTION_BIND_ADDRESS = "bind-address"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def normalize_address(address: str) -> str:
    if not ADDRESS_RE.match(address or ""):
        raise HTTPException(status_code=422, detail="Invalid Ethereum/XMTP address")
    return address.lower()


def build_nonce_message(
    action: str, resource: str, address: str, nonce: str, expires_at: datetime
) -> str:
    """Canonical domain-separated text the wallet must sign verbatim."""
    exp = _as_utc(expires_at).strftime("%Y-%m-%dT%H:%M:%SZ")
    return (
        f"{DOMAIN}\n"
        f"action: {action}\n"
        f"resource: {resource}\n"
        f"address: {address.lower()}\n"
        f"nonce: {nonce}\n"
        f"expires_at: {exp}"
    )


def recover_signer(message: str, signature: str) -> str:
    """Recover the EIP-191 signer address (lowercase); 422 on malformed input."""
    if not SIGNATURE_RE.match(signature or ""):
        raise HTTPException(status_code=422, detail="Invalid signature format")
    try:
        recovered = Account.recover_message(encode_defunct(text=message), signature=signature)
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid signature") from None
    return recovered.lower()


async def issue_nonce(
    db: AsyncSession, *, action: str, resource: str, address: str
) -> tuple[str, str, datetime]:
    """Create a single-use challenge row; returns (nonce, message, expires_at)."""
    if action not in NONCE_ACTIONS:
        raise HTTPException(status_code=422, detail="Unknown nonce action")
    normalized = normalize_address(address)
    now = _now()
    # Opportunistic sweep of this address's dead challenges, then cap live ones.
    await db.execute(
        delete(XmtpAuthNonce)
        .where(
            XmtpAuthNonce.address == normalized,
            XmtpAuthNonce.expires_at <= now,
        )
        .execution_options(synchronize_session=False)
    )
    live = await db.scalar(
        select(func.count())
        .select_from(XmtpAuthNonce)
        .where(
            XmtpAuthNonce.action == action,
            XmtpAuthNonce.address == normalized,
            XmtpAuthNonce.expires_at > now,
        )
    )
    if live and live >= MAX_LIVE_NONCES_PER_ADDRESS:
        raise HTTPException(status_code=429, detail="Too many open signature challenges")
    nonce = secrets.token_urlsafe(32)
    expires_at = _now() + timedelta(seconds=NONCE_TTL_SECONDS)
    db.add(
        XmtpAuthNonce(
            nonce=nonce,
            action=action,
            resource=resource,
            address=normalized,
            expires_at=expires_at,
        )
    )
    await db.flush()
    message = build_nonce_message(action, resource, normalized, nonce, expires_at)
    return nonce, message, expires_at


async def require_signed_nonce(
    db: AsyncSession,
    *,
    action: str,
    resource: str,
    address: str,
    nonce: str,
    signature: str,
) -> None:
    """Verify the EIP-191 proof and atomically burn the nonce.

    Raises 422 on a missing/binding-mismatched/bad signature, 409 on replay,
    410 on an expired challenge. On success the nonce row is consumed inside
    the caller's transaction, so a later rollback un-burns nothing the caller
    did not also roll back.
    """
    normalized = normalize_address(address)
    row = await db.get(XmtpAuthNonce, nonce)
    if (
        row is None
        or row.action != action
        or row.resource != resource
        or row.address != normalized
    ):
        raise HTTPException(status_code=422, detail="Signature proof does not match the issued challenge")

    # The signed text is rebuilt from the stored row — client-supplied
    # action/resource/address/expiry never influence what gets verified.
    message = build_nonce_message(row.action, row.resource, row.address, row.nonce, row.expires_at)
    signer = recover_signer(message, signature)
    if signer != normalized:
        raise HTTPException(status_code=422, detail="Signature does not match the claimed address")

    consumed = await db.execute(
        update(XmtpAuthNonce)
        .where(
            XmtpAuthNonce.nonce == nonce,
            XmtpAuthNonce.consumed_at.is_(None),
            XmtpAuthNonce.expires_at > _now(),
        )
        .values(consumed_at=_now())
        .execution_options(synchronize_session=False)
    )
    if consumed.rowcount != 1:
        # The row in the session is stale (a concurrent consume may have won);
        # re-read before deciding which error is truthful.
        await db.refresh(row)
        if row.consumed_at is not None:
            raise HTTPException(status_code=409, detail="Signature challenge already used")
        if _as_utc(row.expires_at) <= _now():
            raise HTTPException(status_code=410, detail="Signature challenge expired")
        raise HTTPException(status_code=409, detail="Signature challenge already used")
