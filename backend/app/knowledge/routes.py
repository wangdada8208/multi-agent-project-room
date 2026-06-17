"""Knowledge REST API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import get_current_user
from app.knowledge import service as knowledge_service
from app.models.room import Room
from app.models.user import User

router = APIRouter(prefix="/api/v1/rooms/{room_id}/docs", tags=["knowledge"])


class CreateDocRequest(BaseModel):
    title: str = Field(min_length=1, max_length=256)
    content: str = Field(min_length=1)
    author_id: str | None = None


async def _ensure_room(db: AsyncSession, room_id: str) -> None:
    if await db.get(Room, room_id) is None:
        raise HTTPException(status_code=404, detail="Room not found")


@router.post("")
async def create_doc(
    room_id: str,
    payload: CreateDocRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    await _ensure_room(db, room_id)
    doc = await knowledge_service.create_doc(
        db=db,
        room_id=room_id,
        title=payload.title,
        content=payload.content,
        author_id=payload.author_id or current_user.id,
    )
    return {"doc": doc.to_dict()}


@router.get("")
async def list_docs(
    room_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    await _ensure_room(db, room_id)
    docs = await knowledge_service.list_docs(db, room_id)
    return {"docs": [doc.to_dict(include_content=False) for doc in docs]}


@router.get("/search")
async def search_docs(
    room_id: str,
    q: str = Query(min_length=1),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    await _ensure_room(db, room_id)
    return {"results": await knowledge_service.search_docs(db, room_id, q)}


@router.get("/{doc_id}")
async def get_doc(
    room_id: str,
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    await _ensure_room(db, room_id)
    doc = await knowledge_service.get_doc(db, room_id, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"doc": doc.to_dict()}
