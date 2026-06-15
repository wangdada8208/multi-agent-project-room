from __future__ import annotations

from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException

from backend.app.services.room_store import room_store


router = APIRouter(prefix="/api/v1/rooms", tags=["rooms"])


class CreateRoomRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""


class CreateMessageRequest(BaseModel):
    sender_id: str = Field(default="human-demo", min_length=1, max_length=120)
    sender_type: str = Field(default="human")
    content: str = Field(min_length=1)
    msg_type: str = Field(default="text")


@router.get("")
async def list_rooms() -> dict:
    return {"rooms": room_store.list_rooms()}


@router.post("")
async def create_room(payload: CreateRoomRequest) -> dict:
    room = room_store.create_room(room_id=None, name=payload.name, description=payload.description)
    return {"room": room.to_dict()}


@router.get("/{room_id}/messages")
async def list_messages(room_id: str) -> dict:
    if room_store.get_room(room_id) is None:
        raise HTTPException(status_code=404, detail="Room not found")

    return {"messages": room_store.list_messages(room_id)}


@router.post("/{room_id}/messages")
async def create_message(room_id: str, payload: CreateMessageRequest) -> dict:
    if room_store.get_room(room_id) is None:
        raise HTTPException(status_code=404, detail="Room not found")

    message = room_store.add_message(
        room_id=room_id,
        sender_id=payload.sender_id,
        sender_type=payload.sender_type,  # type: ignore[arg-type]
        content=payload.content,
        msg_type=payload.msg_type,  # type: ignore[arg-type]
    )
    return {"message": message.to_dict()}
