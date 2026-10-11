from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Optional
from sqlalchemy import String, Text, DateTime, ForeignKey, BigInteger, UniqueConstraint, event, update
from sqlalchemy.orm import Mapped, mapped_column, Session, relationship
from app.core.database import Base


class Message(Base):
    __tablename__ = "messages"

    __table_args__ = (UniqueConstraint("room_id", "room_seq", name="uq_message_room_seq"),
                      UniqueConstraint("room_id", "sender_id", "client_message_id", name="uq_message_client_key"))
    client_message_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    room_seq: Mapped[int] = mapped_column(BigInteger, nullable=False)

    id: Mapped[str] = mapped_column(
        String(36), primary_key=True, default=lambda: str(uuid.uuid4())
    )
    room_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("rooms.id"), nullable=False, index=True
    )
    room: Mapped["Room"] = relationship("Room")
    sender_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=False
    )
    sender_type: Mapped[str] = mapped_column(
        String(16), nullable=False, default="human"
    )  # "human" | "agent" | "system"
    content: Mapped[str] = mapped_column(Text, nullable=False)
    msg_type: Mapped[str] = mapped_column(
        String(32), nullable=False, default="text"
    )  # text | system | task | proposal | report | approval_request
    sender_name: Mapped[Optional[str]] = mapped_column(
        String(128), nullable=True, default=None
    )
    parent_id: Mapped[Optional[str]] = mapped_column(
        String(36), ForeignKey("messages.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "room_seq": self.room_seq,
            "room_id": self.room_id,
            "sender_id": self.sender_id,
            "sender_type": self.sender_type,
            "sender_name": self.sender_name,
            "content": self.content,
            "msg_type": self.msg_type,
            "parent_id": self.parent_id,
            "created_at": self.created_at.isoformat(),
        }


@event.listens_for(Session, "before_flush")
def allocate_room_sequences(session, flush_context, instances):
    """Counter row lock lasts until commit: later same-room writes cannot overtake.

    All ORM Message insertion paths use this hook. Never use a PG sequence or
    created_at as the commit cursor. Direct SQL inserts are outside this contract.
    """
    from app.models.room import Room
    from app.models.room_permission import RoomPermission
    from app.chat.pg_wakeup import signal_sync_in_transaction
    connection = session.connection()
    messages = sorted((obj for obj in session.new if isinstance(obj, Message)),
                      key=lambda obj: obj.room_id)
    pending_rooms = {obj.id: obj for obj in session.new if isinstance(obj, Room)}
    tracked_rooms = {obj.id: obj for obj in session.new | session.dirty if isinstance(obj, Room)}
    hints = set()
    for message in messages:
        from app.chat.plaintext_guard import PlaintextStorageForbidden
        tracked = tracked_rooms.get(message.room_id)
        if tracked is not None and tracked.transport == "xmtp":
            raise PlaintextStorageForbidden(message.room_id)
        if message.room_id in pending_rooms:
            room = pending_rooms[message.room_id]
            room.message_seq = (room.message_seq or 0) + 1
            message.room_seq = room.message_seq
        else:
            sequence, transport = connection.execute(update(Room).where(Room.id == message.room_id)
                .values(message_seq=Room.message_seq + 1).returning(Room.message_seq, Room.transport)).one()
            if transport == "xmtp":
                raise PlaintextStorageForbidden(message.room_id)
            message.room_seq = sequence
        hints.add(message.room_id)
    for obj in session.new | session.dirty | session.deleted:
        if isinstance(obj, Room):
            if obj.id:
                hints.add(obj.id)
        elif isinstance(obj, RoomPermission):
            hints.add(obj.room_id)
    for room_id in sorted(hints):
        signal_sync_in_transaction(connection, "room", room_id)
