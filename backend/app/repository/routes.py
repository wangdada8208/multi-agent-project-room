"""Repository REST API."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.repository.service import GitService

router = APIRouter(prefix="/api/v1/rooms/{room_id}/git", tags=["repository"])


def _service() -> GitService:
    return GitService()


@router.get("/status")
async def git_status(room_id: str) -> dict:
    try:
        return _service().status()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/branch")
async def git_branch(room_id: str) -> dict:
    try:
        return _service().branch()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/log")
async def git_log(room_id: str, limit: int = Query(10, ge=1, le=50)) -> dict:
    try:
        return {"commits": _service().log(limit=limit)}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/diff")
async def git_diff(room_id: str) -> dict:
    try:
        return _service().diff()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
