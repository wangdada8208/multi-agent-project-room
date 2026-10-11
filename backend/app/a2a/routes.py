from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.a2a import task_manager as tm
from app.api.permissions import require_role
from app.chat import service as chat_service
from app.core.database import get_db
from app.core.security import get_current_user
from app.models.user import User

router = APIRouter(prefix="/api/v1", tags=["tasks"])


@router.get("/rooms/{room_id}/tasks")
async def list_room_tasks(
    room_id: str,
    status: str | None = Query(None, pattern="^(submitted|working|completed|failed|canceled|input_required)$"),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    room = await chat_service.resolve_room(db, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    await require_role(room.id, current_user, db, min_role="viewer")

    tasks = await tm.list_room_tasks(room_id=room.id, status=status, page=page, limit=limit)
    return {"tasks": tasks}


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    task = await tm.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    task_room_id = task.get("room_id")
    if not task_room_id:
        raise HTTPException(
            status_code=403,
            detail="Task has no associated room and cannot be accessed",
        )

    room = await chat_service.resolve_room(db, task_room_id)
    if room is None:
        raise HTTPException(status_code=403, detail="No access to task room")

    await require_role(room.id, current_user, db, min_role="viewer")
    return {"task": task}


@router.get("/tasks/{task_id}/events")
async def get_task_events(
    task_id: str,
    after_seq: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    task = await tm.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    task_room_id = task.get("room_id")
    if not task_room_id:
        raise HTTPException(
            status_code=403,
            detail="Task has no associated room and cannot be accessed",
        )

    room = await chat_service.resolve_room(db, task_room_id)
    if room is None:
        raise HTTPException(status_code=403, detail="No access to task room")

    await require_role(room.id, current_user, db, min_role="viewer")
    events = await tm.get_task_events(task_id, after_seq=after_seq, limit=limit)
    return {"task_id": task_id, "events": events}
