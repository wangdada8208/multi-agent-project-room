"""Authenticated permanent ownership; invitations grant no execution permissions."""
from __future__ import annotations

from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from functools import wraps
import hashlib
import hmac
import secrets
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, SecretStr, model_validator
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import SQLAlchemyError

from app.agent.service import authorize_agent_registration, find_username_matches
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.agent_binding import AgentBindingInvite
from app.models.user import User

router = APIRouter(prefix="/api/v1/agent-bindings", tags=["agent-bindings"])
_attempts: dict[tuple[str, str], deque] = defaultdict(deque)


class InvitationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_agent_user_id: str | None = None
    target_agent_username: str | None = None

    @model_validator(mode="after")
    def exclusive_target(self):
        if self.target_agent_user_id is not None and self.target_agent_username is not None:
            raise ValueError("Specify one target")
        return self


class ClaimRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: SecretStr


def _digest(code: str, salt: str) -> str:
    return hashlib.sha256((salt + ":" + code).encode()).hexdigest()


async def _human(db: AsyncSession, user: User) -> User:
    stored = await db.get(User, user.id, populate_existing=True)
    if stored is None or stored.user_type != "human":
        raise HTTPException(403, "Human account required")
    return stored


def _reject_claim():
    raise HTTPException(409, "Binding invitation unavailable or agent already bound")


def _limit_attempt(user_id: str, action: str, limit: int, window: int):
    now = time.monotonic()
    attempts = _attempts[(user_id, action)]
    while attempts and attempts[0] <= now - window:
        attempts.popleft()
    if len(attempts) >= limit:
        raise HTTPException(429, "Too many binding attempts")
    attempts.append(now)


def _database_errors(handler):
    # Do not expose SQL parameter values (including hashes) through the global handler.
    @wraps(handler)
    async def guarded(*args, **kwargs):
        try:
            return await handler(*args, **kwargs)
        except SQLAlchemyError:
            try:
                await kwargs["db"].rollback()
            except SQLAlchemyError:
                pass
            raise HTTPException(503, "Binding storage temporarily unavailable") from None
    return guarded


@router.post("/invitations", status_code=201)
@_database_errors
async def issue_invitation(payload: InvitationRequest, response: Response, db: AsyncSession = Depends(get_db),
                           user: User = Depends(get_current_user)):
    owner = await _human(db, user)
    _limit_attempt(owner.id, "issue", 10, 600)
    now = datetime.now(timezone.utc)
    # UPDATE obtains a DB write/row lock, serializing issuance counts across workers.
    await db.execute(update(User).where(User.id == owner.id, User.user_type == "human")
                     .values(owner_user_id=User.owner_user_id).execution_options(synchronize_session=False))
    count = await db.scalar(select(func.count()).select_from(AgentBindingInvite).where(
        AgentBindingInvite.issuer_user_id == owner.id,
        AgentBindingInvite.created_at > now - timedelta(minutes=10)))
    if count >= 10:
        await db.rollback()
        raise HTTPException(429, "Too many invitations")
    target = None
    if payload.target_agent_user_id is not None or payload.target_agent_username is not None:
        if payload.target_agent_user_id is not None:
            target = await db.get(User, payload.target_agent_user_id)
        else:
            matches = await find_username_matches(db, payload.target_agent_username)
            target = matches[0] if len(matches) == 1 else None
        if target is None or target.user_type != "agent":
            await db.rollback()
            raise HTTPException(403, "Target unavailable")
        matches = await find_username_matches(db, target.username)
        if len(matches) != 1:
            await db.rollback()
            raise HTTPException(403, "Target unavailable")
    invite_id = str(uuid.uuid4())
    code = invite_id + "." + secrets.token_urlsafe(32)
    salt = secrets.token_hex(16)
    expires = now + timedelta(minutes=10)
    invite = AgentBindingInvite(id=invite_id, token_hash=_digest(code, salt), token_salt=salt,
                                issuer_user_id=owner.id, target_agent_user_id=target.id if target else None,
                                expires_at=expires, created_at=now)
    db.add(invite)
    await db.commit()
    response.headers["Cache-Control"] = "no-store"
    return {"id": invite_id, "code": code, "expires_at": expires.isoformat()}


