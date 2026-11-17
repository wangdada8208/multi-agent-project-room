"""Local helper HTTP API.

Human endpoints require a user_type='human' account (get_current_human).
Helper endpoints authenticate with `Authorization: Bearer mhp_<id>.<secret>`
via get_current_helper; heartbeat additionally accepts a revoked token so the
helper can learn it was revoked.
"""
from __future__ import annotations

from functools import wraps

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.rate_limit import check_rate_limit
from app.config import get_settings
from app.core.database import get_db
from app.core.security import get_current_user
from app.helper import service
from app.helper.models import HelperDevice
from app.helper.schemas import (
    CreateSeatRequest,
    HeartbeatRequest,
    HeartbeatResponse,
    HelperDeviceView,
    HubRoom,
    JoinTicketRequest,
    JoinTicketResponse,
    PairingCodeResponse,
    PairRequest,
    PairResponse,
    SeatGrant,
    SeatPeer,
    SeatStatusResponse,
    SeatView,
)
from app.models.user import User

router = APIRouter(tags=["helpers"])
_bearer = HTTPBearer(auto_error=False)


async def get_current_human(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> User:
    """get_current_user + user_type='human', re-read so a type change cannot ride a stale session."""
    stored = await db.get(User, user.id, populate_existing=True)
    if stored is None or stored.user_type != "human":
        raise HTTPException(403, "Human account required")
    return stored


async def get_current_helper(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> HelperDevice:
    if credentials is None or not credentials.credentials.startswith(service.HELPER_TOKEN_PREFIX):
        raise HTTPException(401, "Helper token required")
    return await service.authenticate_helper(db, credentials.credentials)


async def get_current_helper_for_heartbeat(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> HelperDevice:
    if credentials is None or not credentials.credentials.startswith(service.HELPER_TOKEN_PREFIX):
        raise HTTPException(401, "Helper token required")
    return await service.authenticate_helper(db, credentials.credentials, allow_revoked=True)


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
            raise HTTPException(503, "Helper storage temporarily unavailable") from None
    return guarded


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


# ── human ──

@router.post("/api/v1/helpers/pairing-codes", response_model=PairingCodeResponse, status_code=201)
@_database_errors
async def create_pairing_code(request: Request, response: Response, db: AsyncSession = Depends(get_db),
                              user: User = Depends(get_current_human)):
    hub_origin = get_settings().a2a_public_url.rstrip("/")
    result = await service.issue_pairing_code(db, user, hub_origin)
    _no_store(response)
    return result


@router.get("/api/v1/helpers", response_model=list[HelperDeviceView])
@_database_errors
async def my_helpers(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_human)):
    return await service.list_helpers(db, user)


@router.delete("/api/v1/helpers/{helper_id}", status_code=204)
@_database_errors
async def revoke(helper_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_human)):
    await service.revoke_helper(db, user, helper_id)


@router.post("/api/v1/helpers/{helper_id}/join-tickets", response_model=JoinTicketResponse, status_code=201)
@_database_errors
async def create_join_ticket(helper_id: str, payload: JoinTicketRequest, response: Response,
                             db: AsyncSession = Depends(get_db), user: User = Depends(get_current_human)):
    result = await service.issue_join_ticket(db, user, helper_id, payload)
    _no_store(response)
    return result


@router.get("/api/v1/rooms/{room_id}/seats", response_model=list[SeatView])
@_database_errors
async def room_seats(room_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_human)):
    return await service.list_room_seats(db, user, room_id)


@router.get("/api/v1/rooms/{room_id}/seat-peers", response_model=list[SeatPeer])
@_database_errors
async def seat_peers(room_id: str, db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    """人类成员与本房席位 Agent 均可读的最小同伴名单（连环护栏用）。"""
    return await service.list_seat_peers(db, user, room_id)


@router.post("/api/v1/rooms/{room_id}/seats/{seat_id}/group-added", status_code=204)
@_database_errors
async def seat_group_added(room_id: str, seat_id: str, db: AsyncSession = Depends(get_db),
                           user: User = Depends(get_current_human)):
    await service.mark_group_added(db, user, room_id, seat_id)


@router.delete("/api/v1/rooms/{room_id}/seats/{seat_id}", status_code=204)
@_database_errors
async def remove_room_seat(room_id: str, seat_id: str, db: AsyncSession = Depends(get_db),
                           user: User = Depends(get_current_human)):
    await service.remove_seat_by_human(db, user, room_id, seat_id)


# ── helper ──

@router.post("/api/v1/helpers/pair", response_model=PairResponse)
@_database_errors
async def pair(request: Request, payload: PairRequest, response: Response, db: AsyncSession = Depends(get_db)):
    # The pairing code is the only credential on this unauthenticated endpoint;
    # brute-forcing it is additionally bounded by the shared IP rate limiter.
    await check_rate_limit(request, "helpers-pair")
    result = await service.pair_helper(db, payload.code.get_secret_value(),
                                       payload.device_name, payload.platform)
    _no_store(response)
    return result


@router.get("/api/v1/helpers/me/rooms", response_model=list[HubRoom])
@_database_errors
async def helper_rooms(db: AsyncSession = Depends(get_db), helper: HelperDevice = Depends(get_current_helper)):
    return await service.list_helper_rooms(db, helper)


@router.post("/api/v1/helpers/me/seats", response_model=SeatGrant, status_code=201)
@_database_errors
async def helper_create_seat(payload: CreateSeatRequest, response: Response, db: AsyncSession = Depends(get_db),
                             helper: HelperDevice = Depends(get_current_helper)):
    result = await service.create_seat(db, helper, payload)
    _no_store(response)
    return result


@router.get("/api/v1/helpers/me/seats/{seat_id}", response_model=SeatStatusResponse)
@_database_errors
async def helper_get_seat(seat_id: str, db: AsyncSession = Depends(get_db),
                          helper: HelperDevice = Depends(get_current_helper)):
    return await service.get_seat(db, helper, seat_id)


@router.post("/api/v1/helpers/me/seats/{seat_id}/token")
@_database_errors
async def helper_seat_token(seat_id: str, response: Response, db: AsyncSession = Depends(get_db),
                            helper: HelperDevice = Depends(get_current_helper)):
    token = await service.refresh_agent_token(db, helper, seat_id)
    _no_store(response)
    return {"agent_token": token}


@router.delete("/api/v1/helpers/me/seats/{seat_id}", status_code=204)
@_database_errors
async def helper_delete_seat(seat_id: str, db: AsyncSession = Depends(get_db),
                             helper: HelperDevice = Depends(get_current_helper)):
    await service.delete_seat_by_helper(db, helper, seat_id)


@router.post("/api/v1/helpers/me/heartbeat", response_model=HeartbeatResponse)
@_database_errors
async def helper_heartbeat(payload: HeartbeatRequest, db: AsyncSession = Depends(get_db),
                           helper: HelperDevice = Depends(get_current_helper_for_heartbeat)):
    return await service.heartbeat(db, helper, payload)
