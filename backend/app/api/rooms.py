"""Room API: create and list rooms, backed by PostgreSQL."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.room import Room

router = APIRouter(prefix="/api/v1/rooms", tags=["rooms"])


class CreateRoomRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""


@router.get("")
async def list_rooms(db: AsyncSession = Depends(get_db)) -> dict:
    result = await db.execute(
        select(Room).where(Room.is_active == True).order_by(Room.created_at.desc())
    )
    rooms = result.scalars().all()
    return {"rooms": [r.to_dict() for r in rooms]}


@router.post("")
async def create_room(
    payload: CreateRoomRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    room = Room(name=payload.name, description=payload.description)
    db.add(room)
    await db.commit()
    await db.refresh(room)
    return {"room": room.to_dict()}


@router.get("/{room_id}")
async def get_room(
    room_id: str,
    db: AsyncSession = Depends(get_db),
) -> dict:
    room = await db.get(Room, room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="Room not found")
    return {"room": room.to_dict()}
