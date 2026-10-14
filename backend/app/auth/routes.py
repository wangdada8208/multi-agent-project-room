from __future__ import annotations

from datetime import datetime, timezone
import hmac

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.config import get_settings
from app.agent.service import find_username_matches
from app.agent.identity import normalize_unicode_casefold
from app.core.security import create_access_token, get_current_user, hash_password, verify_password
from app.models.user import User
from .rate_limit import check_rate_limit, clear_attempts

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[\w.-]+$")
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=128)
    user_type: str = Field(default="human", pattern="^(human|agent)$")


class LoginRequest(BaseModel):
    username: str = Field(max_length=128)
    password: str = Field(max_length=128)


def _auth_response(user: User) -> dict:
    return {
        "user": user.to_dict(),
        "access_token": create_access_token(user.id, user.user_type),
        "token_type": "bearer",
    }


@router.post("/register")
async def register(request: Request, payload: RegisterRequest, db: AsyncSession = Depends(get_db)) -> dict:
    canonical_username = normalize_unicode_casefold(payload.username)
    # Reserve the attempt up front: every registration try counts, successful or
    # not, and the reservation happens in the same atomic step as the threshold
    # check so concurrent requests cannot slip past the limit together.
    await check_rate_limit(request, "register", identifier=canonical_username)

    if payload.user_type == "agent":
        secret = get_settings().agent_enrollment_secret.get_secret_value()
        key = request.headers.get("X-Agent-Enrollment-Key", "")
        if not secret or not hmac.compare_digest(key.encode("utf-8"), secret.encode("utf-8")):
            raise HTTPException(status_code=403, detail="Agent enrollment requires administrator authorization")

    # Canonicalize all new accounts so human and agent names share the existing
    # DB unique constraint even across processes; no process-local lock is used.
    username = canonical_username
    if await find_username_matches(db, username):
        raise HTTPException(status_code=409, detail="Username already exists")

    user = User(
        username=username,
        display_name=payload.display_name,
        user_type=payload.user_type,
        password_hash=hash_password(payload.password),
        last_seen_at=datetime.now(timezone.utc),
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Username already exists") from None
    await db.refresh(user)

    # The registration attempt was already reserved above; a success does not
    # erase it, so bulk account creation stays rate limited.
    return _auth_response(user)


@router.post("/login")
async def login(request: Request, payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> dict:
    canonical_username = normalize_unicode_casefold(payload.username)
    # Reserving the attempt here makes the check atomic with the count, so a
    # burst of concurrent guesses can no longer race past the threshold.
    reservation = await check_rate_limit(request, "login", identifier=canonical_username)

    matches = await find_username_matches(db, payload.username)
    user = matches[0] if len(matches) == 1 else None
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    if not getattr(user, "is_active", True):
        raise HTTPException(status_code=401, detail="Inactive account")

    # A successful login undoes only its own reservation and the account's
    # failure record.  The IP-level record is deliberately left alone: an
    # attacker holding any valid account must not be able to erase the attack
    # trail by logging in.
    if reservation is not None:
        await reservation.release()
    await clear_attempts(request, "login", identifier=canonical_username)
    user.last_seen_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)
    return _auth_response(user)


@router.get("/me")
async def me(current_user: User = Depends(get_current_user)) -> dict:
    return {"user": current_user.to_dict()}
