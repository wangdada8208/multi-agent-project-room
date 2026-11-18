from __future__ import annotations

from datetime import datetime, timezone
import hmac
import re
import secrets
from typing import Literal, Optional
import unicodedata

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.identity import comparison_identity, normalize_unicode_casefold
from app.agent.service import find_username_matches
from app.auth.email_otp import (
    check_email_otp_cooldown,
    email_is_configured,
    issue_email_otp,
    normalize_and_validate_email,
    revoke_email_otp,
    send_verification_email,
    verify_and_consume_email_otp,
)
from app.auth.google_oauth import verify_google_id_token
from app.config import get_settings
from app.core.database import get_db
from app.core.security import create_access_token, get_current_user, hash_password, verify_password
from app.models.oauth_account import UserOAuthAccount
from app.models.user import User
from .rate_limit import check_rate_limit, clear_attempts

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


# users.username, users.normalized_username and users.comparison_username are all
# String(64). Casefolding can make a name LONGER than the input (`ß` -> `ss`), so a
# 64-character username can normalise to a 128-character key. The INSERT then blew
# up with a data-truncation error and the endpoint answered 500. Rejecting the
# input as a validation error keeps an unrepresentable name out of the database
# without widening any column (a schema change would need its own migration).
_NAME_KEY_MAX_LENGTH = 64
_SAFE_USERNAME_CHAR_RE = re.compile(r"[^a-z0-9_.-]+")


def _validate_storable_username(value: str) -> str:
    for key in (normalize_unicode_casefold(value), comparison_identity(value)):
        if len(key) > _NAME_KEY_MAX_LENGTH:
            raise ValueError(
                "username normalizes to a comparison key longer than "
                f"{_NAME_KEY_MAX_LENGTH} characters; please choose a shorter name"
            )
    return value


class RegisterRequest(BaseModel):
    username: str = Field(min_length=3, max_length=64, pattern=r"^[\w.-]+$")
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=128)
    user_type: str = Field(default="human", pattern="^(human|agent)$")

    @field_validator("username")
    @classmethod
    def _reject_unstorable_normalized_length(cls, value: str) -> str:
        return _validate_storable_username(value)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=254)
    password: str = Field(max_length=128)


class EmailSendCodeRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    purpose: Literal["register", "login"] = "register"


class EmailRegisterRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    code: str = Field(min_length=6, max_length=12)
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(default="", max_length=128)
    username: Optional[str] = Field(default=None, min_length=3, max_length=64, pattern=r"^[\w.-]+$")

    @field_validator("username")
    @classmethod
    def _reject_unstorable_normalized_length(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        return _validate_storable_username(value)


class EmailLoginRequest(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    code: str = Field(min_length=6, max_length=12)


class GoogleLoginRequest(BaseModel):
    credential: str = Field(min_length=10, max_length=8192)


def _auth_response(user: User) -> dict:
    return {
        "user": user.to_dict(include_email=True),
        "access_token": create_access_token(user.id, user.user_type),
        "token_type": "bearer",
    }


_dummy_hash: str | None = None


def _timing_dummy_hash() -> str:
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = hash_password("mapr-timing-equalizer")
    return _dummy_hash


async def _find_user_by_email(db: AsyncSession, normalized_email: str) -> User | None:
    result = await db.execute(
        select(User).where(User.normalized_email == normalized_email).limit(1)
    )
    return result.scalar_one_or_none()


async def _find_oauth_account(
    db: AsyncSession, *, provider: str, provider_subject: str
) -> UserOAuthAccount | None:
    result = await db.execute(
        select(UserOAuthAccount)
        .where(
            UserOAuthAccount.provider == provider,
            UserOAuthAccount.provider_subject == provider_subject,
        )
        .limit(1)
    )
    return result.scalar_one_or_none()


async def _has_provider_binding(db: AsyncSession, *, user_id: str, provider: str) -> bool:
    result = await db.execute(
        select(UserOAuthAccount.id)
        .where(
            UserOAuthAccount.user_id == user_id,
            UserOAuthAccount.provider == provider,
        )
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


async def _allocate_unique_username(db: AsyncSession, seed: str) -> str:
    ascii_seed = unicodedata.normalize("NFKC", seed).strip().lower()
    cleaned = _SAFE_USERNAME_CHAR_RE.sub("_", ascii_seed).strip("._-")
    if not cleaned:
        cleaned = "user"
    if len(cleaned) < 3:
        cleaned = f"user_{cleaned}"
    base = cleaned[:48].rstrip("._-") or "user"
    if len(base) < 3:
        base = "user"

    if not await find_username_matches(db, base):
        return base
    for _ in range(16):
        candidate = f"{base}_{secrets.token_hex(3)}"
        if not await find_username_matches(db, candidate):
            return candidate
    return f"user_{secrets.token_hex(6)}"


@router.get("/providers")
async def auth_providers() -> dict:
    settings = get_settings()
    google_client_id = (settings.google_client_id or "").strip()
    return {
        "email_enabled": email_is_configured(settings),
        "google_enabled": bool(google_client_id),
        "google_client_id": google_client_id,
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
        # Written explicitly rather than relying on the model validator: the
        # value is *stored*, never applied back to `username`. The UNIQUE index
        # on this column is what closes the check-then-insert race between two
        # concurrent registrations (audit H3).
        comparison_username=comparison_identity(username),
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


@router.post("/email/send-code")
async def send_email_code(
    request: Request, payload: EmailSendCodeRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    cleaned_email, normalized_email = normalize_and_validate_email(payload.email)
    settings = get_settings()
    await check_rate_limit(request, f"email_send_{payload.purpose}", identifier=normalized_email)

    if not email_is_configured(settings):
        raise HTTPException(status_code=503, detail="邮件服务尚未配置")

    existing = await _find_user_by_email(db, normalized_email)
    if payload.purpose == "register":
        if existing is not None:
            raise HTTPException(status_code=409, detail="该邮箱已注册，请直接登录")
        code = await issue_email_otp(normalized_email, "register", settings)
        try:
            await send_verification_email(cleaned_email, code, "register", settings)
        except Exception:
            await revoke_email_otp(normalized_email, "register", settings)
            raise
    else:
        if (
            existing is not None
            and existing.user_type == "human"
            and getattr(existing, "is_active", True)
        ):
            code = await issue_email_otp(normalized_email, "login", settings)
            try:
                await send_verification_email(cleaned_email, code, "login", settings)
            except Exception:
                await revoke_email_otp(normalized_email, "login", settings)
                raise
        else:
            # Reserve cooldown even when the address is unknown/non-human to avoid user enumeration.
            await check_email_otp_cooldown(normalized_email, "login", settings, reserve=True)

    return {
        "sent": True,
        "expires_in": int(settings.email_otp_ttl_seconds),
        "cooldown_seconds": int(settings.email_otp_cooldown_seconds),
    }


@router.post("/email/register")
async def register_with_email(
    request: Request, payload: EmailRegisterRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    cleaned_email, normalized_email = normalize_and_validate_email(payload.email)
    settings = get_settings()
    await check_rate_limit(request, "email_register", identifier=normalized_email)

    await verify_and_consume_email_otp(normalized_email, payload.code, "register", settings)

    if await _find_user_by_email(db, normalized_email) is not None:
        raise HTTPException(status_code=409, detail="该邮箱已注册，请直接登录")

    if payload.username:
        username = normalize_unicode_casefold(payload.username)
        if await find_username_matches(db, username):
            raise HTTPException(status_code=409, detail="Username already exists")
    else:
        username = await _allocate_unique_username(db, cleaned_email.split("@", 1)[0])

    now = datetime.now(timezone.utc)
    display_name = payload.display_name.strip() or cleaned_email.split("@", 1)[0][:128]
    user = User(
        username=username,
        comparison_username=comparison_identity(username),
        display_name=display_name,
        user_type="human",
        email=cleaned_email,
        normalized_email=normalized_email,
        email_verified_at=now,
        password_hash=hash_password(payload.password),
        last_seen_at=now,
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="邮箱或用户名已被占用") from None
    await db.refresh(user)
    return _auth_response(user)


@router.post("/email/login")
async def login_with_email_code(
    request: Request, payload: EmailLoginRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    _, normalized_email = normalize_and_validate_email(payload.email)
    settings = get_settings()
    reservation = await check_rate_limit(request, "email_login", identifier=normalized_email)

    await verify_and_consume_email_otp(normalized_email, payload.code, "login", settings)

    user = await _find_user_by_email(db, normalized_email)
    if user is None or user.user_type != "human":
        raise HTTPException(status_code=401, detail="邮箱未注册或验证码无效")
    if not getattr(user, "is_active", True):
        raise HTTPException(status_code=401, detail="Inactive account")

    if reservation is not None:
        await reservation.release()
    await clear_attempts(request, "email_login", identifier=normalized_email)

    now = datetime.now(timezone.utc)
    user.last_seen_at = now
    if user.email_verified_at is None:
        user.email_verified_at = now
    await db.commit()
    await db.refresh(user)
    return _auth_response(user)


@router.post("/login")
async def login(request: Request, payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> dict:
    raw_identifier = payload.username.strip()
    if "@" in raw_identifier:
        rate_identifier = unicodedata.normalize("NFKC", raw_identifier).lower()
        reservation = await check_rate_limit(request, "login", identifier=rate_identifier)
        matched = await _find_user_by_email(db, rate_identifier)
        user = matched if (matched is not None and matched.user_type == "human") else None
    else:
        rate_identifier = normalize_unicode_casefold(payload.username)
        # Reserving the attempt here makes the check atomic with the count, so a
        # burst of concurrent guesses can no longer race past the threshold.
        reservation = await check_rate_limit(request, "login", identifier=rate_identifier)
        matches = await find_username_matches(db, payload.username)
        user = matches[0] if len(matches) == 1 else None

    # Verify against a constant hash even when the user is unknown or passwordless
    # (e.g. Google-only) so response timing never leaks account existence.
    has_usable_hash = user is not None and bool(user.password_hash)
    password_hash = user.password_hash if has_usable_hash else _timing_dummy_hash()
    if not verify_password(payload.password, password_hash) or not has_usable_hash or user is None:
        raise HTTPException(status_code=401, detail="Invalid username or password")

    if not getattr(user, "is_active", True):
        raise HTTPException(status_code=401, detail="Inactive account")

    # A successful login undoes only its own reservation and the account's
    # failure record.  The IP-level record is deliberately left alone: an
    # attacker holding any valid account must not be able to erase the attack
    # trail by logging in.
    if reservation is not None:
        await reservation.release()
    await clear_attempts(request, "login", identifier=rate_identifier)
    user.last_seen_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(user)
    return _auth_response(user)


@router.post("/google")
async def login_with_google(
    request: Request, payload: GoogleLoginRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    settings = get_settings()
    reservation = await check_rate_limit(request, "google_login")
    if not (settings.google_client_id or "").strip():
        raise HTTPException(status_code=503, detail="Google 登录尚未配置")

    identity = await verify_google_id_token(payload.credential, settings)
    now = datetime.now(timezone.utc)

    oauth_link = await _find_oauth_account(
        db, provider="google", provider_subject=identity.sub
    )
    if oauth_link is not None:
        user = await db.get(User, oauth_link.user_id)
        if user is None or user.user_type != "human":
            raise HTTPException(status_code=401, detail="关联账号不存在或类型受限")
        if not getattr(user, "is_active", True):
            raise HTTPException(status_code=401, detail="Inactive account")
        if oauth_link.provider_email != identity.email:
            oauth_link.provider_email = identity.email
        if not user.avatar_url and identity.picture:
            user.avatar_url = identity.picture
        user.last_seen_at = now
        await db.commit()
        await db.refresh(user)
        if reservation is not None:
            await reservation.release()
        return _auth_response(user)

    existing_user = await _find_user_by_email(db, identity.normalized_email)
    if existing_user is not None:
        if existing_user.user_type != "human":
            raise HTTPException(status_code=409, detail="该邮箱关联的账号类型不支持 Google 登录")
        if not getattr(existing_user, "is_active", True):
            raise HTTPException(status_code=401, detail="Inactive account")
        if existing_user.email_verified_at is None:
            raise HTTPException(
                status_code=409,
                detail="该本地账号邮箱尚未验证，为防止账号被接管已拒绝自动绑定",
            )
        if await _has_provider_binding(db, user_id=existing_user.id, provider="google"):
            raise HTTPException(status_code=409, detail="该账号已绑定其他 Google 账户")

        db.add(
            UserOAuthAccount(
                user_id=existing_user.id,
                provider="google",
                provider_subject=identity.sub,
                provider_email=identity.email,
            )
        )
        if not existing_user.avatar_url and identity.picture:
            existing_user.avatar_url = identity.picture
        existing_user.last_seen_at = now
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            raise HTTPException(status_code=409, detail="Google 账号绑定冲突，请重试") from None
        await db.refresh(existing_user)
        if reservation is not None:
            await reservation.release()
        return _auth_response(existing_user)

    username = await _allocate_unique_username(db, identity.email.split("@", 1)[0])
    user = User(
        username=username,
        comparison_username=comparison_identity(username),
        display_name=identity.name,
        user_type="human",
        email=identity.email,
        normalized_email=identity.normalized_email,
        email_verified_at=now,
        avatar_url=identity.picture,
        password_hash=None,
        last_seen_at=now,
    )
    db.add(user)
    await db.flush()
    db.add(
        UserOAuthAccount(
            user_id=user.id,
            provider="google",
            provider_subject=identity.sub,
            provider_email=identity.email,
        )
    )
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="账号创建并发冲突，请重试") from None
    await db.refresh(user)
    if reservation is not None:
        await reservation.release()
    return _auth_response(user)


@router.get("/me")
async def me(current_user: User = Depends(get_current_user)) -> dict:
    return {"user": current_user.to_dict(include_email=True)}