@router.post("/claim")
@_database_errors
async def claim_invitation(payload: ClaimRequest, db: AsyncSession = Depends(get_db),
                           user: User = Depends(get_current_user)):
    await authorize_agent_registration(db, user, user.username)
    _limit_attempt(user.id, "claim", 20, 60)
    agent_id = user.id
    code = payload.code.get_secret_value()
    if len(code) > 128:
        _reject_claim()
    invite_id = code.partition(".")[0]
    invite = await db.get(AgentBindingInvite, invite_id)
    if invite is None or not hmac.compare_digest(_digest(code, invite.token_salt), invite.token_hash):
        _reject_claim()
    # Owner identity is derived exclusively from the persisted invitation.
    owner_id = invite.issuer_user_id
    owner = await db.get(User, owner_id, populate_existing=True)
    if owner is None or owner.user_type != "human":
        _reject_claim()
    now = datetime.now(timezone.utc)
    consumed = await db.execute(update(AgentBindingInvite).where(
        AgentBindingInvite.id == invite_id,
        AgentBindingInvite.consumed_at.is_(None), AgentBindingInvite.revoked_at.is_(None),
        AgentBindingInvite.expires_at > now,
        or_(AgentBindingInvite.target_agent_user_id.is_(None),
            AgentBindingInvite.target_agent_user_id == agent_id),
    ).values(consumed_at=now, claimed_agent_user_id=agent_id)
      .execution_options(synchronize_session=False))
    if consumed.rowcount != 1:
        await db.rollback()
        _reject_claim()
    bound = await db.execute(update(User).where(
        User.id == agent_id, User.user_type == "agent", User.owner_user_id.is_(None)
    ).values(owner_user_id=owner_id, owner_bound_at=now).execution_options(synchronize_session=False))
    if bound.rowcount != 1:
        await db.rollback()
        _reject_claim()
    await db.commit()
    return {"agent_user_id": agent_id, "owner_user_id": owner_id, "owner_bound_at": now.isoformat()}


@router.get("/agents")
@_database_errors
async def owned_agents(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    owner = await _human(db, user)
    agents = (await db.scalars(select(User).where(User.owner_user_id == owner.id,
                                                 User.user_type == "agent").order_by(User.created_at, User.id))).all()
    return {"agents": [{"id": a.id, "username": a.username, "display_name": a.display_name,
                         "owner_user_id": a.owner_user_id,
                         "owner_bound_at": a.owner_bound_at.isoformat() if a.owner_bound_at else None}
                        for a in agents]}


@router.post("/invitations/{invite_id}/revoke")
@_database_errors
async def revoke_invitation(invite_id: str, db: AsyncSession = Depends(get_db),
                            user: User = Depends(get_current_user)):
    owner = await _human(db, user)
    found = await db.scalar(select(AgentBindingInvite.id).where(
        AgentBindingInvite.id == invite_id, AgentBindingInvite.issuer_user_id == owner.id))
    if found is None:
        raise HTTPException(404, "Invitation not found")
    changed = await db.execute(update(AgentBindingInvite).where(
        AgentBindingInvite.id == invite_id, AgentBindingInvite.issuer_user_id == owner.id,
        AgentBindingInvite.consumed_at.is_(None), AgentBindingInvite.revoked_at.is_(None)
    ).values(revoked_at=datetime.now(timezone.utc)).execution_options(synchronize_session=False))
    if changed.rowcount != 1:
        await db.rollback()
        raise HTTPException(409, "Invitation unavailable")
    await db.commit()
    return {"id": invite_id, "revoked": True}
