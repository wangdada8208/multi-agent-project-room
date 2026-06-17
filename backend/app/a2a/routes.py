from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.a2a import task_manager as tm
from app.core.security import get_current_user
from app.models.user import User

router = APIRouter(prefix="/api/v1", tags=["tasks"])


@router.get("/rooms/{room_id}/tasks")
async def list_room_tasks(
    room_id: str,
    status: str | None = Query(None, pattern="^(submitted|working|completed|failed|canceled|input_required)$"),
    page: int = Query(1, ge=1),
    limit: int = Query(50, ge=1, le=200),
    current_user: User = Depends(get_current_user),
) -> dict:
    tasks = await tm.list_room_tasks(room_id=room_id, status=status, page=page, limit=limit)
    return {"tasks": tasks}


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str,
    current_user: User = Depends(get_current_user),
) -> dict:
    task = await tm.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"task": task}
