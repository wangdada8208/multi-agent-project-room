"""WebSocket chat handler with PostgreSQL persistence.

Message flow:
  Client sends JSON → server persists to DB → server broadcasts to room
"""

import json
from fastapi import WebSocket, WebSocketDisconnect
from app.core.database import async_session
from app.chat import service as chat_service
from app.ws.connection_manager import connection_manager
from app.models.room import Room


async def handle_chat(websocket: WebSocket, room_id: str) -> None:
    """WebSocket endpoint for a chat room.

    Wire this in main.py:
        app.add_websocket_route("/ws/chat/{room_id}", handle_chat)
    """
    await connection_manager.connect(room_id, websocket)

    await connection_manager.broadcast(
        room_id,
        {"type": "system", "content": "A participant joined the room."},
    )

    try:
        while True:
            raw = await websocket.receive_json()
            msg_type = raw.get("type", "")

            # ── Heartbeat ──
            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
                continue

            # ── Typing indicator ──
            if msg_type == "typing":
                await connection_manager.broadcast(
                    room_id,
                    {"type": "typing", "sender_id": raw.get("sender_id", "anonymous")},
                )
                continue

            # ── Chat message ──
            if msg_type == "message":
                content = str(raw.get("content", "")).strip()
                if not content:
                    await websocket.send_json(
                        {"type": "error", "message": "content is required"}
                    )
                    continue

                async with async_session() as db:
                    # Ensure room exists
                    room = await db.get(Room, room_id)
                    if room is None:
                        await websocket.send_json(
                            {"type": "error", "message": "Room not found"}
                        )
                        continue

                    message = await chat_service.save_message(
                        db=db,
                        room_id=room_id,
                        sender_id=str(raw.get("sender_id", "anonymous")),
                        sender_type=raw.get("sender_type", "human"),
                        content=content,
                        msg_type=raw.get("msg_type", "text"),
                        parent_id=raw.get("parent_id"),
                    )

                await connection_manager.broadcast(
                    room_id,
                    {"type": "message", "message": message.to_dict()},
                )

    except WebSocketDisconnect:
        connection_manager.disconnect(room_id, websocket)
        await connection_manager.broadcast(
            room_id,
            {"type": "system", "content": "A participant left the room."},
        )
    except Exception as e:
        connection_manager.disconnect(room_id, websocket)
        await connection_manager.broadcast(
            room_id,
            {"type": "system", "content": f"Connection error: {str(e)}"},
        )
