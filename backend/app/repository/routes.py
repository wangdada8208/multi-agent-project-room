"""Repository REST API."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query

from sqlalchemy.ext.asyncio import AsyncSession
from app.api.permissions import require_role
from app.core.database import get_db
from app.core.security import get_current_user
from app.config import get_settings
from app.models.user import User
from app.repository.service import GitService

router = APIRouter(prefix="/api/v1/rooms/{room_id}/git", tags=["repository"])


def _service(room_id: str) -> GitService:
    root = Path(get_settings().repository_root).resolve()
    target = (root / room_id).resolve()
    if target.parent != root or not (target / ".git").exists():
        raise HTTPException(status_code=404, detail="No repository attached to this room")
    return GitService(target)


@router.get("/status")
async def git_status(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    await require_role(room_id, current_user, db)
    try:
        return _service(room_id).status()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/branch")
async def git_branch(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    await require_role(room_id, current_user, db)
    try:
        return _service(room_id).branch()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/log")
async def git_log(
    room_id: str,
    limit: int = Query(10, ge=1, le=50),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    await require_role(room_id, current_user, db)
    try:
        return {"commits": _service(room_id).log(limit=limit)}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/diff")
async def git_diff(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    await require_role(room_id, current_user, db)
    try:
        return _service(room_id).diff()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
