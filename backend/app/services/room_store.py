from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from threading import Lock
from typing import Literal
from uuid import uuid4


MessageType = Literal["text", "system", "task", "proposal", "report", "approval_request"]


@dataclass
class Message:
    id: str
    room_id: str
    sender_id: str
    sender_type: Literal["human", "agent", "system"]
    content: str
    msg_type: MessageType = "text"
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Room:
    id: str
    name: str
    description: str
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return asdict(self)


class RoomStore:
    """Tiny in-memory store for the demo.

    The real MVP should replace this with PostgreSQL models and migrations.
    """

    def __init__(self) -> None:
        self._lock = Lock()
        self._rooms: dict[str, Room] = {}
        self._messages: dict[str, list[Message]] = {}
        self.create_room("demo-room", "Demo Project Room")
        self.add_message(
            room_id="demo-room",
            sender_id="system",
            sender_type="system",
            content="Welcome to the Multi-Agent Project Room demo.",
            msg_type="system",
        )

    def create_room(self, room_id: str | None, name: str, description: str = "") -> Room:
        with self._lock:
            new_room = Room(id=room_id or str(uuid4()), name=name, description=description)
            self._rooms[new_room.id] = new_room
            self._messages.setdefault(new_room.id, [])
            return new_room

    def list_rooms(self) -> list[dict]:
        with self._lock:
            return [room.to_dict() for room in self._rooms.values()]

    def get_room(self, room_id: str) -> Room | None:
        with self._lock:
            return self._rooms.get(room_id)

    def add_message(
        self,
        room_id: str,
        sender_id: str,
        sender_type: Literal["human", "agent", "system"],
        content: str,
        msg_type: MessageType = "text",
    ) -> Message:
        with self._lock:
            if room_id not in self._rooms:
                raise KeyError(f"Room not found: {room_id}")

            message = Message(
                id=str(uuid4()),
                room_id=room_id,
                sender_id=sender_id,
                sender_type=sender_type,
                content=content,
                msg_type=msg_type,
            )
            self._messages.setdefault(room_id, []).append(message)
            return message

    def list_messages(self, room_id: str) -> list[dict]:
        with self._lock:
            return [message.to_dict() for message in self._messages.get(room_id, [])]


room_store = RoomStore()
